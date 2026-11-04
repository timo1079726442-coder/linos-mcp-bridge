import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface JobConsoleRecord {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  pid: number | null;
  exitCode: number | null;
  timedOut: boolean;
  cancelRequested: boolean;
  durationMs: number;
  outputBytes: number;
  truncatedOutput: boolean;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  progress: string;
  errorCode?: string;
  finishedAt: string | null;
  display: string;
  cwdDisplay: string;
  attemptsHistoryLength: number;
}

export interface JobConsoleOutput {
  jobId: string;
  state: string;
  output: string;
  nextOffset: number;
  eof: boolean;
  truncated: boolean;
}

const JOB_ID_RE = /^job_[0-9a-f]{24}$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SCAN_FILES = 500;

interface StoredJobRecord {
  id: string;
  state: string;
  attempts: number;
  history: unknown[];
  checkpoints: Array<{ message?: unknown }>;
  durationMs: number;
  outputBytes: number;
  truncatedOutput?: unknown;
  cancelRequested?: unknown;
  pid?: unknown;
  exitCode?: unknown;
  timedOut?: unknown;
  lastHeartbeatAt?: unknown;
  lastOutputAt?: unknown;
  errorCode?: unknown;
  finishedAt?: unknown;
  spec: Record<string, unknown>;
}

function isStoredJobRecord(value: unknown): value is StoredJobRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && JOB_ID_RE.test(record.id)
    && typeof record.state === "string"
    && typeof record.attempts === "number"
    && Array.isArray(record.history)
    && Array.isArray(record.checkpoints)
    && typeof record.durationMs === "number"
    && typeof record.outputBytes === "number"
    && typeof record.spec === "object"
    && record.spec !== null;
}

function dirFor(stateRoot: string, profileId: string, workspaceId: string): string {
  if (!PROFILE_ID_RE.test(profileId)) throw new Error("JOB_PROFILE_INVALID");
  if (!WORKSPACE_ID_RE.test(workspaceId)) throw new Error("JOB_WORKSPACE_INVALID");
  return path.join(stateRoot, "profiles", profileId, "jobs", workspaceId);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

async function readStoredRecord(dir: string, id: string): Promise<StoredJobRecord> {
  if (!JOB_ID_RE.test(id)) throw new Error("JOB_ID_INVALID");
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, `${id}.json`), "utf8");
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? "JOB_NOT_FOUND" : "JOB_STORE_UNAVAILABLE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("JOB_RECORD_CORRUPT");
  }
  if (!isStoredJobRecord(parsed)) throw new Error("JOB_RECORD_CORRUPT");
  return parsed;
}

function toConsoleRecord(record: StoredJobRecord): JobConsoleRecord {
  return {
    id: record.id,
    kind: asString(record.spec.kind) ?? "unknown",
    state: record.state,
    attempts: record.attempts,
    pid: asNumber(record.pid),
    exitCode: asNumber(record.exitCode),
    timedOut: asBoolean(record.timedOut),
    cancelRequested: asBoolean(record.cancelRequested),
    durationMs: record.durationMs,
    outputBytes: record.outputBytes,
    truncatedOutput: asBoolean(record.truncatedOutput),
    lastHeartbeatAt: asString(record.lastHeartbeatAt),
    lastOutputAt: asString(record.lastOutputAt),
    progress: record.state === "RUNNING"
      ? `running ${Math.floor(record.durationMs / 1000)}s`
      : record.state.toLowerCase(),
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
    finishedAt: asString(record.finishedAt),
    display: asString(record.spec.label) ?? asString(record.spec.kind) ?? "job",
    cwdDisplay: asString(record.spec.cwdDisplay) ?? "",
    attemptsHistoryLength: Array.isArray(record.history) ? record.history.length : 0,
  };
}

export async function listJobConsoleRecords(stateRoot: string, profileId: string, workspaceId: string, limit = 50): Promise<JobConsoleRecord[]> {
  const dir = dirFor(stateRoot, profileId, workspaceId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const bounded = entries.filter((entry) => entry.startsWith("job_") && entry.endsWith(".json")).slice(0, MAX_SCAN_FILES);
  const records: JobConsoleRecord[] = [];
  for (const entry of bounded) {
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isStoredJobRecord(parsed)) records.push(toConsoleRecord(parsed));
    } catch {
      // Skip unreadable records in list views; single-record reads report corruption.
    }
  }
  return records.sort((a, b) => b.id.localeCompare(a.id)).slice(0, Math.max(1, Math.min(100, Math.floor(limit) || 50)));
}

export async function getJobConsoleRecord(stateRoot: string, profileId: string, workspaceId: string, id: string): Promise<JobConsoleRecord> {
  return toConsoleRecord(await readStoredRecord(dirFor(stateRoot, profileId, workspaceId), id));
}

export async function readJobConsoleOutput(
  stateRoot: string,
  profileId: string,
  workspaceId: string,
  id: string,
  offset: number,
  maxBytes: number,
): Promise<JobConsoleOutput> {
  const dir = dirFor(stateRoot, profileId, workspaceId);
  const record = await readStoredRecord(dir, id).catch(() => null);
  const start = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const limit = Math.max(1, Math.min(32_768, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 8192));
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await fs.open(path.join(dir, `${id}.log`), "r");
    const stat = await handle.stat();
    if (start >= stat.size) {
      return { jobId: id, state: record?.state ?? "UNKNOWN", output: "", nextOffset: stat.size, eof: true, truncated: false };
    }
    const length = Math.min(limit, stat.size - start);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { jobId: id, state: record?.state ?? "UNKNOWN", output: buffer.toString("utf8"), nextOffset: start + length, eof: start + length >= stat.size, truncated: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { jobId: id, state: record?.state ?? "UNKNOWN", output: "", nextOffset: start, eof: true, truncated: false };
    }
    throw new Error("JOB_OUTPUT_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function requestJobCancel(stateRoot: string, profileId: string, workspaceId: string, id: string): Promise<JobConsoleRecord> {
  const dir = dirFor(stateRoot, profileId, workspaceId);
  const record = await readStoredRecord(dir, id);
  if (record.state !== "RUNNING" && record.state !== "QUEUED") {
    throw new Error("JOB_NOT_RUNNING");
  }
  const tmp = path.join(dir, `${record.id}.json.tmp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, JSON.stringify({ ...record, cancelRequested: true }, null, 2), "utf8");
  // Windows 上 rename 可能因并发读/杀软锁定报 EPERM，带退避重试，失败则清理临时文件。
  let delayMs = 20;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(tmp, path.join(dir, `${record.id}.json`));
      return toConsoleRecord({ ...record, cancelRequested: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "";
      if (!["EPERM", "EBUSY", "EACCES"].includes(code) || attempt === 7) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 400);
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => undefined);
  throw new Error("JOB_STORE_UNAVAILABLE");
}
