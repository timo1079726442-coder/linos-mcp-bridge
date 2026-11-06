import * as path from "node:path";
import { JobStore, type JobKind, type JobRecord, type JobStartInput } from "./job-store.js";
import { assertAllowedCommand, resolvePowerShellArgv, tokenizeCommand } from "./command-tools.js";
import { McpSecurityBoundary } from "./security-boundary.js";
import { launchJob, cancelActiveJob, isJobActive, countActiveJobs, waitForActiveJobSettled, recoverInterruptedJobs } from "./job-runner.js";
import { redactString } from "./redaction.js";
import type { McpCallerContext } from "./mcp-tools.js";

export const JOB_ACTION_NAMES = new Set(["execute_command", "run_powershell", "git_commit"]);
export const MAX_JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_ACTIVE_JOBS_PER_WORKSPACE = 2;
export const IDEMPOTENT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const startQueues = new Map<string, Promise<void>>();

async function withWorkspaceStartLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = startQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  startQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (startQueues.get(key) === tail) startQueues.delete(key);
  }
}

export interface JobWorkspace {
  boundary: McpSecurityBoundary;
  workspaceId: string;
  workspaceRoot: string;
  profileDir: string;
  caller?: McpCallerContext;
  shellScopeGranted?: boolean;
}

function requireCaller(ws: JobWorkspace): string {
  const clientId = ws.caller?.clientId;
  if (typeof clientId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(clientId)) {
    throw new Error("CLIENT_ID_REQUIRED");
  }
  return clientId;
}

function requireShellScope(ws: JobWorkspace): void {
  if (ws.shellScopeGranted !== true) {
    throw new Error("INSUFFICIENT_SCOPE：后台任务会执行命令，需要 workspace.shell 授权；请在控制中心重新授权连接器。");
  }
}

function boundedTimeoutMs(value: unknown): number {
  const timeout = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_JOB_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_JOB_TIMEOUT_MS, timeout));
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.slice(0, 120);
}

function cleanIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text)) throw new Error("JOB_IDEMPOTENCY_KEY_INVALID");
  return text;
}

function cleanMode(value: unknown): "user" | "constrained" {
  return value === "constrained" ? "constrained" : "user";
}

function asDisplay(value: string): string {
  return redactString(value).slice(0, 4000);
}

async function resolveCwd(boundary: McpSecurityBoundary, cwd: unknown): Promise<{ absolute: string; display: string; input: string }> {
  const input = typeof cwd === "string" && cwd ? cwd : ".";
  const resolved = await boundary.resolveWritePath(input);
  const stat = await (await import("node:fs/promises")).stat(resolved.absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("CWD_NOT_DIRECTORY");
  return { absolute: resolved.absolute, display: resolved.display, input };
}

async function assertUnderlyingToolEnabled(profileDir: string, workspaceId: string, action: JobKind): Promise<void> {
  const { loadToolPolicy } = await import("./tool-policy.js");
  const policy = await loadToolPolicy(profileDir, workspaceId);
  const entry = (policy.tools as Record<string, { enabled?: boolean } | undefined>)[action];
  if (!entry || entry.enabled !== true) {
    throw new Error(`TOOL_DISABLED：后台任务使用的 ${action} 已在控制中心关闭。`);
  }
}

async function markOrphaned(store: JobStore, record: JobRecord): Promise<JobRecord> {
  // 与 recoverInterruptedJobs 保持同一判定：必须"创建已过期 + 心跳已过期"才算孤儿，
  // 否则刚进 QUEUED 的任务、或别的 Runtime 正在跑的任务会被误标 INTERRUPTED。
  const createdAge = Date.now() - Date.parse(record.createdAt);
  const heartbeatAge = record.lastHeartbeatAt ? Date.now() - Date.parse(record.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
  const stale = Number.isFinite(createdAge) && createdAge > 30_000
    && (!Number.isFinite(heartbeatAge) || heartbeatAge > 30_000);
  if ((record.state === "RUNNING" || record.state === "QUEUED") && !isJobActive(record.id) && stale) {
    const next: JobRecord = {
      ...record,
      state: "INTERRUPTED",
      finishedAt: record.finishedAt ?? new Date().toISOString(),
      errorCode: "JOB_INTERRUPTED",
      checkpoints: [...record.checkpoints, { at: new Date().toISOString(), message: "worker lost; safe to resume" }].slice(-100),
    };
    return store.save(next);
  }
  return record;
}

function requireSameWorkspace(record: JobRecord, workspaceId: string): void {
  if (record.spec.workspaceId !== workspaceId) throw new Error("JOB_WORKSPACE_MISMATCH");
}

function requireSameClient(record: JobRecord, clientId: string): void {
  if (record.spec.clientId !== clientId) throw new Error("JOB_CLIENT_MISMATCH");
}

async function ensureActiveSlot(store: JobStore, profileDir: string, workspaceId: string): Promise<void> {
  await recoverInterruptedJobs(store);
  const records = await store.list(200);
  const persistedOnly = records.filter((item) =>
    (item.state === "RUNNING" || item.state === "QUEUED") && !isJobActive(item.id)
  ).length;
  const activeControllers = countActiveJobs(profileDir, workspaceId);
  if (persistedOnly + activeControllers >= MAX_ACTIVE_JOBS_PER_WORKSPACE) {
    throw new Error("JOB_CONCURRENCY_LIMIT：已有后台任务在运行，先等它结束或取消。");
  }
}

/**
 * 诊断注入点：只有测试构造的 ws 会带 timeline 属性；生产 ws 没有该属性。
 * 不写配置、不读环境变量、不暴露 MCP 参数。
 */
function timelineOf(ws: unknown): ((event: import("./job-timeline.js").TimelineEvent) => void) | undefined {
  const candidate = (ws as { timeline?: unknown } | null)?.timeline;
  return typeof candidate === "function"
    ? (candidate as (event: import("./job-timeline.js").TimelineEvent) => void)
    : undefined;
}
export async function startJobTool(
  ws: JobWorkspace,
  args: Record<string, unknown>,
): Promise<{ job_id: string; state: string; poll_hint_ms: number; resumed: boolean }> {
  const clientId = requireCaller(ws);
  requireShellScope(ws);
  const profileDir = ws.profileDir;
  if (!profileDir) throw new Error("TOOL_POLICY_UNAVAILABLE：缺少 profile 目录无法创建任务。");
  const action = args.action;
  if (action !== "execute_command" && action !== "run_powershell" && action !== "git_commit") {
    throw new Error("JOB_ACTION_UNSUPPORTED");
  }
  await assertUnderlyingToolEnabled(profileDir, ws.workspaceId, action);
  const store = new JobStore(profileDir, ws.workspaceId, timelineOf(ws));
  const idempotencyKey = cleanIdempotencyKey(args.idempotency_key);
  const label = cleanLabel(args.label) ?? `${action} job`;
  const timeoutMs = boundedTimeoutMs(args.timeout_ms);
  const cwd = await resolveCwd(ws.boundary, args.cwd);
  let argv: string[];
  let display: string;
  let mode: "user" | "constrained" | undefined;
  let message: string | undefined;
  let allowEmpty: boolean | undefined;
  if (action === "execute_command") {
    const command = typeof args.command === "string" ? args.command : Array.isArray(args.command) ? args.command.map(String).join(" ") : "";
    const tokens = tokenizeCommand(command);
    assertAllowedCommand(tokens);
    argv = tokens;
    display = argv.join(" ");
  } else if (action === "run_powershell") {
    const command = typeof args.command === "string" ? args.command : "";
    mode = cleanMode(args.mode);
    const resolved = await resolvePowerShellArgv(command, mode);
    if (cwd.absolute !== (await ws.boundary.resolveWritePath(typeof args.cwd === "string" && args.cwd ? args.cwd : ".")).absolute) {
      throw new Error("JOB_CWD_CHANGED");
    }
    argv = resolved.argv;
    display = resolved.display;
  } else {
    const msg = typeof args.message === "string" ? args.message.trim() : "";
    if (!msg || msg.length > 500 || /[\u0000\r\n]/.test(msg)) throw new Error("COMMIT_MESSAGE_INVALID");
    message = msg;
    allowEmpty = args.allow_empty === true;
    argv = ["git", "commit", "-m", msg, ...(allowEmpty ? ["--allow-empty"] : [])];
    display = `git commit -m ${JSON.stringify(msg)}`;
  }

  const input: JobStartInput = {
    kind: action,
    label,
    clientId,
    workspaceId: ws.workspaceId,
    argv,
    display: asDisplay(display),
    cwdInput: cwd.input,
    cwdAbsolute: cwd.absolute,
    cwdDisplay: cwd.display,
    timeoutMs,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(mode ? { mode } : {}),
    ...(message ? { message } : {}),
    ...(allowEmpty !== undefined ? { allowEmpty } : {}),
  };
  return withWorkspaceStartLock(`${path.resolve(profileDir)}::${ws.workspaceId}`, async () => {
    if (idempotencyKey) {
      const active = await store.findActiveByIdempotencyKey({ clientId, idempotencyKey });
      if (active) return { job_id: active.id, state: active.state, poll_hint_ms: 5000, resumed: true };
      const recent = await store.findRecentTerminalByIdempotencyKey({ clientId, idempotencyKey, withinMs: IDEMPOTENT_REUSE_WINDOW_MS });
      if (recent && recent.state === "SUCCEEDED") {
        return { job_id: recent.id, state: recent.state, poll_hint_ms: 5000, resumed: true };
      }
    }
    await ensureActiveSlot(store, profileDir, ws.workspaceId);
    const created = await store.create(input);
    await launchJob(store, created, {
      timeline: timelineOf(ws),
      workspaceRoot: ws.boundary.rootReal,
      profileDir,
      workspaceId: ws.workspaceId,
    });
    const view = await store.get(created.id);
    return { job_id: view.id, state: view.state, poll_hint_ms: 5000, resumed: false };
  });
}

export async function jobStatusTool(ws: JobWorkspace, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const clientId = requireCaller(ws);
  const store = new JobStore(ws.profileDir || null, ws.workspaceId, timelineOf(ws));
  const id = typeof args.job_id === "string" ? args.job_id : "";
  let record = await store.get(id);
  requireSameWorkspace(record, ws.workspaceId);
  requireSameClient(record, clientId);
  record = await markOrphaned(store, record);
  const status = store.toStatus(record);
  return {
    ...status,
    command: asDisplay(record.spec.display),
    cwd: record.spec.cwdDisplay,
    attempts: record.attempts,
    last_checkpoint: record.checkpoints[record.checkpoints.length - 1]?.message ?? null,
  };
}

export async function jobListTool(ws: JobWorkspace, args: Record<string, unknown>): Promise<{ jobs: Array<Record<string, unknown>> }> {
  const clientId = requireCaller(ws);
  const store = new JobStore(ws.profileDir || null, ws.workspaceId, timelineOf(ws));
  const limit = typeof args.limit === "number" ? args.limit : 20;
  const records = await store.list(limit);
  const owned = records.filter((record) => record.spec.clientId === clientId && record.spec.workspaceId === ws.workspaceId);
  const jobs: Array<Record<string, unknown>> = [];
  for (const record of owned) {
    const current = await markOrphaned(store, record);
    const status = store.toStatus(current);
    const last = current.checkpoints[current.checkpoints.length - 1];
    jobs.push({
      job_id: status.job_id,
      kind: status.kind,
      state: status.state,
      label: current.spec.label,
      attempts: status.attempts,
      exit_code: status.exit_code,
      timed_out: status.timed_out,
      duration_ms: status.duration_ms,
      output_bytes: status.output_bytes,
      last_checkpoint: last?.message ?? null,
      finished_at: status.finished_at,
    });
  }
  return { jobs };
}

export async function jobOutputTool(ws: JobWorkspace, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const clientId = requireCaller(ws);
  const store = new JobStore(ws.profileDir || null, ws.workspaceId, timelineOf(ws));
  const id = typeof args.job_id === "string" ? args.job_id : "";
  const record = await store.get(id);
  requireSameWorkspace(record, ws.workspaceId);
  requireSameClient(record, clientId);
  const marked = await markOrphaned(store, record);
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const maxBytes = typeof args.max_bytes === "number" ? args.max_bytes : 8192;
  const out = await store.readOutput(id, offset, maxBytes);
  return {
    job_id: marked.id,
    state: marked.state,
    output: out.output,
    next_offset: out.nextOffset,
    eof: out.eof,
    truncated: out.truncated || (await store.get(id)).truncatedOutput,
  };
}

async function waitForTerminal(store: JobStore, id: string, timeoutMs: number): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  let last = await store.get(id);
  while ((last.state === "RUNNING" || last.state === "QUEUED") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await store.get(id);
  }
  return last;
}

export async function jobCancelTool(ws: JobWorkspace, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const clientId = requireCaller(ws);
  const profileDir = ws.profileDir;
  const store = new JobStore(profileDir || null, ws.workspaceId, timelineOf(ws));
  const id = typeof args.job_id === "string" ? args.job_id : "";
  return withWorkspaceStartLock(`${path.resolve(profileDir || "")}::${ws.workspaceId}`, async () => {
    let record = await store.get(id);
    requireSameWorkspace(record, ws.workspaceId);
    requireSameClient(record, clientId);
    record = await markOrphaned(store, record);
    if (record.state !== "RUNNING" && record.state !== "QUEUED") throw new Error("JOB_NOT_RUNNING");
    const { cancelActiveJob } = await import("./job-runner.js");
    await cancelActiveJob(store, id, timelineOf(ws));
    const updated = await waitForTerminal(store, id, 15000);
    return { job_id: updated.id, state: updated.state, cancel_requested: updated.cancelRequested };
  });
}

export async function jobResumeTool(ws: JobWorkspace, args: Record<string, unknown>): Promise<{ job_id: string; state: string; poll_hint_ms: number }> {
  const clientId = requireCaller(ws);
  requireShellScope(ws);
  const profileDir = ws.profileDir;
  if (!profileDir) throw new Error("TOOL_POLICY_UNAVAILABLE：缺少 profile 目录无法恢复任务。");
  const store = new JobStore(profileDir, ws.workspaceId, timelineOf(ws));
  const id = typeof args.job_id === "string" ? args.job_id : "";
  let initial = await store.get(id);
  requireSameWorkspace(initial, ws.workspaceId);
  requireSameClient(initial, clientId);
  return withWorkspaceStartLock(`${path.resolve(profileDir)}::${ws.workspaceId}`, async () => {
    let record = await store.get(id);
    requireSameWorkspace(record, ws.workspaceId);
    requireSameClient(record, clientId);
    record = await markOrphaned(store, record);
    if (isJobActive(id) && (record.state === "RUNNING" || record.state === "QUEUED")) {
      return { job_id: record.id, state: record.state, poll_hint_ms: 5000 };
    }
    if (isJobActive(id)) {
      await waitForActiveJobSettled(id);
      record = await store.get(id);
      requireSameWorkspace(record, ws.workspaceId);
      requireSameClient(record, clientId);
      record = await markOrphaned(store, record);
    }
    if (record.state !== "INTERRUPTED" && record.state !== "TIMED_OUT" && record.state !== "FAILED" && record.state !== "CANCELLED") {
      throw new Error("JOB_NOT_RESUMABLE");
    }
    await assertUnderlyingToolEnabled(ws.profileDir, ws.workspaceId, record.spec.kind === "run_powershell" ? "run_powershell" : record.spec.kind === "git_commit" ? "git_commit" : "execute_command");
    await recoverInterruptedJobsForResume(store, record);
    const queued = await store.get(id);
    const { launchJob } = await import("./job-runner.js");
    await launchJob(store, queued, {
      timeline: timelineOf(ws),
      workspaceRoot: ws.boundary.rootReal,
      profileDir,
      workspaceId: ws.workspaceId,
    });
    const view = await store.get(id);
    return { job_id: view.id, state: view.state, poll_hint_ms: 5000 };
  });
}

async function recoverInterruptedJobsForResume(store: JobStore, record: JobRecord): Promise<void> {
  // CANCELLED 也要重置为 QUEUED：否则 resume 通过入口校验后，
  // launchJob 仍看到 CANCELLED 状态而抛 JOB_NOT_RESUMABLE（实测 189ms 自杀）。
  if (record.state !== "INTERRUPTED" && record.state !== "TIMED_OUT" && record.state !== "FAILED" && record.state !== "CANCELLED") return;
  await store.save({
    ...record,
    state: "QUEUED",
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    cancelRequested: false,
    errorCode: undefined,
    errorMessage: undefined,
    pid: null,
    history: [...record.history, {
      attempt: record.attempts,
      state: record.state,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      finishedAt: record.finishedAt ?? new Date().toISOString(),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    }],
    checkpoints: [...record.checkpoints, { at: new Date().toISOString(), message: `resume queued as attempt ${record.attempts + 1}` }].slice(-100),
  }, { allowTerminalResume: record.state === "CANCELLED" || record.state === "INTERRUPTED" || record.state === "TIMED_OUT" || record.state === "FAILED" });
}

export async function handleJobTool(
  name: string,
  args: Record<string, unknown>,
  ws: JobWorkspace,
): Promise<unknown> {
  switch (name) {
    case "start_job":
      return startJobTool(ws, args);
    case "job_status":
      return jobStatusTool(ws, args);
    case "job_output":
      return jobOutputTool(ws, args);
    case "job_list":
      return jobListTool(ws, args);
    case "job_cancel":
      return jobCancelTool(ws, args);
    case "job_resume":
      return jobResumeTool(ws, args);
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

export function jobToolsForManifest(): Array<{ name: string; area: string; risk: "READ_ONLY" | "DRY_RUN_ONLY" }> {
  return [
    { name: "start_job", area: "execution", risk: "DRY_RUN_ONLY" },
    { name: "job_status", area: "execution_evidence", risk: "READ_ONLY" },
    { name: "job_output", area: "execution_evidence", risk: "READ_ONLY" },
    { name: "job_list", area: "execution_evidence", risk: "READ_ONLY" },
    { name: "job_cancel", area: "execution", risk: "DRY_RUN_ONLY" },
    { name: "job_resume", area: "execution", risk: "DRY_RUN_ONLY" },
  ];
}

