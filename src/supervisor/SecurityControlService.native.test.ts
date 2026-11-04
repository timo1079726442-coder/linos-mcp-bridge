import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAclStore } from "../main/workspace/FolderAclStore.js";
import { ProfileClientRegistry } from "../main/oauth/ProfileClientRegistry.js";
import { WorkspaceGrantStore } from "../main/oauth/WorkspaceGrantStore.js";
import type { ProfileConfig } from "../shared/types.js";
import { createMcpCreateTestWriter } from "./McpCreateTestWriter.js";
import { SecurityControlService } from "./SecurityControlService.js";

const stateRoots: string[] = [];
const nativeIt = process.platform === "win32"
  && !!process.env.C2C_V2_CREATE_TEST_WORKSPACE_ROOT
  && !!process.env.C2C_V2_CREATE_TEST_WRITER_DLL
  ? it
  : it.skip;

afterEach(async () => {
  await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SecurityControlService native isolated CREATE", () => {
  nativeIt("writes only after approval through the one-shot permit and verifies an independent readback", async () => {
    const workspaceRoot = process.env.C2C_V2_CREATE_TEST_WORKSPACE_ROOT!;
    const writerDll = process.env.C2C_V2_CREATE_TEST_WRITER_DLL!;
    const stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-create02-native-state-"));
    stateRoots.push(stateRoot);
    await mkdir(path.join(stateRoot, "profiles", "profile-native"), { recursive: true });

    const active: ProfileConfig = {
      schemaVersion: "2",
      profileId: "profile-native",
      profileName: "Isolated CREATE Test",
      profileType: "custom",
      createdAt: new Date().toISOString(),
      deviceId: "device-native-test",
      runtimeId: "runtime-native-test",
      currentWorkspace: { root: workspaceRoot, workspaceId: "workspace-native-test" },
      transport: {
        transportId: null, provider: null, tunnelName: null, tunnelId: null, hostname: null, zone: null,
        publicMcpUrl: null, expectedLocalPort: 48766,
      },
      expectedLocalHost: "127.0.0.1",
      runtime: { source: "PACKAGED_V2", binaryPath: null, entryPath: null },
      trustedRedirectPolicy: { source: "builtin", builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] },
      chatgptLaunchUrl: "https://chatgpt.com",
      healthCheckIntervalSec: 30,
      autoStart: { atLogin: false, minimized: true },
      autoRepair: { policy: "STRICT_FAIL_CLOSED", maxRetriesPerDay: 2, cooldownSec: 60 },
    };
    const runtimeIdentity = {
      deviceId: active.deviceId,
      profileId: active.profileId,
      runtimeId: active.runtimeId,
      runtimeInstanceId: "c2c_ri_native-test-12345678",
      workspaceId: active.currentWorkspace.workspaceId,
      workspaceRoot,
    };
    const auditEvents: Record<string, unknown>[] = [];
    const service = new SecurityControlService({
      stateRoot,
      getActiveProfile: () => active,
      getRuntimeIdentity: () => runtimeIdentity,
      mcpCreateTestWorkspaceRoot: workspaceRoot,
      mcpCreateTestWriter: createMcpCreateTestWriter(writerDll),
      appendAudit: async (entry) => { auditEvents.push(entry); },
    });

    await service.addFolderAclRule({
      path: workspaceRoot,
      access: "READ_WRITE",
      label: "Isolated native CREATE test",
      extensionPolicy: { mode: "ALLOW_LIST", allowedExtensions: [".txt"] },
      nativeConfirmation: "LOCAL_CONFIRMED",
      confirmedProfileId: active.profileId,
      confirmedWorkspaceId: active.currentWorkspace.workspaceId!,
      confirmedWorkspaceRoot: workspaceRoot,
    });
    await new ProfileClientRegistry(stateRoot, active.profileId).upsert({
      clientId: "native-test-client",
      clientName: "Synthetic native writer test",
      redirectUris: ["https://chatgpt.com/callback"],
      scopes: ["workspace.read", "workspace.write"],
    });
    await new WorkspaceGrantStore(stateRoot, active.profileId).set(active.currentWorkspace.workspaceId!, {
      clientId: "native-test-client",
      accessTokenHash: "a".repeat(64),
      refreshTokenHash: "b".repeat(64),
      scopes: ["workspace.read", "workspace.write"],
      audience: active.currentWorkspace.workspaceId!,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
    });
    const content = `CREATE-02 approved bytes ${randomBytes(8).toString("hex")}\n`;
    const relativePath = `approved-${randomBytes(6).toString("hex")}.txt`;
    const targetPath = path.join(workspaceRoot, relativePath);
    const pending = await service.requestMcpCreateIntent({
      runtimeInstanceId: runtimeIdentity.runtimeInstanceId,
      caller: { clientId: "native-test-client", requestId: "native-json-rpc-1" },
      intent: { operation: "CREATE", relativePath, content },
    });
    if (pending.status !== "PENDING" || !pending.requestId) throw new Error("MCP CREATE was not queued.");
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    const pendingView = (await service.getApproval(pending.requestId))!;
    await expect(service.executeApprovedWrite({ requestId: pending.requestId, expectedRevision: pendingView.revision }))
      .rejects.toThrow("APPROVAL_NOT_EXECUTABLE");
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

    const approved = await service.decideApproval({
      requestId: pending.requestId,
      expectedRevision: pendingView.revision,
      decision: "APPROVE",
    });
    const executed = await service.executeApprovedWrite({ requestId: approved.requestId, expectedRevision: approved.revision });
    if (executed.status !== "SUCCEEDED") throw new Error(`Native CREATE execution failed: ${executed.code}`);
    expect(executed).toMatchObject({
      status: "SUCCEEDED",
      code: "APPROVAL_VERIFIED",
      record: { operation: "CREATE", execution: "SUCCEEDED", verification: "VERIFIED", attemptCount: 1 },
      evidence: { sha256: createHash("sha256").update(content).digest("hex"), byteLength: Buffer.byteLength(content) },
    });

    const independentBytes = await readFile(targetPath);
    expect(independentBytes.toString("utf8")).toBe(content);
    expect(createHash("sha256").update(independentBytes).digest("hex")).toBe(executed.evidence.sha256);
    await expect(service.executeApprovedWrite({ requestId: executed.record.requestId, expectedRevision: executed.record.revision }))
      .rejects.toThrow("APPROVAL_NOT_EXECUTABLE");
    await expect(readFile(targetPath)).resolves.toEqual(independentBytes);
    expect(auditEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "MCP_CREATE_TEST_WRITER_VERIFIED", testOnly: true, readbackSha256: executed.evidence.sha256 }),
    ]));
  });
});
