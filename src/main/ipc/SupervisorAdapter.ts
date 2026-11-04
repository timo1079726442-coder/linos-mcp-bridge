import type { IpcSupervisor } from "../../shared/IpcSupervisor.js";
import { SupervisorClient } from "./SupervisorClient.js";

type Awaited<T> = T extends Promise<infer U> ? U : T;

export class SupervisorAdapter implements IpcSupervisor {
  constructor(private readonly client: SupervisorClient) {}

  private call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.client.call<T>({ method, params, timeoutMs });
  }

  listProfiles(): Promise<Awaited<ReturnType<IpcSupervisor["listProfiles"]>>> {
    return this.call("profile.list");
  }
  createProfile(opts: Parameters<IpcSupervisor["createProfile"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["createProfile"]>>> {
    return this.call("profile.create", opts);
  }
  async getActiveProfile(): Promise<Awaited<ReturnType<IpcSupervisor["getActiveProfile"]>>> {
    return this.call("profile.get-active");
  }
  updateOrdinarySettings(patch: Parameters<IpcSupervisor["updateOrdinarySettings"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["updateOrdinarySettings"]>>> {
    return this.call("settings.ordinary.update", patch, 30_000);
  }
  getServiceConnectionSettings(): Promise<Awaited<ReturnType<IpcSupervisor["getServiceConnectionSettings"]>>> {
    return this.call("profile.service.get", undefined, 30_000);
  }
  updateServiceConnectionSettings(patch: Parameters<IpcSupervisor["updateServiceConnectionSettings"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["updateServiceConnectionSettings"]>>> {
    return this.call("profile.service.update", patch, 30_000);
  }
  importServiceCredential(sourcePath: string): Promise<Awaited<ReturnType<IpcSupervisor["importServiceCredential"]>>> {
    return this.call("profile.service.importCredential", { sourcePath }, 30_000);
  }
  async setActiveProfile(profileId: string): Promise<void> {
    await this.call("profile.set-active", { profileId });
  }
  validateWorkspace(root: string): Promise<Awaited<ReturnType<IpcSupervisor["validateWorkspace"]>>> {
    return this.call("workspace.validate", { root });
  }
  detectWorkspace(root: string): Promise<Awaited<ReturnType<IpcSupervisor["detectWorkspace"]>>> {
    return this.call("workspace.detect", { root });
  }
  changeRuntimePort(port: number): Promise<{ ok: boolean; changed: boolean; port: number }> {
    return this.call("profile.port.update", { port }, 60_000);
  }
  createIntent(opts: { grantAllScopes?: boolean } = {}): Promise<Awaited<ReturnType<IpcSupervisor["createIntent"]>>> {
    return this.call("intent.create", { grantAllScopes: opts.grantAllScopes === true });
  }
  listIntents(): Promise<Awaited<ReturnType<IpcSupervisor["listIntents"]>>> {
    return this.call("intent.list");
  }
  getReadiness(): Promise<Awaited<ReturnType<IpcSupervisor["getReadiness"]>>> {
    return this.call("readiness.get");
  }
  runDiagnostics(): Promise<Awaited<ReturnType<IpcSupervisor["runDiagnostics"]>>> {
    // Windows process inspection and DPAPI health probes are bounded but can
    // legitimately exceed the default 10s control-plane timeout.
    return this.call("diagnostics.run", undefined, 30_000);
  }
  listFaultCases(params: Parameters<IpcSupervisor["listFaultCases"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["listFaultCases"]>>> {
    return this.call("diagnostics.fault-cases.list", params, 30_000);
  }
  matchRepairOptions(params: Parameters<IpcSupervisor["matchRepairOptions"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["matchRepairOptions"]>>> {
    return this.call("diagnostics.repair-options.match", params, 30_000);
  }
  runRepair(
    params: Parameters<IpcSupervisor["runRepair"]>[0],
    nativeConfirmation: Parameters<IpcSupervisor["runRepair"]>[1],
  ): Promise<Awaited<ReturnType<IpcSupervisor["runRepair"]>>> {
    return this.call("diagnostics.repair.run", { request: params, nativeConfirmation }, 90_000);
  }
  listRepairHistory(params: Parameters<IpcSupervisor["listRepairHistory"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["listRepairHistory"]>>> {
    return this.call("diagnostics.repair-history.list", params, 30_000);
  }
  prepareWorkspaceChange(opts: Parameters<IpcSupervisor["prepareWorkspaceChange"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["prepareWorkspaceChange"]>>> {
    return this.call("workspace.change.prepare", opts);
  }
  commitWorkspaceChange(opts: Parameters<IpcSupervisor["commitWorkspaceChange"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["commitWorkspaceChange"]>>> {
    return this.call("workspace.change.commit", opts);
  }
  listExecutionRecords(limit?: number): Promise<Awaited<ReturnType<IpcSupervisor["listExecutionRecords"]>>> {
    return this.call("execution.list", { limit: limit ?? 20 }, 30_000);
  }
  getExecutionOutput(id: string): Promise<Awaited<ReturnType<IpcSupervisor["getExecutionOutput"]>>> {
    return this.call("execution.output", { id }, 30_000);
  }
  getAgentTaskAvailability(): Promise<Awaited<ReturnType<IpcSupervisor["getAgentTaskAvailability"]>>> {
    return this.call("agent-task.availability");
  }
  submitAgentTask(request: Parameters<IpcSupervisor["submitAgentTask"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["submitAgentTask"]>>> {
    return this.call("agent-task.submit", request, 30_000);
  }
  getAgentTaskStatus(taskId: string): Promise<Awaited<ReturnType<IpcSupervisor["getAgentTaskStatus"]>>> {
    return this.call("agent-task.status", { taskId });
  }
  cancelAgentTask(taskId: string): Promise<Awaited<ReturnType<IpcSupervisor["cancelAgentTask"]>>> {
    return this.call("agent-task.cancel", { taskId });
  }
  getAgentTaskResult(taskId: string): Promise<Awaited<ReturnType<IpcSupervisor["getAgentTaskResult"]>>> {
    return this.call("agent-task.result", { taskId });
  }
  getAgentTaskEvidence(taskId: string): Promise<Awaited<ReturnType<IpcSupervisor["getAgentTaskEvidence"]>>> {
    return this.call("agent-task.evidence", { taskId });
  }
  restoreProfile(config: Parameters<IpcSupervisor["restoreProfile"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["restoreProfile"]>>> {
    return this.call("profile.restore", config, 30_000);
  }
  gitChanges(root: string): Promise<Awaited<ReturnType<IpcSupervisor["gitChanges"]>>> {
    return this.call("workspace.git-changes", { root }, 30_000);
  }

  getFolderAcl(): Promise<Awaited<ReturnType<IpcSupervisor["getFolderAcl"]>>> {
    return this.call("security.folder-acl.get");
  }
  getFolderAclRuleForConfirmation(input: Parameters<IpcSupervisor["getFolderAclRuleForConfirmation"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["getFolderAclRuleForConfirmation"]>>> {
    return this.call("security.folder-acl.get-for-confirmation", input);
  }
  addFolderAclRule(input: Parameters<IpcSupervisor["addFolderAclRule"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["addFolderAclRule"]>>> {
    return this.call("security.folder-acl.add", input);
  }
  removeFolderAclRule(input: Parameters<IpcSupervisor["removeFolderAclRule"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["removeFolderAclRule"]>>> {
    return this.call("security.folder-acl.remove", input);
  }
  checkFolderAccess(input: Parameters<IpcSupervisor["checkFolderAccess"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["checkFolderAccess"]>>> {
    return this.call("security.folder-acl.check", input);
  }
  listApprovals(): Promise<Awaited<ReturnType<IpcSupervisor["listApprovals"]>>> {
    return this.call("security.approvals.list");
  }
  getApproval(requestId: string): Promise<Awaited<ReturnType<IpcSupervisor["getApproval"]>>> {
    return this.call("security.approvals.get", { requestId });
  }
  decideApproval(input: Parameters<IpcSupervisor["decideApproval"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["decideApproval"]>>> {
    return this.call("security.approvals.decide", input);
  }
  revokeApproval(input: Parameters<IpcSupervisor["revokeApproval"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["revokeApproval"]>>> {
    return this.call("security.approvals.revoke", input);
  }
  executeApprovedWrite(input: Parameters<IpcSupervisor["executeApprovedWrite"]>[0]): Promise<Awaited<ReturnType<IpcSupervisor["executeApprovedWrite"]>>> {
    return this.call("security.approvals.execute", input);
  }
  restartRuntime(): Promise<Awaited<ReturnType<IpcSupervisor["restartRuntime"]>>> {
    return this.call("runtime.restart", undefined, 60_000);
  }
  restartTransport(): Promise<Awaited<ReturnType<IpcSupervisor["restartTransport"]>>> {
    return this.call("transport.restart", undefined, 60_000);
  }
}
