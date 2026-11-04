import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  AgentTaskStoreError,
  type ActiveAgentTaskScope,
  type AgentTaskBlockReason,
  type AgentTaskBinding,
  type AgentTaskRecord,
  type AgentTaskRepository,
  type AgentTaskStatus,
  type ResolvedAgentTaskBinding,
  type SubmitAgentTaskRequest,
  type TrustedAgentTaskBindingResolver,
  type TrustedAgentTaskScopeResolver,
} from "./AgentTaskStore.js";

/** Dispatch is deliberately a compile-time and runtime constant until a trusted executor is reviewed. */
export const AGENT_DISPATCH_ENABLED = false as const;

export type AgentTaskServiceErrorCode =
  | "INVALID_ARGUMENT"
  | "TRUSTED_BINDING_UNAVAILABLE"
  | "BINDING_MISMATCH"
  | "TASK_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "TASK_NOT_ACTIVE"
  | "TASK_STORE_CORRUPT"
  | "TASK_STORE_UNAVAILABLE"
  | "TASK_STORE_FULL";

export class AgentTaskServiceError extends Error {
  constructor(readonly code: AgentTaskServiceErrorCode) {
    super(code);
    this.name = "AgentTaskServiceError";
  }
}

export interface AgentTaskServiceOptions {
  repository: AgentTaskRepository;
  /** Must be supplied by trusted Supervisor composition; never by MCP/Renderer/client input. */
  bindingResolver?: TrustedAgentTaskBindingResolver;
  /** Re-reads the active identity on every query to prevent cross-Workspace disclosure. */
  activeScopeResolver?: TrustedAgentTaskScopeResolver;
  now?: () => number;
  createTaskId?: () => string;
}

export interface AgentTaskPublicBinding {
  profileId: string;
  workspaceId: string;
  agentId: string;
  authorizedExecutorId: string | null;
  branch: string;
  worktreeId: string;
  /** Workspace-relative path only. */
  worktreePath: string;
  baseCommit: string;
}

export interface AgentTaskStatusSnapshot {
  taskId: string;
  status: AgentTaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  binding: AgentTaskPublicBinding;
  attemptId: null;
  /** Actual assigned/running executor. v1 never dispatches, so this remains null. */
  executorId: null;
  reasonCode: AgentTaskBlockReason;
}

export interface AgentTaskCancelResult {
  taskId: string;
  accepted: false;
  status: "BLOCKED";
  reasonCode: "TASK_NOT_ACTIVE";
}

export interface AgentTaskResult {
  taskId: string;
  available: false;
  status: "BLOCKED";
  reasonCode: AgentTaskBlockReason;
  result: null;
}

/**
 * Provider-neutral task contract backed by a control-plane-owned repository.
 * v1 intentionally has no dispatch or completion ingestion method: without a
 * trusted binding and an approved local executor, tasks cannot become active.
 */
export class AgentTaskService {
  readonly agentDispatchEnabled = AGENT_DISPATCH_ENABLED;
  private readonly now: () => number;
  private readonly createTaskId: () => string;

  constructor(private readonly options: AgentTaskServiceOptions) {
    if (!options || !options.repository) throw new AgentTaskServiceError("TASK_STORE_UNAVAILABLE");
    this.now = options.now ?? Date.now;
    this.createTaskId = options.createTaskId ?? (() => `task_${randomUUID()}`);
  }

  /**
   * Client may select only opaque agent/worktree IDs and a specification digest.
   * A trusted Supervisor resolver derives and verifies every identity and Git
   * binding. Missing/failed resolution is rejected without creating a record.
   */
  async submit(request: SubmitAgentTaskRequest): Promise<{ task: AgentTaskStatusSnapshot; replayed: boolean }> {
    const safeRequest = validateSubmitRequest(request);
    const resolver = this.options.bindingResolver;
    if (!resolver) throw new AgentTaskServiceError("TRUSTED_BINDING_UNAVAILABLE");

    let resolved: ResolvedAgentTaskBinding | null;
    try {
      resolved = await resolver.resolveBinding(safeRequest.selection);
    } catch {
      throw new AgentTaskServiceError("TRUSTED_BINDING_UNAVAILABLE");
    }
    if (!resolved) throw new AgentTaskServiceError("TRUSTED_BINDING_UNAVAILABLE");

    const binding = normalizeResolvedBinding(resolved, safeRequest.selection);
    const activeScope = await this.resolveActiveScope("TRUSTED_BINDING_UNAVAILABLE");
    if (activeScope.profileId !== binding.profileId || activeScope.workspaceId !== binding.workspaceId) {
      throw new AgentTaskServiceError("BINDING_MISMATCH");
    }
    const reasonCode: AgentTaskBlockReason = binding.authorizedExecutorId === null
      ? "NO_EXECUTOR"
      : "DISPATCH_DISABLED";
    // Keep the gate explicit and non-configurable. An authorized executor may
    // be resolved for context, but no process/task is launched by this module.
    if (AGENT_DISPATCH_ENABLED) throw new AgentTaskServiceError("TASK_STORE_UNAVAILABLE");

    const timestamp = this.timestamp();
    const taskId = this.createTaskId();
    if (!isSafeTaskId(taskId)) throw new AgentTaskServiceError("INVALID_ARGUMENT");
    const requestDigest = sha256(JSON.stringify({ binding, specificationSha256: safeRequest.specificationSha256 }));
    const idempotencyScopeDigest = sha256(`${binding.profileId}\u0000${binding.workspaceId}\u0000${safeRequest.idempotencyKey}`);
    const record: AgentTaskRecord = {
      schemaVersion: 1,
      taskId,
      idempotencyScopeDigest,
      requestDigest,
      binding,
      specificationSha256: safeRequest.specificationSha256,
      status: "BLOCKED",
      revision: 1,
      reasonCode,
      attemptId: null,
      executorId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      result: null,
      evidence: [{
        evidenceId: `${taskId}.blocked.1`,
        taskId,
        attemptId: null,
        sequence: 1,
        kind: "TASK_BLOCKED",
        source: "CONTROL_PLANE",
        occurredAt: timestamp,
        reasonCode,
      }],
    };

    try {
      const created = await this.options.repository.createOrGetBlocked(record);
      return { task: toStatusSnapshot(created.record), replayed: !created.created };
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async status(taskId: string): Promise<AgentTaskStatusSnapshot> {
    const record = await this.getRecord(taskId);
    return toStatusSnapshot(record);
  }

  /** A blocked task has no running process to cancel; do not report it cancelled. */
  async cancel(taskId: string): Promise<AgentTaskCancelResult> {
    const record = await this.getRecord(taskId);
    return {
      taskId: record.taskId,
      accepted: false,
      status: "BLOCKED",
      reasonCode: "TASK_NOT_ACTIVE",
    };
  }

  /** No result exists for a blocked task. Caller-supplied completion values are never accepted. */
  async result(taskId: string): Promise<AgentTaskResult> {
    const record = await this.getRecord(taskId);
    return {
      taskId: record.taskId,
      available: false,
      status: "BLOCKED",
      reasonCode: record.reasonCode,
      result: null,
    };
  }

  /** Returns only the bounded control-plane event manifest, never raw task or process output. */
  async evidence(taskId: string): Promise<AgentTaskRecord["evidence"]> {
    const record = await this.getRecord(taskId);
    const event = record.evidence[0];
    return [{
      evidenceId: event.evidenceId,
      taskId: event.taskId,
      attemptId: event.attemptId,
      sequence: event.sequence,
      kind: event.kind,
      source: event.source,
      occurredAt: event.occurredAt,
      reasonCode: event.reasonCode,
    }];
  }

  private async getRecord(taskId: string): Promise<AgentTaskRecord> {
    if (!isSafeTaskId(taskId)) throw new AgentTaskServiceError("INVALID_ARGUMENT");
    const activeScope = await this.resolveActiveScope("TASK_NOT_FOUND");
    try {
      const record = await this.options.repository.get(taskId);
      // Missing and out-of-scope tasks have the same error to prevent existence disclosure.
      if (!record || record.binding.profileId !== activeScope.profileId
        || record.binding.workspaceId !== activeScope.workspaceId) {
        throw new AgentTaskServiceError("TASK_NOT_FOUND");
      }
      return record;
    } catch (error) {
      if (error instanceof AgentTaskServiceError) throw error;
      throw mapStoreError(error);
    }
  }

  private async resolveActiveScope(
    missingCode: "TRUSTED_BINDING_UNAVAILABLE" | "TASK_NOT_FOUND",
  ): Promise<ActiveAgentTaskScope> {
    const resolver = this.options.activeScopeResolver;
    if (!resolver) throw new AgentTaskServiceError(missingCode);
    let scope: ActiveAgentTaskScope | null;
    try {
      scope = await resolver.resolveActiveScope();
    } catch {
      throw new AgentTaskServiceError(missingCode);
    }
    if (!isValidActiveScope(scope)) throw new AgentTaskServiceError(missingCode);
    return { profileId: scope.profileId, workspaceId: scope.workspaceId };
  }

  private timestamp(): string {
    const time = this.now();
    if (!Number.isFinite(time) || time < 0 || time > 8.64e15) throw new AgentTaskServiceError("INVALID_ARGUMENT");
    return new Date(time).toISOString();
  }
}

function toStatusSnapshot(record: AgentTaskRecord): AgentTaskStatusSnapshot {
  return {
    taskId: record.taskId,
    status: record.status,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    binding: {
      profileId: record.binding.profileId,
      workspaceId: record.binding.workspaceId,
      agentId: record.binding.agentId,
      authorizedExecutorId: record.binding.authorizedExecutorId,
      branch: record.binding.branch,
      worktreeId: record.binding.worktreeId,
      worktreePath: record.binding.worktreePath,
      baseCommit: record.binding.baseCommit,
    },
    attemptId: null,
    executorId: null,
    reasonCode: record.reasonCode,
  };
}

function validateSubmitRequest(request: SubmitAgentTaskRequest): {
  idempotencyKey: string;
  selection: Pick<SubmitAgentTaskRequest, "agentId" | "worktreeId">;
  specificationSha256: string;
} {
  if (!isPlainObject(request) || !hasExactKeys(request, ["idempotencyKey", "agentId", "worktreeId", "specificationSha256"])
    || !isSafeId(request.idempotencyKey) || !isSafeId(request.agentId) || !isSafeId(request.worktreeId)
    || !isSha256(request.specificationSha256)) {
    throw new AgentTaskServiceError("INVALID_ARGUMENT");
  }
  return {
    idempotencyKey: request.idempotencyKey,
    selection: { agentId: request.agentId, worktreeId: request.worktreeId },
    specificationSha256: request.specificationSha256,
  };
}

function normalizeResolvedBinding(
  resolved: ResolvedAgentTaskBinding,
  selection: Pick<SubmitAgentTaskRequest, "agentId" | "worktreeId">,
): AgentTaskBinding {
  if (!isPlainObject(resolved) || !hasExactKeys(resolved, [
    "profileId", "workspaceId", "agentId", "authorizedExecutorId", "branch", "worktreeId", "worktreePath",
    "baseCommit", "workspaceRoot", "worktreeRoot",
  ])
    || resolved.agentId !== selection.agentId || resolved.worktreeId !== selection.worktreeId
    || !isSafeId(resolved.profileId) || !isSafeId(resolved.workspaceId) || !isSafeId(resolved.agentId)
    || (resolved.authorizedExecutorId !== null && !isSafeId(resolved.authorizedExecutorId))
    || !isSafeGitBranch(resolved.branch) || !isSafeId(resolved.worktreeId)
    || !isSafeRelativeWorktreePath(resolved.worktreePath) || !isGitCommit(resolved.baseCommit)
    || !isCanonicalRoot(resolved.workspaceRoot) || !isCanonicalRoot(resolved.worktreeRoot)) {
    throw new AgentTaskServiceError("BINDING_MISMATCH");
  }
  const workspaceRoot = normalizeRoot(resolved.workspaceRoot);
  const worktreeRoot = normalizeRoot(resolved.worktreeRoot);
  return {
    workspaceId: resolved.workspaceId,
    profileId: resolved.profileId,
    agentId: resolved.agentId,
    authorizedExecutorId: resolved.authorizedExecutorId,
    branch: resolved.branch,
    worktreeId: resolved.worktreeId,
    worktreePath: resolved.worktreePath.replaceAll("\\", "/"),
    workspaceRootSha256: sha256(workspaceRoot),
    worktreeRootSha256: sha256(worktreeRoot),
    baseCommit: resolved.baseCommit.toLowerCase(),
  };
}

function mapStoreError(error: unknown): AgentTaskServiceError {
  if (error instanceof AgentTaskServiceError) return error;
  if (error instanceof AgentTaskStoreError) {
    switch (error.code) {
      case "TASK_IDEMPOTENCY_CONFLICT": return new AgentTaskServiceError("IDEMPOTENCY_CONFLICT");
      case "TASK_NOT_FOUND": return new AgentTaskServiceError("TASK_NOT_FOUND");
      case "TASK_STORE_CORRUPT": return new AgentTaskServiceError("TASK_STORE_CORRUPT");
      case "TASK_STORE_FULL": return new AgentTaskServiceError("TASK_STORE_FULL");
      case "TASK_STORE_SCOPE_MISMATCH": return new AgentTaskServiceError("BINDING_MISMATCH");
      default: return new AgentTaskServiceError("TASK_STORE_UNAVAILABLE");
    }
  }
  return new AgentTaskServiceError("TASK_STORE_UNAVAILABLE");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}

function isValidActiveScope(value: unknown): value is ActiveAgentTaskScope {
  return isPlainObject(value) && hasExactKeys(value, ["profileId", "workspaceId"])
    && isSafeId(value.profileId) && isSafeId(value.workspaceId);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isSafeTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isGitCommit(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value);
}

function isSafeGitBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//") || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

function isSafeRelativeWorktreePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\u0000") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.endsWith("/")) return false;
  return normalized.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isCanonicalRoot(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= 4_096
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeRoot(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
