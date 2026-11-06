import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { redactString } from "./redaction.js";
import { assertAllowedCommand, commandSpawnEnv, tokenizeCommand } from "./command-tools.js";
import { McpSecurityBoundary } from "./security-boundary.js";
import { gitCommit } from "./command-tools.js";
import { JobStore, type JobRecord } from "./job-store.js";
import type { TimelineSink } from "./job-timeline.js";

export interface ActiveJobController {
  child: ChildProcess | null;
  cancelRequested: boolean;
  profileDir: string;
  workspaceId: string;
  /** 本次 attempt 真正结束时 resolve；用于避免复用"正在清理"的旧控制器。 */
  settled: Promise<void>;
  attemptId: string;
  auditOperationId?: string;
  settle: () => void;
}

const activeJobs = new Map<string, ActiveJobController>();

/** 统一收尾：移除控制器并让等待者（resume/launch）立即恢复。 */
function finishActive(id: string): void {
  const controller = activeJobs.get(id);
  activeJobs.delete(id);
  controller?.settle();
}

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
}

export function countActiveJobs(profileDir: string, workspaceId: string): number {
  const target = process.platform === "win32" ? path.resolve(profileDir).toLowerCase() : path.resolve(profileDir);
  return [...activeJobs.values()].filter((controller) => {
    const candidate = process.platform === "win32" ? path.resolve(controller.profileDir).toLowerCase() : path.resolve(controller.profileDir);
    return candidate === target && controller.workspaceId === workspaceId;
  }).length;
}

async function terminateChild(child: ChildProcess, pid: number | undefined): Promise<void> {
  try {
    if (process.platform === "win32") {
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/PID", String(pid ?? child.pid ?? 0), "/T", "/F"], () => resolve());
      });
    } else if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("JOB_JOIN_TIMEOUT")), ms);
      promise.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitForActiveJobSettled(jobId: string, timeoutMs = 15_000): Promise<void> {
  const controller = activeJobs.get(jobId);
  if (!controller) return;
  await withTimeout(controller.settled, timeoutMs);
}

export interface LaunchOptions {
  workspaceRoot: string;
  profileDir: string;
  workspaceId: string;
  /** 诊断用；只有测试会传，生产入口不传也不会写文件。 */
  timeline?: TimelineSink;
}

/**
 * 结构校验，而不是数 argv 段数。
 * 旧实现写死 `argv.length < 9`，但 resolvePowerShellArgv 只生成 6 段（user）
 * 或 8 段（constrained）—— 导致 start_job 的 run_powershell 100% COMMAND_INVALID。
 * 这里改成校验"谁在跑、跑什么"，与段数无关。
 */
export function revalidateArgv(kind: JobRecord["spec"]["kind"], argv: string[]): void {
  if (kind === "execute_command") {
    assertAllowedCommand(tokenizeCommand(argv.join(" ")));
    return;
  }
  if (kind === "run_powershell") {
    if (!Array.isArray(argv) || argv.length < 3) throw new Error("COMMAND_INVALID");
    if (!argv.includes("-Command")) throw new Error("COMMAND_INVALID");
    const exeName = String(argv[0] ?? "").toLowerCase();
    if (!/(^|[\\/])(powershell|pwsh)(\.exe)?$/.test(exeName)) throw new Error("COMMAND_INVALID");
    const script = argv[argv.length - 1];
    if (typeof script !== "string" || !script.trim() || script.length > 8_000) throw new Error("COMMAND_INVALID");
    return;
  }
  if (kind === "git_commit") return;
  throw new Error("JOB_ACTION_UNSUPPORTED");
}

async function revalidateCwd(boundary: McpSecurityBoundary, record: JobRecord): Promise<string> {
  const resolved = await boundary.resolveWritePath(record.spec.cwdInput || ".");
  const stat = await (await import("node:fs/promises")).stat(resolved.absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("CWD_NOT_DIRECTORY");
  if (path.resolve(resolved.absolute) !== path.resolve(record.spec.cwdAbsolute)) throw new Error("JOB_CWD_CHANGED");
  return resolved.absolute;
}

export async function recoverInterruptedJobs(store: JobStore, now = Date.now(), staleAfterMs = 30_000): Promise<number> {
  const records = await store.list(200);
  let marked = 0;
  for (const record of records) {
    if ((record.state === "RUNNING" || record.state === "QUEUED") && !activeJobs.has(record.id)) {
      const heartbeatAgeMs = record.lastHeartbeatAt ? now - Date.parse(record.lastHeartbeatAt) : Number.POSITIVE_INFINITY;
      const createdAgeMs = now - Date.parse(record.createdAt);
      const createdIsStale = Number.isFinite(createdAgeMs) && createdAgeMs > staleAfterMs;
      const heartbeatIsStale = !Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > staleAfterMs;
      // 两个条件都要满足才算孤儿：刚创建、还没写第一条心跳的任务不能被当成"已中断"。
      if (createdIsStale && heartbeatIsStale) {
        const next: JobRecord = {
          ...record,
          state: "INTERRUPTED",
          finishedAt: record.finishedAt ?? new Date(now).toISOString(),
          errorCode: "JOB_INTERRUPTED",
          checkpoints: [...record.checkpoints, { at: new Date(now).toISOString(), message: "interrupted by runtime restart or lost worker" }].slice(-100),
        };
        await store.save(next);
        marked += 1;
      }
    }
  }
  return marked;
}

export async function cancelActiveJob(store: JobStore, id: string, timeline?: TimelineSink): Promise<JobRecord> {
  const controller = activeJobs.get(id);
  const record = await store.get(id);
  if (!controller || (record.state !== "RUNNING" && record.state !== "QUEUED")) throw new Error("JOB_NOT_RUNNING");
  const emit = timeline ?? (() => undefined);
  const pid = controller.child?.pid ?? record.pid ?? null;
  store.noteAttempt(id, controller.attemptId);
  emit({ job_id: id, attempt_id: controller.attemptId, event: "CANCEL_REQUESTED", pid });
  // 先把"取消"写进记录并落成终态：进程被 kill 后退出码非 0，若等 runner 回写会把 CANCELLED 覆盖成 FAILED。
  const next: JobRecord = {
    ...record,
    cancelRequested: true,
    state: "CANCELLED",
    errorCode: "JOB_CANCELLED",
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - Date.parse(record.startedAt ?? record.createdAt)),
  };
  await store.save(next);
  emit({ job_id: id, attempt_id: controller.attemptId, event: "CANCEL_PERSISTED", pid });
  controller.cancelRequested = true;
  const child = controller.child;
  if (child && !child.killed) {
    emit({ job_id: id, attempt_id: controller.attemptId, event: "CANCEL_SIGNAL_SENT", pid });
    await terminateChild(child, pid ?? undefined);
  }
  try {
    await withTimeout(controller.settled, 15_000);
  } catch {
    throw new Error("JOB_CANCEL_SETTLE_TIMEOUT");
  }
  return store.get(id);
}

export async function launchJob(
  store: JobStore,
  record: JobRecord,
  options: LaunchOptions,
): Promise<JobRecord> {
  // 旧 attempt 可能"终态已写、控制器尚未清理"：不能静默返回，必须等它真正结束后再决定。
  const attemptId = `attempt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const emit = options.timeline ?? (() => undefined);
  emit({ job_id: record.id, attempt_id: attemptId, event: "LAUNCH_RESERVED", pid: null });
  const existing = activeJobs.get(record.id);
  if (existing) {
    await Promise.race([existing.settled, new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
    const stillThere = activeJobs.get(record.id);
    if (stillThere && stillThere === existing) {
      const snapshot = await store.get(record.id).catch(() => null);
      if (snapshot?.state === "RUNNING") {
        emit({ job_id: record.id, attempt_id: attemptId, event: "LAUNCH_REJECTED" });
        throw new Error("JOB_ALREADY_ACTIVE");
      }
    }
  }
  // 必须先读最新记录：resume 传入的 record 可能是终态快照。
  let current = await store.get(record.id);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const controller: ActiveJobController = { child: null, cancelRequested: current.cancelRequested, profileDir: options.profileDir, workspaceId: options.workspaceId, settled, settle, attemptId, ...(current.spec.auditOperationId ? { auditOperationId: current.spec.auditOperationId } : {}) };
  activeJobs.set(record.id, controller);
  if (current.state !== "QUEUED" && current.state !== "INTERRUPTED" && current.state !== "FAILED" && current.state !== "TIMED_OUT" && current.state !== "CANCELLED") {
    finishActive(record.id);
    throw new Error("JOB_NOT_RESUMABLE");
  }
  void runJob(store, record.id, options, controller)
    .catch(async (error: unknown) => {
      try {
        const latest = await store.get(record.id);
        if (latest.state === "RUNNING" || latest.state === "QUEUED") {
          await store.save({
            ...latest,
            state: "FAILED",
            finishedAt: new Date().toISOString(),
            errorCode: "JOB_RUNNER_FAILED",
            errorMessage: redactString(error instanceof Error ? error.message : String(error)).slice(0, 500),
            checkpoints: [...latest.checkpoints, { at: new Date().toISOString(), message: "failed to launch worker" }].slice(-100),
          });
        }
      } catch {
        // Keep the persisted record for startup recovery; do not turn a failed error-write into an unhandled rejection.
      }
    })
    .finally(async () => {
      if (controller.auditOperationId) {
        try {
          const finalRecord = await store.get(record.id);
          const { appendJobAudit } = await import("./job-audit.js");
          await appendJobAudit(options.profileDir, finalRecord, controller.auditOperationId);
          await store.save({ ...finalRecord, auditState: "PERSISTED" });
        } catch {
          const latest = await store.get(record.id).catch(() => null);
          if (latest) await store.save({ ...latest, auditState: "PENDING" }).catch(() => undefined);
        }
      }
      finishActive(record.id);
      emit({ job_id: record.id, attempt_id: attemptId, event: "CONTROLLER_SETTLED" });
    });
  return store.get(record.id);
}

async function runJob(
  store: JobStore,
  id: string,
  options: LaunchOptions,
  controller: ActiveJobController,
): Promise<void> {
  const startedWall = Date.now();
  const emitRun = options.timeline ?? (() => undefined);
  const attemptId = controller.attemptId;
  store.noteAttempt(id, attemptId);
  let record: JobRecord;
  try {
    record = await store.get(id);
  } catch {
    return;
  }
  record = await store.save({
    ...record,
    attempts: record.attempts + 1,
    state: "RUNNING",
    durationMs: 0,
    startedAt: record.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    timedOut: false,
    cancelRequested: controller.cancelRequested,
    errorCode: undefined,
    errorMessage: undefined,
    lastHeartbeatAt: new Date().toISOString(),
    checkpoints: [...record.checkpoints, { at: new Date().toISOString(), message: `attempt ${record.attempts + 1} started` }].slice(-100),
  });
  let heartbeatStopped = false;
  let heartbeatTask: Promise<void> | null = null;
  const heartbeat = setInterval(() => {
    if (heartbeatStopped || heartbeatTask) return;
    heartbeatTask = (async () => {
      try {
        const latest = await store.get(id);
        // Never resurrect a terminal record: a stale heartbeat copy must not
        // overwrite the final save (read-modify-write race under load).
        if (latest.state !== "RUNNING" || latest.finishedAt) return;
        await store.save({
          ...latest,
          durationMs: Date.now() - startedWall,
          lastHeartbeatAt: new Date().toISOString(),
        });
      } catch {
        /* best effort */
      }
    })().finally(() => { heartbeatTask = null; });
  }, 5000);
  let child: ChildProcess | null = null;
  let exitPromise: Promise<number | null> | null = null;
  let drainOutput: (() => Promise<void>) | null = null;
  let exitObserved = false;
  try {
    const boundary = await McpSecurityBoundary.create(options.workspaceRoot, {
      aclPath: options.profileDir ? path.join(options.profileDir, "folder-acl.json") : null,
      workspaceId: options.workspaceId,
      profileDir: options.profileDir || null,
    });
    revalidateArgv(record.spec.kind, record.spec.argv);
    const cwdAbsolute = await revalidateCwd(boundary, record);
    if (record.spec.kind === "git_commit") {
      const committed = await import("./command-tools.js").then((mod) => mod.gitCommit(boundary, {
        message: record.spec.message ?? "",
        allowEmpty: record.spec.allowEmpty === true,
      } as { message?: unknown; allowEmpty?: unknown }));
      const latest = await store.get(id);
      const durationMs = Date.now() - startedWall;
      await store.save({
        ...latest,
        state: "SUCCEEDED",
        exitCode: 0,
        durationMs,
        finishedAt: new Date().toISOString(),
        resultSummary: `git ${committed.commit} ${committed.branch}`,
        checkpoints: [...latest.checkpoints, { at: new Date().toISOString(), message: "finished SUCCEEDED" }].slice(-100),
        history: [...latest.history, {
          attempt: latest.attempts,
          state: "SUCCEEDED",
          exitCode: 0,
          durationMs,
          finishedAt: new Date().toISOString(),
        }],
      });
      return;
    }
    child = spawn(record.spec.argv[0]!, record.spec.argv.slice(1), {
      cwd: cwdAbsolute,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: commandSpawnEnv(),
    });
    controller.child = child;
    // 关键：spawn 后立刻注册退出监听，避免短命进程在 await store.save() 期间退出而丢事件。
    exitPromise = waitForExit(child);
    emitRun({ job_id: id, attempt_id: attemptId, event: "WAIT_EXIT_ATTACHED", pid: child.pid ?? null });
    const pid = child.pid ?? null;
    record = await store.save({ ...record, pid, durationMs: 0 });
    if (controller.cancelRequested) {
      await terminateChild(child, pid ?? undefined);
    }
    const timeout = setTimeout(() => {
      void (async () => {
        const latest = await store.get(id).catch(() => null);
        if (!latest || latest.state !== "RUNNING") return;
        await store.save({ ...latest, timedOut: true, cancelRequested: true });
        await terminateChild(child!, pid ?? undefined);
      })();
    }, record.spec.timeoutMs);
    // 行缓冲：只把"完整行"写进日志，残行留到下一次 data 再拼。
    // 之前直接写 chunk，PowerShell 的 stdout 被拆成 "tick 17" + "tick 18\r\n"
    // 这类边界时，日志里就会出现 "tick 17tick 18" 的粘连（实测每次必现 4–5 处）。
    // 同时把 CRLF 统一成 LF，避免行尾混用。
    let carry = "";
    const flushLines = async (final: boolean): Promise<void> => {
      if (!carry) return;
      const normalized = carry.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const parts = normalized.split("\n");
      carry = final ? "" : (parts.pop() ?? "");
      const complete = parts.length > 0 ? `${parts.join("\n")}\n` : "";
      if (!complete) return;
      await store.appendOutput(id, complete).catch(() => undefined);
    };
    const append = async (chunk: Buffer, stream: "out" | "err"): Promise<void> => {
      const text = stream === "err" ? `[stderr] ${chunk.toString("utf8")}` : chunk.toString("utf8");
      carry += text;
      await flushLines(false);
    };
    let outputQueue: Promise<void> = Promise.resolve();
    let outputDrained = false;
    const queueAppend = (chunk: Buffer, stream: "out" | "err"): void => {
      outputQueue = outputQueue.then(() => append(chunk, stream)).catch(() => undefined);
    };
    drainOutput = async () => {
      if (outputDrained) return;
      await outputQueue;
      await flushLines(true);
      outputDrained = true;
      emitRun({ job_id: id, attempt_id: attemptId, event: "OUTPUT_DRAINED" });
    };
    child.stdout?.on("data", (chunk: Buffer) => queueAppend(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => queueAppend(chunk, "err"));
    let exitCode: number | null = null;
    let finished = false;
    const cancelWatcher = (async (): Promise<"cancelled" | "changed"> => {
      while (!finished) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (finished) return "changed";
        let latest: JobRecord | null = null;
        try {
          latest = await store.get(id);
        } catch {
          return "changed";
        }
        if (!latest || latest.state !== "RUNNING") return "changed";
        if (latest.cancelRequested) {
          controller.cancelRequested = true;
          await terminateChild(child, pid ?? undefined);
          return "cancelled";
        }
      }
      return "changed";
    })();
    try {
      const outcome = await Promise.race([
        withTimeout(exitPromise!, record.spec.timeoutMs + 15_000).then((code) => ({ kind: "exit" as const, code })),
        cancelWatcher.then((kind) => ({ kind, code: null as number | null })),
      ]);
      finished = true;
      if (outcome.kind === "exit") {
        exitCode = outcome.code;
      } else {
        // A terminal store update may win the race before the child emits `close`.
        // Do not claim PROCESS_EXITED or settle the controller until close is observed.
        try {
          exitCode = await withTimeout(exitPromise!, 15_000);
        } catch {
          await terminateChild(child, pid ?? undefined);
          exitCode = await withTimeout(exitPromise!, 15_000);
        }
      }
      exitObserved = true;
      emitRun({ job_id: id, attempt_id: attemptId, event: "PROCESS_EXITED", pid: controller.child?.pid ?? null, exit_code: exitCode });
      await drainOutput?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "JOB_JOIN_TIMEOUT") {
        await terminateChild(child!, pid ?? undefined);
        try {
          exitCode = await withTimeout(exitPromise!, 15_000);
          exitObserved = true;
          emitRun({ job_id: id, attempt_id: attemptId, event: "PROCESS_EXITED", pid: controller.child?.pid ?? null, exit_code: exitCode });
        } catch {
          /* retain the original join timeout; controller cleanup still drains known output writes */
        }
      }
      await store.save({ ...(await store.get(id)), errorCode: "JOB_JOIN_TIMEOUT", errorMessage: "worker join timeout" });
      throw error;
    } finally {
      finished = true;
      clearTimeout(timeout);
      await drainOutput?.();
    }
    const latest = await store.get(id);
    // 取消是终态：runner 不得用退出码把它改写成 FAILED。
    if (latest.state === "CANCELLED") {
      return;
    }
    const durationMs = Date.now() - startedWall;
    const cancelled = latest.cancelRequested === true;
    const timedOut = latest.timedOut === true;
    const outcome = cancelled
      ? { state: "CANCELLED" as const, errorCode: "JOB_CANCELLED" as const }
      : timedOut
        ? { state: "TIMED_OUT" as const, errorCode: "JOB_TIMED_OUT" as const }
        : exitCode === 0
          ? { state: "SUCCEEDED" as const, errorCode: undefined }
          : { state: "FAILED" as const, errorCode: "JOB_EXIT_NONZERO" as const };
    await store.save({
      ...latest,
      state: outcome.state,
      exitCode,
      durationMs,
      finishedAt: new Date().toISOString(),
      pid: latest.pid,
      errorCode: outcome.errorCode,
      resultSummary: `${record.spec.display} → ${outcome.state} exit=${exitCode ?? "null"}`,
      checkpoints: [...latest.checkpoints, { at: new Date().toISOString(), message: `finished ${outcome.state}` }].slice(-100),
      history: [...latest.history, {
        attempt: latest.attempts,
        state: outcome.state,
        exitCode,
        durationMs,
        finishedAt: new Date().toISOString(),
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      }],
    });
    emitRun({ job_id: id, attempt_id: attemptId, event: "TERMINAL_PERSISTED", pid: latest.pid ?? null, exit_code: exitCode });
  } catch (error) {
    const latest = await store.get(id).catch(() => null);
    if (latest && (latest.state === "RUNNING" || latest.state === "QUEUED")) {
      await store.save({
        ...latest,
        state: "FAILED",
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedWall,
        errorCode: "JOB_RUNNER_FAILED",
        errorMessage: redactString(error instanceof Error ? error.message : String(error)).slice(0, 500),
        checkpoints: [...latest.checkpoints, { at: new Date().toISOString(), message: "worker failed" }].slice(-100),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    heartbeatStopped = true;
    clearInterval(heartbeat);
    if (heartbeatTask) await heartbeatTask;
    const latest = await store.get(id).catch(() => null);
    if (latest && latest.state === "RUNNING") {
      await store.save({
        ...latest,
        durationMs: Date.now() - startedWall,
        lastHeartbeatAt: latest.lastHeartbeatAt ?? new Date().toISOString(),
      }).catch(() => undefined);
    }
  }
}
