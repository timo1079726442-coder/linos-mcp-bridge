import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalQueue, type ApprovalAuditEvent } from "../main/approval/ApprovalQueue.js";
import { FolderAclStore } from "../main/workspace/FolderAclStore.js";
import type { ProfileConfig } from "../shared/types.js";
import { SecurityControlService } from "./SecurityControlService.js";

const roots: string[] = [];

function profile(workspaceRoot: string, profileType: ProfileConfig["profileType"] = "home", workspaceId = "workspace-a"): ProfileConfig {
  return {
    schemaVersion: "2",
    profileId: "profile-a",
    profileName: "Home Test",
    profileType,
    createdAt: "2026-10-08T00:00:00.000Z",
    deviceId: "device-a",
    runtimeId: "runtime-a",
    currentWorkspace: { root: workspaceRoot, workspaceId },
    transport: {
      transportId: null,
      provider: null,
      tunnelName: null,
      tunnelId: null,
      hostname: null,
      zone: null,
      publicMcpUrl: null,
      expectedLocalPort: 48766,
    },
    expectedLocalHost: "127.0.0.1",
    runtime: { source: "PACKAGED_V2", binaryPath: null, entryPath: null },
    trustedRedirectPolicy: { source: "builtin", builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] },
    chatgptLaunchUrl: "https://chatgpt.com",
    healthCheckIntervalSec: 30,
    autoStart: { atLogin: false, minimized: true },
    autoRepair: { policy: "STRICT_FAIL_CLOSED", maxRetriesPerDay: 2, cooldownSec: 60 },
  };
}

async function makeContext(profileType: ProfileConfig["profileType"] = "home") {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-security-control-"));
  roots.push(root);
  const stateRoot = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace-a");
  await mkdir(workspaceRoot, { recursive: true });
  const active: { value: ProfileConfig | null } = { value: profile(workspaceRoot, profileType) };
  const auditEvents: Record<string, unknown>[] = [];
  const service = new SecurityControlService({
    stateRoot,
    getActiveProfile: () => active.value,
    appendAudit: async (entry) => { auditEvents.push(entry); },
  });
  return { root, stateRoot, workspaceRoot, active, auditEvents, service };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SecurityControlService", () => {
  it("scopes ACL rules to the active Profile/Workspace and audits mutations", async () => {
    const context = await makeContext();
    const snapshot = await context.service.getFolderAcl();
    expect(snapshot).toMatchObject({
      profileId: "profile-a",
      profileType: "home",
      workspaceId: "workspace-a",
      mutationAvailability: "AVAILABLE",
      entries: [],
    });

    const rule = await context.service.addFolderAclRule({
      path: context.workspaceRoot,
      access: "READ_WRITE",
      label: "Source files",
      extensionPolicy: { mode: "ALLOW_LIST", allowedExtensions: [".ts", ".json"] },
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    });
    expect(rule).toMatchObject({ profileId: "profile-a", workspaceId: "workspace-a", access: "READ_WRITE" });
    await expect(context.service.checkFolderAccess({ path: path.join(context.workspaceRoot, "src", "main.ts"), operation: "write" }))
      .resolves.toMatchObject({ allowed: true, ruleId: rule.ruleId });
    await expect(context.service.checkFolderAccess({ path: path.join(context.workspaceRoot, "src", "main.md"), operation: "write" }))
      .resolves.toMatchObject({ allowed: false, reason: "EXTENSION_NOT_ALLOWED" });

    const removal = await context.service.removeFolderAclRule({
      ruleId: rule.ruleId,
      expectedRevision: rule.revision,
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    });
    expect(removal.removed).toBe(true);
    expect(context.auditEvents.map((entry) => entry.event)).toEqual([
      "FOLDER_ACL_ADD_REQUESTED", "FOLDER_ACL_ADDED", "FOLDER_ACL_REMOVE_REQUESTED", "FOLDER_ACL_REMOVED",
    ]);
    expect(JSON.stringify(context.auditEvents)).not.toContain(context.workspaceRoot);
  });

  it("keeps Legacy Profile read-only and rejects all ACL and approval mutations", async () => {
    const context = await makeContext("company");
    await expect(context.service.getFolderAcl()).resolves.toMatchObject({
      profileType: "company",
      mutationAvailability: "PROFILE_PROTECTED",
      mutationBlockReason: "COMPANY_PROFILE_PROTECTED",
    });
    await expect(context.service.addFolderAclRule({
      path: context.workspaceRoot,
      access: "READ_ONLY",
      extensionPolicy: { mode: "ALLOW_ALL" },
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    })).rejects.toThrow("COMPANY_PROFILE_PROTECTED");
    await expect(context.service.removeFolderAclRule({
      ruleId: "missing", expectedRevision: 1, nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a", confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    })).rejects.toThrow("COMPANY_PROFILE_PROTECTED");
    await expect(context.service.executeApprovedWrite({ requestId: "missing", expectedRevision: 1 })).rejects.toThrow("COMPANY_PROFILE_PROTECTED");
    expect(context.auditEvents).toEqual([]);
  });

  it("fails closed when the active workspace changes under existing ACL state", async () => {
    const context = await makeContext();
    await context.service.addFolderAclRule({
      path: context.workspaceRoot,
      access: "READ_ONLY",
      extensionPolicy: { mode: "ALLOW_ALL" },
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    });
    const nextRoot = path.join(context.root, "workspace-b");
    await mkdir(nextRoot);
    context.active.value = profile(nextRoot, "home", "workspace-b");

    await expect(context.service.getFolderAcl()).rejects.toThrow("ACL_SCOPE_MISMATCH");
  });

  it("requires Main confirmation and returns exact rule scope only for the internal confirmation RPC", async () => {
    const context = await makeContext();
    const input = {
      path: context.workspaceRoot,
      access: "READ_WRITE" as const,
      extensionPolicy: { mode: "ALLOW_ALL" as const },
    };
    const addWithoutMarker = (value: unknown) => context.service.addFolderAclRule(value as never);
    await expect(addWithoutMarker(input)).rejects.toThrow("ACL_LOCAL_CONFIRMATION_REQUIRED");

    const confirmed = {
      ...input,
      nativeConfirmation: "LOCAL_CONFIRMED" as const,
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    };
    const created = await context.service.addFolderAclRule(confirmed);
    const confirmationRef = {
      ruleId: created.ruleId,
      expectedRevision: created.revision,
      expectedProfileId: "profile-a",
      expectedWorkspaceId: "workspace-a",
      expectedWorkspaceRoot: context.workspaceRoot,
    };
    await expect(context.service.getFolderAclRuleForConfirmation(confirmationRef))
      .resolves.toMatchObject({ ruleId: created.ruleId, folderPath: created.folderPath, access: "READ_WRITE" });
    await expect(context.service.getFolderAclRuleForConfirmation({ ...confirmationRef, expectedRevision: created.revision + 1 }))
      .rejects.toThrow("ACL_STALE_REVISION");
    const removeWithoutMarker = (value: unknown) => context.service.removeFolderAclRule(value as never);
    await expect(removeWithoutMarker({
      ...confirmationRef,
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: context.workspaceRoot,
    }))
      .rejects.toThrow("ACL_LOCAL_CONFIRMATION_REQUIRED");
  });

  it("rejects ACL confirmations if the workspace root differs despite matching Profile and Workspace IDs", async () => {
    const context = await makeContext();
    const input = {
      path: context.workspaceRoot,
      access: "READ_ONLY" as const,
      extensionPolicy: { mode: "ALLOW_ALL" as const },
    };

    await expect(context.service.addFolderAclRule({
      ...input,
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: "profile-a",
      confirmedWorkspaceId: "workspace-a",
      confirmedWorkspaceRoot: path.join(context.root, "workspace-other"),
    })).rejects.toThrow("ACL_PROFILE_OR_WORKSPACE_CHANGED");
  });

  it("records execution as unavailable after binding checks and leaves the file untouched", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "new.txt");
    const acl = new FolderAclStore({
      stateRoot: context.stateRoot,
      profileId: "profile-a",
      workspaceId: "workspace-a",
      workspaceRoot: context.workspaceRoot,
    });
    await acl.add({ path: context.workspaceRoot, permission: "write", extensions: [".txt"] });
    const auditEvents: ApprovalAuditEvent[] = [];
    const queue = new ApprovalQueue({
      stateRoot: context.stateRoot,
      profileId: "profile-a",
      workspaceId: "workspace-a",
      workspaceRoot: context.workspaceRoot,
      acl,
      getActiveIdentity: () => ({
        profileId: context.active.value?.profileId ?? null,
        workspaceId: context.active.value?.currentWorkspace.workspaceId ?? null,
        workspaceRoot: context.active.value?.currentWorkspace.root ?? null,
      }),
      appendAudit: async (event) => { auditEvents.push(event); },
    });
    const requested = await queue.requestWrite({ targetPath, content: "approved bytes", summary: "Create file" });
    const approved = await queue.decide({ requestId: requested.requestId, expectedRevision: requested.revision, decision: "APPROVE" });

    const result = await context.service.executeApprovedWrite({ requestId: approved.requestId, expectedRevision: approved.revision });
    expect(result).toMatchObject({ status: "UNAVAILABLE", code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" });
    expect(result.record).toMatchObject({ decision: "APPROVED", execution: "NOT_STARTED", verification: "NOT_RUN", attemptCount: 0 });
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(auditEvents.map((entry) => entry.event)).toEqual(["APPROVAL_REQUESTED", "APPROVAL_DECIDED"]);
    expect(context.auditEvents).toMatchObject([{ event: "APPROVAL_EXECUTION_BLOCKED", resultCode: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" }]);
    expect((await context.service.listApprovals()).executionAvailability).toBe("UNAVAILABLE");
  });
});
