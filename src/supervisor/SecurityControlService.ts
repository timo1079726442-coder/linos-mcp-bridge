import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ApprovalQueue, type ApprovalRecord, type ApprovalRequestSource } from "../main/approval/ApprovalQueue.js";
import { FolderAclStore, type AccessVerdict, type FolderAclRule, type FolderPermission } from "../main/workspace/FolderAclStore.js";
import { redactString } from "../main/redaction/Redactor.js";
import { normalizePathForComparison, resolvePathWithinWorkspace } from "../main/workspace/PathContainment.js";
import { ProfileClientRegistry } from "../main/oauth/ProfileClientRegistry.js";
import { WorkspaceGrantStore } from "../main/oauth/WorkspaceGrantStore.js";
import { WritePolicyStore } from "../main/profile/WritePolicyStore.js";
import type { McpCreateTestWriter } from "./McpCreateTestWriter.js";
import type { McpUpdateWriter } from "./McpUpdateWriter.js";
import type { RuntimeBridgeDiagnosticSink, RuntimeCreateIntentRequest, RuntimeCreateIntentResult, RuntimeUpdateIntentRequest } from "../main/process/RuntimeSupervisorBridge.js";
import type {
  ApprovalDecisionInput,
  ApprovalExecutionActionResult,
  ApprovalQueueActionRef,
  ApprovalQueueSnapshot,
  ApprovalRecordView,
  ConfirmedFolderAclAddInput,
  ConfirmedFolderAclRemoveInput,
  FolderAccessCheckInput,
  FolderAccessEntry,
  FolderAccessVerdict,
  FolderAclAddInput,
  FolderAclRuleConfirmationInput,
  FolderAclSnapshot,
  RedactedDiffPreview,
} from "../shared/security.js";
import type { ProfileConfig } from "../shared/types.js";

const SNAPSHOT_STALE_AFTER_MS = 60_000;
const MAX_PENDING_MCP_CREATE_REQUESTS = 8;
const MAX_MCP_CREATE_PREVIEW_BYTES = 16 * 1024;
const MAX_MCP_CREATE_PREVIEW_LINES = 200;

interface PendingMcpCreatePayload {
  content: Buffer;
  beforeContent?: Buffer;
  expiresAtMs: number;
}

export class SecurityControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SecurityControlError";
  }
}

export interface SecurityControlRuntimeIdentity {
  deviceId: string;
  profileId: string;
  runtimeId: string;
  runtimeInstanceId: string | null;
  workspaceId: string | null;
  workspaceRoot: string | null;
}

export interface SecurityControlServiceOptions {
  stateRoot: string;
  getActiveProfile: () => ProfileConfig | null | Promise<ProfileConfig | null>;
  getRuntimeIdentity?: () => SecurityControlRuntimeIdentity | null | Promise<SecurityControlRuntimeIdentity | null>;
  /** Exact workspace root permitted for isolated V2 CREATE verification; unset means disabled. */
  mcpCreateTestWorkspaceRoot?: string | null;
  /** Windows-only, single-level, exclusive-create adapter; never enabled in production Profiles. */
  mcpCreateTestWriter?: McpCreateTestWriter;
  /** Version-bound atomic replacement writer for approved UPDATE requests. */
  mcpUpdateWriter?: McpUpdateWriter;
  appendAudit: (entry: Record<string, unknown>) => Promise<unknown>;
  onMcpCreateDiagnostic?: RuntimeBridgeDiagnosticSink;
  now?: () => number;
}

/**
 * Supervisor-owned ACL and approval projection. Every mutation resolves the
 * active Profile and Workspace at call time; Renderer-supplied identity is
 * never accepted as authority.
 */
export class SecurityControlService {
  private readonly now: () => number;
  private readonly pendingMcpCreatePayloads = new Map<string, PendingMcpCreatePayload>();

  constructor(private readonly options: SecurityControlServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async getFolderAcl(): Promise<FolderAclSnapshot> {
    const active = await this.requireActiveWorkspace();
    const snapshot = await this.acl(active).listSnapshot();
    const protectedProfile = active.profileType === "company";
    return {
      ...snapshot,
      profileName: active.profileName,
      profileType: active.profileType,
      mutationAvailability: protectedProfile ? "PROFILE_PROTECTED" : "AVAILABLE",
      mutationBlockReason: protectedProfile ? "COMPANY_PROFILE_PROTECTED" : null,
      entries: snapshot.entries.map((entry) => ({ ...entry, folderPath: redactString(entry.folderPath) })),
    };
  }

  /** Exact path is returned only for the trusted Main confirmation dialog. */
  async getFolderAclRuleForConfirmation(input: FolderAclRuleConfirmationInput): Promise<FolderAccessEntry | null> {
    const active = await this.requireActiveWorkspace();
    assertConfirmedIdentity(active, input.expectedProfileId, input.expectedWorkspaceId, input.expectedWorkspaceRoot);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new SecurityControlError("ACL_BAD_REVISION");
    const rule = (await this.acl(active).list()).find((item) => item.id === input.ruleId);
    if (!rule) return null;
    if (rule.revision !== input.expectedRevision) throw new SecurityControlError("ACL_STALE_REVISION");
    return toFolderAccessEntry(rule, active, false);
  }

  async addFolderAclRule(input: ConfirmedFolderAclAddInput): Promise<FolderAccessEntry> {
    const active = await this.requireMutableWorkspace();
    requireLocalAclConfirmation(input.nativeConfirmation);
    assertConfirmedIdentity(active, input.confirmedProfileId, input.confirmedWorkspaceId, input.confirmedWorkspaceRoot);
    const pathDigest = digestText(normalizePathForComparison(input.path));
    await this.options.appendAudit({
      event: "FOLDER_ACL_ADD_REQUESTED",
      profileId: active.profileId,
      workspaceId: active.currentWorkspace.workspaceId,
      pathDigest,
      access: input.access,
    });
    const extensions = input.extensionPolicy.mode === "ALLOW_ALL"
      ? null
      : input.extensionPolicy.allowedExtensions;
    const rule = await this.acl(active).add({
      path: input.path,
      permission: toPermission(input.access),
      label: input.label,
      extensions,
    });
    await this.options.appendAudit({
      event: "FOLDER_ACL_ADDED",
      profileId: active.profileId,
      workspaceId: active.currentWorkspace.workspaceId,
      ruleId: rule.id,
      pathDigest,
      access: input.access,
      ruleRevision: rule.revision,
    });
    return toFolderAccessEntry(rule, active);
  }

  async removeFolderAclRule(input: ConfirmedFolderAclRemoveInput): Promise<{ removed: boolean; revision: number }> {
    const active = await this.requireMutableWorkspace();
    requireLocalAclConfirmation(input.nativeConfirmation);
    assertConfirmedIdentity(active, input.confirmedProfileId, input.confirmedWorkspaceId, input.confirmedWorkspaceRoot);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new SecurityControlError("ACL_BAD_REVISION");
    const acl = this.acl(active);
    const rule = (await acl.list()).find((item) => item.id === input.ruleId);
    if (!rule) return { removed: false, revision: (await acl.listSnapshot()).revision };
    const pathDigest = digestText(normalizePathForComparison(rule.path));
    await this.options.appendAudit({
      event: "FOLDER_ACL_REMOVE_REQUESTED",
      profileId: active.profileId,
      workspaceId: active.currentWorkspace.workspaceId,
      ruleId: input.ruleId,
      pathDigest,
      expectedRevision: input.expectedRevision,
    });
    const result = await acl.remove(input.ruleId, input.expectedRevision);
    if (result.removed) {
      await this.options.appendAudit({
        event: "FOLDER_ACL_REMOVED",
        profileId: active.profileId,
        workspaceId: active.currentWorkspace.workspaceId,
        ruleId: input.ruleId,
        pathDigest,
        revision: result.revision,
      });
    }
    return result;
  }

  async checkFolderAccess(input: FolderAccessCheckInput): Promise<FolderAccessVerdict> {
    const active = await this.requireActiveWorkspace();
    return await this.acl(active).checkAccess(input.path, input.operation) as FolderAccessVerdict;
  }

  async isMcpCreateTestModeEnabled(): Promise<boolean> {
    const active = await this.options.getActiveProfile();
    const configuredRoot = this.options.mcpCreateTestWorkspaceRoot;
    if (!active || active.profileType !== "custom" || !configuredRoot || !this.options.mcpCreateTestWriter
      || !path.isAbsolute(configuredRoot)
      || !active.currentWorkspace.root || !path.isAbsolute(active.currentWorkspace.root)) return false;
    try {
      const [workspaceRoot, testRoot, temporaryRoot] = await Promise.all([
        fs.realpath(active.currentWorkspace.root),
        fs.realpath(configuredRoot),
        fs.realpath(tmpdir()),
      ]);
      return normalizePathForComparison(workspaceRoot) === normalizePathForComparison(testRoot)
        && normalizePathForComparison(workspaceRoot) !== normalizePathForComparison(temporaryRoot)
        && isWithinPath(temporaryRoot, workspaceRoot);
    } catch {
      return false;
    }
  }

  async requestMcpCreateIntent(request: RuntimeCreateIntentRequest): Promise<RuntimeCreateIntentResult> {
    let previousStageAt = Date.now();
    const correlationId = typeof request.correlationId === "string"
      && /^c2c_ri_[A-Za-z0-9_-]{8,128}:[1-9][0-9]{0,15}$/.test(request.correlationId)
      ? request.correlationId
      : "unavailable";
    const mark = (stage: string, errorCode?: string): void => {
      const now = Date.now();
      try {
        this.options.onMcpCreateDiagnostic?.({
          stage,
          correlationId,
          elapsedMs: Math.max(0, now - previousStageAt),
          ...(errorCode && /^[A-Z][A-Z0-9_]{1,79}$/.test(errorCode) ? { errorCode } : {}),
        });
      } catch { /* diagnostics must not affect authorization */ }
      previousStageAt = now;
    };
    mark("mcp_create_validation_started");
    const active = await this.requireMutableWorkspace();
    mark("mcp_create_workspace_loaded");
    if (!await this.isMcpCreateTestModeEnabled()) throw new SecurityControlError("MCP_CREATE_TEST_WORKSPACE_REQUIRED");
    mark("mcp_create_test_scope_validated");
    const workspaceId = active.currentWorkspace.workspaceId;
    const workspaceRoot = active.currentWorkspace.root;
    if (!workspaceId || !workspaceRoot || !isValidMcpCreateRequest(request)) {
      throw new SecurityControlError("MCP_CREATE_REQUEST_INVALID");
    }
    mark("mcp_create_request_validated");

    const runtime = await this.options.getRuntimeIdentity?.();
    if (!runtime || runtime.runtimeInstanceId !== request.runtimeInstanceId
      || runtime.deviceId !== active.deviceId || runtime.profileId !== active.profileId
      || runtime.runtimeId !== active.runtimeId || runtime.workspaceId !== workspaceId
      || !runtime.workspaceRoot
      || normalizePathForComparison(runtime.workspaceRoot) !== normalizePathForComparison(workspaceRoot)) {
      throw new SecurityControlError("MCP_RUNTIME_IDENTITY_MISMATCH");
    }
    mark("mcp_create_runtime_identity_validated");

    const clients = new ProfileClientRegistry(this.options.stateRoot, active.profileId);
    const client = await clients.findByClientId(request.caller.clientId);
    if (!client || client.pinStatus !== "active" || !client.scopes.includes("workspace.write")) {
      throw new SecurityControlError("MCP_CLIENT_WRITE_SCOPE_REQUIRED");
    }
    const grantSnapshot = await new WorkspaceGrantStore(this.options.stateRoot, active.profileId).inspect(workspaceId);
    if (grantSnapshot.state !== "PRESENT") throw new SecurityControlError("MCP_WORKSPACE_GRANT_UNAVAILABLE");
    const grant = grantSnapshot.grant;
    if (grant.revoked || grant.clientId !== request.caller.clientId || grant.audience !== workspaceId
      || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= this.now()
      || !grant.scopes.includes("workspace.write")) {
      throw new SecurityControlError("MCP_WORKSPACE_WRITE_GRANT_REQUIRED");
    }
    mark("mcp_create_client_grant_validated");

    const relativePath = request.intent.relativePath;
    if (!isSafeMcpCreatePath(relativePath) || relativePath.includes("/") || relativePath.includes("\\")
      || !relativePath.toLowerCase().endsWith(".txt")) {
      throw new SecurityControlError("MCP_CREATE_PATH_INVALID");
    }
    const root = await fs.realpath(workspaceRoot);
    const target = path.resolve(root, ...relativePath.replaceAll("\\", "/").split("/"));
    const contained = await resolvePathWithinWorkspace(root, target);
    if (!contained.ok) throw new SecurityControlError("MCP_CREATE_PATH_OUTSIDE_WORKSPACE");
    const canonicalRelative = path.relative(contained.workspaceRoot, contained.targetPath).replaceAll("\\", "/");
    if (!canonicalRelative || canonicalRelative === "." || canonicalRelative.startsWith("../") || canonicalRelative.includes("/../")) {
      throw new SecurityControlError("MCP_CREATE_PATH_OUTSIDE_WORKSPACE");
    }
    try {
      await fs.lstat(contained.targetPath);
      throw new SecurityControlError("MCP_CREATE_TARGET_EXISTS");
    } catch (error: unknown) {
      if (error instanceof SecurityControlError) throw error;
      if (!isNodeError(error) || error.code !== "ENOENT") throw new SecurityControlError("MCP_CREATE_TARGET_UNAVAILABLE");
    }
    const parentPath = path.dirname(contained.targetPath);
    const parentReal = await fs.realpath(parentPath).catch(() => null);
    const parentStats = parentReal ? await fs.stat(parentReal).catch(() => null) : null;
    if (!parentReal || !parentStats?.isDirectory()
      || normalizePathForComparison(parentReal) !== normalizePathForComparison(parentPath)
      || !isWithinPath(contained.workspaceRoot, parentReal)) {
      throw new SecurityControlError("MCP_CREATE_PARENT_UNAVAILABLE");
    }
    const access = await this.acl(active).checkAccess(contained.targetPath, "write");
    if (!access.allowed) throw new SecurityControlError("MCP_CREATE_ACL_DENIED");
    mark("mcp_create_path_acl_validated");

    const content = Buffer.from(request.intent.content, "utf8");
    if (content.byteLength > 1_000_000 || content.toString("utf8") !== request.intent.content
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.intent.content)) {
      throw new SecurityControlError("MCP_CREATE_CONTENT_INVALID");
    }
    this.removeExpiredMcpCreatePayloads();
    if (this.pendingMcpCreatePayloads.size >= MAX_PENDING_MCP_CREATE_REQUESTS) {
      content.fill(0);
      throw new SecurityControlError("MCP_CREATE_CAPACITY_EXCEEDED");
    }

    const source: ApprovalRequestSource = {
      kind: "MCP",
      clientId: request.caller.clientId,
      requestId: request.caller.requestId,
      runtimeInstanceId: request.runtimeInstanceId,
    };
    mark("mcp_create_queue_enqueue_started");
    let record: ApprovalRecord;
    try {
      record = await this.queue(active).requestWrite({
        targetPath: contained.targetPath,
        content,
        summary: "MCP CREATE",
        createOnly: true,
        source,
        onDiagnostic: (event) => this.options.onMcpCreateDiagnostic?.({ ...event, correlationId }),
      });
    } catch (error) {
      content.fill(0);
      throw error;
    }
    const existingPayload = this.pendingMcpCreatePayloads.get(record.requestId);
    if (existingPayload) {
      content.fill(0);
    } else {
      this.pendingMcpCreatePayloads.set(record.requestId, {
        content,
        expiresAtMs: Date.parse(record.expiresAt),
      });
    }
    mark("mcp_create_queue_pending");
    return { status: "PENDING", requestId: record.requestId };
  }

  async requestMcpUpdateIntent(request: RuntimeUpdateIntentRequest): Promise<RuntimeCreateIntentResult> {
    const active = await this.requireMutableWorkspace();
    const workspaceId = active.currentWorkspace.workspaceId;
    const workspaceRoot = active.currentWorkspace.root;
    if (!workspaceId || !workspaceRoot || !isValidMcpUpdateRequest(request)) {
      throw new SecurityControlError("MCP_UPDATE_REQUEST_INVALID");
    }

    const runtime = await this.options.getRuntimeIdentity?.();
    if (!runtime || runtime.runtimeInstanceId !== request.runtimeInstanceId
      || runtime.deviceId !== active.deviceId || runtime.profileId !== active.profileId
      || runtime.runtimeId !== active.runtimeId || runtime.workspaceId !== workspaceId
      || !runtime.workspaceRoot
      || normalizePathForComparison(runtime.workspaceRoot) !== normalizePathForComparison(workspaceRoot)) {
      throw new SecurityControlError("MCP_RUNTIME_IDENTITY_MISMATCH");
    }

    const clients = new ProfileClientRegistry(this.options.stateRoot, active.profileId);
    const client = await clients.findByClientId(request.caller.clientId);
    if (!client || client.pinStatus !== "active" || !client.scopes.includes("workspace.write")) {
      throw new SecurityControlError("MCP_CLIENT_WRITE_SCOPE_REQUIRED");
    }
    const grantSnapshot = await new WorkspaceGrantStore(this.options.stateRoot, active.profileId).inspect(workspaceId);
    if (grantSnapshot.state !== "PRESENT") throw new SecurityControlError("MCP_WORKSPACE_GRANT_UNAVAILABLE");
    const grant = grantSnapshot.grant;
    if (grant.revoked || grant.clientId !== request.caller.clientId || grant.audience !== workspaceId
      || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= this.now()
      || !grant.scopes.includes("workspace.write")) {
      throw new SecurityControlError("MCP_WORKSPACE_WRITE_GRANT_REQUIRED");
    }

    const relativePath = request.intent.relativePath;
    if (!isSafeMcpCreatePath(relativePath)) throw new SecurityControlError("MCP_UPDATE_PATH_INVALID");
    const root = await fs.realpath(workspaceRoot);
    const target = path.resolve(root, ...relativePath.replaceAll("\\", "/").split("/"));
    const contained = await resolvePathWithinWorkspace(root, target);
    if (!contained.ok) throw new SecurityControlError("MCP_UPDATE_PATH_OUTSIDE_WORKSPACE");
    const targetStat = await fs.lstat(contained.targetPath).catch(() => null);
    if (!targetStat?.isFile() || targetStat.isSymbolicLink() || targetStat.size > 1_000_000) {
      throw new SecurityControlError("MCP_UPDATE_TARGET_UNAVAILABLE");
    }

    const access = await this.acl(active).checkAccess(contained.targetPath, "write");
    if (!access.allowed) throw new SecurityControlError("MCP_UPDATE_ACL_DENIED");

    const writePolicyStore = new WritePolicyStore(this.options.stateRoot);
    const policy = await writePolicyStore.load();
    if (!policy.enabled || !policy.tools.updateFile) throw new SecurityControlError("MCP_UPDATE_TOOL_DISABLED");
    if ((policy.deviceId && policy.deviceId !== active.deviceId)
      || (policy.profileId && policy.profileId !== active.profileId)
      || (policy.workspaceId && policy.workspaceId !== workspaceId)
      || (policy.workspaceRoot && normalizePathForComparison(policy.workspaceRoot) !== normalizePathForComparison(workspaceRoot))) {
      throw new SecurityControlError("MCP_UPDATE_POLICY_SCOPE_MISMATCH");
    }
    const policyPathError = await writePolicyStore.checkPath(contained.targetPath);
    if (policyPathError) throw new SecurityControlError(`MCP_UPDATE_${policyPathError}`);

    const before = await fs.readFile(contained.targetPath);
    let beforePreview: Buffer | undefined;
    try {
      const observedSha256 = createHash("sha256").update(before).digest("hex");
      if (observedSha256 !== request.intent.expectedTargetSha256) {
        throw new SecurityControlError("MCP_UPDATE_TARGET_CHANGED");
      }
      if (before.byteLength <= MAX_MCP_CREATE_PREVIEW_BYTES) beforePreview = Buffer.from(before);
    } finally {
      before.fill(0);
    }

    const content = Buffer.from(request.intent.content, "utf8");
    if (content.byteLength > 1_000_000 || content.toString("utf8") !== request.intent.content
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.intent.content)) {
      content.fill(0);
      beforePreview?.fill(0);
      throw new SecurityControlError("MCP_UPDATE_CONTENT_INVALID");
    }
    this.removeExpiredMcpCreatePayloads();
    if (this.pendingMcpCreatePayloads.size >= MAX_PENDING_MCP_CREATE_REQUESTS) {
      content.fill(0);
      beforePreview?.fill(0);
      throw new SecurityControlError("MCP_UPDATE_CAPACITY_EXCEEDED");
    }

    const source: ApprovalRequestSource = {
      kind: "MCP",
      clientId: request.caller.clientId,
      requestId: request.caller.requestId,
      runtimeInstanceId: request.runtimeInstanceId,
    };
    let record: ApprovalRecord;
    try {
      record = await this.queue(active).requestWrite({
        targetPath: contained.targetPath,
        content,
        summary: "MCP UPDATE",
        replaceOnly: true,
        source,
      });
    } catch (error) {
      content.fill(0);
      beforePreview?.fill(0);
      throw error;
    }
    if (record.operationKind !== "REPLACE_FILE"
      || record.expectedTargetVersion !== `SHA256:${request.intent.expectedTargetSha256}`) {
      content.fill(0);
      beforePreview?.fill(0);
      throw new SecurityControlError("MCP_UPDATE_TARGET_CHANGED");
    }

    const existingPayload = this.pendingMcpCreatePayloads.get(record.requestId);
    if (existingPayload) {
      content.fill(0);
      beforePreview?.fill(0);
    } else {
      this.pendingMcpCreatePayloads.set(record.requestId, {
        content,
        ...(beforePreview ? { beforeContent: beforePreview } : {}),
        expiresAtMs: Date.parse(record.expiresAt),
      });
    }
    return { status: "PENDING", requestId: record.requestId };
  }

  async listApprovals(): Promise<ApprovalQueueSnapshot> {
    const active = await this.requireActiveWorkspace();
    this.removeExpiredMcpCreatePayloads();
    const queue = this.queue(active);
    const records = await queue.list();
    const createExecutionAvailable = Boolean(this.options.mcpCreateTestWriter) && await this.isMcpCreateTestModeEnabled();
    const updateExecutionAvailable = Boolean(this.options.mcpUpdateWriter);
    const executionAvailable = records.every((record) => {
      if (record.decision !== "APPROVED" || record.execution === "SUCCEEDED") return true;
      if (record.source?.kind !== "MCP") return false;
      if (record.operationKind === "CREATE_FILE") return createExecutionAvailable;
      if (record.operationKind === "REPLACE_FILE") return updateExecutionAvailable;
      return false;
    });
    return {
      profileId: active.profileId,
      profileName: active.profileName,
      profileType: active.profileType,
      workspaceId: active.currentWorkspace.workspaceId!,
      observedAt: new Date(this.now()).toISOString(),
      staleAfterMs: SNAPSHOT_STALE_AFTER_MS,
      executionAvailability: executionAvailable ? "AVAILABLE" : "UNAVAILABLE",
      executionUnavailableReason: executionAvailable ? null : "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
      records: records.map((record) => toApprovalRecordView(record, active, this.previewFor(record))),
    };
  }

  async getApproval(requestId: string): Promise<ApprovalRecordView | null> {
    const active = await this.requireActiveWorkspace();
    this.removeExpiredMcpCreatePayloads();
    const record = await this.queue(active).get(requestId);
    return record ? toApprovalRecordView(record, active, this.previewFor(record)) : null;
  }

  async decideApproval(input: ApprovalDecisionInput): Promise<ApprovalRecordView> {
    const active = await this.requireMutableWorkspace();
    const queue = this.queue(active);
    const current = await queue.get(input.requestId);
    if (!current) throw new SecurityControlError("APPROVAL_NOT_FOUND");
    if (input.decision === "APPROVE" && current.source?.kind === "MCP") {
      const payload = this.pendingMcpCreatePayloads.get(current.requestId);
      if (!payload || payload.expiresAtMs <= this.now()) throw new SecurityControlError("APPROVAL_CONTENT_UNAVAILABLE");
      if (this.previewFor(current).state !== "AVAILABLE") {
        throw new SecurityControlError("APPROVAL_PREVIEW_UNAVAILABLE");
      }
    }
    const record = await queue.decide(input);
    if (input.decision === "REJECT") this.deletePendingMcpCreatePayload(record.requestId);
    return toApprovalRecordView(record, active, this.previewFor(record));
  }

  async revokeApproval(input: ApprovalQueueActionRef): Promise<ApprovalRecordView> {
    const active = await this.requireMutableWorkspace();
    const record = await this.queue(active).revoke(input);
    this.deletePendingMcpCreatePayload(record.requestId);
    return toApprovalRecordView(record, active, this.previewFor(record));
  }

  async executeApprovedWrite(input: ApprovalQueueActionRef): Promise<ApprovalExecutionActionResult> {
    const active = await this.requireMutableWorkspace();
    const queue = this.queue(active);
    const record = await queue.get(input.requestId);
    const createAllowed = record?.operationKind === "CREATE_FILE"
      && Boolean(this.options.mcpCreateTestWriter) && await this.isMcpCreateTestModeEnabled();
    const updateAllowed = record?.operationKind === "REPLACE_FILE" && Boolean(this.options.mcpUpdateWriter);
    if (!record || record.revision !== input.expectedRevision || record.source?.kind !== "MCP"
      || (!createAllowed && !updateAllowed)) {
      const unavailable = await queue.reportExecutionUnavailable(input);
      return {
        status: "UNAVAILABLE",
        code: unavailable.code,
        record: toApprovalRecordView(unavailable.record, active, this.previewFor(unavailable.record)),
      };
    }
    if (record.operationKind === "REPLACE_FILE" && !await this.isUpdatePolicyStillAuthorized(active, record.targetPath)) {
      return {
        status: "UNAVAILABLE",
        code: "APPROVAL_WRITE_PERMISSION_REVOKED",
        record: toApprovalRecordView(record, active, this.previewFor(record)),
      };
    }

    const payload = this.pendingMcpCreatePayloads.get(record.requestId);
    if (!payload || payload.expiresAtMs <= this.now()) {
      const unavailable = await queue.reportExecutionUnavailable(input);
      return {
        status: "UNAVAILABLE",
        code: unavailable.code,
        record: toApprovalRecordView(unavailable.record, active, this.previewFor(unavailable.record)),
      };
    }

    const attempt = await queue.beginExecution({
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      content: payload.content,
    });
    if (!attempt.allowed) {
      return {
        status: "UNAVAILABLE",
        code: attempt.code,
        record: toApprovalRecordView(attempt.record, active, this.previewFor(attempt.record)),
      };
    }

    let writerResult: { fileId: string; sha256: string; byteLength: number };
    try {
      const execution = record.operationKind === "CREATE_FILE"
        ? await queue.executeMcpCreateWithPermit(attempt.permit.token, async (material) => {
            const fileName = path.basename(material.targetPath);
            if (!this.options.mcpCreateTestWriter) throw new SecurityControlError("MCP_CREATE_TEST_WRITER_UNAVAILABLE");
            if (!isSafeMcpCreatePath(fileName) || !fileName.toLowerCase().endsWith(".txt")) {
              throw new SecurityControlError("MCP_CREATE_TEST_FILENAME_INVALID");
            }
            if (normalizePathForComparison(path.dirname(material.targetPath)) !== normalizePathForComparison(material.workspaceRoot)) {
              throw new SecurityControlError("MCP_CREATE_TEST_PARENT_MISMATCH");
            }
            return await this.options.mcpCreateTestWriter(material);
          })
        : await queue.executeMcpUpdateWithPermit(attempt.permit.token, async (material) => {
            if (!this.options.mcpUpdateWriter) throw new SecurityControlError("MCP_UPDATE_WRITER_UNAVAILABLE");
            if (!isSafeMcpCreatePath(path.relative(material.workspaceRoot, material.targetPath).replaceAll("\\", "/"))) {
              throw new SecurityControlError("MCP_UPDATE_PATH_INVALID");
            }
            return await this.options.mcpUpdateWriter(material);
          });
      if (!execution.allowed) {
        return {
          status: "UNAVAILABLE",
          code: execution.code,
          record: toApprovalRecordView(execution.record, active, this.previewFor(execution.record)),
        };
      }
      writerResult = execution.result;
      const verified = await queue.verifyExecution(attempt.permit.token);
      if (verified.verification !== "VERIFIED" || verified.execution !== "SUCCEEDED") {
        this.deletePendingMcpCreatePayload(verified.requestId);
        return {
          status: "UNAVAILABLE",
          code: verified.failureCode ?? "APPROVAL_EXECUTOR_FAILED",
          record: toApprovalRecordView(verified, active, this.previewFor(verified)),
        };
      }
      this.deletePendingMcpCreatePayload(verified.requestId);
      try {
        await this.options.appendAudit({
          event: verified.operationKind === "CREATE_FILE" ? "MCP_CREATE_TEST_WRITER_VERIFIED" : "MCP_UPDATE_WRITER_VERIFIED",
          profileId: verified.profileId,
          workspaceId: verified.workspaceId,
          requestId: verified.requestId,
          contentDigest: verified.contentDigest,
          fileId: writerResult.fileId,
          readbackSha256: writerResult.sha256,
          byteLength: writerResult.byteLength,
          ...(verified.operationKind === "CREATE_FILE" ? { testOnly: true } : {}),
        });
      } catch {
        return {
          status: "UNAVAILABLE",
          code: "APPROVAL_AUDIT_UNAVAILABLE",
          record: toApprovalRecordView(verified, active, this.previewFor(verified)),
        };
      }
      return {
        status: "SUCCEEDED",
        code: "APPROVAL_VERIFIED",
        record: toApprovalRecordView(verified, active, this.previewFor(verified)),
        evidence: { fileId: writerResult.fileId, sha256: writerResult.sha256, byteLength: writerResult.byteLength },
      };
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : "";
      const codeMatch = rawMessage.match(/(?:^|:)([A-Z][A-Z0-9_:-]{0,120})$/);
      const nodeCode = error && typeof error === "object" && "code" in error
        && typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code : null;
      const detail = codeMatch?.[1] ?? (nodeCode ? `NODE_${nodeCode}` : error instanceof Error ? error.name : "UNCLASSIFIED");
      let auditUnavailable = false;
      try {
        await this.options.appendAudit({
          event: record.operationKind === "CREATE_FILE" ? "MCP_CREATE_TEST_WRITER_FAILED" : "MCP_UPDATE_WRITER_FAILED",
          profileId: record.profileId,
          workspaceId: record.workspaceId,
          requestId: record.requestId,
          failureCode: detail,
          ...(record.operationKind === "CREATE_FILE" ? { testOnly: true } : {}),
        });
      } catch {
        auditUnavailable = true;
      }
      let failed: ApprovalRecord;
      let resultUncertain = false;
      try {
        failed = await queue.failExecution(attempt.permit.token, "APPROVAL_EXECUTOR_FAILED");
      } catch {
        resultUncertain = true;
        try {
          failed = (await queue.get(input.requestId)) ?? record;
        } catch {
          failed = record;
        }
      }
      return {
        status: "UNAVAILABLE",
        code: resultUncertain ? "APPROVAL_RESULT_UNCERTAIN"
          : auditUnavailable ? "APPROVAL_AUDIT_UNAVAILABLE" : "APPROVAL_EXECUTOR_FAILED",
        record: toApprovalRecordView(failed, active, this.previewFor(failed)),
      };
    }
  }

  private previewFor(record: ApprovalRecord): RedactedDiffPreview {
    const payload = this.pendingMcpCreatePayloads.get(record.requestId);
    if (!payload || payload.expiresAtMs <= this.now()) return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
    if (record.operationKind === "REPLACE_FILE") {
      if (!payload.beforeContent) return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
      return createMcpUpdatePreview(payload.beforeContent, payload.content);
    }
    return createMcpContentPreview(payload.content);
  }

  private deletePendingMcpCreatePayload(requestId: string): void {
    const payload = this.pendingMcpCreatePayloads.get(requestId);
    payload?.content.fill(0);
    payload?.beforeContent?.fill(0);
    this.pendingMcpCreatePayloads.delete(requestId);
  }

  private removeExpiredMcpCreatePayloads(): void {
    for (const [requestId, payload] of this.pendingMcpCreatePayloads) {
      if (payload.expiresAtMs <= this.now()) {
        payload.content.fill(0);
        payload.beforeContent?.fill(0);
        this.pendingMcpCreatePayloads.delete(requestId);
      }
    }
  }

  private async isUpdatePolicyStillAuthorized(active: ProfileConfig, targetPath: string): Promise<boolean> {
    try {
      const workspaceId = active.currentWorkspace.workspaceId;
      const workspaceRoot = active.currentWorkspace.root;
      if (!workspaceId || !workspaceRoot) return false;
      const store = new WritePolicyStore(this.options.stateRoot);
      const policy = await store.load();
      if (!policy.enabled || !policy.tools.updateFile) return false;
      if ((policy.deviceId && policy.deviceId !== active.deviceId)
        || (policy.profileId && policy.profileId !== active.profileId)
        || (policy.workspaceId && policy.workspaceId !== workspaceId)
        || (policy.workspaceRoot && normalizePathForComparison(policy.workspaceRoot) !== normalizePathForComparison(workspaceRoot))) {
        return false;
      }
      return await store.checkPath(targetPath) === null;
    } catch {
      return false;
    }
  }

  private acl(active: ProfileConfig): FolderAclStore {
    return new FolderAclStore({
      stateRoot: this.options.stateRoot,
      profileId: active.profileId,
      profileName: active.profileName,
      workspaceId: active.currentWorkspace.workspaceId!,
      workspaceRoot: active.currentWorkspace.root,
      now: this.now,
    });
  }

  private queue(active: ProfileConfig): ApprovalQueue {
    const acl = this.acl(active);
    return new ApprovalQueue({
      stateRoot: this.options.stateRoot,
      profileId: active.profileId,
      workspaceId: active.currentWorkspace.workspaceId!,
      workspaceRoot: active.currentWorkspace.root!,
      acl,
      getActiveIdentity: async () => {
        const current = await this.options.getActiveProfile();
        return {
          profileId: current?.profileId ?? null,
          workspaceId: current?.currentWorkspace.workspaceId ?? null,
          workspaceRoot: current?.currentWorkspace.root ?? null,
        };
      },
      appendAudit: async (event) => {
        await this.options.appendAudit({
          event: event.event,
          profileId: event.profileId,
          workspaceId: event.workspaceId,
          requestId: event.requestId,
          revision: event.revision,
          timestamp: event.timestamp,
          resultCode: event.resultCode,
          operationDigest: event.operationDigest,
          contentDigest: event.contentDigest,
          ...(event.source ? { source: { ...event.source } } : {}),
        });
      },
      now: this.now,
    });
  }

  private async requireActiveWorkspace(): Promise<ProfileConfig> {
    const active = await this.options.getActiveProfile();
    if (!active) throw new SecurityControlError("SECURITY_ACTIVE_PROFILE_UNAVAILABLE");
    if (!active.currentWorkspace.workspaceId || !active.currentWorkspace.root) {
      throw new SecurityControlError("SECURITY_WORKSPACE_REQUIRED");
    }
    return active;
  }

  private async requireMutableWorkspace(): Promise<ProfileConfig> {
    const active = await this.requireActiveWorkspace();
    if (active.profileType === "company") throw new SecurityControlError("COMPANY_PROFILE_PROTECTED");
    return active;
  }
}

function isValidMcpCreateRequest(value: unknown): value is RuntimeCreateIntentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<RuntimeCreateIntentRequest>;
  const caller = request.caller;
  const intent = request.intent;
  if (typeof request.runtimeInstanceId !== "string" || !/^c2c_ri_[A-Za-z0-9_-]{8,128}$/.test(request.runtimeInstanceId)
    || (request.correlationId !== undefined && (typeof request.correlationId !== "string"
      || !/^c2c_ri_[A-Za-z0-9_-]{8,128}:[1-9][0-9]{0,15}$/.test(request.correlationId)))
    || !caller || typeof caller !== "object" || !intent || typeof intent !== "object") return false;
  const requestId = caller.requestId;
  return typeof caller.clientId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(caller.clientId)
    && (typeof requestId === "string" ? requestId.length >= 1 && requestId.length <= 128
      : typeof requestId === "number" && Number.isSafeInteger(requestId))
    && intent.operation === "CREATE" && typeof intent.relativePath === "string"
    && isSafeMcpCreatePath(intent.relativePath) && typeof intent.content === "string"
    && !intent.content.includes("\0") && Buffer.byteLength(intent.content, "utf8") <= 1_000_000;
}

function isValidMcpUpdateRequest(value: unknown): value is RuntimeUpdateIntentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<RuntimeUpdateIntentRequest>;
  const caller = request.caller;
  const intent = request.intent;
  if (typeof request.runtimeInstanceId !== "string" || !/^c2c_ri_[A-Za-z0-9_-]{8,128}$/.test(request.runtimeInstanceId)
    || (request.correlationId !== undefined && (typeof request.correlationId !== "string"
      || !/^c2c_ri_[A-Za-z0-9_-]{8,128}:[1-9][0-9]{0,15}$/.test(request.correlationId)))
    || !caller || typeof caller !== "object" || !intent || typeof intent !== "object") return false;
  const requestId = caller.requestId;
  return typeof caller.clientId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(caller.clientId)
    && (typeof requestId === "string" ? requestId.length >= 1 && requestId.length <= 128
      : typeof requestId === "number" && Number.isSafeInteger(requestId))
    && intent.operation === "UPDATE" && typeof intent.relativePath === "string"
    && isSafeMcpCreatePath(intent.relativePath) && typeof intent.content === "string"
    && !intent.content.includes("\0") && Buffer.byteLength(intent.content, "utf8") <= 1_000_000
    && typeof intent.expectedTargetSha256 === "string" && /^[a-f0-9]{64}$/.test(intent.expectedTargetSha256);
}

function isSafeMcpCreatePath(value: string): boolean {
  if (!value || value.length > 32_768 || value.trim() !== value || value.includes("\0") || value.includes(":")) return false;
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) return false;
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) return false;
  return !parts.some((part) => {
    const lower = part.toLowerCase();
    return lower === ".git" || lower === ".env" || lower.startsWith(".env.")
      || /(^|[-_.])(credential|credentials|secret|secrets|oauth-store|auth-store)([-_.]|$)/.test(lower)
      || /\.(pem|key|pfx|p12)$/.test(lower);
  });
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(normalizePathForComparison(root), normalizePathForComparison(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function toPermission(access: FolderAclAddInput["access"]): FolderPermission {
  switch (access) {
    case "READ_ONLY": return "read";
    case "READ_WRITE": return "write";
    case "DENY": return "none";
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toFolderAccessEntry(rule: FolderAclRule, active: ProfileConfig, redactPath = true): FolderAccessEntry {
  return {
    ruleId: rule.id,
    profileId: active.profileId,
    profileName: active.profileName,
    workspaceId: active.currentWorkspace.workspaceId!,
    folderPath: redactPath ? redactString(rule.path) : rule.path,
    access: rule.permission === "read" ? "READ_ONLY" : rule.permission === "write" ? "READ_WRITE" : "DENY",
    extensionPolicy: rule.extensions === null
      ? { mode: "ALLOW_ALL", deniedExtensions: [] }
      : { mode: "ALLOW_LIST", allowedExtensions: [...rule.extensions], deniedExtensions: [] },
    inheritance: "DIRECT",
    updatedAt: rule.updatedAt,
    revision: rule.revision,
  };
}

function requireLocalAclConfirmation(value: unknown): void {
  if (value !== "LOCAL_CONFIRMED") throw new SecurityControlError("ACL_LOCAL_CONFIRMATION_REQUIRED");
}

function assertConfirmedIdentity(active: ProfileConfig, profileId: string, workspaceId: string, workspaceRoot: string): void {
  if (!profileId || !workspaceId || !workspaceRoot
    || active.profileId !== profileId
    || active.currentWorkspace.workspaceId !== workspaceId
    || normalizePathForComparison(active.currentWorkspace.root ?? "") !== normalizePathForComparison(workspaceRoot)) {
    throw new SecurityControlError("ACL_PROFILE_OR_WORKSPACE_CHANGED");
  }
}

function createMcpContentPreview(content: Uint8Array): RedactedDiffPreview {
  if (content.byteLength > MAX_MCP_CREATE_PREVIEW_BYTES) return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
  const text = Buffer.from(content).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(content))) return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
  if (redactString(text) !== text) return { state: "REDACTED", lines: [], omittedLineCount: 0 };
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_MCP_CREATE_PREVIEW_LINES) return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
  return {
    state: "AVAILABLE",
    lines: lines.map((line) => ({ kind: "ADD" as const, text: line })),
    omittedLineCount: 0,
  };
}

function createMcpUpdatePreview(before: Uint8Array, after: Uint8Array): RedactedDiffPreview {
  if (before.byteLength > MAX_MCP_CREATE_PREVIEW_BYTES || after.byteLength > MAX_MCP_CREATE_PREVIEW_BYTES) {
    return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
  }
  const beforeText = Buffer.from(before).toString("utf8");
  const afterText = Buffer.from(after).toString("utf8");
  if (!Buffer.from(beforeText, "utf8").equals(Buffer.from(before))
    || !Buffer.from(afterText, "utf8").equals(Buffer.from(after))) {
    return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
  }
  if (redactString(beforeText) !== beforeText || redactString(afterText) !== afterText) {
    return { state: "REDACTED", lines: [], omittedLineCount: 0 };
  }
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  if (beforeLines.length > MAX_MCP_CREATE_PREVIEW_LINES || afterLines.length > MAX_MCP_CREATE_PREVIEW_LINES) {
    return { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 };
  }

  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix += 1;

  const contextBefore = beforeLines.slice(Math.max(0, prefix - 3), prefix);
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const contextAfter = suffix > 0
    ? afterLines.slice(afterLines.length - suffix, Math.min(afterLines.length, afterLines.length - suffix + 3))
    : [];
  const omittedLineCount = Math.max(0, prefix - contextBefore.length) + Math.max(0, suffix - contextAfter.length);

  return {
    state: "AVAILABLE",
    lines: [
      ...contextBefore.map((line) => ({ kind: "CONTEXT" as const, text: line })),
      ...removed.map((line) => ({ kind: "REMOVE" as const, text: line })),
      ...added.map((line) => ({ kind: "ADD" as const, text: line })),
      ...contextAfter.map((line) => ({ kind: "CONTEXT" as const, text: line })),
    ],
    omittedLineCount,
  };
}

function toApprovalRecordView(
  record: ApprovalRecord,
  active: ProfileConfig,
  diff: RedactedDiffPreview = { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 },
): ApprovalRecordView {
  const lastDecision = record.decisions[record.decisions.length - 1];
  const lastAttempt = record.attempts[record.attempts.length - 1];
  return {
    requestId: record.requestId,
    revision: record.revision,
    profileId: record.profileId,
    profileName: active.profileName,
    workspaceId: record.workspaceId,
    targetPath: redactString(record.targetPath),
    operation: record.operationKind === "CREATE_FILE" ? "CREATE" : "UPDATE",
    summary: record.summary,
    requester: record.source ? { ...record.source } : null,
    decision: record.decision,
    execution: record.execution,
    verification: record.verification,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: lastDecision?.decidedAt ?? null,
    executedAt: lastAttempt?.finishedAt ?? lastAttempt?.startedAt ?? null,
    verifiedAt: lastAttempt?.verification !== "NOT_RUN" ? lastAttempt?.finishedAt ?? null : null,
    binding: {
      contentDigest: record.contentDigest,
      expectedTargetVersion: record.expectedTargetVersion,
      operationDigest: record.operationDigest,
    },
    diff,
    attemptCount: record.attemptCount,
    maxAttempts: record.attemptLimit,
    lastFailureCode: record.failureCode ?? null,
  };
}

export type { AccessVerdict };
