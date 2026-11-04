// Shared types between Electron main and renderer.
// These types are the SINGLE SOURCE OF TRUTH for the IPC contract.

// ===== Identity =====

export type DeviceId = string;
export type ProfileId = string;
export type RuntimeId = string;
export type RuntimeInstanceId = string;
export type WorkspaceId = string;

// ===== Profile =====

export type ProfileType = "company" | "home" | "custom";

export interface ProfileSummary {
  profileId: ProfileId;
  profileName: string;
  profileType: ProfileType;
  createdAt: string;
  currentWorkspaceRoot: string | null;
  currentWorkspaceId: WorkspaceId | null;
  transportProvider: string | null;
  publicMcpUrl: string | null;
  expectedLocalPort?: number;
}

export interface ProfileConfig {
  schemaVersion: string;
  profileId: ProfileId;
  profileName: string;
  profileType: ProfileType;
  createdAt: string;
  deviceId: DeviceId;
  runtimeId: RuntimeId;
  currentWorkspace: {
    root: string | null;
    workspaceId: WorkspaceId | null;
  };
  transport: {
    transportId: string | null;
    provider: string | null;
    tunnelName: string | null;
    tunnelId: string | null;
    hostname: string | null;
    zone: string | null;
    publicMcpUrl: string | null;
    expectedLocalPort: number;
    /** Explicit V2-owned cloudflared binary; never Legacy state. */
    binaryPath?: string | null;
    /** Explicit V2-owned credential path; secret contents never cross IPC. */
    credentialPath?: string | null;
  };
  expectedLocalHost: string;
  runtime: {
    source: "PACKAGED_V2" | "EXTERNAL_DEV" | "LEGACY_MIGRATION";
    binaryPath: string | null;
    entryPath: string | null;
  };
  trustedRedirectPolicy: {
    source: string;
    builtinOrigins: string[];
    userApprovedOrigins: string[];
    signedPolicyUpdates: unknown[];
  };
  chatgptLaunchUrl: string;
  healthCheckIntervalSec: number;
  autoStart: { atLogin: boolean; minimized: boolean };
  autoRepair: {
    policy: "STRICT_FAIL_CLOSED" | "SAFE_AUTO_REPAIR";
    maxRetriesPerDay: number;
    cooldownSec: number;
  };
}

export interface OrdinarySettingsPatch {
  healthCheckIntervalSec?: number;
  autoStart?: Partial<ProfileConfig["autoStart"]>;
}

export interface OrdinarySettingsValues {
  healthCheckIntervalSec: number;
  autoStart: ProfileConfig["autoStart"];
}

export interface OrdinarySettingsUpdateResult {
  profileId: ProfileId;
  values: OrdinarySettingsValues;
  persisted: true;
}

export type ServiceTransportProvider = "LOCAL_ONLY" | "CLOUDFLARE_NAMED";

export interface ServiceConnectionSettingsPatch {
  expectedProfileId: ProfileId;
  provider: ServiceTransportProvider;
  hostname?: string | null;
  tunnelName?: string | null;
  tunnelId?: string | null;
  zone?: string | null;
  binaryPath?: string | null;
  credentialPath?: string | null;
}

export interface ServiceConnectionSettingsView {
  profileId: ProfileId;
  provider: ServiceTransportProvider;
  expectedLocalHost: string;
  expectedLocalPort: number;
  hostname: string | null;
  tunnelName: string | null;
  tunnelId: string | null;
  zone: string | null;
  publicMcpUrl: string | null;
  binaryPath: string | null;
  credentialConfigured: boolean;
  chatgptLaunchUrl: string;
}

export interface ServiceConnectionSettingsUpdateResult {
  changed: boolean;
  restartRequired: boolean;
  settings: ServiceConnectionSettingsView;
}

export interface ServiceCredentialImportResult {
  canceled: boolean;
  profileId: ProfileId | null;
  fileName: string | null;
  storedPath: string | null;
}

// ===== Write Policy (owner-authorized local writes) =====

export const WRITE_POLICY_SCHEMA_VERSION = 2 as const;

export type WriteToolId =
  | "createFile"
  | "updateFile"
  | "deleteFile"
  | "executeCommand"
  | "gitCommit"
  | "powershell";

export interface WriteToolToggles {
  createFile: boolean;
  updateFile: boolean;
  deleteFile: boolean;
  executeCommand: boolean;
  gitCommit: boolean;
  powershell: boolean;
}

export const DEFAULT_WRITE_TOOL_TOGGLES: WriteToolToggles = {
  createFile: false,
  updateFile: false,
  deleteFile: false,
  executeCommand: false,
  gitCommit: false,
  powershell: false,
};

export interface WritePolicy {
  schemaVersion: typeof WRITE_POLICY_SCHEMA_VERSION;
  /** Legacy-compatible file-write toggle. */
  enabled: boolean;
  /** Independent, default-off arbitrary PowerShell execution toggle. */
  powershellEnabled: boolean;
  /** Per-tool owner toggles, all default off. */
  tools: WriteToolToggles;
  /** Device/Profile/Workspace binding; null only for migrated legacy policy. */
  deviceId: DeviceId | null;
  profileId: ProfileId | null;
  workspaceId: WorkspaceId | null;
  workspaceRoot: string | null;
  /** Absolute paths the owner allows writes to. */
  allowedDirectories: string[];
  /** Optional exact file paths allowed in addition to the directory list. */
  allowedFiles: string[];
  /** Max bytes per single file write. Default 1MB. */
  maxBytesPerWrite: number;
  /** Max entries in the directory and file allowlists. */
  maxAllowedDirectories: number;
  maxAllowedFiles: number;
  updatedAt: string;
  updatedBy: string;
}

export interface WritePolicyUpdate {
  enabled?: boolean;
  powershellEnabled?: boolean;
  tools?: Partial<WriteToolToggles>;
  deviceId?: DeviceId | null;
  profileId?: ProfileId | null;
  workspaceId?: WorkspaceId | null;
  workspaceRoot?: string | null;
  allowedDirectories?: string[];
  allowedFiles?: string[];
  maxBytesPerWrite?: number;
}

export interface WritePolicyUpdateResult {
  policy: WritePolicy;
  /** True if this update changed the policy. */
  changed: boolean;
}

export interface WriteAuditEntry {
  sequence: number;
  timestamp: string;
  actor: {
    /** OAuth client_id from the bearer token. "unknown" if absent. */
    clientId: string;
    requestId: string | null;
  };
  workspaceId: string;
  /** Workspace-relative target path or working directory. */
  relativePath: string;
  operation: "CREATE" | "OVERWRITE" | "UPDATE" | "DELETE" | "PATCH" | "LEGACY_WRITE" | "POWERSHELL" | "EXECUTE_COMMAND" | "GIT_COMMIT";
  bytesWritten: number;
  beforeSha256: string | null;
  afterSha256: string | null;
  outcome: "STARTED" | "WRITTEN" | "COMPLETED" | "DENIED" | "FAILED";
  source: "runtime" | "legacy";
  reasonCode?: string;
  backupRef?: string;
}

// ===== Workspace =====

export interface WorkspaceInfo {
  root: string;
  workspaceId: WorkspaceId;
  exists: boolean;
  isGitRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
}

export interface WorkspaceCandidate {
  root: string;
  workspaceId: WorkspaceId;
  isGitRepo: boolean;
  projectType: string;
  languages: string[];
  frameworks: string[];
}

/**
 * Bounded Git change summary. Only exposes file paths and line-count stats;
 * never diff bodies or file contents, so it cannot leak source material.
 *
 * When `available` is false the summary MUST NOT be read as "no changes".
 * `reasonCode` distinguishes a genuine non-Git directory from a git command
 * that failed, so the UI can fail closed instead of showing a false clean tree.
 */
export interface GitChangeSummary {
  available: boolean;
  isGitRepo: boolean;
  branch: string | null;
  changedFiles: Array<{ path: string; status: string }>;
  stats: { filesChanged: number; insertions: number; deletions: number };
  truncated: boolean;
  reasonCode?: "NOT_A_GIT_REPO" | "GIT_COMMAND_FAILED";
}

// ===== Readiness Layers =====

export type LayerState = "PASS" | "DEGRADED" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";

export interface ReadinessSnapshot {
  overall: "GREEN" | "YELLOW" | "RED" | "GRAY";
  lastStateCheckAt: string | null;
  lastFullVerification: string | null;
  lastError: string | null;
  layers: {
    runtime: LayerState;
    transport: LayerState;
    connector: LayerState;
    conversation: LayerState;
    workspace: LayerState;
    repository: LayerState;
  };
  c2cFullReady: boolean;
}

// ===== Transaction (Workspace Change) =====

export type TxPhase =
  | "PREPARE"
  | "CANDIDATE"
  | "COMMITTING"
  | "COMMITTED"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "FAILED";

export type TxStepState = "IDLE" | "PREPARED" | "COMPLETED";
export type TxNextAction =
  | "NONE"
  | "PROMOTE_PENDING"
  | "UPDATE_PROFILE"
  | "REVOKE_OLD_GRANT"
  | "FINALIZE";

export type TxStep =
  | "PREPARED"
  | "CANDIDATE_VERIFIED"
  | "PENDING_PROMOTED"
  | "PROFILE_UPDATED"
  | "OLD_GRANT_REVOKED"
  | "COMMITTED"
  | "ROLLBACK_STARTED"
  | "ROLLED_BACK";

export interface TransactionJournal {
  transactionId: string;
  profileId: ProfileId;
  oldWorkspaceId: WorkspaceId | null;
  newWorkspaceId: WorkspaceId | null;
  oldWorkspaceRoot: string | null;
  newWorkspaceRoot: string | null;
  phase: TxPhase;
  stepState: TxStepState;
  nextAction: TxNextAction;
  lastCompletedStep: TxStep | null;
  commitStarted: boolean;
  pendingPromoted: boolean;
  profileUpdated: boolean;
  oldGrantRevoked: boolean;
  commitCompleted: boolean;
  rollbackStarted: boolean;
  rollbackCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

// ===== Connection Intent =====

export type IntentStatus =
  | "PENDING"
  | "CLIENT_BOUND"
  | "CONSENT_PENDING"
  | "CONSUMED"
  | "EXPIRED"
  | "REVOKED"
  | "REVOKED_RUNTIME_RESTART";

export interface ConnectionIntent {
  intentId: string;
  deviceId: DeviceId;
  profileId: ProfileId;
  runtimeId: RuntimeId;
  runtimeInstanceId: RuntimeInstanceId;
  workspaceId: WorkspaceId;
  status: IntentStatus;
  createdAt: string;
  expiresAt: string;
  candidateClientId: string | null;
  candidateClientName: string | null;
  candidateRedirectUris: string[];
  requestedScopes: string[];
  revokeReason?: string;
}

// ===== IPC Contract =====

export interface IpcRequest<TParams = unknown> {
  capability: string;
  params: TParams;
  ts: string;
  nonce: string;
}

export interface IpcResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export type IpcCapability =
  | "profile:list"
  | "profile:create"
  | "profile:set-active"
  | "profile:get-active"
  | "profile:switch"
  | "profile:delete"
  | "profile:read"
  | "profile:update"
  | "workspace:pick"
  | "workspace:validate"
  | "workspace:detect"
  | "workspace:change-prepare"
  | "workspace:change-commit"
  | "workspace:change-cancel"
  | "workspace:git-changes"
  | "readiness:get"
  | "intent:create"
  | "intent:status"
  | "intent:open-chatgpt"
  | "diagnostics:run"
  | "diagnostics:export-bundle"
  | "diagnostics:cases:read"
  | "diagnostics:repairs:read"
  | "diagnostics:repair:execute"
  | "diagnostics:history:read"
  | "collaboration:executions:read"
  | "security:folder-acl:read"
  | "security:folder-acl:add"
  | "security:folder-acl:remove"
  | "security:folder-acl:check"
  | "security:folder-acl:pick"
  | "security:approvals:read"
  | "security:approvals:decide"
  | "security:approvals:revoke"
  | "security:approvals:execute"
  | "logs:read"
  | "settings:read"
  | "settings:update"
  | "settings:ordinary:update"
  | "settings:backup:export"
  | "settings:backup:import"
  | "write-policy:get"
  | "write-policy:set"
  | "write-policy:add-dir"
  | "write-policy:remove-dir"
  | "write-policy:audit"
  | "codex:status:get"
  | "codex:pairing:create"
  | "tunnel:local:manage"
  | "connection:diagnose"
  | "connection:repair"
  | "peer:inspect"
  | "peer:open-panel"
  | "peer:set-dangerous"
  | "services:discover"
  | "tunnel:named:manage"
  | "tools:policy:manage"
  | "datasources:manage"
  | "network:manage"
  | "service:runtime:restart"
  | "runtime:port:check"
  | "audit:tool:status"
  | "jobs:read"
  | "jobs:manage"
  | "service:multi:list"
  | "service:multi:create"
  | "service:multi:start"
  | "service:multi:stop"
  | "service:transport:restart"
  | "service:pairing:create"
  | "service:pairing:clear"
  | "screen:windows:read"
  | "screen:capture";

// ===== Screen Capture (local-only raw preview boundary) =====

export type ScreenWindowScope = "ACTIVE_WINDOW" | "SELECTED_WINDOW" | "FULL_SCREEN";

export interface ScreenWindowSummary {
  windowId: string;
  title: string;
  active: boolean;
  protected: boolean;
}

export interface ScreenAccessSnapshot {
  observedAt: string | null;
  fresh: boolean | null;
  freshnessReason: string | null;
  authorization: "AUTHORIZED" | "NOT_AUTHORIZED" | "UNKNOWN";
  scope: ScreenWindowScope | null;
  windowEnumeration: {
    state: "AVAILABLE" | "FAILED" | "NOT_AVAILABLE";
    windows: readonly ScreenWindowSummary[];
    reasonCode: string | null;
    reason: string | null;
  };
  capture: {
    state: "SUCCEEDED" | "FAILED" | "NOT_REQUESTED" | "UNKNOWN";
    capturedAt: string | null;
    reasonCode: string | null;
    reason: string | null;
    preview: {
      redacted: boolean;
      localOnlyApproved?: boolean;
      dataUrl: string;
      expiresAt: string;
    } | null;
  };
}

// ===== Diagnostics =====

export interface OAuthAuthorizationStatus {
  state: "UNKNOWN" | "NOT_CONFIGURED" | "WORKSPACE_REQUIRED" | "AUTH_REQUIRED" | "REVOKED" | "EXPIRED" | "AUTHORIZED";
  activeClientCount: number;
  validWorkspaceGrant: boolean | null;
  observedAt: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  appVersion: string;
  osVersion: string;
  profileMetadata: ProfileSummary | null;
  readiness: ReadinessSnapshot;
  runtime: {
    pid: number | null;
    port: number | null;
    identity: { deviceId: DeviceId; profileId: ProfileId; runtimeId: RuntimeId; runtimeInstanceId: RuntimeInstanceId; workspaceId: WorkspaceId } | null;
    healthEndpointOk: boolean;
    processCmdline?: string | null;
    processExe?: string | null;
    processStartTime?: string | null;
    workspaceIdMatches?: boolean | null;
    portListening?: boolean | null;
  };
  transport: {
    provider: string | null;
    publicUrl: string | null;
    edgeConnected: boolean;
    publicHealthStatus: number | null;
    publicMcpAnonymous: number | null;
    oauthDiscoveryOk: boolean;
    processAlive?: boolean;
    binaryFound?: boolean;
    binaryPath?: string | null;
  };
  /** Local OAuth/grant state from the existing ProfileClientRegistry and WorkspaceGrantStore. */
  oauthAuthorization?: OAuthAuthorizationStatus;
  workspace: { root: string | null; workspaceId: WorkspaceId | null; isGitRepo: boolean };
  repository: { isGitRepo: boolean; branch: string | null; dirty: boolean | null };
  secretStore: { dpapiOk: boolean; encryptionBackend?: "dpapi" | "aes-gcm-fallback" | "none" };
  watchdog: { alive: boolean; lastHeartbeatAt: string | null; status?: "NOT_STARTED" | "ALIVE" | "DEAD" | "UNKNOWN" };
  supervisor: { alive: boolean; lastHeartbeatAt: string | null; pid?: number | null; startedAt?: string | null; commandImage?: string | null };
  recentRecoveryActions: Array<{ at: string; signal: string; action: string; result: string }>;
  sanitizedLogsTail: string[];
}

export type SafeFaultCode =
  | "ACTIVE_PROFILE_UNRESOLVED"
  | "PROFILE_IDENTITY_MISMATCH"
  | "LOCAL_RUNTIME_NOT_READY"
  | "PORT_LISTENER_OWNER_UNKNOWN"
  | "TUNNEL_PROCESS_MISSING"
  | "TUNNEL_EDGE_UNAVAILABLE"
  | "PUBLIC_530"
  | "PUBLIC_OAUTH_DISCOVERY_UNVERIFIED"
  | "WORKSPACE_IDENTITY_UNAVAILABLE"
  | "WORKSPACE_IDENTITY_MISMATCH"
  | "OAUTH_AUTH_STATE_UNAVAILABLE";

export type FaultResponseState = "OK" | "NO_DATA" | "STALE" | "UNAVAILABLE";

export interface FaultCasesRequest {
  query?: string;
  limit?: number;
  cursor?: string;
  expectedProfileId?: string;
}

export interface FaultCaseView {
  signature: string;
  code: SafeFaultCode;
  layer: "runtime" | "transport" | "connector" | "workspace" | "profile";
  state: "OPEN" | "RESOLVED";
  evidenceStatus: "OBSERVED";
  rootCauseStatus: "CANDIDATE";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  evidenceCodes: string[];
  matchingLessonIds: string[];
  latestRepairAttemptId: string | null;
}

export interface FaultCasesResponse {
  state: FaultResponseState;
  activeProfileId: string | null;
  observedAt: string;
  staleAfterMs: number;
  source: "audit-chain-projection";
  cases: FaultCaseView[];
  nextCursor: string | null;
  reasonCode?: string;
}

export interface MatchRepairOptionsRequest {
  signature: string;
  expectedProfileId: string;
  expectedWorkspaceId: string | null;
  diagnosisObservedAt: string;
}

export interface RepairSuggestionView {
  suggestionId: RepairSuggestionId;
  title: string;
  evidenceStatus: "CANDIDATE" | "HIGH_CONFIDENCE";
  matchBasis: string[];
  sourceLessonIds: string[];
  risk: "LOW" | "MANUAL_ONLY";
  executable: boolean;
  reasonCode: string | null;
  requiresNativeConfirmation: boolean;
}

export interface MatchRepairOptionsResponse {
  state: "OK" | "NO_MATCH" | "CANDIDATE_ONLY" | "STALE" | "UNAVAILABLE";
  signature: string;
  activeProfileId: string | null;
  observedAt: string;
  staleAfterMs: number;
  suggestions: RepairSuggestionView[];
  reasonCode?: string;
}

export interface RunRepairRequest extends MatchRepairOptionsRequest {
  suggestionId: RepairSuggestionView["suggestionId"];
}

export const REPAIR_SUGGESTION_IDS = [
  "START_PROFILE_RUNTIME",
  "START_PROFILE_TUNNEL",
  "RESTART_PROFILE_TUNNEL",
  "RETRY_PUBLIC_530",
  "INVALID_REQUEST",
] as const;
export type RepairSuggestionId = typeof REPAIR_SUGGESTION_IDS[number];

export function isRepairSuggestionId(value: unknown): value is RepairSuggestionId {
  return typeof value === "string" && (REPAIR_SUGGESTION_IDS as readonly string[]).includes(value);
}

/** Validate untrusted JSON at IPC/Supervisor boundaries; TypeScript types do not validate IPC payloads. */
export function isRunRepairRequest(value: unknown): value is RunRepairRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.signature === "string" && /^fault:v1:[a-f0-9]{64}$/.test(request.signature) &&
    typeof request.expectedProfileId === "string" && request.expectedProfileId.length > 0 && request.expectedProfileId.length <= 128 &&
    (request.expectedWorkspaceId === null || (typeof request.expectedWorkspaceId === "string" && request.expectedWorkspaceId.length <= 128)) &&
    typeof request.diagnosisObservedAt === "string" && Number.isFinite(Date.parse(request.diagnosisObservedAt)) &&
    isRepairSuggestionId(request.suggestionId) && request.suggestionId !== "INVALID_REQUEST";
}

export interface RepairAttemptView {
  attemptId: string;
  signature: string;
  code: SafeFaultCode;
  suggestionId: RepairSuggestionView["suggestionId"];
  result: "STARTED" | "SUCCEEDED" | "FAILED" | "REJECTED" | "CANCELLED" | "STALE" | "UNVERIFIED";
  actionState: "NOT_STARTED" | "STARTED" | "COMPLETED";
  evidenceStatus: "CANDIDATE" | "HIGH_CONFIDENCE";
  startedAt: string;
  completedAt: string | null;
  postCheck: { state: "PASS" | "FAIL" | "NOT_RUN"; observedAt: string | null; reasonCode: string };
  rollback: { state: "NOT_REQUIRED" | "COMPLETED" | "FAILED" | "MANUAL_REQUIRED" | "UNKNOWN"; reasonCode: string | null };
}

export interface RunRepairResponse extends RepairAttemptView {
  source: "audit-chain";
}

export interface RepairHistoryRequest {
  query?: string;
  limit?: number;
  cursor?: string;
  expectedProfileId?: string;
}

export interface RepairHistoryResponse {
  state: FaultResponseState;
  activeProfileId: string | null;
  observedAt: string;
  staleAfterMs: number;
  source: "audit-chain-projection";
  entries: RepairAttemptView[];
  nextCursor: string | null;
  reasonCode?: string;
}

// ===== Execution Store read projection =====

export interface ExecutionRecordSummary {
  id: string;
  taskId: string;
  iteration: number;
  timestamp: string;
  changedFiles: string[];
  tests: Array<{
    category: string;
    command?: string;
    passed: boolean;
    testCount?: number;
    failedCount?: number;
  }>;
  status: "PASS" | "FAIL" | "UNKNOWN";
  summary: string;
  publicOutput: boolean;
  /**
   * Derived projection field (not stored on disk). The Runtime injects its
   * current identity.runtimeInstanceId so consumers can refuse records left
   * by a prior crashed session (a stale `exec_runtime_ready` will not match
   * the live runtimeInstanceId). null only if this Runtime cannot identify
   * itself, which is not expected for any configured session.
   */
  runtimeInstanceId: string | null;
}

export interface ExecutionListResponse {
  available: boolean;
  source: "execution-store";
  /**
   * runtimeInstanceId of the Runtime that produced this projection. Consumers
   * MUST compare it against the current Supervisor's session id before
   * interpreting an `exec_runtime_ready` record as evidence of current
   * health: a stale record left in the Execution Store from a prior
   * crashed session will not match the live runtimeInstanceId.
   */
  runtimeInstanceId: string | null;
  records: ExecutionRecordSummary[];
}

export interface ExecutionOutputResponse {
  available: boolean;
  source: "execution-store";
  id: string;
  output: string;
  /** Same stale-record guard as ExecutionListResponse. */
  runtimeInstanceId: string | null;
}

// ===== Audit =====

export interface AuditEntry {
  sequence: number;
  timestamp: string;
  previousHash: string;
  payloadHash: string;
  payload: {
    event: string;
    signal?: string;
    policy?: string;
    action?: string;
    result?: string;
    metadata?: Record<string, unknown>;
  };
}






