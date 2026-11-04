import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { AtomicJsonFileError, readAtomicJson, withAtomicJsonFileLock, writeAtomicJson } from "../storage/AtomicJsonFile.js";
import { redactString } from "../redaction/Redactor.js";
import type { FolderAclStore } from "../workspace/FolderAclStore.js";
import { normalizePathForComparison, resolvePathWithinWorkspace } from "../workspace/PathContainment.js";

export type ApprovalOperationKind = "CREATE_FILE" | "REPLACE_FILE";
export type ApprovalDecision = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "REVOKED" | "STALE";
export type ApprovalExecution = "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type ApprovalVerification = "NOT_RUN" | "VERIFIED" | "MISMATCH" | "UNAVAILABLE";
export type ApprovalFailureCode =
  | "APPROVAL_EXPIRED"
  | "APPROVAL_STALE_REVISION"
  | "APPROVAL_PROFILE_CHANGED"
  | "APPROVAL_WORKSPACE_CHANGED"
  | "APPROVAL_ACL_CHANGED"
  | "APPROVAL_TARGET_CHANGED"
  | "APPROVAL_TARGET_EXISTS"
  | "APPROVAL_TARGET_UNAVAILABLE"
  | "APPROVAL_CONTENT_MISMATCH"
  | "APPROVAL_RETRY_LIMIT"
  | "APPROVAL_EXECUTION_INTERRUPTED"
  | "APPROVAL_EXECUTOR_FAILED"
  | "APPROVAL_EXECUTOR_TIMEOUT"
  | "APPROVAL_WRITE_PERMISSION_REVOKED"
  | "APPROVAL_SAFE_EXECUTION_UNAVAILABLE";

export interface ApprovalDecisionEntry {
  decision: "APPROVED" | "REJECTED";
  decidedAt: string;
  revision: number;
}

export interface ApprovalAttemptEntry {
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  execution: "RUNNING" | "SUCCEEDED" | "FAILED";
  verification: "NOT_RUN" | "VERIFIED" | "MISMATCH" | "UNAVAILABLE";
  failureCode?: ApprovalFailureCode;
}

export interface ApprovalRequestSource {
  kind: "MCP";
  clientId: string;
  requestId: string | number;
  runtimeInstanceId: string;
}

export interface ApprovalRecord {
  requestId: string;
  revision: number;
  profileId: string;
  workspaceId: string;
  source?: ApprovalRequestSource;
  targetPath: string;
  operationKind: ApprovalOperationKind;
  summary: string;
  contentDigest: string;
  operationDigest: string;
  expectedTargetVersion: string;
  aclRuleId: string;
  aclRevision: number;
  createdAt: string;
  expiresAt: string;
  decision: ApprovalDecision;
  execution: ApprovalExecution;
  verification: ApprovalVerification;
  attemptCount: number;
  attemptLimit: number;
  decisions: ApprovalDecisionEntry[];
  attempts: ApprovalAttemptEntry[];
  failureCode?: ApprovalFailureCode;
}

export interface ApprovalAuditEvent {
  event: "APPROVAL_REQUESTED" | "APPROVAL_DECIDED" | "APPROVAL_REVOKED" | "APPROVAL_EXECUTION_STARTED" | "APPROVAL_EXECUTION_FINISHED" | "APPROVAL_EXECUTION_FAILED" | "APPROVAL_EXECUTION_BLOCKED";
  profileId: string;
  workspaceId: string;
  requestId: string;
  revision: number;
  timestamp: string;
  resultCode: string;
  operationDigest: string;
  contentDigest: string;
  source?: ApprovalRequestSource;
}

export interface ApprovalQueueIdentity {
  profileId: string | null;
  workspaceId: string | null;
  workspaceRoot: string | null;
}

export interface ApprovalQueueOptions {
  stateRoot: string;
  profileId: string;
  workspaceId: string;
  workspaceRoot: string;
  acl: Pick<FolderAclStore, "checkAccess">;
  getActiveIdentity: () => ApprovalQueueIdentity | Promise<ApprovalQueueIdentity>;
  appendAudit: (event: ApprovalAuditEvent) => Promise<void>;
  now?: () => number;
}

export interface ExecutionPermitHandle {
  token: string;
  requestId: string;
  revision: number;
  expiresAt: string;
}

export interface McpCreateExecutionMaterial {
  targetPath: string;
  workspaceRoot: string;
  content: Buffer;
  contentDigest: string;
}

export interface McpUpdateExecutionMaterial {
  targetPath: string;
  workspaceRoot: string;
  content: Buffer;
  contentDigest: string;
  expectedTargetVersion: string;
}

/** No path or content leaves the trusted control layer. */
export interface PermitAuthorization {
  allowed: false;
  code: ApprovalFailureCode;
}

export class ApprovalQueueError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ApprovalQueueError";
  }
}

interface ApprovalQueueDocument {
  schemaVersion: 1;
  profileId: string;
  workspaceId: string;
  workspaceRoot: string;
  revision: number;
  records: ApprovalRecord[];
}

interface ActivePermit {
  requestId: string;
  runningRevision: number;
  expiresAtMs: number;
  content: Buffer;
  consumed: boolean;
}

const activePermitRegistries = new Map<string, Map<string, ActivePermit>>();

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const PERMIT_TTL_MS = 60 * 1000;
const MAX_CONTENT_BYTES = 1 * 1024 * 1024;
const MAX_TARGET_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const MAX_SUMMARY_LENGTH = 240;
const ATTEMPT_LIMIT = 2;

export class ApprovalQueue {
  private readonly stateRoot: string;
  private readonly now: () => number;
  private readonly activePermits: Map<string, ActivePermit>;

  constructor(private readonly options: ApprovalQueueOptions) {
    assertSafeIdentity(options.profileId, "APPROVAL_BAD_PROFILE_ID");
    assertSafeIdentity(options.workspaceId, "APPROVAL_BAD_WORKSPACE_ID");
    if (!path.isAbsolute(options.stateRoot) || !path.isAbsolute(options.workspaceRoot)) {
      throw new ApprovalQueueError("APPROVAL_PATH_NOT_ABSOLUTE");
    }
    if (typeof options.getActiveIdentity !== "function" || typeof options.appendAudit !== "function") {
      throw new ApprovalQueueError("APPROVAL_TRUSTED_DEPENDENCY_REQUIRED");
    }
    this.stateRoot = path.resolve(options.stateRoot);
    this.now = options.now ?? Date.now;
    const registryKey = path.resolve(this.stateRoot, "profiles", options.profileId, "approval-queue.json");
    const normalizedRegistryKey = process.platform === "win32" ? registryKey.toLowerCase() : registryKey;
    let registry = activePermitRegistries.get(normalizedRegistryKey);
    if (!registry) {
      registry = new Map<string, ActivePermit>();
      activePermitRegistries.set(normalizedRegistryKey, registry);
    }
    this.activePermits = registry;
  }

  private filePath(): string {
    return path.join(this.stateRoot, "profiles", this.options.profileId, "approval-queue.json");
  }

  private async readDocument(): Promise<ApprovalQueueDocument> {
    let raw: unknown;
    try {
      raw = await readAtomicJson<unknown>(this.filePath(), MAX_QUEUE_BYTES);
    } catch (error: unknown) {
      if (error instanceof AtomicJsonFileError) throw new ApprovalQueueError("APPROVAL_STORE_CORRUPT");
      throw new ApprovalQueueError("APPROVAL_STORE_UNAVAILABLE");
    }
    if (raw === undefined) {
      return {
        schemaVersion: 1,
        profileId: this.options.profileId,
        workspaceId: this.options.workspaceId,
        workspaceRoot: await this.canonicalWorkspaceRoot(),
        revision: 0,
        records: [],
      };
    }
    if (!isQueueDocument(raw) || raw.profileId !== this.options.profileId) {
      throw new ApprovalQueueError("APPROVAL_STORE_CORRUPT");
    }
    const currentWorkspaceRoot = await this.canonicalWorkspaceRoot();
    if (raw.workspaceId !== this.options.workspaceId
      || normalizePathForComparison(raw.workspaceRoot) !== normalizePathForComparison(currentWorkspaceRoot)) {
      throw new ApprovalQueueError("APPROVAL_SCOPE_MISMATCH");
    }
    if (raw.records.some((record) => !isApprovalRecord(record) || record.profileId !== raw.profileId
      || record.workspaceId !== raw.workspaceId || record.operationDigest !== digestBinding(record))) {
      throw new ApprovalQueueError("APPROVAL_STORE_CORRUPT");
    }
    return raw;
  }

  private async canonicalWorkspaceRoot(): Promise<string> {
    const result = await resolvePathWithinWorkspace(this.options.workspaceRoot, this.options.workspaceRoot);
    if (!result.ok) throw new ApprovalQueueError("APPROVAL_WORKSPACE_UNAVAILABLE");
    return result.workspaceRoot;
  }

  private async writeDocument(document: ApprovalQueueDocument): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(document), "utf8") > MAX_QUEUE_BYTES) {
      throw new ApprovalQueueError("APPROVAL_QUEUE_FULL");
    }
    await writeAtomicJson(this.filePath(), document);
  }

  private async assertActiveIdentity(): Promise<ApprovalFailureCode | null> {
    let identity: ApprovalQueueIdentity;
    try {
      identity = await this.options.getActiveIdentity();
    } catch {
      return "APPROVAL_PROFILE_CHANGED";
    }
    if (identity.profileId !== this.options.profileId) return "APPROVAL_PROFILE_CHANGED";
    if (identity.workspaceId !== this.options.workspaceId) return "APPROVAL_WORKSPACE_CHANGED";
    if (typeof identity.workspaceRoot !== "string" || !path.isAbsolute(identity.workspaceRoot)) return "APPROVAL_WORKSPACE_CHANGED";
    try {
      if (normalizePathForComparison(identity.workspaceRoot) !== normalizePathForComparison(this.options.workspaceRoot)) {
        return "APPROVAL_WORKSPACE_CHANGED";
      }
    } catch {
      return "APPROVAL_WORKSPACE_CHANGED";
    }
    return null;
  }

  private async audit(record: ApprovalRecord, event: ApprovalAuditEvent["event"], resultCode: string): Promise<void> {
    await this.options.appendAudit({
      event,
      profileId: record.profileId,
      workspaceId: record.workspaceId,
      requestId: record.requestId,
      revision: record.revision,
      timestamp: new Date(this.now()).toISOString(),
      resultCode,
      operationDigest: record.operationDigest,
      contentDigest: record.contentDigest,
      ...(record.source ? { source: { ...record.source } } : {}),
    });
  }

  /** Creates a write-only approval request. File bytes remain in the caller and are never persisted. */
  async requestWrite(input: {
    targetPath: string;
    content: Uint8Array | string;
    summary: string;
    createOnly?: boolean;
    replaceOnly?: boolean;
    source?: ApprovalRequestSource;
    onDiagnostic?: (event: { stage: string; elapsedMs: number; errorCode?: string }) => void;
  }): Promise<ApprovalRecord> {
    const identityFailure = await this.assertActiveIdentity();
    if (identityFailure) throw new ApprovalQueueError(identityFailure);
    if (!path.isAbsolute(input.targetPath) || typeof input.summary !== "string"
      || (input.source !== undefined && !isApprovalRequestSource(input.source))) {
      throw new ApprovalQueueError("APPROVAL_BAD_REQUEST");
    }
    const content = Buffer.isBuffer(input.content) ? Buffer.from(input.content) : Buffer.from(input.content);
    if (content.byteLength > MAX_CONTENT_BYTES) throw new ApprovalQueueError("APPROVAL_CONTENT_TOO_LARGE");
    const resolved = await resolvePathWithinWorkspace(this.options.workspaceRoot, input.targetPath);
    if (!resolved.ok) throw new ApprovalQueueError(`APPROVAL_${resolved.reason}`);
    const access = await this.options.acl.checkAccess(resolved.targetPath, "write");
    if (!access.allowed) throw new ApprovalQueueError(`APPROVAL_ACL_${access.reason}`);
    const targetVersion = await readTargetVersion(resolved.targetPath);
    if (input.createOnly && targetVersion !== "ABSENT") throw new ApprovalQueueError("APPROVAL_TARGET_EXISTS");
    if (input.replaceOnly && targetVersion === "ABSENT") throw new ApprovalQueueError("APPROVAL_TARGET_UNAVAILABLE");
    const contentDigest = digestBytes(content);
    if (targetVersion === `SHA256:${contentDigest}`) throw new ApprovalQueueError("APPROVAL_NO_OP");
    const parentStats = await fs.stat(path.dirname(resolved.targetPath)).catch(() => null);
    if (!parentStats?.isDirectory()) throw new ApprovalQueueError("APPROVAL_TARGET_UNAVAILABLE");

    const nowMs = this.now();
    const expiresAt = new Date(nowMs + DEFAULT_TTL_MS).toISOString();
    const operationKind: ApprovalOperationKind = targetVersion === "ABSENT" ? "CREATE_FILE" : "REPLACE_FILE";
    const record: ApprovalRecord = {
      requestId: `apr_${randomBytes(12).toString("base64url")}`,
      revision: 0,
      profileId: this.options.profileId,
      workspaceId: this.options.workspaceId,
      ...(input.source ? { source: { ...input.source } } : {}),
      targetPath: resolved.targetPath,
      operationKind,
      summary: sanitizeDisplayText(input.summary, MAX_SUMMARY_LENGTH),
      contentDigest,
      operationDigest: "",
      expectedTargetVersion: targetVersion,
      aclRuleId: access.ruleId,
      aclRevision: access.aclRevision,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt,
      decision: "PENDING",
      execution: "NOT_STARTED",
      verification: "NOT_RUN",
      attemptCount: 0,
      attemptLimit: ATTEMPT_LIMIT,
      decisions: [],
      attempts: [],
    };
    record.operationDigest = digestBinding(record);

    const lockWaitStarted = Date.now();
    const emit = (stage: string, elapsedMs: number, errorCode?: string): void => {
      try {
        input.onDiagnostic?.({ stage, elapsedMs: Math.max(0, elapsedMs), ...(errorCode ? { errorCode } : {}) });
      } catch { /* diagnostics must not affect queue mutations */ }
    };
    return withAtomicJsonFileLock(this.filePath(), async () => {
      emit("approval_queue_lock_acquired", Date.now() - lockWaitStarted);
      const document = await this.readDocument();
      const mcpSource = input.source?.kind === "MCP" ? input.source : null;
      if (mcpSource) {
        const priorRequest = document.records.find((item) => hasSameMcpRequest(item, mcpSource));
        if (priorRequest) {
          const sameAction = priorRequest.operationKind === record.operationKind
            && normalizePathForComparison(priorRequest.targetPath) === normalizePathForComparison(record.targetPath)
            && priorRequest.contentDigest === record.contentDigest
            && priorRequest.expectedTargetVersion === record.expectedTargetVersion;
          if (sameAction && priorRequest.decision === "PENDING" && priorRequest.execution === "NOT_STARTED") {
            emit("approval_queue_idempotent_reuse", Date.now() - lockWaitStarted);
            return cloneRecord(priorRequest);
          }
          throw new ApprovalQueueError("APPROVAL_IDEMPOTENCY_CONFLICT");
        }
        const pendingWrite = document.records.find((item) => item.source?.kind === "MCP"
          && item.decision === "PENDING" && item.execution === "NOT_STARTED"
          && normalizePathForComparison(item.targetPath) === normalizePathForComparison(record.targetPath));
        if (pendingWrite) {
          const sameRequester = pendingWrite.source?.kind === "MCP"
            && pendingWrite.source.clientId === mcpSource.clientId
            && pendingWrite.source.runtimeInstanceId === mcpSource.runtimeInstanceId;
          const sameAction = pendingWrite.operationKind === record.operationKind
            && pendingWrite.contentDigest === record.contentDigest
            && pendingWrite.expectedTargetVersion === record.expectedTargetVersion;
          if (sameRequester && sameAction) {
            emit("approval_queue_idempotent_reuse", Date.now() - lockWaitStarted);
            return cloneRecord(pendingWrite);
          }
          throw new ApprovalQueueError("APPROVAL_TARGET_PENDING");
        }
      }
      this.bump(document, record);
      document.records.push(record);
      const auditStartedAt = Date.now();
      await this.audit(record, "APPROVAL_REQUESTED", "REQUESTED");
      emit("approval_queue_audit_completed", Date.now() - auditStartedAt);
      const writeStartedAt = Date.now();
      await this.writeDocument(document);
      emit("approval_queue_document_written", Date.now() - writeStartedAt);
      return cloneRecord(record);
    });
  }

  async list(): Promise<ApprovalRecord[]> {
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) throw new ApprovalQueueError(identityFailure);
      const document = await this.readDocument();
      const changed = await this.recoverInterruptedExecutions(document);
      if (changed) {
        const identityFailureBeforeWrite = await this.assertActiveIdentity();
        if (identityFailureBeforeWrite) throw new ApprovalQueueError(identityFailureBeforeWrite);
        await this.writeDocument(document);
      }
      const identityFailureBeforeReturn = await this.assertActiveIdentity();
      if (identityFailureBeforeReturn) throw new ApprovalQueueError(identityFailureBeforeReturn);
      return document.records.map(cloneRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async get(requestId: string): Promise<ApprovalRecord | null> {
    const records = await this.list();
    return records.find((record) => record.requestId === requestId) ?? null;
  }

  /** Called by the main process during shutdown; active attempts recover as failed on the next read. */
  abandonOutstandingPermitsOnShutdown(): void {
    this.activePermits.clear();
  }

  /** Main process must show and confirm the immutable request before calling this method. */
  async decide(input: { requestId: string; expectedRevision: number; decision: "APPROVE" | "REJECT" }): Promise<ApprovalRecord> {
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const document = await this.readDocument();
      const recovered = await this.recoverInterruptedExecutions(document);
      if (recovered) await this.writeDocument(document);
      const record = this.requireRecord(document, input.requestId);
      this.assertRevision(record, input.expectedRevision);
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) return this.commitDecision(document, record, "STALE", identityFailure);
      const nowMs = this.now();
      if (Date.parse(record.expiresAt) <= nowMs) return this.commitDecision(document, record, "EXPIRED", "APPROVAL_EXPIRED");

      if (input.decision === "REJECT") {
        if (record.decision !== "PENDING") throw new ApprovalQueueError("APPROVAL_NOT_PENDING");
        return this.commitDecision(document, record, "REJECTED", "REJECTED");
      }
      const isFirstApproval = record.decision === "PENDING" && record.attemptCount === 0;
      const isBoundedRetry = record.decision === "APPROVED" && record.execution === "FAILED" && record.attemptCount < record.attemptLimit;
      if (!isFirstApproval && !isBoundedRetry) throw new ApprovalQueueError("APPROVAL_NOT_DECIDABLE");
      const staleCode = await this.checkBoundTarget(record);
      if (staleCode) return this.commitDecision(document, record, "STALE", staleCode);
      return this.commitDecision(document, record, "APPROVED", "APPROVED");
    });
  }

  async revoke(input: { requestId: string; expectedRevision: number }): Promise<ApprovalRecord> {
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const document = await this.readDocument();
      const recovered = await this.recoverInterruptedExecutions(document);
      if (recovered) await this.writeDocument(document);
      const record = this.requireRecord(document, input.requestId);
      this.assertRevision(record, input.expectedRevision);
      if (record.execution === "RUNNING" || record.execution === "SUCCEEDED") {
        throw new ApprovalQueueError("APPROVAL_EXECUTION_ALREADY_STARTED");
      }
      if (record.decision !== "PENDING" && record.decision !== "APPROVED") throw new ApprovalQueueError("APPROVAL_NOT_REVOCABLE");
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) throw new ApprovalQueueError(identityFailure);
      record.decision = "REVOKED";
      this.bump(document, record);
      await this.audit(record, "APPROVAL_REVOKED", "REVOKED");
      await this.writeDocument(document);
      return cloneRecord(record);
    });
  }

  /** Starts one bounded attempt; the supplied payload is checked against the approved digest and is not persisted. */
  async beginExecution(input: { requestId: string; expectedRevision: number; content: Uint8Array | string }): Promise<
    | { allowed: true; permit: ExecutionPermitHandle }
    | { allowed: false; code: ApprovalFailureCode; record: ApprovalRecord }
  > {
    const content = Buffer.isBuffer(input.content) ? Buffer.from(input.content) : Buffer.from(input.content);
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const document = await this.readDocument();
      const recovered = await this.recoverInterruptedExecutions(document);
      if (recovered) await this.writeDocument(document);
      const record = this.requireRecord(document, input.requestId);
      this.assertRevision(record, input.expectedRevision);
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) {
        const stale = await this.commitDecision(document, record, "STALE", identityFailure);
        return { allowed: false, code: identityFailure, record: stale };
      }
      if (Date.parse(record.expiresAt) <= this.now()) {
        record.decision = "EXPIRED";
        this.bump(document, record);
        await this.audit(record, "APPROVAL_DECIDED", "APPROVAL_EXPIRED");
        await this.writeDocument(document);
        return { allowed: false, code: "APPROVAL_EXPIRED", record: cloneRecord(record) };
      }
      if (record.decision !== "APPROVED" || (record.execution !== "NOT_STARTED" && record.execution !== "FAILED")) {
        throw new ApprovalQueueError("APPROVAL_NOT_EXECUTABLE");
      }
      if (record.attemptCount >= record.attemptLimit) return this.commitFailure(document, record, "APPROVAL_RETRY_LIMIT");
      if (digestBytes(content) !== record.contentDigest) {
        const stale = await this.commitDecision(document, record, "STALE", "APPROVAL_CONTENT_MISMATCH");
        return { allowed: false, code: "APPROVAL_CONTENT_MISMATCH", record: stale };
      }
      const staleCode = await this.checkBoundTarget(record);
      if (staleCode) {
        const stale = await this.commitDecision(document, record, "STALE", staleCode);
        return { allowed: false, code: staleCode, record: stale };
      }

      record.attemptCount += 1;
      record.execution = "RUNNING";
      record.verification = "NOT_RUN";
      delete record.failureCode;
      record.attempts.push({
        attempt: record.attemptCount,
        startedAt: new Date(this.now()).toISOString(),
        execution: "RUNNING",
        verification: "NOT_RUN",
      });
      this.bump(document, record);
      const token = randomBytes(32).toString("base64url");
      const expiresAtMs = this.now() + PERMIT_TTL_MS;
      const permit: ExecutionPermitHandle = {
        token,
        requestId: record.requestId,
        revision: record.revision,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      this.activePermits.set(token, {
        requestId: record.requestId,
        runningRevision: record.revision,
        expiresAtMs,
        content,
        consumed: false,
      });
      try {
        await this.audit(record, "APPROVAL_EXECUTION_STARTED", `ATTEMPT_${record.attemptCount}`);
        await this.writeDocument(document);
      } catch (error: unknown) {
        this.activePermits.delete(token);
        throw error;
      }
      return { allowed: true, permit };
    });
  }

  /**
   * Consumes a single approved MCP CREATE permit while holding the queue lock.
   * The narrow test adapter is the only callback that receives the target and
   * bytes; other callers retain the fail-closed authorizeExecution contract.
   */
  async executeMcpCreateWithPermit<T>(
    token: string,
    writer: (material: McpCreateExecutionMaterial) => Promise<T>,
  ): Promise<{ allowed: true; result: T } | { allowed: false; code: ApprovalFailureCode; record: ApprovalRecord }> {
    if (typeof writer !== "function") throw new ApprovalQueueError("APPROVAL_TRUSTED_DEPENDENCY_REQUIRED");
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const active = this.activePermits.get(token);
      if (!active || active.consumed) throw new ApprovalQueueError("APPROVAL_EXECUTOR_FAILED");
      const document = await this.readDocument();
      const record = this.requireRecord(document, active.requestId);
      if (record.execution !== "RUNNING" || record.revision !== active.runningRevision || active.expiresAtMs <= this.now()) {
        const result = await this.commitFailure(document, record, "APPROVAL_EXECUTOR_TIMEOUT");
        this.activePermits.delete(token);
        return { allowed: false, code: result.code, record: result.record };
      }
      if (record.source?.kind !== "MCP" || record.operationKind !== "CREATE_FILE") {
        const result = await this.commitFailure(document, record, "APPROVAL_EXECUTOR_FAILED");
        this.activePermits.delete(token);
        return { allowed: false, code: result.code, record: result.record };
      }
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) {
        const result = await this.commitFailure(document, record, identityFailure);
        this.activePermits.delete(token);
        return { allowed: false, code: result.code, record: result.record };
      }
      const staleCode = await this.checkBoundTarget(record);
      if (staleCode) {
        const stale = await this.commitDecision(document, record, "STALE", staleCode);
        this.activePermits.delete(token);
        return { allowed: false, code: staleCode, record: stale };
      }

      active.consumed = true;
      const material: McpCreateExecutionMaterial = {
        targetPath: record.targetPath,
        workspaceRoot: await this.canonicalWorkspaceRoot(),
        content: Buffer.from(active.content),
        contentDigest: record.contentDigest,
      };
      active.content.fill(0);
      try {
        return { allowed: true, result: await writer(material) };
      } finally {
        material.content.fill(0);
      }
    });
  }

  /**
   * Consumes one approved MCP UPDATE permit. The queue revalidates the bound
   * target version immediately before releasing path/bytes to the trusted
   * writer, so concurrent edits fail closed instead of being overwritten.
   */
  async executeMcpUpdateWithPermit<T>(
    token: string,
    writer: (material: McpUpdateExecutionMaterial) => Promise<T>,
  ): Promise<{ allowed: true; result: T } | { allowed: false; code: ApprovalFailureCode; record: ApprovalRecord }> {
    if (typeof writer !== "function") throw new ApprovalQueueError("APPROVAL_TRUSTED_DEPENDENCY_REQUIRED");
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const active = this.activePermits.get(token);
      if (!active || active.consumed) throw new ApprovalQueueError("APPROVAL_EXECUTOR_FAILED");
      const document = await this.readDocument();
      const record = this.requireRecord(document, active.requestId);
      if (record.execution !== "RUNNING" || record.revision !== active.runningRevision || active.expiresAtMs <= this.now()) {
        const result = await this.commitFailure(document, record, "APPROVAL_EXECUTOR_TIMEOUT");
        this.activePermits.delete(token);
        return { allowed: false, code: result.code, record: result.record };
      }
      if (record.source?.kind !== "MCP" || record.operationKind !== "REPLACE_FILE") {
        const result = await this.commitFailure(document, record, "APPROVAL_EXECUTOR_FAILED");
        this.activePermits.delete(token);
        return { allowed: false, code: result.code, record: result.record };
      }
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) {
        const result = await this.commitFailure(document, record, identityFailure);
        this.activePermits.delete(token);
        return { allowed: false, code: result.code, record: result.record };
      }
      const staleCode = await this.checkBoundTarget(record);
      if (staleCode) {
        const stale = await this.commitDecision(document, record, "STALE", staleCode);
        this.activePermits.delete(token);
        return { allowed: false, code: staleCode, record: stale };
      }

      active.consumed = true;
      const material: McpUpdateExecutionMaterial = {
        targetPath: record.targetPath,
        workspaceRoot: await this.canonicalWorkspaceRoot(),
        content: Buffer.from(active.content),
        contentDigest: record.contentDigest,
        expectedTargetVersion: record.expectedTargetVersion,
      };
      active.content.fill(0);
      try {
        return { allowed: true, result: await writer(material) };
      } finally {
        material.content.fill(0);
      }
    });
  }

  /**
   * Default product execution gate remains fail-closed: no general Windows
   * writer may receive path/bytes. The isolated MCP CREATE test adapter uses
   * executeMcpCreateWithPermit and UPDATE uses its own version-bound writer.
   */
  async authorizeExecution(token: string): Promise<PermitAuthorization> {
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const active = this.activePermits.get(token);
      if (!active || active.consumed) return { allowed: false, code: "APPROVAL_EXECUTOR_FAILED" };
      const document = await this.readDocument();
      const record = this.requireRecord(document, active.requestId);
      if (record.execution !== "RUNNING" || record.revision !== active.runningRevision || active.expiresAtMs <= this.now()) {
        const result = await this.commitFailure(document, record, "APPROVAL_EXECUTOR_TIMEOUT");
        this.activePermits.delete(token);
        return { allowed: false, code: result.code };
      }
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) {
        const result = await this.commitFailure(document, record, identityFailure);
        this.activePermits.delete(token);
        return { allowed: false, code: result.code };
      }
      const staleCode = await this.checkBoundTarget(record);
      if (staleCode) {
        const result = await this.commitFailure(document, record, staleCode);
        this.activePermits.delete(token);
        return { allowed: false, code: result.code };
      }
      const result = await this.commitFailure(document, record, "APPROVAL_SAFE_EXECUTION_UNAVAILABLE");
      this.activePermits.delete(token);
      return { allowed: false, code: result.code };
    });
  }

  /**
   * Records an explicit execution-action response when no safe writer is
   * installed. Binding checks still run before returning UNAVAILABLE; the
   * approval decision and file state are not changed.
   */
  async reportExecutionUnavailable(input: { requestId: string; expectedRevision: number }): Promise<{
    status: "UNAVAILABLE";
    code: ApprovalFailureCode;
    record: ApprovalRecord;
  }> {
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const document = await this.readDocument();
      const recovered = await this.recoverInterruptedExecutions(document);
      if (recovered) await this.writeDocument(document);
      const record = this.requireRecord(document, input.requestId);
      this.assertRevision(record, input.expectedRevision);
      const identityFailure = await this.assertActiveIdentity();
      if (identityFailure) {
        const stale = await this.commitDecision(document, record, "STALE", identityFailure);
        return { status: "UNAVAILABLE", code: identityFailure, record: stale };
      }
      if (Date.parse(record.expiresAt) <= this.now()) {
        const expired = await this.commitDecision(document, record, "EXPIRED", "APPROVAL_EXPIRED");
        return { status: "UNAVAILABLE", code: "APPROVAL_EXPIRED", record: expired };
      }
      if (record.decision !== "APPROVED" || (record.execution !== "NOT_STARTED" && record.execution !== "FAILED")) {
        throw new ApprovalQueueError("APPROVAL_NOT_EXECUTABLE");
      }
      if (record.attemptCount >= record.attemptLimit) {
        return { status: "UNAVAILABLE", code: "APPROVAL_RETRY_LIMIT", record: cloneRecord(record) };
      }
      const staleCode = await this.checkBoundTarget(record);
      if (staleCode) {
        const stale = await this.commitDecision(document, record, "STALE", staleCode);
        return { status: "UNAVAILABLE", code: staleCode, record: stale };
      }
      await this.audit(record, "APPROVAL_EXECUTION_BLOCKED", "APPROVAL_SAFE_EXECUTION_UNAVAILABLE");
      return {
        status: "UNAVAILABLE",
        code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
        record: cloneRecord(record),
      };
    });
  }

  /** Verifies the on-disk bytes itself; callers cannot report a success flag. */
  async verifyExecution(token: string): Promise<ApprovalRecord> {
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const active = this.activePermits.get(token);
      if (!active || !active.consumed) throw new ApprovalQueueError("APPROVAL_EXECUTION_PERMIT_INVALID");
      const document = await this.readDocument();
      const record = this.requireRecord(document, active.requestId);
      if (record.execution !== "RUNNING" || record.revision !== active.runningRevision) {
        this.activePermits.delete(token);
        throw new ApprovalQueueError("APPROVAL_EXECUTION_NOT_RUNNING");
      }
      let observedVersion: string | null = null;
      let failure: ApprovalFailureCode | undefined;
      try { observedVersion = await readTargetVersion(record.targetPath); }
      catch { failure = "APPROVAL_TARGET_UNAVAILABLE"; }
      const verified = observedVersion === `SHA256:${record.contentDigest}`;
      record.execution = verified ? "SUCCEEDED" : "FAILED";
      record.verification = verified ? "VERIFIED" : (failure ? "UNAVAILABLE" : "MISMATCH");
      if (failure) record.failureCode = failure;
      else if (!verified) record.failureCode = "APPROVAL_TARGET_CHANGED";
      else delete record.failureCode;
      this.finishAttempt(record, record.execution, record.verification, record.failureCode);
      this.bump(document, record);
      try {
        await this.audit(record, verified ? "APPROVAL_EXECUTION_FINISHED" : "APPROVAL_EXECUTION_FAILED", verified ? "VERIFIED" : record.failureCode ?? "VERIFY_MISMATCH");
        await this.writeDocument(document);
      } finally {
        this.activePermits.delete(token);
      }
      return cloneRecord(record);
    });
  }

  /** Records a bounded, coded executor failure; no arbitrary exception text is persisted. */
  async failExecution(token: string, code: ApprovalFailureCode): Promise<ApprovalRecord> {
    if (!isFailureCode(code)) throw new ApprovalQueueError("APPROVAL_BAD_FAILURE_CODE");
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const active = this.activePermits.get(token);
      if (!active) throw new ApprovalQueueError("APPROVAL_EXECUTION_PERMIT_INVALID");
      const document = await this.readDocument();
      const record = this.requireRecord(document, active.requestId);
      if (record.execution !== "RUNNING" || record.revision !== active.runningRevision) throw new ApprovalQueueError("APPROVAL_EXECUTION_NOT_RUNNING");
      record.execution = "FAILED";
      record.verification = "UNAVAILABLE";
      record.failureCode = code;
      this.finishAttempt(record, "FAILED", "UNAVAILABLE", code);
      this.bump(document, record);
      try {
        await this.audit(record, "APPROVAL_EXECUTION_FAILED", code);
        await this.writeDocument(document);
      } finally {
        this.activePermits.delete(token);
      }
      return cloneRecord(record);
    });
  }

  private async checkBoundTarget(record: ApprovalRecord): Promise<ApprovalFailureCode | null> {
    if (record.operationDigest !== digestBinding(record)) return "APPROVAL_STALE_REVISION";
    const identityFailure = await this.assertActiveIdentity();
    if (identityFailure) return identityFailure;
    const resolved = await resolvePathWithinWorkspace(this.options.workspaceRoot, record.targetPath);
    if (!resolved.ok || normalizePathForComparison(resolved.targetPath) !== normalizePathForComparison(record.targetPath)) {
      return "APPROVAL_TARGET_CHANGED";
    }
    const access = await this.options.acl.checkAccess(resolved.targetPath, "write");
    if (!access.allowed || access.ruleId !== record.aclRuleId || access.aclRevision !== record.aclRevision) return "APPROVAL_ACL_CHANGED";
    let currentVersion: string;
    try { currentVersion = await readTargetVersion(resolved.targetPath); }
    catch { return "APPROVAL_TARGET_UNAVAILABLE"; }
    if (currentVersion !== record.expectedTargetVersion) return "APPROVAL_TARGET_CHANGED";
    return null;
  }

  private async recoverInterruptedExecutions(document: ApprovalQueueDocument): Promise<boolean> {
    let changed = false;
    for (const record of document.records) {
      if ((record.decision === "PENDING" || record.decision === "APPROVED")
        && record.execution === "NOT_STARTED" && Date.parse(record.expiresAt) <= this.now()) {
        record.decision = "EXPIRED";
        record.failureCode = "APPROVAL_EXPIRED";
        this.bump(document, record);
        await this.audit(record, "APPROVAL_DECIDED", "APPROVAL_EXPIRED");
        changed = true;
      }
      if (record.execution !== "RUNNING") continue;
      const activeEntry = [...this.activePermits.entries()].find(([, permit]) => permit.requestId === record.requestId && permit.runningRevision === record.revision);
      if (activeEntry && activeEntry[1].expiresAtMs > this.now()) continue;
      if (activeEntry) this.activePermits.delete(activeEntry[0]);
      record.execution = "FAILED";
      record.verification = "UNAVAILABLE";
      record.failureCode = "APPROVAL_EXECUTION_INTERRUPTED";
      this.finishAttempt(record, "FAILED", "UNAVAILABLE", record.failureCode);
      this.bump(document, record);
      await this.audit(record, "APPROVAL_EXECUTION_FAILED", "APPROVAL_EXECUTION_INTERRUPTED");
      changed = true;
    }
    return changed;
  }

  private async commitDecision(
    document: ApprovalQueueDocument,
    record: ApprovalRecord,
    decision: ApprovalDecision,
    resultCode: string,
  ): Promise<ApprovalRecord> {
    record.decision = decision;
    if (decision === "APPROVED" || decision === "REJECTED") {
      record.decisions.push({ decision, decidedAt: new Date(this.now()).toISOString(), revision: record.revision + 1 });
    }
    if (decision === "STALE" || decision === "EXPIRED") record.failureCode = isFailureCode(resultCode) ? resultCode : undefined;
    this.bump(document, record);
    await this.audit(record, "APPROVAL_DECIDED", resultCode);
    await this.writeDocument(document);
    return cloneRecord(record);
  }

  private async commitFailure(
    document: ApprovalQueueDocument,
    record: ApprovalRecord,
    code: ApprovalFailureCode,
  ): Promise<{ allowed: false; code: ApprovalFailureCode; record: ApprovalRecord }> {
    const attemptIsRunning = record.execution === "RUNNING"
      || record.attempts[record.attempts.length - 1]?.execution === "RUNNING";
    if (attemptIsRunning) {
      record.execution = "FAILED";
      record.verification = code === "APPROVAL_RETRY_LIMIT" ? record.verification : "UNAVAILABLE";
      this.finishAttempt(record, "FAILED", record.verification, code);
    }
    record.failureCode = code;
    this.bump(document, record);
    await this.audit(record, "APPROVAL_EXECUTION_FAILED", code);
    await this.writeDocument(document);
    return { allowed: false, code, record: cloneRecord(record) };
  }

  private requireRecord(document: ApprovalQueueDocument, requestId: string): ApprovalRecord {
    const record = document.records.find((candidate) => candidate.requestId === requestId);
    if (!record) throw new ApprovalQueueError("APPROVAL_NOT_FOUND");
    return record;
  }

  private assertRevision(record: ApprovalRecord, expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== record.revision) {
      throw new ApprovalQueueError("APPROVAL_STALE_REVISION");
    }
  }

  private bump(document: ApprovalQueueDocument, record: ApprovalRecord): void {
    document.revision += 1;
    record.revision = document.revision;
  }

  private finishAttempt(
    record: ApprovalRecord,
    execution: ApprovalAttemptEntry["execution"],
    verification: ApprovalAttemptEntry["verification"],
    failureCode?: ApprovalFailureCode,
  ): void {
    const attempt = record.attempts[record.attempts.length - 1];
    if (!attempt || attempt.execution !== "RUNNING") return;
    attempt.execution = execution;
    attempt.verification = verification;
    attempt.finishedAt = new Date(this.now()).toISOString();
    if (failureCode) attempt.failureCode = failureCode;
    else delete attempt.failureCode;
  }
}

async function readTargetVersion(targetPath: string): Promise<string> {
  let stats;
  try { stats = await fs.lstat(targetPath); }
  catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const parent = await fs.stat(path.dirname(targetPath)).catch(() => null);
      if (parent?.isDirectory()) return "ABSENT";
      throw new ApprovalQueueError("APPROVAL_TARGET_UNAVAILABLE");
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_TARGET_BYTES) {
    throw new ApprovalQueueError("APPROVAL_TARGET_UNAVAILABLE");
  }
  const bytes = await fs.readFile(targetPath);
  const after = await fs.lstat(targetPath);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs) {
    throw new ApprovalQueueError("APPROVAL_TARGET_CHANGED");
  }
  return `SHA256:${digestBytes(bytes)}`;
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBinding(record: Pick<ApprovalRecord,
  "requestId" | "profileId" | "workspaceId" | "source" | "targetPath" | "operationKind" | "summary" | "contentDigest" | "expectedTargetVersion" | "aclRuleId" | "aclRevision" | "expiresAt">): string {
  const binding = JSON.stringify({
    requestId: record.requestId,
    profileId: record.profileId,
    workspaceId: record.workspaceId,
    targetPath: normalizePathForComparison(record.targetPath),
    operationKind: record.operationKind,
    summary: record.summary,
    contentDigest: record.contentDigest,
    expectedTargetVersion: record.expectedTargetVersion,
    aclRuleId: record.aclRuleId,
    aclRevision: record.aclRevision,
    expiresAt: record.expiresAt,
    ...(record.source ? { source: record.source } : {}),
  });
  return digestBytes(Buffer.from(binding, "utf8"));
}

function sanitizeDisplayText(value: string, maxLength: number): string {
  return redactString(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function cloneRecord(record: ApprovalRecord): ApprovalRecord {
  return {
    ...record,
    ...(record.source ? { source: { ...record.source } } : {}),
    decisions: record.decisions.map((entry) => ({ ...entry })),
    attempts: record.attempts.map((entry) => ({ ...entry })),
  };
}

function hasSameMcpRequest(record: ApprovalRecord, source: Extract<ApprovalRequestSource, { kind: "MCP" }>): boolean {
  return record.source?.kind === "MCP"
    && record.source.clientId === source.clientId
    && record.source.runtimeInstanceId === source.runtimeInstanceId
    && record.source.requestId === source.requestId;
}

function isApprovalRequestSource(value: unknown): value is ApprovalRequestSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<ApprovalRequestSource>;
  const requestId = source.requestId;
  return source.kind === "MCP"
    && typeof source.clientId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(source.clientId)
    && (typeof requestId === "string" ? requestId.length >= 1 && requestId.length <= 128
      : typeof requestId === "number" && Number.isSafeInteger(requestId))
    && typeof source.runtimeInstanceId === "string" && /^c2c_ri_[A-Za-z0-9_-]{8,128}$/.test(source.runtimeInstanceId);
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ApprovalRecord>;
  return typeof record.requestId === "string" && Number.isSafeInteger(record.revision)
    && typeof record.profileId === "string" && typeof record.workspaceId === "string"
    && (record.source === undefined || isApprovalRequestSource(record.source))
    && typeof record.targetPath === "string" && path.isAbsolute(record.targetPath)
    && (record.operationKind === "CREATE_FILE" || record.operationKind === "REPLACE_FILE")
    && typeof record.summary === "string" && record.summary.length <= MAX_SUMMARY_LENGTH
    && record.summary === sanitizeDisplayText(record.summary, MAX_SUMMARY_LENGTH)
    && typeof record.contentDigest === "string" && /^[a-f0-9]{64}$/.test(record.contentDigest)
    && typeof record.operationDigest === "string" && /^[a-f0-9]{64}$/.test(record.operationDigest)
    && typeof record.expectedTargetVersion === "string" && (record.expectedTargetVersion === "ABSENT" || /^SHA256:[a-f0-9]{64}$/.test(record.expectedTargetVersion))
    && typeof record.aclRuleId === "string" && Number.isSafeInteger(record.aclRevision)
    && typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt))
    && typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt))
    && ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "REVOKED", "STALE"].includes(record.decision ?? "")
    && ["NOT_STARTED", "RUNNING", "SUCCEEDED", "FAILED"].includes(record.execution ?? "")
    && ["NOT_RUN", "VERIFIED", "MISMATCH", "UNAVAILABLE"].includes(record.verification ?? "")
    && Number.isSafeInteger(record.attemptCount) && (record.attemptCount ?? -1) >= 0
    && record.attemptLimit === ATTEMPT_LIMIT && Array.isArray(record.decisions)
    && record.decisions.every((entry) => !!entry && (entry.decision === "APPROVED" || entry.decision === "REJECTED")
      && typeof entry.decidedAt === "string" && Number.isFinite(Date.parse(entry.decidedAt))
      && Number.isSafeInteger(entry.revision) && entry.revision > 0)
    && Array.isArray(record.attempts) && record.attempts.length === record.attemptCount
    && record.attempts.every((entry, index) => !!entry && entry.attempt === index + 1
      && typeof entry.startedAt === "string" && Number.isFinite(Date.parse(entry.startedAt))
      && (entry.finishedAt === undefined || (typeof entry.finishedAt === "string" && Number.isFinite(Date.parse(entry.finishedAt))))
      && ["RUNNING", "SUCCEEDED", "FAILED"].includes(entry.execution)
      && ["NOT_RUN", "VERIFIED", "MISMATCH", "UNAVAILABLE"].includes(entry.verification)
      && (!entry.failureCode || isFailureCode(entry.failureCode)))
    && (!record.failureCode || isFailureCode(record.failureCode));
}

function isQueueDocument(value: unknown): value is ApprovalQueueDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<ApprovalQueueDocument>;
  return document.schemaVersion === 1 && typeof document.profileId === "string" && typeof document.workspaceId === "string"
    && typeof document.workspaceRoot === "string" && path.isAbsolute(document.workspaceRoot)
    && Number.isSafeInteger(document.revision) && (document.revision ?? -1) >= 0 && Array.isArray(document.records)
    && document.records.every(isApprovalRecord);
}

function isFailureCode(value: string): value is ApprovalFailureCode {
  return [
    "APPROVAL_EXPIRED", "APPROVAL_STALE_REVISION", "APPROVAL_PROFILE_CHANGED", "APPROVAL_WORKSPACE_CHANGED",
    "APPROVAL_ACL_CHANGED", "APPROVAL_TARGET_CHANGED", "APPROVAL_TARGET_EXISTS", "APPROVAL_TARGET_UNAVAILABLE", "APPROVAL_CONTENT_MISMATCH",
    "APPROVAL_RETRY_LIMIT", "APPROVAL_EXECUTION_INTERRUPTED", "APPROVAL_EXECUTOR_FAILED", "APPROVAL_EXECUTOR_TIMEOUT",
    "APPROVAL_WRITE_PERMISSION_REVOKED", "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
  ].includes(value);
}

function assertSafeIdentity(value: string, code: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new ApprovalQueueError(code);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
