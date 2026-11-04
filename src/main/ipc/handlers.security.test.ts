import { beforeEach, describe, expect, it, vi } from "vitest";
import { dialog } from "electron";
import type { IpcContext } from "./handlers.js";
import type { IpcSupervisor } from "../../shared/IpcSupervisor.js";
import type { ApprovalRecordView, FolderAccessEntry } from "../../shared/security.js";
import {
  addFolderAclRuleWithLocalConfirmation,
  decideApprovalWithLocalConfirmation,
  executeApprovedWriteWithLocalConfirmation,
  removeFolderAclRuleWithLocalConfirmation,
} from "./handlers.js";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

// This directory contains a checked-in legacy JS artifact with the same basename.
// Force the security tests onto the canonical TypeScript implementation.
vi.mock("./handlers.js", async () => vi.importActual<typeof import("./handlers.js")>("./handlers.ts"));

const record: ApprovalRecordView = {
  requestId: "apr_test",
  revision: 2,
  profileId: "profile-home",
  profileName: "Home",
  workspaceId: "workspace-home",
  targetPath: "D:\\workspace\\note.txt",
  operation: "CREATE",
  summary: "Create a note",
  requester: null,
  decision: "PENDING",
  execution: "NOT_STARTED",
  verification: "NOT_RUN",
  createdAt: "2026-10-08T10:00:00.000Z",
  expiresAt: "2026-10-08T11:00:00.000Z",
  decidedAt: null,
  executedAt: null,
  verifiedAt: null,
  binding: {
    contentDigest: "a".repeat(64),
    expectedTargetVersion: "ABSENT",
    operationDigest: "b".repeat(64),
  },
  diff: { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 },
  attemptCount: 0,
  maxAttempts: 2,
  lastFailureCode: null,
};

const aclRule: FolderAccessEntry = {
  ruleId: "rule_test",
  profileId: "profile-home",
  profileName: "Home",
  workspaceId: "workspace-home",
  folderPath: "D:\\workspace\\restricted",
  access: "DENY",
  extensionPolicy: { mode: "ALLOW_LIST", allowedExtensions: [".txt"], deniedExtensions: [] },
  inheritance: "INHERITED",
  updatedAt: "2026-10-08T10:00:00.000Z",
  revision: 4,
};

function setup(profileType: "local" | "remote" = "local", executionAvailability: "AVAILABLE" | "UNAVAILABLE" = "UNAVAILABLE") {
  const getApproval = vi.fn().mockResolvedValue(record);
  const executeApprovedWrite = vi.fn().mockResolvedValue({ status: "UNAVAILABLE", code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE", record });
  const getActiveProfile = vi.fn().mockResolvedValue({
    profileId: record.profileId,
    profileName: profileType === "remote" ? "Legacy" : record.profileName,
    profileType,
    currentWorkspace: { root: "D:\\workspace", workspaceId: record.workspaceId },
  });
  const getFolderAclRuleForConfirmation = vi.fn().mockResolvedValue(aclRule);
  const addFolderAclRule = vi.fn().mockResolvedValue(aclRule);
  const removeFolderAclRule = vi.fn().mockResolvedValue({ removed: true, revision: 5 });
  const mainWindow = { isDestroyed: () => false };
  const supervisor = {
    getApproval,
    getActiveProfile,
    getFolderAclRuleForConfirmation,
    addFolderAclRule,
    removeFolderAclRule,
    decideApproval: vi.fn().mockResolvedValue({ ...record, decision: "APPROVED" }),
    listApprovals: vi.fn().mockResolvedValue({ executionAvailability }),
  } as unknown as IpcSupervisor;
  Object.assign(supervisor, { executeApprovedWrite });
  return {
    ctx: { supervisor, getMainWindow: () => mainWindow as never, getStateRoot: () => "/tmp/c2c-test-state" } as IpcContext,
    supervisor,
    getApproval,
    executeApprovedWrite,
    getActiveProfile,
    getFolderAclRuleForConfirmation,
    addFolderAclRule,
    removeFolderAclRule,
  };
}

describe("security IPC confirmation boundary", () => {
  beforeEach(() => vi.mocked(dialog.showMessageBox).mockReset());

  it("confirms and signs the exact ACL add request with current Profile and Workspace", async () => {
    const { ctx, addFolderAclRule } = setup();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    const input = {
      path: "D:\\workspace\\src",
      access: "READ_WRITE" as const,
      label: "Source folder",
      extensionPolicy: { mode: "ALLOW_LIST" as const, allowedExtensions: [".ts", ".json"] },
    };

    await addFolderAclRuleWithLocalConfirmation(ctx, input);

    const dialogCall = vi.mocked(dialog.showMessageBox).mock.calls[0] as unknown as [unknown, { detail?: string }];
    expect(dialogCall[1].detail).toContain('Profile: "Home" (profile-home)');
    expect(dialogCall[1].detail).toContain("Workspace: workspace-home");
    expect(dialogCall[1].detail).toContain(JSON.stringify(input.path));
    expect(dialogCall[1].detail).toContain("读写");
    expect(dialogCall[1].detail).toContain('仅允许扩展名：[".ts",".json"]');
    expect(addFolderAclRule).toHaveBeenCalledWith({
      ...input,
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-home",
      confirmedWorkspaceId: "workspace-home",
      confirmedWorkspaceRoot: "D:\\workspace",
    });
  });

  it("does not add an ACL rule when local confirmation is cancelled or the window is missing", async () => {
    const { ctx, addFolderAclRule } = setup();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    const input = { path: "D:\\workspace\\src", access: "READ_ONLY" as const, extensionPolicy: { mode: "ALLOW_ALL" as const } };

    await expect(addFolderAclRuleWithLocalConfirmation(ctx, input)).rejects.toThrow("ACL_CONFIRMATION_CANCELLED");
    expect(addFolderAclRule).not.toHaveBeenCalled();

    ctx.getMainWindow = () => null;
    await expect(addFolderAclRuleWithLocalConfirmation(ctx, input)).rejects.toThrow("ACL_CONFIRMATION_WINDOW_UNAVAILABLE");
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(addFolderAclRule).not.toHaveBeenCalled();
  });

  it("rejects an ACL add if Profile or Workspace changes while the confirmation dialog is open", async () => {
    const { ctx, getActiveProfile, addFolderAclRule } = setup();
    getActiveProfile
      .mockResolvedValueOnce({
        profileId: "profile-home", profileName: "Home", profileType: "local",
        currentWorkspace: { root: "D:\\workspace", workspaceId: "workspace-home" },
      })
      .mockResolvedValueOnce({
        profileId: "profile-home", profileName: "Home", profileType: "local",
        currentWorkspace: { root: "D:\\workspace-two", workspaceId: "workspace-home" },
      });
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await expect(addFolderAclRuleWithLocalConfirmation(ctx, {
      path: "D:\\workspace\\src", access: "READ_ONLY", extensionPolicy: { mode: "ALLOW_ALL" },
    })).rejects.toThrow("ACL_PROFILE_OR_WORKSPACE_CHANGED");
    expect(addFolderAclRule).not.toHaveBeenCalled();
  });

  it("confirms the exact DENY/inherited rule before removal and binds the signed removal to its revision", async () => {
    const { ctx, getFolderAclRuleForConfirmation, removeFolderAclRule } = setup();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await removeFolderAclRuleWithLocalConfirmation(ctx, { ruleId: aclRule.ruleId, expectedRevision: aclRule.revision });

    const dialogCall = vi.mocked(dialog.showMessageBox).mock.calls[0] as unknown as [unknown, { detail?: string }];
    expect(dialogCall[1].detail).toContain(JSON.stringify(aclRule.folderPath));
    expect(dialogCall[1].detail).toContain("禁止");
    expect(dialogCall[1].detail).toContain('仅允许扩展名：[".txt"]');
    expect(dialogCall[1].detail).toContain("可能扩大有效访问范围");
    expect(getFolderAclRuleForConfirmation).toHaveBeenCalledTimes(2);
    expect(removeFolderAclRule).toHaveBeenCalledWith({
      ruleId: aclRule.ruleId,
      expectedRevision: aclRule.revision,
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-home",
      confirmedWorkspaceId: "workspace-home",
      confirmedWorkspaceRoot: "D:\\workspace",
    });
  });

  it("does not remove a rule when confirmation is cancelled or identity changes", async () => {
    const { ctx, getActiveProfile, removeFolderAclRule } = setup();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    const input = { ruleId: aclRule.ruleId, expectedRevision: aclRule.revision };

    await expect(removeFolderAclRuleWithLocalConfirmation(ctx, input)).rejects.toThrow("ACL_CONFIRMATION_CANCELLED");
    expect(removeFolderAclRule).not.toHaveBeenCalled();

    getActiveProfile.mockReset()
      .mockResolvedValueOnce({ profileId: "profile-home", profileName: "Home", profileType: "local", currentWorkspace: { root: "D:\\workspace", workspaceId: "workspace-home" } })
      .mockResolvedValueOnce({ profileId: "profile-home", profileName: "Home", profileType: "local", currentWorkspace: { root: "D:\\workspace-two", workspaceId: "workspace-two" } });
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await expect(removeFolderAclRuleWithLocalConfirmation(ctx, input)).rejects.toThrow("ACL_PROFILE_OR_WORKSPACE_CHANGED");
    expect(removeFolderAclRule).not.toHaveBeenCalled();
  });

  it("requires a native confirmation before APPROVE and keeps the decision separate from execution", async () => {
    const { ctx, supervisor } = setup();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await decideApprovalWithLocalConfirmation(ctx, {
      requestId: record.requestId,
      expectedRevision: record.revision,
      decision: "APPROVE",
    });

    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    const dialogCall = vi.mocked(dialog.showMessageBox).mock.calls[0] as unknown as [unknown, { detail?: string }];
    expect(dialogCall[1].detail).toContain("批准只记录审批决定");
    expect(supervisor.decideApproval).toHaveBeenCalledWith({ requestId: record.requestId, expectedRevision: record.revision, decision: "APPROVE" });
    expect(supervisor.executeApprovedWrite).not.toHaveBeenCalled();
  });

  it("requires an available content preview before any MCP approval confirmation", async () => {
    const { ctx, supervisor, getApproval } = setup();
    getApproval.mockResolvedValue({
      ...record,
      requester: {
        kind: "MCP",
        clientId: "registered-client-1",
        requestId: "json-rpc-42",
        runtimeInstanceId: "c2c_ri_live-instance-12345678",
      },
    });

    await expect(decideApprovalWithLocalConfirmation(ctx, {
      requestId: record.requestId,
      expectedRevision: record.revision,
      decision: "APPROVE",
    })).rejects.toThrow("APPROVAL_PREVIEW_UNAVAILABLE");
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(supervisor.decideApproval).not.toHaveBeenCalled();
  });

  it("shows the full reviewed MCP content and caller identity in native approval confirmation", async () => {
    const { ctx, supervisor, getApproval } = setup();
    getApproval.mockResolvedValue({
      ...record,
      requester: {
        kind: "MCP",
        clientId: "registered-client-1",
        requestId: "json-rpc-42",
        runtimeInstanceId: "c2c_ri_live-instance-12345678",
      },
      diff: { state: "AVAILABLE", lines: [{ kind: "ADD", text: "safe test content" }], omittedLineCount: 0 },
    });
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

    await decideApprovalWithLocalConfirmation(ctx, {
      requestId: record.requestId,
      expectedRevision: record.revision,
      decision: "APPROVE",
    });

    const dialogCall = vi.mocked(dialog.showMessageBox).mock.calls[0] as unknown as [unknown, { detail?: string }];
    expect(dialogCall[1].detail).toContain("registered-client-1 / json-rpc-42");
    expect(dialogCall[1].detail).toContain("safe test content");
    expect(supervisor.decideApproval).toHaveBeenCalledOnce();
  });

  it("does not mutate the approval when the local confirmation is cancelled", async () => {
    const { ctx, supervisor } = setup();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    await expect(decideApprovalWithLocalConfirmation(ctx, {
      requestId: record.requestId,
      expectedRevision: record.revision,
      decision: "APPROVE",
    })).resolves.toEqual(record);
    expect(supervisor.decideApproval).not.toHaveBeenCalled();
  });

  it("blocks Legacy approval and does not open a misleading confirmation", async () => {
    const { ctx, supervisor } = setup("remote");

    await expect(decideApprovalWithLocalConfirmation(ctx, {
      requestId: record.requestId,
      expectedRevision: record.revision,
      decision: "APPROVE",
    })).rejects.toThrow("PROTECTED_PROFILE");
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(supervisor.decideApproval).not.toHaveBeenCalled();
  });

  it("routes execution as a separate no-content action when no safe writer is available", async () => {
    const { ctx, supervisor, getApproval, executeApprovedWrite } = setup();
    getApproval.mockResolvedValue({ ...record, decision: "APPROVED" });

    await expect(executeApprovedWriteWithLocalConfirmation(ctx, {
      requestId: record.requestId,
      expectedRevision: record.revision,
    })).resolves.toMatchObject({ status: "UNAVAILABLE", code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" });
    expect(supervisor.executeApprovedWrite).toHaveBeenCalledWith({ requestId: record.requestId, expectedRevision: record.revision });
    expect(executeApprovedWrite).toHaveBeenCalledWith({ requestId: record.requestId, expectedRevision: record.revision });
    expect(executeApprovedWrite.mock.calls[0]?.[0]).not.toHaveProperty("content");
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
