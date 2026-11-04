/**
 * workflow-ledger — 有边界的"工作流计划"台账。
 *
 * 定位（与对方一致，避免误解）：
 * - 它**只记录计划与自报进度**，不授予任何文件/屏幕/命令权限；
 * - 计划必须先在本机确认（workflow_commit 走本机审批门）才会进入 ACTIVE；
 * - 工作流里的 allowed_actions 只用于校验"下一步能报什么"，不会替其它工具放行；
 * - 关闭浏览器/重启 runtime 即丢失（内存台账，30 分钟有效）。
 *
 * 与对方相比多做的一点：workflow_commit 直接复用本机审批对话框，
 * 因此"本机批准"是真实动作，而不是永远返回 LOCAL_OWNER_APPROVAL_REQUIRED。
 */
import { createHash, randomBytes } from "node:crypto";

export type WorkflowPhase = "PREPARED" | "ACTIVE" | "STOPPED" | "COMPLETED" | "CANCELLED";

export const SAFE_WORKFLOW_ACTIONS = Object.freeze([
  "workspace_info", "list_directory", "read_file", "search_workspace", "search_files",
  "file_metadata", "directory_tree", "file_sha256", "compare_files", "csv_preview",
  "batch_read_files", "batch_file_status", "project_snapshot", "batch_search_patterns",
  "audit_project_structure", "generate_project_inventory", "detect_archive_candidates",
  "list_artifacts", "read_latest_report", "git_status", "git_diff", "git_recent_commits",
  "git_changed_files", "git_local_branches", "test_inventory", "execution_summary",
  "execution_output", "mcp_self_check", "capability_manifest", "shadcn_info",
  "shadcn_local_components", "shadcn_search", "shadcn_view",
] as const);

const ACTION_SET = new Set<string>(SAFE_WORKFLOW_ACTIONS);

/**
 * 可被 workflow_run_step 真正执行的只读动作。
 * 只含本地只读/检索类；不含写入、屏幕、数据源、命令，也不含 workflow_run_step 自身。
 */
export const EXECUTABLE_WORKFLOW_ACTIONS = Object.freeze([
  "workspace_info", "list_directory", "read_file", "search_workspace", "search_files",
  "file_metadata", "directory_tree", "file_sha256", "compare_files", "csv_preview",
  "batch_read_files", "batch_file_status", "project_snapshot", "batch_search_patterns",
  "audit_project_structure", "generate_project_inventory", "detect_archive_candidates",
  "list_artifacts", "read_latest_report", "git_status", "git_diff", "git_recent_commits",
  "git_changed_files", "git_local_branches", "test_inventory", "execution_summary",
  "execution_output", "mcp_self_check", "capability_manifest", "shadcn_info",
  "shadcn_local_components", "shadcn_search", "shadcn_view",
] as const);
const EXECUTABLE_SET = new Set<string>(EXECUTABLE_WORKFLOW_ACTIONS);

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 48;
const MAX_STEPS = 20;
const MAX_TOOL_CALLS = 250;
const ID = /^[0-9a-f]{32}$/;
const SAFE_NAME = /^[\p{L}\p{N} _.-]{2,100}$/u;
const SECRETISH = /(?:bearer|password|passwd|cookie|authorization|api[_-]?key|access[_-]?token|private[_-]?key|secret|sdtoken|h5st)/i;

export class WorkflowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkflowError";
  }
}

export interface WorkflowContext {
  readonly clientId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}

interface WorkflowStep {
  at: number;
  toolCalls: number;
  nextAction: string;
  summaryDigest: string;
  error: boolean;
  /** workflow_run_step 真实执行时记录动作与结果，手工进度步骤没有这两个字段。 */
  action?: string;
  ok?: boolean;
}

interface PendingStep {
  action: string;
  stepNumber: number;
}

interface WorkflowEntry {
  id: string;
  clientId: string;
  workspaceId: string;
  workspaceRoot: string;
  name: string;
  goalDigest: string;
  phase: WorkflowPhase;
  createdAt: number;
  expiresAt: number;
  allowedActions: string[];
  maxToolCalls: number;
  toolCalls: number;
  stopOnError: boolean;
  lastEvent: string;
  fingerprint: string;
  steps: WorkflowStep[];
  pending?: PendingStep;
}

const workflows = new Map<string, WorkflowEntry>();

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeLabel(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !SECRETISH.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function prune(): void {
  const now = Date.now();
  for (const entry of workflows.values()) {
    if ((entry.phase === "PREPARED" || entry.phase === "ACTIVE") && entry.expiresAt <= now) {
      entry.phase = "STOPPED";
      entry.lastEvent = "EXPIRED";
    }
  }
  if (workflows.size <= MAX_ENTRIES) return;
  for (const [id, entry] of workflows) {
    if (entry.phase !== "PREPARED" && entry.phase !== "ACTIVE") workflows.delete(id);
    if (workflows.size <= MAX_ENTRIES) break;
  }
}

function view(entry: WorkflowEntry): Record<string, unknown> {
  return {
    workflow_id: entry.id,
    preview_fingerprint: entry.fingerprint,
    name: entry.name,
    phase: entry.phase,
    created_at: new Date(entry.createdAt).toISOString(),
    expires_at: new Date(entry.expiresAt).toISOString(),
    allowed_actions: [...entry.allowedActions],
    max_tool_calls: entry.maxToolCalls,
    tool_calls_used: entry.toolCalls,
    remaining_tool_calls: Math.max(0, entry.maxToolCalls - entry.toolCalls),
    file_writes_allowed: 0,
    shell_allowed: false,
    delete_allowed: false,
    move_allowed: false,
    auto_execution: false,
    access_granted_by_workflow: false,
    usage_self_reported: true,
    last_event: entry.lastEvent,
    // 只带摘要，不回传用户填写的原文。
    steps: entry.steps.map((step) => ({
      at: new Date(step.at).toISOString(),
      tool_calls: step.toolCalls,
      next_action: step.nextAction,
      summary_digest: step.summaryDigest,
      error: step.error,
      ...(step.action ? { action: step.action } : {}),
      ...(step.ok === undefined ? {} : { ok: step.ok }),
    })),
  };
}

function owned(ctx: WorkflowContext, id: unknown): WorkflowEntry {
  prune();
  if (typeof id !== "string" || !ID.test(id)) throw new WorkflowError("INVALID_WORKFLOW_ID");
  const entry = workflows.get(id);
  if (!entry
    || entry.clientId !== ctx.clientId
    || entry.workspaceId !== ctx.workspaceId
    || entry.workspaceRoot !== ctx.workspaceRoot) {
    throw new WorkflowError("WORKFLOW_NOT_FOUND");
  }
  return entry;
}

export function prepareWorkflow(ctx: WorkflowContext, args: Record<string, unknown>): Record<string, unknown> {
  prune();
  if (workflows.size >= MAX_ENTRIES) throw new WorkflowError("WORKFLOW_CAPACITY_EXCEEDED");
  const name = args.name;
  if (typeof name !== "string" || !SAFE_NAME.test(name)) throw new WorkflowError("INVALID_WORKFLOW_NAME");
  const goal = args.goal;
  if (!safeLabel(goal, 600)) throw new WorkflowError("INVALID_WORKFLOW_GOAL");

  const requested = args.allowed_actions === undefined ? ["workspace_info", "list_directory", "read_file", "git_status"] : args.allowed_actions;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > SAFE_WORKFLOW_ACTIONS.length
    || requested.some((action) => typeof action !== "string" || !ACTION_SET.has(action))
    || new Set(requested).size !== requested.length) {
    throw new WorkflowError("UNSAFE_WORKFLOW_SCOPE");
  }
  const maxToolCalls = args.max_tool_calls === undefined ? 25 : args.max_tool_calls;
  if (typeof maxToolCalls !== "number" || !Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > MAX_TOOL_CALLS) {
    throw new WorkflowError("INVALID_WORKFLOW_BUDGET");
  }
  if (args.allow_shell === true || args.allow_delete === true || args.allow_move === true
    || (typeof args.max_file_writes === "number" && args.max_file_writes !== 0)) {
    throw new WorkflowError("UNSAFE_WORKFLOW_SCOPE");
  }

  const id = randomBytes(16).toString("hex");
  const now = Date.now();
  const entry: WorkflowEntry = {
    id,
    clientId: ctx.clientId,
    workspaceId: ctx.workspaceId,
    workspaceRoot: ctx.workspaceRoot,
    name,
    goalDigest: digest(goal),
    phase: "PREPARED",
    createdAt: now,
    expiresAt: now + TTL_MS,
    allowedActions: [...requested],
    maxToolCalls,
    toolCalls: 0,
    stopOnError: args.stop_on_error !== false,
    lastEvent: "PREPARED",
    fingerprint: "",
    steps: [],
  };
  entry.fingerprint = digest(JSON.stringify({
    id: entry.id,
    name: entry.name,
    goalDigest: entry.goalDigest,
    allowedActions: entry.allowedActions,
    maxToolCalls: entry.maxToolCalls,
    expiresAt: entry.expiresAt,
    stopOnError: entry.stopOnError,
  }));
  workflows.set(id, entry);
  return { ...view(entry), local_owner_approval_required: true };
}

export function commitWorkflow(ctx: WorkflowContext, id: unknown): Record<string, unknown> {
  const entry = owned(ctx, id);
  if (entry.phase === "PREPARED") {
    entry.phase = "ACTIVE";
    entry.lastEvent = "OWNER_ACTIVATED";
  } else if (entry.phase !== "ACTIVE") {
    throw new WorkflowError("WORKFLOW_NOT_ACTIVE");
  }
  return {
    ...view(entry),
    local_owner_approved: true,
    // 批准的是"计划"，不是文件/屏幕/命令权限。
    permission_granted: false,
  };
}

export function statusWorkflow(ctx: WorkflowContext, id: unknown, includeEvents: boolean): Record<string, unknown> {
  const entry = owned(ctx, id);
  const result = view(entry);
  if (!includeEvents) delete result.steps;
  return result;
}

export function continueWorkflow(ctx: WorkflowContext, id: unknown, args: Record<string, unknown>): Record<string, unknown> {
  const entry = owned(ctx, id);
  if (entry.phase !== "ACTIVE") throw new WorkflowError("WORKFLOW_NOT_ACTIVE");
  const summary = args.step_summary;
  if (!safeLabel(summary, 240)) throw new WorkflowError("UNSAFE_WORKFLOW_NOTES");
  const used = args.tool_calls_used === undefined ? 0 : args.tool_calls_used;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0 || used > MAX_TOOL_CALLS) {
    throw new WorkflowError("INVALID_WORKFLOW_BUDGET");
  }
  if (args.file_writes_used !== undefined && args.file_writes_used !== 0) {
    throw new WorkflowError("UNSAFE_WORKFLOW_SCOPE");
  }
  const nextAction = args.next_action;
  if (typeof nextAction !== "string" || !ACTION_SET.has(nextAction) || !entry.allowedActions.includes(nextAction)) {
    throw new WorkflowError("WORKFLOW_SCOPE_DENIED");
  }
  const observedError = args.observed_error;
  if (observedError !== undefined && observedError !== "" && !safeLabel(observedError, 100)) {
    throw new WorkflowError("UNSAFE_WORKFLOW_NOTES");
  }
  if (entry.toolCalls + used > entry.maxToolCalls) {
    entry.phase = "STOPPED";
    entry.lastEvent = "BUDGET_EXCEEDED";
    throw new WorkflowError("WORKFLOW_BUDGET_EXCEEDED");
  }
  entry.toolCalls += used;
  entry.steps.push({
    at: Date.now(),
    toolCalls: used,
    nextAction,
    summaryDigest: digest(summary),
    error: typeof observedError === "string" && observedError !== "",
  });
  if (entry.steps.length > MAX_STEPS) entry.steps.splice(0, entry.steps.length - MAX_STEPS);
  if (typeof observedError === "string" && observedError !== "" && entry.stopOnError) {
    entry.phase = "STOPPED";
    entry.lastEvent = "STOPPED_ON_ERROR";
  } else {
    entry.lastEvent = "PROGRESS_RECORDED";
  }
  return view(entry);
}

/** 只检查"能不能跑这一步"，不消耗预算（执行前的策略检查用）。 */
export function assertWorkflowStepAllowed(
  ctx: WorkflowContext,
  id: unknown,
  action: unknown,
): { stepNumber: number } {
  const entry = owned(ctx, id);
  if (entry.phase !== "ACTIVE") throw new WorkflowError("WORKFLOW_NOT_ACTIVE");
  if (typeof action !== "string" || !EXECUTABLE_SET.has(action)) {
    throw new WorkflowError("WORKFLOW_ACTION_NOT_EXECUTABLE");
  }
  if (!entry.allowedActions.includes(action)) throw new WorkflowError("WORKFLOW_SCOPE_DENIED");
  if (entry.pending) throw new WorkflowError("WORKFLOW_STEP_IN_PROGRESS");
  if (entry.toolCalls >= entry.maxToolCalls) {
    entry.phase = "STOPPED";
    entry.lastEvent = "BUDGET_EXCEEDED";
    throw new WorkflowError("WORKFLOW_BUDGET_EXCEEDED");
  }
  return { stepNumber: entry.toolCalls + 1 };
}

/** 占一步预算；成功后必须调用 finishWorkflowStep 落账。 */
export function reserveWorkflowStep(
  ctx: WorkflowContext,
  id: unknown,
  action: unknown,
): { stepNumber: number; remainingToolCalls: number } {
  const { stepNumber } = assertWorkflowStepAllowed(ctx, id, action);
  const entry = owned(ctx, id);
  entry.toolCalls += 1;
  entry.pending = { action: action as string, stepNumber };
  entry.lastEvent = "STEP_STARTED";
  return { stepNumber, remainingToolCalls: entry.maxToolCalls - entry.toolCalls };
}

/** 记录这一步的真实结果；失败且 stop_on_error 时停止计划。 */
export function finishWorkflowStep(
  ctx: WorkflowContext,
  id: unknown,
  action: string,
  success: boolean,
  errorCode?: string,
): Record<string, unknown> {
  const entry = owned(ctx, id);
  if (!entry.pending || entry.pending.action !== action) throw new WorkflowError("WORKFLOW_STEP_NOT_PENDING");
  delete entry.pending;
  entry.steps.push({
    at: Date.now(),
    toolCalls: 1,
    nextAction: action,
    summaryDigest: digest(`${action}:${success ? "ok" : errorCode ?? "error"}`),
    error: !success,
    action,
    ok: success,
  });
  if (entry.steps.length > MAX_STEPS) entry.steps.splice(0, entry.steps.length - MAX_STEPS);
  if (!success && entry.stopOnError) {
    entry.phase = "STOPPED";
    entry.lastEvent = "STEP_FAILED";
  } else {
    entry.lastEvent = success ? "STEP_EXECUTED" : "STEP_FAILED";
  }
  return view(entry);
}

export function cancelWorkflow(ctx: WorkflowContext, id: unknown): Record<string, unknown> {  const entry = owned(ctx, id);
  if (entry.phase === "CANCELLED") return view(entry);
  if (entry.phase !== "PREPARED" && entry.phase !== "ACTIVE") throw new WorkflowError("WORKFLOW_NOT_CANCELLABLE");
  entry.phase = "CANCELLED";
  entry.lastEvent = "CANCELLED";
  return view(entry);
}

/** 本机审批对话框用：只给计划元数据，不含 goal 原文。 */
export function describeWorkflowForApproval(ctx: WorkflowContext, id: unknown): { summary: string; details: string[] } {
  const entry = owned(ctx, id);
  return {
    summary: `激活工作流「${entry.name}」· ${entry.allowedActions.length} 类只读动作 · 预算 ${entry.maxToolCalls} 次`,
    details: [
      `工作流：${entry.name}（${entry.id}）`,
      `阶段：${entry.phase} · 到期 ${new Date(entry.expiresAt).toISOString()}`,
      `允许动作：${entry.allowedActions.join(", ")}`,
      `预算：${entry.maxToolCalls} 次工具调用；文件写入/删除/移动/命令均为 0 或关闭`,
      "批准只表示本机同意开始记录这个计划的进度，不会自动执行工具或授予其它权限。",
    ],
  };
}

/** 测试用。 */
export function __resetWorkflowsForTest(): void {
  workflows.clear();
}
