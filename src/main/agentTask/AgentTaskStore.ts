import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  AtomicJsonFileError,
  readAtomicJson,
  withAtomicJsonFileLock,
  writeAtomicJson,
} from "../storage/AtomicJsonFile.js";

export type AgentTaskStatus =
  | "BLOCKED"
  | "QUEUED"
  | "RUNNING"
  | "CANCEL_REQUESTED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN"
  | "INDETERMINATE";

export type AgentTaskBlockReason = "NO_EXECUTOR" | "DISPATCH_DISABLED";

/** Client-selectable opaque IDs and specification digest only. */
export interface SubmitAgentTaskRequest {
  idempotencyKey: string;
  agentId: string;
  worktreeId: string;
  specificationSha256: string;
}

/** Trusted Supervisor resolution; never constructed from client-supplied identity fields. */
export interface ResolvedAgentTaskBinding {
  profileId: string;
  workspaceId: string;
  agentId: string;
  /** Null means no authorized local executor is available for this selection. */
  authorizedExecutorId: string | null;
  branch: string;
  worktreeId: string;
  /** Relative path from trusted Supervisor state; never an absolute host path. */
  worktreePath: string;
  /** Actual verified Git HEAD at the selected worktree when resolved. */
  baseCommit: string;
  /** Canonical roots are used transiently for binding; raw paths are not persisted or returned. */
  workspaceRoot: string;
  worktreeRoot: string;
}

/**
 * Implemented only by trusted Supervisor composition. It must resolve the active
 * Profile/Workspace and verify agent/executor authorization plus the selected
 * Git worktree root, branch, and HEAD/base commit before returning a binding.
 */
export interface TrustedAgentTaskBindingResolver {
  resolveBinding(selection: Pick<SubmitAgentTaskRequest, "agentId" | "worktreeId">): Promise<ResolvedAgentTaskBinding | null>;
}

export interface ActiveAgentTaskScope {
  profileId: string;
  workspaceId: string;
}

/** Trusted Supervisor query-time identity source; it must report the current active scope. */
export interface TrustedAgentTaskScopeResolver {
  resolveActiveScope(): Promise<ActiveAgentTaskScope | null>;
}

export interface AgentTaskBinding {
  workspaceId: string;
  profileId: string;
  agentId: string;
  authorizedExecutorId: string | null;
  branch: string;
  worktreeId: string;
  worktreePath: string;
  workspaceRootSha256: string;
  worktreeRootSha256: string;
  baseCommit: string;
}

export interface AgentTaskEvidenceEvent {
  evidenceId: string;
  taskId: string;
  attemptId: null;
  sequence: 1;
  kind: "TASK_BLOCKED";
  source: "CONTROL_PLANE";
  occurredAt: string;
  reasonCode: AgentTaskBlockReason;
}

export interface AgentTaskRecord {
  schemaVersion: 1;
  taskId: string;
  /** Scoped hash of trusted profile/workspace identity plus caller idempotency key. */
  idempotencyScopeDigest: string;
  requestDigest: string;
  binding: AgentTaskBinding;
  specificationSha256: string;
  /** v1 persists only blocked tasks; no input can create a success state. */
  status: "BLOCKED";
  revision: 1;
  reasonCode: AgentTaskBlockReason;
  attemptId: null;
  executorId: null;
  createdAt: string;
  updatedAt: string;
  startedAt: null;
  finishedAt: null;
  result: null;
  evidence: [AgentTaskEvidenceEvent];
}

export class AgentTaskStoreError extends Error {
  constructor(readonly code:
    | "TASK_IDEMPOTENCY_CONFLICT"
    | "TASK_NOT_FOUND"
    | "TASK_STORE_CORRUPT"
    | "TASK_STORE_FULL"
    | "TASK_STORE_PATH_INVALID"
    | "TASK_STORE_SCOPE_MISMATCH"
    | "TASK_STORE_UNAVAILABLE") {
    super(code);
    this.name = "AgentTaskStoreError";
  }
}

export interface AgentTaskRepository {
  createOrGetBlocked(record: AgentTaskRecord): Promise<{ record: AgentTaskRecord; created: boolean }>;
  get(taskId: string): Promise<AgentTaskRecord | null>;
}

interface AgentTaskDocument {
  schemaVersion: 1;
  profileId: string;
  records: AgentTaskRecord[];
}

const MAX_TASK_RECORDS = 1_000;
const MAX_STORE_BYTES = 4 * 1024 * 1024;

/**
 * File-backed task metadata repository. Its path is derived under the trusted
 * Supervisor state root and one profile. AtomicJsonFile rejects a symlink at
 * the leaf and uses exclusive same-directory temp files + rename; its mutex is
 * process-local only. Parent ACL/reparse-point safety and single-writer process
 * ownership must be guaranteed by the trusted Supervisor composition.
 */
export class FileAgentTaskRepository implements AgentTaskRepository {
  private readonly filePath: string;

  constructor(stateRoot: string, private readonly profileId: string) {
    if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot) || !isSafeOpaqueId(profileId)) {
      throw new AgentTaskStoreError("TASK_STORE_PATH_INVALID");
    }
    this.filePath = path.join(path.resolve(stateRoot), "profiles", profileId, "agent-tasks.json");
  }

  async createOrGetBlocked(record: AgentTaskRecord): Promise<{ record: AgentTaskRecord; created: boolean }> {
    if (!isBlockedRecord(record)) throw new AgentTaskStoreError("TASK_STORE_CORRUPT");
    if (record.binding.profileId !== this.profileId) throw new AgentTaskStoreError("TASK_STORE_SCOPE_MISMATCH");
    return withAtomicJsonFileLock(this.filePath, async () => {
      const document = await this.readDocument();
      const prior = document.records.find((item) => item.idempotencyScopeDigest === record.idempotencyScopeDigest);
      if (prior) {
        if (prior.requestDigest !== record.requestDigest) throw new AgentTaskStoreError("TASK_IDEMPOTENCY_CONFLICT");
        return { record: cloneRecord(prior), created: false };
      }
      if (document.records.some((item) => item.taskId === record.taskId)) {
        throw new AgentTaskStoreError("TASK_STORE_CORRUPT");
      }
      if (document.records.length >= MAX_TASK_RECORDS) throw new AgentTaskStoreError("TASK_STORE_FULL");
      const next = { schemaVersion: 1 as const, profileId: this.profileId, records: [...document.records, cloneRecord(record)] };
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAX_STORE_BYTES) {
        throw new AgentTaskStoreError("TASK_STORE_FULL");
      }
      await this.writeDocument(next);
      return { record: cloneRecord(record), created: true };
    });
  }

  async get(taskId: string): Promise<AgentTaskRecord | null> {
    return withAtomicJsonFileLock(this.filePath, async () => {
      const document = await this.readDocument();
      const record = document.records.find((item) => item.taskId === taskId);
      return record ? cloneRecord(record) : null;
    });
  }

  private async readDocument(): Promise<AgentTaskDocument> {
    let raw: unknown;
    try {
      raw = await readAtomicJson<unknown>(this.filePath, MAX_STORE_BYTES);
    } catch (error) {
      if (error instanceof AtomicJsonFileError) {
        throw new AgentTaskStoreError(error.code === "JSON_STORE_TOO_LARGE" ? "TASK_STORE_FULL" : "TASK_STORE_CORRUPT");
      }
      throw new AgentTaskStoreError("TASK_STORE_UNAVAILABLE");
    }
    if (raw === undefined) return { schemaVersion: 1, profileId: this.profileId, records: [] };
    if (!isDocument(raw, this.profileId)) throw new AgentTaskStoreError("TASK_STORE_CORRUPT");
    return raw;
  }

  private async writeDocument(document: AgentTaskDocument): Promise<void> {
    try {
      await writeAtomicJson(this.filePath, document);
    } catch {
      throw new AgentTaskStoreError("TASK_STORE_UNAVAILABLE");
    }
  }
}

function isDocument(value: unknown, expectedProfileId: string): value is AgentTaskDocument {
  if (!isObject(value) || !hasExactKeys(value, ["schemaVersion", "profileId", "records"])
    || value.schemaVersion !== 1 || value.profileId !== expectedProfileId
    || !Array.isArray(value.records) || value.records.length > MAX_TASK_RECORDS) return false;
  const taskIds = new Set<string>();
  const idempotencyDigests = new Set<string>();
  for (const record of value.records) {
    if (!isBlockedRecord(record) || record.binding.profileId !== expectedProfileId) return false;
    if (taskIds.has(record.taskId) || idempotencyDigests.has(record.idempotencyScopeDigest)) return false;
    taskIds.add(record.taskId);
    idempotencyDigests.add(record.idempotencyScopeDigest);
  }
  return true;
}

function isBlockedRecord(value: unknown): value is AgentTaskRecord {
  if (!isObject(value) || !hasExactKeys(value, [
    "schemaVersion", "taskId", "idempotencyScopeDigest", "requestDigest", "binding", "specificationSha256",
    "status", "revision", "reasonCode", "attemptId", "executorId", "createdAt", "updatedAt",
    "startedAt", "finishedAt", "result", "evidence",
  ]) || value.schemaVersion !== 1 || value.status !== "BLOCKED" || value.revision !== 1
    || (value.reasonCode !== "NO_EXECUTOR" && value.reasonCode !== "DISPATCH_DISABLED")
    || value.attemptId !== null || value.executorId !== null || value.startedAt !== null
    || value.finishedAt !== null || value.result !== null) return false;
  if (!isSafeOpaqueId(value.taskId) || !isSha256(value.idempotencyScopeDigest) || !isSha256(value.requestDigest)
    || !isSha256(value.specificationSha256) || !isIsoDate(value.createdAt) || value.updatedAt !== value.createdAt) return false;
  if (!isObject(value.binding) || !hasExactKeys(value.binding, [
    "workspaceId", "profileId", "agentId", "authorizedExecutorId", "branch", "worktreeId", "worktreePath",
    "workspaceRootSha256", "worktreeRootSha256", "baseCommit",
  ])
    || !isSafeOpaqueId(value.binding.workspaceId)
    || !isSafeOpaqueId(value.binding.profileId)
    || !isSafeOpaqueId(value.binding.agentId)
    || (value.binding.authorizedExecutorId !== null && !isSafeOpaqueId(value.binding.authorizedExecutorId))
    || !isSafeBranch(value.binding.branch)
    || !isSafeOpaqueId(value.binding.worktreeId)
    || !isSafeRelativePath(value.binding.worktreePath)
    || !isSha256(value.binding.workspaceRootSha256)
    || !isSha256(value.binding.worktreeRootSha256)
    || !isGitCommit(value.binding.baseCommit)) return false;
  const normalizedBinding = {
    workspaceId: value.binding.workspaceId,
    profileId: value.binding.profileId,
    agentId: value.binding.agentId,
    authorizedExecutorId: value.binding.authorizedExecutorId,
    branch: value.binding.branch,
    worktreeId: value.binding.worktreeId,
    worktreePath: value.binding.worktreePath,
    workspaceRootSha256: value.binding.workspaceRootSha256,
    worktreeRootSha256: value.binding.worktreeRootSha256,
    baseCommit: value.binding.baseCommit.toLowerCase(),
  };
  if (sha256(JSON.stringify({ binding: normalizedBinding, specificationSha256: value.specificationSha256 })) !== value.requestDigest) return false;
  if (!Array.isArray(value.evidence) || value.evidence.length !== 1) return false;
  const event = value.evidence[0];
  return isObject(event) && hasExactKeys(event, [
    "evidenceId", "taskId", "attemptId", "sequence", "kind", "source", "occurredAt", "reasonCode",
  ])
    && event.evidenceId === `${value.taskId}.blocked.1`
    && event.taskId === value.taskId
    && event.attemptId === null
    && event.sequence === 1
    && event.kind === "TASK_BLOCKED"
    && event.source === "CONTROL_PLANE"
    && event.occurredAt === value.createdAt
    && event.reasonCode === value.reasonCode;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isGitCommit(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value);
}

function isSafeBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneRecord(record: AgentTaskRecord): AgentTaskRecord {
  return {
    schemaVersion: record.schemaVersion,
    taskId: record.taskId,
    idempotencyScopeDigest: record.idempotencyScopeDigest,
    requestDigest: record.requestDigest,
    binding: { ...record.binding },
    specificationSha256: record.specificationSha256,
    status: record.status,
    revision: record.revision,
    reasonCode: record.reasonCode,
    attemptId: record.attemptId,
    executorId: record.executorId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    result: record.result,
    evidence: [{ ...record.evidence[0] }],
  };
}
