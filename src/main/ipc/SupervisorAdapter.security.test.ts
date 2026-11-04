import { describe, expect, it, vi } from "vitest";
import type { SupervisorClient } from "./SupervisorClient.js";
import { SupervisorAdapter } from "./SupervisorAdapter.js";
import type {
  ConfirmedFolderAclAddInput,
  ConfirmedFolderAclRemoveInput,
  FolderAclRuleConfirmationInput,
} from "../../shared/security.js";

describe("SupervisorAdapter security RPC contract", () => {
  it("routes every ACL and approval operation with the original DTO params", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const adapter = new SupervisorAdapter({ call } as unknown as SupervisorClient);
    const confirmationRef: FolderAclRuleConfirmationInput = {
      ruleId: "rule-a",
      expectedRevision: 3,
      expectedProfileId: "profile-a",
      expectedWorkspaceId: "workspace-a",
      expectedWorkspaceRoot: "D:\\workspace",
    };
    const aclAdd: ConfirmedFolderAclAddInput = {
      path: "D:\\workspace\\src",
      access: "READ_WRITE",
      extensionPolicy: { mode: "ALLOW_LIST", allowedExtensions: [".ts"] },
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: "D:\\workspace",
    };
    const aclRemove: ConfirmedFolderAclRemoveInput = {
      ruleId: "rule-a",
      expectedRevision: 3,
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: "D:\\workspace",
    };
    const accessCheck = { path: "D:\\workspace\\src\\main.ts", operation: "write" as const };
    const decision = { requestId: "apr_a", expectedRevision: 4, decision: "APPROVE" as const };
    const action = { requestId: "apr_a", expectedRevision: 4 };

    await adapter.getFolderAcl();
    await adapter.getFolderAclRuleForConfirmation(confirmationRef);
    await adapter.addFolderAclRule(aclAdd);
    await adapter.removeFolderAclRule(aclRemove);
    await adapter.checkFolderAccess(accessCheck);
    await adapter.listApprovals();
    await adapter.getApproval("apr_a");
    await adapter.decideApproval(decision);
    await adapter.revokeApproval(action);
    await adapter.executeApprovedWrite(action);

    const calls = call.mock.calls.map(([request]) => request as { method: string; params?: unknown });
    expect(calls.map(({ method }) => method)).toEqual([
      "security.folder-acl.get",
      "security.folder-acl.get-for-confirmation",
      "security.folder-acl.add",
      "security.folder-acl.remove",
      "security.folder-acl.check",
      "security.approvals.list",
      "security.approvals.get",
      "security.approvals.decide",
      "security.approvals.revoke",
      "security.approvals.execute",
    ]);
    expect(calls.map(({ params }) => params)).toEqual([
      undefined,
      confirmationRef,
      aclAdd,
      aclRemove,
      accessCheck,
      undefined,
      { requestId: "apr_a" },
      decision,
      action,
      action,
    ]);
    expect(calls[1]?.params).toBe(confirmationRef);
    expect(calls[2]?.params).toBe(aclAdd);
    expect(calls[3]?.params).toBe(aclRemove);
    expect(calls[7]?.params).toBe(decision);
    expect(calls[8]?.params).toBe(action);
    expect(calls[9]?.params).toBe(action);
  });

  it("routes task submit and evidence queries through dedicated Supervisor RPC methods", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const adapter = new SupervisorAdapter({ call } as unknown as SupervisorClient);
    const request = {
      idempotencyKey: "submit-fixture",
      agentId: "agent-fixture",
      worktreeId: "worktree-fixture",
      specificationSha256: "a".repeat(64),
    };

    await adapter.getAgentTaskAvailability();
    await adapter.submitAgentTask(request);
    await adapter.getAgentTaskStatus("task-fixture");
    await adapter.cancelAgentTask("task-fixture");
    await adapter.getAgentTaskResult("task-fixture");
    await adapter.getAgentTaskEvidence("task-fixture");

    const calls = call.mock.calls.map(([rpc]) => rpc as { method: string; params?: unknown });
    expect(calls.map(({ method }) => method)).toEqual([
      "agent-task.availability",
      "agent-task.submit",
      "agent-task.status",
      "agent-task.cancel",
      "agent-task.result",
      "agent-task.evidence",
    ]);
    expect(calls.map(({ params }) => params)).toEqual([
      undefined,
      request,
      { taskId: "task-fixture" },
      { taskId: "task-fixture" },
      { taskId: "task-fixture" },
      { taskId: "task-fixture" },
    ]);
  });
});
