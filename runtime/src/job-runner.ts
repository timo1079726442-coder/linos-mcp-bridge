import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { redactString } from "./redaction.js";
import { assertAllowedCommand, commandSpawnEnv, tokenizeCommand } from "./command-tools.js";
import { McpSecurityBoundary } from "./security-boundary.js";
import { gitCommit } from "./command-tools.js";
import { JobStore, type JobRecord } from "./job-store.js";

export interface ActiveJobController {
  child: ChildProcess | null;
  cancelRequested: boolean;
  profileDir: string;
}

const activeJobs = new Map<string, ActiveJobController>();

export function isJobActive(jobId: string): boolean {
  return activeJobs.has(jobId);
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

export interface LaunchOptions {
  workspaceRoot: string;
  profileDir: string;
  workspaceId: string;
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
      if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > staleAfterMs || createdAgeMs > staleAfterMs) {
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

export async function cancelActiveJob(store: JobStore, id: string): Promise<JobRecord> {
  const controller = activeJobs.get(id);
  const record = await store.get(id);
  if (!controller || (record.state !== "RUNNING" && record.state !== "QUEUED")) throw new Error("JOB_NOT_RUNNING");
  const next: JobRecord = { ...record, cancelRequested: true };
  await store.save(next);
  controller.cancelRequested = true;
  const child = controller.child;
  const pid = next.pid ?? undefined;
  if (child && !child.killed) {
    await terminateChild(child, pid);
  }
  return store.get(id);
}

export async function launchJob(
  store: JobStore,
  record: JobRecord,
  options: LaunchOptions,
): Promise<JobRecord> {
  if (activeJobs.has(record.id)) return store.get(record.id);
  // 必须先读最新记录：resume 传入的 record 是 CANCELLED 快照（cancelRequested=true），
  // 用它初始化控制器会让恢复出来的 attempt 一启动就自杀（实测 189ms）。
  let current = await store.get(record.id);
  const controller: ActiveJobController = { child: null, cancelRequested: current.cancelRequested, profileDir: options.profileDir };
  activeJobs.set(record.id, controller);
  if (current.state !== "QUEUED" && current.state !== "INTERRUPTED" && current.state !== "FAILED" && current.state !== "TIMED_OUT" && current.state !== "CANCELLED") {
    activeJobs.delete(record.id);
    throw new Error("JOB_NOT_RESUMABLE");
  }
  void runJob(store, record.id, options, controller).catch(async (error: unknown) => {
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
    } finally {
      activeJobs.delete(record.id);
    }
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
  let record: JobRecord;
  try {
    record = await store.get(id);
  } catch {
    activeJobs.delete(id);
    return;
  }
  record = await store.save({
    ...record,
    attempts: record.attempts + 1,
    state: "RUNNING",
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
  const heartbeat = setInterval(() => {
    void (async () => {
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
    })();
  }, 5000);
  let child: ChildProcess | null = null;
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
    child.stdout?.on("data", (chunk: Buffer) => void append(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => void append(chunk, "err"));
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
        withTimeout(waitForExit(child), record.spec.timeoutMs + 15_000).then((code) => ({ kind: "exit" as const, code })),
        cancelWatcher.then((kind) => ({ kind, code: null as number | null })),
      ]);
      finished = true;
      exitCode = outcome.kind === "exit" ? outcome.code : null;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg === "JOB_JOIN_TIMEOUT") {
        await terminateChild(child, pid ?? undefined);
      }
      await store.save({ ...(await store.get(id)), errorCode: "JOB_JOIN_TIMEOUT", errorMessage: "worker join timeout" });
      throw error;
    } finally {
      finished = true;
      clearTimeout(timeout);
      // 进程结束后把残行连同换行一起写出去，避免最后一行粘连或丢换行。
      await flushLines(true);
    }
    const latest = await store.get(id);
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
    clearInterval(heartbeat);
    const latest = await store.get(id).catch(() => null);
    if (latest && latest.state === "RUNNING") {
      await store.save({
        ...latest,
        durationMs: Date.now() - startedWall,
        lastHeartbeatAt: latest.lastHeartbeatAt ?? new Date().toISOString(),
      }).catch(() => undefined);
    }
    activeJobs.delete(id);
  }
}
