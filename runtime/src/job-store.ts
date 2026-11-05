import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { redactString } from "./redaction.js";
import { writeAtomicJson } from "./atomic-write.js";

export type JobKind = "execute_command" | "run_powershell" | "git_commit";
export type JobState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "INTERRUPTED";

export interface JobSpec {
  kind: JobKind;
  label: string;
  argv: string[];
  display: string;
  cwdInput: string;
  cwdAbsolute: string;
  cwdDisplay: string;
  timeoutMs: number;
  clientId: string;
  workspaceId: string;
  idempotencyKey?: string;
  mode?: "user" | "constrained";
  message?: string;
  allowEmpty?: boolean;
}

export interface JobCheckpoint {
  at: string;
  message: string;
}

export interface JobAttemptOutcome {
  attempt: number;
  state: Exclude<JobState, "QUEUED" | "RUNNING">;
  exitCode: number | null;
  durationMs: number;
  finishedAt: string;
  errorCode?: string;
}

export interface JobRecord {
  id: string;
  spec: JobSpec;
  state: JobState;
  attempts: number;
  history: JobAttemptOutcome[];
  pid: number | null;
  runnerPid: number | null;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelRequested: boolean;
  errorCode?: string;
  errorMessage?: string;
  outputBytes: number;
  truncatedOutput: boolean;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  checkpoints: JobCheckpoint[];
  resultSummary?: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobStartInput {
  kind: JobKind;
  label: string;
  clientId: string;
  workspaceId: string;
  argv: string[];
  display: string;
  cwdInput: string;
  cwdAbsolute: string;
  cwdDisplay: string;
  timeoutMs: number;
  idempotencyKey?: string;
  mode?: "user" | "constrained";
  message?: string;
  allowEmpty?: boolean;
}

export interface JobStatus {
  job_id: string;
  kind: JobKind;
  state: JobState;
  attempts: number;
  pid: number | null;
  exit_code: number | null;
  timed_out: boolean;
  cancel_requested: boolean;
  duration_ms: number;
  output_bytes: number;
  truncated_output: boolean;
  last_heartbeat_at: string | null;
  last_output_at: string | null;
  progress: string;
  error_code?: string;
  finished_at: string | null;
}

const JOB_ID_RE = /^job_[0-9a-f]{24}$/;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_JOB_FILES_SCANNED = 500;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is JobRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && JOB_ID_RE.test(record.id)
    && typeof record.state === "string"
    && typeof record.attempts === "number"
    && Array.isArray(record.history)
    && typeof record.durationMs === "number";
}

function safeWorkspaceId(workspaceId: string): string {
  return WORKSPACE_ID_RE.test(workspaceId) ? workspaceId : "default";
}

function jobFile(dir: string, id: string): string {
  if (!JOB_ID_RE.test(id)) throw new Error("JOB_ID_INVALID");
  return path.join(dir, `${id}.json`);
}

function logFile(dir: string, id: string): string {
  if (!JOB_ID_RE.test(id)) throw new Error("JOB_ID_INVALID");
  return path.join(dir, `${id}.log`);
}

export class JobStore {
  private readonly directory: string | null;
  private readonly workspaceId: string;
  /** 诊断用（仅测试注入）；生产为 undefined，不写任何文件。 */
  private readonly timeline?: (event: import("./job-timeline.js").TimelineEvent) => void;

  constructor(
    profileDir: string | null,
    workspaceId: string,
    timeline?: (event: import("./job-timeline.js").TimelineEvent) => void,
  ) {
    this.workspaceId = safeWorkspaceId(workspaceId);
    this.directory = profileDir ? path.join(profileDir, "jobs", this.workspaceId) : null;
    this.timeline = timeline;
  }

  private requireDir(): string {
    if (!this.directory) throw new Error("JOB_STORE_UNAVAILABLE");
    return this.directory;
  }

  private async listFiles(): Promise<string[]> {
    const dir = this.requireDir();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.startsWith("job_") && entry.endsWith(".json")).slice(0, MAX_JOB_FILES_SCANNED);
  }

  async create(input: JobStartInput): Promise<JobRecord> {
    const dir = this.requireDir();
    const id = `job_${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();
    const record: JobRecord = {
      id,
      spec: {
        kind: input.kind,
        label: input.label.slice(0, 120),
        argv: [...input.argv],
        display: redactString(input.display).slice(0, 4000),
        cwdInput: input.cwdInput,
        cwdAbsolute: input.cwdAbsolute,
        cwdDisplay: input.cwdDisplay,
        timeoutMs: input.timeoutMs,
        clientId: input.clientId,
        workspaceId: this.workspaceId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.message ? { message: input.message.slice(0, 500) } : {}),
        ...(input.allowEmpty !== undefined ? { allowEmpty: input.allowEmpty } : {}),
      },
      state: "QUEUED",
      attempts: 0,
      history: [],
      pid: null,
      runnerPid: process.pid,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      cancelRequested: false,
      outputBytes: 0,
      truncatedOutput: false,
      lastHeartbeatAt: null,
      lastOutputAt: null,
      checkpoints: [{ at: now, message: "queued" }],
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    await writeAtomicJson(jobFile(dir, id), record);
    return record;
  }

  async get(id: string): Promise<JobRecord> {
    const raw = await fs.readFile(jobFile(this.requireDir(), id), "utf8").catch(() => {
      throw new Error("JOB_NOT_FOUND");
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("JOB_RECORD_CORRUPT");
    }
    if (!isRecord(parsed)) throw new Error("JOB_RECORD_CORRUPT");
    return parsed;
  }

  async list(limit = 50): Promise<JobRecord[]> {
    const files = await this.listFiles();
    const records: JobRecord[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.requireDir(), file), "utf8")) as unknown;
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // Skip unreadable records here; get() reports corruption for a single job.
      }
    }
    return records
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit) || 50)));
  }

  async save(record: JobRecord): Promise<JobRecord> {
    const attemptId = String(record.attempts);
    const base = { job_id: record.id, attempt_id: attemptId };
    this.timeline?.({ ...base, event: "STORE_SAVE_BEGIN" });
    try {
      // 取消是终态：并发写入时（runner 回写 vs cancel 落盘）不允许被覆盖回 RUNNING/FAILED。
      const existing = await this.get(record.id).catch(() => null);
      const effective = existing?.state === "CANCELLED" && record.state !== "CANCELLED"
        ? { ...record, state: "CANCELLED" as const, cancelRequested: true }
        : record;
      const next: JobRecord = { ...effective, updatedAt: new Date().toISOString() };
      this.timeline?.({ ...base, event: "STORE_ATOMIC_WRITE_BEGIN" });
      await writeAtomicJson(jobFile(this.requireDir(), record.id), next);
      this.timeline?.({ ...base, event: "STORE_ATOMIC_WRITE_END" });
      this.timeline?.({ ...base, event: "STORE_SAVE_END" });
      return next;
    } catch (error) {
      this.timeline?.({ ...base, event: "STORE_SAVE_ERROR" });
      throw error;
    }
  }

  async findActiveByIdempotencyKey(input: { clientId: string; idempotencyKey: string }): Promise<JobRecord | null> {
    const records = await this.list(200);
    const match = records.find((record) =>
      record.spec.clientId === input.clientId
      && record.spec.workspaceId === this.workspaceId
      && record.spec.idempotencyKey === input.idempotencyKey
      && (record.state === "QUEUED" || record.state === "RUNNING"));
    return match ?? null;
  }

  async findRecentTerminalByIdempotencyKey(input: { clientId: string; idempotencyKey: string; withinMs: number }): Promise<JobRecord | null> {
    const records = await this.list(200);
    const cutoff = Date.now() - input.withinMs;
    const match = records.find((record) =>
      record.spec.clientId === input.clientId
      && record.spec.workspaceId === this.workspaceId
      && record.spec.idempotencyKey === input.idempotencyKey
      && (record.state === "SUCCEEDED" || record.state === "FAILED" || record.state === "CANCELLED" || record.state === "TIMED_OUT")
      && Date.parse(record.finishedAt ?? "") >= cutoff);
    return match ?? null;
  }

  async appendOutput(id: string, chunk: string): Promise<{ outputBytes: number; truncated: boolean }> {
    const file = logFile(this.requireDir(), id);
    const text = redactString(chunk);
    if (!text) {
      const record = await this.get(id);
      return { outputBytes: record.outputBytes, truncated: record.truncatedOutput };
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, text, "utf8");
    let stat = await fs.stat(file);
    let truncated = false;
    if (stat.size > MAX_LOG_BYTES + 64 * 1024) {
      const handle = await fs.open(file, "r+");
      try {
        const tail = Buffer.alloc(MAX_LOG_BYTES);
        await handle.read(tail, 0, MAX_LOG_BYTES, Math.max(0, stat.size - LOG_TAIL_BYTES));
        await handle.truncate(0);
        await handle.write(tail, 0, MAX_LOG_BYTES, 0);
      } finally {
        await handle.close();
      }
      stat = await fs.stat(file);
      truncated = true;
    }
    const record = await this.get(id);
    const next: JobRecord = {
      ...record,
      outputBytes: stat.size,
      truncatedOutput: record.truncatedOutput || truncated,
      lastOutputAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.save(next);
    return { outputBytes: next.outputBytes, truncated: next.truncatedOutput };
  }

  async readOutput(id: string, offset: number, maxBytes: number): Promise<{ output: string; nextOffset: number; eof: boolean; truncated: boolean }> {
    const start = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
    const limit = Math.max(1, Math.min(32_768, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 8192));
    const file = logFile(this.requireDir(), id);
    let handle;
    try {
      handle = await fs.open(file, "r");
    } catch {
      const missing = await this.get(id).catch(() => null);
      return { output: "", nextOffset: start, eof: true, truncated: missing?.truncatedOutput ?? false };
    }
    try {
      const stat = await handle.stat();
      if (start >= stat.size) {
        return { output: "", nextOffset: stat.size, eof: true, truncated: false };
      }
      const length = Math.min(limit, stat.size - start);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return { output: buffer.toString("utf8"), nextOffset: start + length, eof: start + length >= stat.size, truncated: false };
    } finally {
      await handle.close();
    }
  }

  toStatus(record: JobRecord): JobStatus {
    const progress = record.state === "RUNNING"
      ? `running ${Math.floor(record.durationMs / 1000)}s · ${record.outputBytes} bytes logged`
      : record.state.toLowerCase();
    return {
      job_id: record.id,
      kind: record.spec.kind,
      state: record.state,
      attempts: record.attempts,
      pid: record.pid,
      exit_code: record.exitCode,
      timed_out: record.timedOut,
      cancel_requested: record.cancelRequested,
      duration_ms: record.durationMs,
      output_bytes: record.outputBytes,
      truncated_output: record.truncatedOutput,
      last_heartbeat_at: record.lastHeartbeatAt,
      last_output_at: record.lastOutputAt,
      progress,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      finished_at: record.finishedAt,
    };
  }
}
