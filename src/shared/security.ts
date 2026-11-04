/** Typed, redacted security projections shared by Main, Preload, and Renderer. */
import type { ProfileType } from "./types.js";

export type FolderAccess = "READ_ONLY" | "READ_WRITE" | "DENY";

export type ExtensionPolicy =
  | { mode: "ALLOW_ALL"; deniedExtensions: string[] }
  | { mode: "ALLOW_LIST"; allowedExtensions: string[]; deniedExtensions: string[] };

export interface FolderAccessEntry {
  ruleId: string;
  profileId: string;
  profileName: string;
  workspaceId: string;
  folderPath: string;
  access: FolderAccess;
  extensionPolicy: ExtensionPolicy;
  inheritance: "DIRECT" | "INHERITED";
  updatedAt: string;
  revision: number;
}

export interface FolderAclSnapshot {
  profileId: string;
  profileName: string;
  profileType: ProfileType;
  workspaceId: string;
  observedAt: string;
  staleAfterMs: number;
  revision: number;
  mutationAvailability: "AVAILABLE" | "PROFILE_PROTECTED";
  mutationBlockReason: "PROTECTED_PROFILE" | null;
  entries: FolderAccessEntry[];
}

export type FolderAccessVerdict =
  | {
      allowed: true;
      profileId: string;
      workspaceId: string;
      canonicalPath: string;
      operation: "read" | "write";
      ruleId: string;
      aclRevision: number;
    }
  | {
      allowed: false;
      profileId: string;
      workspaceId: string;
      canonicalPath: string | null;
      operation: "read" | "write";
      ruleId: string | null;
      reason:
        | "INVALID_PATH"
        | "WORKSPACE_UNAVAILABLE"
        | "OUTSIDE_WORKSPACE"
        | "PATH_UNRESOLVABLE"
        | "NO_RULES"
        | "NO_MATCH"
        | "DENY_RULE"
        | "INSUFFICIENT_PERMISSION"
        | "EXTENSION_NOT_ALLOWED"
        | "ACL_SCOPE_MISMATCH"
        | "ACL_STORE_CORRUPT"
        | "ACL_STORE_UNAVAILABLE";
    };

export type ApprovalDecision = "PENDING" | "APPROVED" | "REJECTED" | "REVOKED" | "EXPIRED" | "STALE";
export type ApprovalExecution = "NOT_STARTED" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
export type ApprovalVerification = "VERIFIED" | "MISMATCH" | "NOT_RUN" | "UNAVAILABLE";

export interface RedactedDiffLine {
  kind: "CONTEXT" | "ADD" | "REMOVE";
  text: string;
}

export interface RedactedDiffPreview {
  state: "AVAILABLE" | "REDACTED" | "UNAVAILABLE";
  lines: RedactedDiffLine[];
  omittedLineCount: number;
}

export interface ApprovalRecordView {
  requestId: string;
  revision: number;
  profileId: string;
  profileName: string;
  workspaceId: string;
  targetPath: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "RENAME";
  summary: string;
  requester: {
    kind: "MCP";
    clientId: string;
    requestId: string | number;
    runtimeInstanceId: string;
  } | null;
  decision: ApprovalDecision;
  execution: ApprovalExecution;
  verification: ApprovalVerification;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  verifiedAt: string | null;
  binding: {
    contentDigest: string;
    expectedTargetVersion: string;
    operationDigest: string;
  };
  diff: RedactedDiffPreview;
  attemptCount: number;
  maxAttempts: number;
  lastFailureCode: string | null;
}

export interface ApprovalQueueSnapshot {
  profileId: string;
  profileName: string;
  profileType: ProfileType;
  workspaceId: string;
  observedAt: string;
  staleAfterMs: number;
  executionAvailability: "AVAILABLE" | "UNAVAILABLE";
  executionUnavailableReason: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" | null;
  records: ApprovalRecordView[];
}

export interface ApprovalQueueActionRef {
  requestId: string;
  expectedRevision: number;
}

export interface ApprovalRecordRef {
  requestId: string;
  revision: number;
}

export interface ApprovalDecisionActions {
  /** Approving is a decision only; Main shows a native confirmation first. */
  decide(request: ApprovalRecordRef, decision: "APPROVE" | "REJECT"): Promise<void>;
  /** Execution is a separate local action and is unavailable without a safe writer. */
  execute(request: ApprovalRecordRef): Promise<void>;
  revoke(request: ApprovalRecordRef): Promise<void>;
}

export type ApprovalExecutionActionResult =
  | {
    status: "UNAVAILABLE";
    code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" | "APPROVAL_STALE_REVISION" | "APPROVAL_NOT_EXECUTABLE"
      | "APPROVAL_EXPIRED" | "APPROVAL_PROFILE_CHANGED" | "APPROVAL_WORKSPACE_CHANGED" | "APPROVAL_ACL_CHANGED"
      | "APPROVAL_TARGET_CHANGED" | "APPROVAL_TARGET_EXISTS" | "APPROVAL_TARGET_UNAVAILABLE" | "APPROVAL_RETRY_LIMIT" | "APPROVAL_CONTENT_MISMATCH"
      | "APPROVAL_EXECUTION_INTERRUPTED" | "APPROVAL_EXECUTOR_FAILED" | "APPROVAL_EXECUTOR_TIMEOUT"
      | "APPROVAL_WRITE_PERMISSION_REVOKED" | "APPROVAL_AUDIT_UNAVAILABLE" | "APPROVAL_RESULT_UNCERTAIN";
    record: ApprovalRecordView;
  }
  | {
    status: "SUCCEEDED";
    code: "APPROVAL_VERIFIED";
    record: ApprovalRecordView;
    evidence: { fileId: string; sha256: string; byteLength: number };
  };

export interface FolderAclAddInput {
  path: string;
  access: FolderAccess;
  label?: string;
  extensionPolicy: { mode: "ALLOW_ALL" } | { mode: "ALLOW_LIST"; allowedExtensions: string[] };
}

export interface FolderAclRemoveInput {
  ruleId: string;
  expectedRevision: number;
}

/** Main-only trust marker; Renderer APIs must never accept or supply this field. */
export type LocalAclConfirmation = "LOCAL_CONFIRMED";

export interface ConfirmedFolderAclAddInput extends FolderAclAddInput {
  nativeConfirmation: LocalAclConfirmation;
  confirmedProfileId: string;
  confirmedWorkspaceId: string;
  confirmedWorkspaceRoot: string;
}

export interface ConfirmedFolderAclRemoveInput extends FolderAclRemoveInput {
  nativeConfirmation: LocalAclConfirmation;
  confirmedProfileId: string;
  confirmedWorkspaceId: string;
  confirmedWorkspaceRoot: string;
}

export interface FolderAclRuleConfirmationInput {
  ruleId: string;
  expectedRevision: number;
  expectedProfileId: string;
  expectedWorkspaceId: string;
  expectedWorkspaceRoot: string;
}

export interface FolderAccessCheckInput {
  path: string;
  operation: "read" | "write";
}

export interface ApprovalDecisionInput extends ApprovalQueueActionRef {
  decision: "APPROVE" | "REJECT";
}
