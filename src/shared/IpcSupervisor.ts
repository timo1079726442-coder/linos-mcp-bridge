/**
 * IpcSupervisor — common interface for both real SupervisorClient (production)
 * and SupervisorStub (tests/mock/fixture only).
 *
 * Per CP1 ARCHITECTURE_V2: production MUST use real SupervisorClient.
 * SupervisorStub is allowed only in unit tests and dev fixtures.
 */
import type {
  ProfileConfig, ProfileSummary, ProfileType, OrdinarySettingsPatch, OrdinarySettingsUpdateResult,
  ServiceConnectionSettingsPatch, ServiceConnectionSettingsUpdateResult, ServiceConnectionSettingsView, ServiceCredentialImportResult,
  WorkspaceInfo, WorkspaceCandidate, ConnectionIntent,
  DiagnosticsReport, ReadinessSnapshot, FaultCasesRequest, FaultCasesResponse,
  MatchRepairOptionsRequest, MatchRepairOptionsResponse, RunRepairRequest, RunRepairResponse,
  RepairHistoryRequest, RepairHistoryResponse, ExecutionListResponse, GitChangeSummary, ExecutionOutputResponse,
} from "./types.js";

import type { AgentTaskService } from "../main/agentTask/AgentTaskService.js";
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
  FolderAclRuleConfirmationInput,
  FolderAclSnapshot,
} from "./security.js";

export interface IpcSupervisor {
  listProfiles(): Promise<ProfileSummary[]>;
  createProfile(opts: { profileName: string; profileType: ProfileType; initialWorkspaceRoot?: string | null; expectedLocalPort?: number }): Promise<ProfileSummary>;
  getActiveProfile(): Promise<ProfileConfig | null>;
  updateOrdinarySettings(patch: OrdinarySettingsPatch): Promise<OrdinarySettingsUpdateResult>;
  getServiceConnectionSettings(): Promise<ServiceConnectionSettingsView>;
  updateServiceConnectionSettings(patch: ServiceConnectionSettingsPatch): Promise<ServiceConnectionSettingsUpdateResult>;
  importServiceCredential(sourcePath: string): Promise<ServiceCredentialImportResult>;
  setActiveProfile(profileId: string): Promise<void>;
  validateWorkspace(root: string): Promise<WorkspaceInfo>;
  detectWorkspace(root: string): Promise<WorkspaceCandidate>;
  /** 更换本机监听端口（48766 已允许；48765 永久禁止）。 */
  changeRuntimePort(port: number): Promise<{ ok: boolean; changed: boolean; port: number }>;
  /** grantAllScopes=true 时把本机全部 scope 作为本次连接的授权上限（全权模式）。 */
  createIntent(opts?: { grantAllScopes?: boolean }): Promise<ConnectionIntent>;
  listIntents(): Promise<ConnectionIntent[]>;
  getReadiness(): Promise<ReadinessSnapshot>;
  runDiagnostics(): Promise<DiagnosticsReport>;
  listFaultCases(params: FaultCasesRequest): Promise<FaultCasesResponse>;
  matchRepairOptions(params: MatchRepairOptionsRequest): Promise<MatchRepairOptionsResponse>;
  runRepair(params: RunRepairRequest, nativeConfirmation: "NOT_REQUIRED" | "LOCAL_CONFIRMED" | "LOCAL_CANCELLED"): Promise<RunRepairResponse>;
  listRepairHistory(params: RepairHistoryRequest): Promise<RepairHistoryResponse>;
  prepareWorkspaceChange(opts: { profileId: string; newWorkspaceRoot: string }): Promise<{ transactionId: string }>;
  commitWorkspaceChange(opts: { profileId: string }): Promise<{ action: "commit" | "noop" }>;
  listExecutionRecords(limit?: number): Promise<ExecutionListResponse>;
  getExecutionOutput(id: string): Promise<ExecutionOutputResponse | null>;
  getAgentTaskAvailability(): Promise<{
    dispatchEnabled: false;
    trustedBindingAvailable: false;
    executorCatalogAvailable: false;
    reasonCode: "TRUSTED_CATALOG_UNAVAILABLE";
  }>;
  submitAgentTask(request: Parameters<AgentTaskService["submit"]>[0]): ReturnType<AgentTaskService["submit"]>;
  getAgentTaskStatus(taskId: string): ReturnType<AgentTaskService["status"]>;
  cancelAgentTask(taskId: string): ReturnType<AgentTaskService["cancel"]>;
  getAgentTaskResult(taskId: string): ReturnType<AgentTaskService["result"]>;
  getAgentTaskEvidence(taskId: string): ReturnType<AgentTaskService["evidence"]>;
  restoreProfile(config: ProfileConfig): Promise<ProfileSummary>;
  gitChanges(root: string): Promise<GitChangeSummary>;

  getFolderAcl(): Promise<FolderAclSnapshot>;
  getFolderAclRuleForConfirmation(input: FolderAclRuleConfirmationInput): Promise<FolderAccessEntry | null>;
  addFolderAclRule(input: ConfirmedFolderAclAddInput): Promise<FolderAccessEntry>;
  removeFolderAclRule(input: ConfirmedFolderAclRemoveInput): Promise<{ removed: boolean; revision: number }>;
  checkFolderAccess(input: FolderAccessCheckInput): Promise<FolderAccessVerdict>;
  listApprovals(): Promise<ApprovalQueueSnapshot>;
  getApproval(requestId: string): Promise<ApprovalRecordView | null>;
  decideApproval(input: ApprovalDecisionInput): Promise<ApprovalRecordView>;
  revokeApproval(input: ApprovalQueueActionRef): Promise<ApprovalRecordView>;
  executeApprovedWrite(input: ApprovalQueueActionRef): Promise<ApprovalExecutionActionResult>;

  /** 重启我们自己的 V2 Runtime（绝不触碰 Legacy 生产服务）。 */
  restartRuntime(): Promise<{ ok: boolean; previousPid: number | null; state: unknown }>;
  /** 重启我们自己的隧道。 */
  restartTransport(): Promise<{ ok: boolean; provider: string; port: number }>;
}
