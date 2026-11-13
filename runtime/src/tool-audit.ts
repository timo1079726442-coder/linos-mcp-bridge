import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { redactString } from "./redaction.js";

export type ToolAuditKind = "INTENT_DURABLE" | "EXECUTION_STARTED_DURABLE" | "RESULT_DURABLE" | "READ_RESULT";

export interface ToolAuditInput {
  tool: string;
  ok?: boolean;
  durationMs?: number;
  path?: string;
  paths?: string[];
  command?: string;
  bytes?: number;
  sha256?: string;
  errorCode?: string;
  clientId?: string;
  idempotencyKey?: string;
  workspaceRoot?: string;
}

export interface AuditReceipt {
  operationId: string;
  seq: number;
  hash: string;
  durability: "FILE_AND_DIRECTORY_SYNC" | "FILE_SYNC_ONLY";
}

export class AuditJournalError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "AuditJournalError";
  }
}

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  /** 仅非预期异常时携带，便于定位（已截断，不含文件内容）。 */
  errorMessage?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_PENDING_REQUESTS = 1024;
const AUDIT_TIMEOUT_MS = 5_000;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKER_ID = randomUUID();
const pending = new Map<string, PendingRequest>();
let worker: Worker | null = null;

function safeWorkspaceId(workspaceId: string): string {
  if (!WORKSPACE_ID_RE.test(workspaceId)) throw new AuditJournalError("AUDIT_WORKSPACE_INVALID");
  return workspaceId;
}

export function toolAuditPath(profileDir: string, workspaceId = "default"): string {
  if (!profileDir) throw new AuditJournalError("AUDIT_DIR_UNAVAILABLE");
  return path.join(profileDir, "audit", `${safeWorkspaceId(workspaceId)}.journal.jsonl`);
}

function sanitizePath(value: string, workspaceRoot?: string): string {
  const redacted = redactString(value).replace(/\\/g, "/");
  const root = workspaceRoot ? path.resolve(workspaceRoot).replace(/\\/g, "/").replace(/\/$/, "") : "";
  const resolved = path.isAbsolute(value) ? path.resolve(value).replace(/\\/g, "/") : "";
  if (root && resolved && (resolved === root || resolved.startsWith(`${root}/`))) {
    return resolved === root ? "." : path.relative(root, resolved).replace(/\\/g, "/").slice(0, 512);
  }
  return redacted
    .replace(/^([A-Za-z]:)?\/?Users\/[^/]+/i, "$1/Users/<user>")
    .replace(/^\/home\/[^/]+/i, "/home/<user>")
    .slice(0, 512);
}

function sanitizeInput(input: ToolAuditInput): Record<string, unknown> {
  const tool = typeof input.tool === "string" ? input.tool.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100) : "unknown";
  if (!tool) throw new AuditJournalError("AUDIT_SCHEMA_INVALID");
  const fields: Record<string, unknown> = { tool };
  if (typeof input.ok === "boolean") fields.ok = input.ok;
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) fields.durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(input.durationMs)));
  if (typeof input.path === "string") fields.path = sanitizePath(input.path, input.workspaceRoot);
  if (Array.isArray(input.paths)) fields.paths = input.paths.slice(0, 25).filter((item): item is string => typeof item === "string").map((item) => sanitizePath(item, input.workspaceRoot));
  if (typeof input.command === "string") {
    const command = input.command.trim();
    const executable = command.split(/\s+/, 1)[0]?.replace(/^["']|["']$/g, "") ?? "";
    if (executable) fields.commandProgram = path.basename(executable).slice(0, 80);
    fields.commandSha256 = createHash("sha256").update(command).digest("hex");
  }
  if (typeof input.bytes === "number" && Number.isSafeInteger(input.bytes) && input.bytes >= 0) fields.bytes = input.bytes;
  if (typeof input.sha256 === "string" && /^[0-9a-f]{64}$/i.test(input.sha256)) fields.sha256 = input.sha256.toLowerCase();
  if (typeof input.errorCode === "string") fields.errorCode = redactString(input.errorCode).slice(0, 120);
  if (typeof input.clientId === "string") fields.clientIdHash = createHash("sha256").update(input.clientId).digest("hex");
  if (typeof input.idempotencyKey === "string" && input.idempotencyKey.length > 0) {
    fields.idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
  }
  return fields;
}

function failAllPending(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function disposeWorker(target: Worker, error: Error): void {
  if (worker === target) worker = null;
  failAllPending(error);
  void target.terminate().catch(() => undefined);
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL("./audit-journal-worker.js", import.meta.url));
  created.unref();
  created.on("message", (response: WorkerResponse) => {
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (pending.size === 0) created.unref();
    if (response.ok) request.resolve(response.result);
    else request.reject(new AuditJournalError(response.errorCode ?? "AUDIT_UNAVAILABLE", [response.errorCode ?? "AUDIT_UNAVAILABLE", response.errorMessage].filter(Boolean).join(": ")));
  });
  created.on("error", (error: Error) => disposeWorker(created, new AuditJournalError("AUDIT_WORKER_FAILED", error.message)));
  created.on("exit", (code: number) => {
    if (worker === created) disposeWorker(created, new AuditJournalError("AUDIT_WORKER_EXITED", `worker exit ${code}`));
  });
  worker = created;
  return created;
}

async function requestWorker<T>(message: Record<string, unknown>, timeoutMs = AUDIT_TIMEOUT_MS): Promise<T> {
  if (pending.size >= MAX_PENDING_REQUESTS) throw new AuditJournalError("AUDIT_QUEUE_FULL");
  const target = ensureWorker();
  const id = randomUUID();
  target.ref();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      reject(new AuditJournalError("AUDIT_TIMEOUT"));
      if (pending.size === 0) target.unref();
    }, timeoutMs);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    try {
      target.postMessage({ ...message, id, workerId: WORKER_ID });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      if (pending.size === 0) target.unref();
      reject(new AuditJournalError("AUDIT_WORKER_FAILED", error instanceof Error ? error.message : "worker post failed"));
    }
  });
}

export async function appendToolAuditEvent(
  profileDir: string,
  workspaceId: string,
  kind: ToolAuditKind,
  input: ToolAuditInput,
  operationId: string = randomUUID(),
): Promise<AuditReceipt> {
  const targetWorkspaceId = safeWorkspaceId(workspaceId);
  const file = toolAuditPath(profileDir, targetWorkspaceId);
  const fields = sanitizeInput(input);
  const tool = String(fields.tool);
  delete fields.tool;
  return requestWorker<AuditReceipt>({
    action: "append",
    file,
    workspaceId: targetWorkspaceId,
    operationId,
    kind,
    tool,
    fields,
  });
}

export function appendToolAuditIntent(
  profileDir: string,
  workspaceId: string,
  input: ToolAuditInput,
  operationId: string = randomUUID(),
): Promise<AuditReceipt> {
  return appendToolAuditEvent(profileDir, workspaceId, "INTENT_DURABLE", input, operationId);
}

export function appendToolAuditExecutionStarted(
  profileDir: string,
  workspaceId: string,
  input: ToolAuditInput,
  operationId: string,
): Promise<AuditReceipt> {
  return appendToolAuditEvent(profileDir, workspaceId, "EXECUTION_STARTED_DURABLE", input, operationId);
}

export function appendToolAuditResult(
  profileDir: string,
  workspaceId: string,
  input: ToolAuditInput,
  operationId: string,
): Promise<AuditReceipt> {
  return appendToolAuditEvent(profileDir, workspaceId, "RESULT_DURABLE", input, operationId);
}

export function appendReadOnlyToolAudit(
  profileDir: string,
  workspaceId: string,
  input: ToolAuditInput,
  operationId: string = randomUUID(),
): Promise<AuditReceipt> {
  return appendToolAuditEvent(profileDir, workspaceId, "READ_RESULT", input, operationId);
}

/** Backward-compatible audit append for non-MCP internal metadata. */
export function appendToolAudit(profileDir: string, input: ToolAuditInput): Promise<AuditReceipt> {
  return appendReadOnlyToolAudit(profileDir, "default", input);
}

async function verifyLegacyToolAudit(profileDir: string): Promise<Record<string, unknown>> {
  const file = path.join(profileDir, "audit", "tool-calls.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, entries: 0 };
    return { ok: false, entries: 0, errorCode: "LEGACY_AUDIT_READ_FAILED" };
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let previousHash = "0".repeat(64);
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(lines[index]) as Record<string, unknown>; }
    catch { return { ok: false, entries: lines.length, brokenAt: index + 1, errorCode: "LEGACY_AUDIT_CORRUPT" }; }
    const hash = parsed.hash;
    const entry = { ...parsed };
    delete entry.hash;
    if (typeof hash !== "string" || entry.prevHash !== previousHash || entry.seq !== index + 1
      || createHash("sha256").update(previousHash).update(JSON.stringify(entry)).digest("hex") !== hash) {
      return { ok: false, entries: lines.length, brokenAt: index + 1, errorCode: "LEGACY_AUDIT_CORRUPT" };
    }
    previousHash = hash;
  }
  if (raw.length > 0 && !raw.endsWith("\n")) {
    return { ok: false, entries: lines.length, brokenAt: lines.length, errorCode: "LEGACY_AUDIT_TORN_TAIL" };
  }
  return { ok: true, entries: lines.length };
}

/**
 * 当前平台实际能达到的持久化等级（与 audit-journal-worker 的 append 回执一致）：
 * - win32：目录项 `fsync` 不可用（Node 返回 EPERM），只有文件级 sync → FILE_SYNC_ONLY；
 * - 其他平台：文件 + 目录项都同步 → FILE_AND_DIRECTORY_SYNC。
 * 该字段对外公布，避免把降级能力宣传成完整持久化。
 */
export function auditDurability(): "FILE_AND_DIRECTORY_SYNC" | "FILE_SYNC_ONLY" {
  return process.platform === "win32" ? "FILE_SYNC_ONLY" : "FILE_AND_DIRECTORY_SYNC";
}

export async function verifyToolAudit(profileDir: string, workspaceId?: string): Promise<Record<string, unknown>> {
  const auditDir = path.join(profileDir, "audit");
  const current = workspaceId
    ? await requestWorker<Record<string, unknown>>({ action: "verify", file: toolAuditPath(profileDir, workspaceId) })
    : await requestWorker<Record<string, unknown>>({ action: "verify", auditDir });
  const legacy = await verifyLegacyToolAudit(profileDir);
  const currentPending = Array.isArray(current.pendingOperations) ? current.pendingOperations : [];
  const legacyBroken = legacy.ok === false;
  return {
    ...current,
    ok: current.ok === true && legacy.ok === true,
    entries: Number(current.entries ?? 0) + Number(legacy.entries ?? 0),
    pendingOperations: currentPending,
    legacy,
    /** 实测能力，不是声称能力：Windows 上为 FILE_SYNC_ONLY。 */
    durability: auditDurability(),
    platform: process.platform,
    ...(current.ok === true && legacyBroken ? { brokenAt: legacy.brokenAt, errorCode: legacy.errorCode } : {}),
  };
}
