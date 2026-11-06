import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";

const GENESIS = "0".repeat(64);
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_ORDER = ["ok", "durationMs", "path", "paths", "commandProgram", "commandSha256", "bytes", "sha256", "errorCode", "clientIdHash", "idempotencyKeyHash"];
const EVENT_KINDS = new Set(["INTENT_DURABLE", "EXECUTION_STARTED_DURABLE", "RESULT_DURABLE", "READ_RESULT"]);

interface AuditPayload {
  seq: number;
  at: string;
  workspaceId: string;
  operationId: string;
  kind: string;
  tool: string;
  prevHash: string;
  [key: string]: unknown;
}

interface AuditLine extends AuditPayload {
  length: number;
  crc32: string;
  hash: string;
}

interface LockMetadata {
  pid: number;
  token: string;
  workerId: string;
  createdAt: number;
  heartbeatAt: number;
}

interface AppendMessage {
  id: string;
  action: "append";
  file: string;
  workspaceId: string;
  operationId: string;
  kind: string;
  tool: string;
  workerId: string;
  fields: Record<string, unknown>;
}

interface VerifyMessage {
  id: string;
  action: "verify";
  file?: string;
  auditDir?: string;
}

type WorkerMessage = AppendMessage | VerifyMessage;

class AuditWorkerError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "AuditWorkerError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | null> {
  let raw: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AuditWorkerError("AUDIT_LOCK_READ_FAILED");
  }
  try {
    const value = JSON.parse(raw) as Partial<LockMetadata>;
    if (!Number.isInteger(value.pid) || typeof value.token !== "string" || typeof value.workerId !== "string"
      || !Number.isFinite(value.createdAt)) {
      throw new Error("bad_lock");
    }
    return { ...value, heartbeatAt: stat.mtimeMs } as LockMetadata;
  } catch {
    // O_EXCL makes the lock visible before the owner has finished writing its
    // initial record. Treat only that short initialization window as busy.
    if (Date.now() - stat.mtimeMs < 1_000) return null;
    throw new AuditWorkerError("AUDIT_LOCK_CORRUPT");
  }
}

async function writeLockMetadata(handle: fs.FileHandle, metadata: LockMetadata): Promise<void> {
  await handle.writeFile(JSON.stringify({ ...metadata, heartbeatAt: Date.now() }));
  await handle.sync();
}

async function acquireLock(lockPath: string, workerId: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomUUID();
  for (;;) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      const metadata: LockMetadata = {
        pid: process.pid,
        token,
        workerId,
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
      };
      await writeLockMetadata(handle, metadata);
      let heartbeatFailure: unknown = null;
      let heartbeatTask: Promise<void> | null = null;
      const heartbeat = setInterval(() => {
        if (heartbeatTask) return;
        heartbeatTask = fs.utimes(lockPath, new Date(), new Date())
          .catch((error: unknown) => { heartbeatFailure = error; })
          .finally(() => { heartbeatTask = null; });
      }, 1_000);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        if (heartbeatTask) await heartbeatTask;
        if (heartbeatFailure) throw new AuditWorkerError("AUDIT_LOCK_HEARTBEAT_FAILED");
        await handle!.close();
        const current = await readLockMetadata(lockPath).catch(() => null);
        if (current?.token === token) await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const metadata = await readLockMetadata(lockPath);
      if (!metadata) {
        if (Date.now() >= deadline) throw new AuditWorkerError("AUDIT_LOCK_TIMEOUT");
        await delay(10);
        continue;
      }
      const stale = Date.now() - metadata.heartbeatAt > LOCK_STALE_MS;
      if (stale && !isPidAlive(metadata.pid)) {
        const quarantined = `${lockPath}.stale.${randomUUID()}`;
        try {
          await fs.rename(lockPath, quarantined);
          await fs.unlink(quarantined).catch(() => undefined);
          continue;
        } catch (renameError) {
          const renameCode = (renameError as NodeJS.ErrnoException).code;
          if (renameCode === "ENOENT") continue;
        }
      }
      if (Date.now() >= deadline) throw new AuditWorkerError("AUDIT_LOCK_TIMEOUT");
      await delay(25);
    }
    if (Date.now() >= deadline) throw new AuditWorkerError("AUDIT_LOCK_TIMEOUT");
  }
}

function crc32(text: string): string {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function orderedPayload(value: Record<string, unknown>): AuditPayload {
  const payload: Record<string, unknown> = {
    seq: value.seq,
    at: value.at,
    workspaceId: value.workspaceId,
    operationId: value.operationId,
    kind: value.kind,
    tool: value.tool,
  };
  for (const key of FIELD_ORDER) {
    if (value[key] !== undefined) payload[key] = value[key];
  }
  payload.prevHash = value.prevHash;
  return payload as AuditPayload;
}

function entryHash(prevHash: string, payloadJson: string, length: number, checksum: string): string {
  return createHash("sha256").update(prevHash).update("\n").update(String(length)).update("\n").update(checksum).update("\n").update(payloadJson).digest("hex");
}

interface JournalState {
  ok: boolean;
  entries: number;
  seq: number;
  hash: string;
  brokenAt?: number;
  errorCode?: string;
  pendingOperations: Array<{ operationId: string; tool: string; state: string }>;
}

async function readAndVerifyJournal(file: string): Promise<JournalState> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, entries: 0, seq: 0, hash: GENESIS, pendingOperations: [] };
    }
    throw new AuditWorkerError("AUDIT_READ_FAILED");
  }
  if (raw.length > MAX_JOURNAL_BYTES) throw new AuditWorkerError("AUDIT_LOG_TOO_LARGE");
  if (raw.length === 0) return { ok: true, entries: 0, seq: 0, hash: GENESIS, pendingOperations: [] };
  if (raw[raw.length - 1] !== 0x0a) {
    return { ok: false, entries: 0, seq: 0, hash: GENESIS, brokenAt: 1, errorCode: "AUDIT_PENDING", pendingOperations: [] };
  }
  const lines = raw.toString("utf8").split("\n").slice(0, -1);
  let previousHash = GENESIS;
  const pending = new Map<string, { operationId: string; tool: string; state: string }>();
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lines[index]) as Record<string, unknown>;
    } catch {
      return { ok: false, entries: lines.length, seq: index, hash: previousHash, brokenAt: index + 1, errorCode: "AUDIT_PENDING", pendingOperations: [...pending.values()] };
    }
    if (typeof parsed.seq !== "number" || parsed.seq !== index + 1 || typeof parsed.at !== "string"
      || typeof parsed.workspaceId !== "string" || typeof parsed.operationId !== "string"
      || typeof parsed.kind !== "string" || !EVENT_KINDS.has(parsed.kind) || typeof parsed.tool !== "string"
      || typeof parsed.prevHash !== "string" || typeof parsed.length !== "number"
      || typeof parsed.crc32 !== "string" || typeof parsed.hash !== "string") {
      return { ok: false, entries: lines.length, seq: index, hash: previousHash, brokenAt: index + 1, errorCode: "AUDIT_PENDING", pendingOperations: [...pending.values()] };
    }
    const payload = orderedPayload(parsed);
    const payloadJson = JSON.stringify(payload);
    const length = Buffer.byteLength(payloadJson, "utf8");
    const checksum = crc32(payloadJson);
    if (parsed.prevHash !== previousHash || parsed.length !== length || parsed.crc32 !== checksum
      || parsed.hash !== entryHash(previousHash, payloadJson, length, checksum)) {
      return { ok: false, entries: lines.length, seq: index, hash: previousHash, brokenAt: index + 1, errorCode: "AUDIT_PENDING", pendingOperations: [...pending.values()] };
    }
    previousHash = parsed.hash;
    const operationId = parsed.operationId;
    if (parsed.kind === "INTENT_DURABLE") {
      pending.set(operationId, { operationId, tool: parsed.tool, state: "INTENT_DURABLE" });
    } else if (parsed.kind === "EXECUTION_STARTED_DURABLE") {
      const current = pending.get(operationId);
      if (!current) return { ok: false, entries: lines.length, seq: index + 1, hash: previousHash, brokenAt: index + 1, errorCode: "AUDIT_ORPHAN_EXECUTION", pendingOperations: [...pending.values()] };
      pending.set(operationId, { ...current, state: "EXECUTION_STARTED_DURABLE" });
    } else if (parsed.kind === "RESULT_DURABLE") {
      if (!pending.has(operationId)) return { ok: false, entries: lines.length, seq: index + 1, hash: previousHash, brokenAt: index + 1, errorCode: "AUDIT_ORPHAN_RESULT", pendingOperations: [...pending.values()] };
      pending.delete(operationId);
    }
  }
  return { ok: true, entries: lines.length, seq: lines.length, hash: previousHash, pendingOperations: [...pending.values()] };
}

async function syncDirectory(directory: string): Promise<"FILE_AND_DIRECTORY_SYNC" | "FILE_SYNC_ONLY"> {
  if (process.platform === "win32") return "FILE_SYNC_ONLY";
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
  return "FILE_AND_DIRECTORY_SYNC";
}

async function appendJournal(message: AppendMessage): Promise<Record<string, unknown>> {
  if (!WORKSPACE_ID_RE.test(message.workspaceId) || !EVENT_KINDS.has(message.kind)
    || !message.operationId || !message.tool || !path.isAbsolute(message.file)) {
    throw new AuditWorkerError("AUDIT_SCHEMA_INVALID");
  }
  await fs.mkdir(path.dirname(message.file), { recursive: true });
  const release = await acquireLock(`${message.file}.lock`, message.workerId);
  try {
    const state = await readAndVerifyJournal(message.file);
    if (!state.ok) throw new AuditWorkerError(state.errorCode ?? "AUDIT_PENDING");
    const payload: Record<string, unknown> = {
      seq: state.seq + 1,
      at: new Date().toISOString(),
      workspaceId: message.workspaceId,
      operationId: message.operationId,
      kind: message.kind,
      tool: message.tool,
    };
    for (const key of FIELD_ORDER) if (message.fields[key] !== undefined) payload[key] = message.fields[key];
    payload.prevHash = state.hash;
    const payloadJson = JSON.stringify(payload);
    const length = Buffer.byteLength(payloadJson, "utf8");
    const checksum = crc32(payloadJson);
    const hash = entryHash(state.hash, payloadJson, length, checksum);
    const existed = await fs.stat(message.file).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    const handle = await fs.open(message.file, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ ...payload, length, crc32: checksum, hash })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const durability = !existed ? await syncDirectory(path.dirname(message.file)) : (process.platform === "win32" ? "FILE_SYNC_ONLY" : "FILE_AND_DIRECTORY_SYNC");
    return { seq: state.seq + 1, hash, durability };
  } finally {
    await release();
  }
}

async function verifyOne(file: string): Promise<JournalState> {
  return readAndVerifyJournal(file);
}

async function verifyAll(auditDir: string): Promise<Record<string, unknown>> {
  let names: string[];
  try {
    names = (await fs.readdir(auditDir)).filter((name) => /^[A-Za-z0-9_-]{1,64}\.journal\.jsonl$/.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, entries: 0, workspaces: {}, pendingOperations: [] };
    return { ok: false, entries: 0, errorCode: "AUDIT_READ_FAILED", workspaces: {}, pendingOperations: [] };
  }
  const workspaces: Record<string, JournalState> = {};
  for (const name of names) workspaces[name.slice(0, -".journal.jsonl".length)] = await verifyOne(path.join(auditDir, name));
  const pendingOperations = Object.values(workspaces).flatMap((state) => state.pendingOperations);
  const broken = Object.entries(workspaces).find(([, state]) => !state.ok);
  return {
    ok: !broken,
    entries: Object.values(workspaces).reduce((total, state) => total + state.entries, 0),
    ...(broken?.[1].brokenAt ? { brokenAt: broken[1].brokenAt, workspaceId: broken[0] } : {}),
    ...(broken?.[1].errorCode ? { errorCode: broken[1].errorCode } : {}),
    workspaces,
    pendingOperations,
  };
}

let queue = Promise.resolve();
parentPort?.on("message", (message: WorkerMessage & { workerId?: string }) => {
  const task = queue.then(async () => {
    if (message.action === "append") return appendJournal(message as AppendMessage);
    if (message.file) return verifyOne(message.file);
    if (message.auditDir) return verifyAll(message.auditDir);
    throw new AuditWorkerError("AUDIT_REQUEST_INVALID");
  });
  queue = task.then(() => undefined, () => undefined);
  void task.then(
    (result) => parentPort?.postMessage({ id: message.id, ok: true, result }),
    (error: unknown) => parentPort?.postMessage({ id: message.id, ok: false, errorCode: error instanceof AuditWorkerError ? error.code : "AUDIT_UNAVAILABLE" }),
  );
});
