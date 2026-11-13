import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const {
  RuntimeSupervisorBridgeSession,
  createRuntimeSupervisorBridgeIpcStream,
} = require("../../dist/main/process/RuntimeSupervisorBridge.js");
const { SecurityControlService } = require("../../dist/supervisor/SecurityControlService.js");
const { ApprovalQueue } = require("../../dist/main/approval/ApprovalQueue.js");
const { AuditChain } = require("../../dist/main/audit/AuditChain.js");
const { FolderAclStore } = require("../../dist/main/workspace/FolderAclStore.js");
const { ProfileClientRegistry } = require("../../dist/main/oauth/ProfileClientRegistry.js");
const { WorkspaceGrantStore } = require("../../dist/main/oauth/WorkspaceGrantStore.js");
const { RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND } = require("../dist/supervisor-bridge.js");
const bridgeModuleUrl = new URL("../dist/supervisor-bridge.js", import.meta.url).href;
const electronNodePath = process.platform === "win32"
  ? fileURLToPath(new URL("../../node_modules/electron/dist/electron.exe", import.meta.url))
  : process.execPath;

function spawnRuntimeNode(childCode, stdio = ["ignore", "pipe", "pipe", "ipc"]) {
  return spawn(electronNodePath, ["--input-type=module", "-e", childCode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", C2C_RUNTIME_SUPERVISOR_BRIDGE_FD: "3" },
    stdio,
  });
}

function nextIpcMessage(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Electron IPC message timeout")), timeoutMs);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("Electron Node mode uses stdio index 3 IPC for repeated full-duplex bridge frames", async () => {
  const childCode = [
    `const { openRuntimeSupervisorBridgeStream } = await import(${JSON.stringify(bridgeModuleUrl)});`,
    "if (process.env.ELECTRON_RUN_AS_NODE !== '1' || typeof process.send !== 'function' || !process.connected || process.stdio !== undefined) { console.error('ELECTRON_IPC_UNAVAILABLE'); process.exit(2); }",
    "const stream = openRuntimeSupervisorBridgeStream();",
    "if (!stream) { console.error('BRIDGE_MISSING'); process.exit(3); }",
    "stream.on('data', (chunk) => stream.write(Buffer.concat([Buffer.from('ack:'), chunk])));",
    "console.log('BRIDGE_READY');",
  ].join("\n");
  const child = spawnRuntimeNode(childCode);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  try {
    const [ready] = await Promise.race([
      once(child.stdout, "data"),
      // 这是"等子进程把模块加载完"的启动预算，不是断言；3s 在负载高的机器/CI 上会误报，
      // 断言本身仍是"帧必须完整往返"。
      new Promise((_, reject) => setTimeout(() => reject(new Error("bridge child startup timeout")), 20_000)),
    ]);
    assert.match(String(ready), /BRIDGE_READY/);
    for (const ping of ["ping-1", "ping-2"]) {
      const response = nextIpcMessage(child);
      child.send({ kind: RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND, data: ping });
      assert.deepEqual(await response, { kind: RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND, data: `ack:${ping}` });
    }
  } catch (error) {
    if (stderr) throw new Error(`${error instanceof Error ? error.message : String(error)}; child stderr: ${stderr}`);
    throw error;
  } finally {
    if (child.connected) child.disconnect();
    if (child.exitCode === null) child.kill();
  }
});

test("Electron Runtime reaches the real isolated ApprovalQueue and returns one PENDING record", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-create03-bridge-e2e-"));
  const stateRoot = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const profileId = "profile-create03-e2e";
  const workspaceId = "workspace-create03-e2e";
  const runtimeInstanceId = "c2c_ri_create03-e2e-12345678";
  const clientId = "registered-create03-client";
  const secret = Buffer.alloc(32, 19);
  const diagnostics = [];
  const audit = new AuditChain(stateRoot, profileId);
  let session;
  let child;

  try {
    await mkdir(workspaceRoot, { recursive: true });
    await audit.open();
    const active = {
      schemaVersion: "2",
      profileId,
      profileName: "CREATE-03 synthetic integration",
      profileType: "custom",
      createdAt: "2026-10-14T00:00:00.000Z",
      deviceId: "device-create03-e2e",
      runtimeId: "runtime-create03-e2e",
      currentWorkspace: { root: workspaceRoot, workspaceId },
      transport: { transportId: null, provider: null, tunnelName: null, tunnelId: null, hostname: null, zone: null, publicMcpUrl: null, expectedLocalPort: 48766 },
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
      profileId,
      runtimeId: active.runtimeId,
      runtimeInstanceId,
      workspaceId,
      workspaceRoot,
    };
    const acl = new FolderAclStore({ stateRoot, profileId, workspaceId, workspaceRoot });
    await acl.add({ path: workspaceRoot, permission: "write", extensions: [".txt"] });
    await new ProfileClientRegistry(stateRoot, profileId).upsert({
      clientId,
      clientName: "Synthetic CREATE-03 integration client",
      redirectUris: ["https://chatgpt.com/callback"],
      scopes: ["workspace.read", "workspace.write"],
    });
    await new WorkspaceGrantStore(stateRoot, profileId).set(workspaceId, {
      clientId,
      accessTokenHash: "a".repeat(64),
      refreshTokenHash: "b".repeat(64),
      scopes: ["workspace.read", "workspace.write"],
      audience: workspaceId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
    });
    const service = new SecurityControlService({
      stateRoot,
      getActiveProfile: () => active,
      getRuntimeIdentity: () => runtimeIdentity,
      mcpCreateTestWorkspaceRoot: workspaceRoot,
      mcpCreateTestWriter: async () => { throw new Error("EXECUTION_NOT_INTEGRATION_TEST"); },
      appendAudit: async (entry) => { await audit.append(entry); },
      onMcpCreateDiagnostic: (event) => diagnostics.push(event),
    });
    assert.equal(await service.isMcpCreateTestModeEnabled(), true);
    let createRequestCount = 0;
    const handleCreateIntent = async (request) => {
      const result = await service.requestMcpCreateIntent(request);
      createRequestCount += 1;
      if (createRequestCount === 1) await new Promise((resolve) => setTimeout(resolve, 1000));
      return result;
    };

    const expectedRequest = {
      caller: { clientId, requestId: "synthetic-json-rpc-1" },
      intent: { operation: "CREATE", relativePath: "create03-bridge-e2e.txt", content: "synthetic CREATE-03 payload" },
    };
    const childCode = [
      `const { createRuntimeSupervisorBridge, openRuntimeSupervisorBridgeStream } = await import(${JSON.stringify(bridgeModuleUrl)});`,
      `const secret = Buffer.from(${JSON.stringify(secret.toString("hex"))}, 'hex');`,
      `const diagnosticSink = (event) => console.error('RUNTIME_DIAG:' + JSON.stringify(event));`,
      `const client = createRuntimeSupervisorBridge(secret, ${JSON.stringify(runtimeInstanceId)}, openRuntimeSupervisorBridgeStream(diagnosticSink), 500, true, diagnosticSink);`,
      `(async () => { let firstError = ''; try { await client.requestCreateIntent(${JSON.stringify(expectedRequest)}); } catch (error) { firstError = error.message; } if (firstError !== 'runtime_supervisor_bridge_timeout') throw new Error('FIRST_REQUEST_DID_NOT_TIME_OUT'); const retry = await client.requestCreateIntent(${JSON.stringify(expectedRequest)}); await new Promise((resolve) => setTimeout(resolve, 1200)); console.log(JSON.stringify({ firstError, retry })); client.close(); })().catch((error) => { console.error(error.message); process.exitCode = 3; client.close(); });`,
    ].join("\n");
    child = spawnRuntimeNode(childCode);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const bridgeStream = createRuntimeSupervisorBridgeIpcStream(child);
    assert.ok(bridgeStream, "Supervisor must receive an authenticated child IPC channel at stdio index 3");
    session = new RuntimeSupervisorBridgeSession(
      bridgeStream,
      secret,
      runtimeInstanceId,
      handleCreateIntent,
      true,
      (event) => diagnostics.push(event),
    );
    const [output] = await Promise.race([
      once(child.stdout, "data"),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Runtime to ApprovalQueue PENDING timeout; stages=${JSON.stringify(diagnostics)}; runtime=${stderr}`)), 12_000);
        timer.unref?.();
      }),
    ]);
    const result = JSON.parse(String(output));
    assert.equal(result.firstError, "runtime_supervisor_bridge_timeout");
    assert.equal(result.retry.status, "PENDING");
    assert.match(result.retry.requestId, /^apr_[A-Za-z0-9_-]{16}$/);

    const queue = new ApprovalQueue({
      stateRoot,
      profileId,
      workspaceId,
      workspaceRoot,
      acl,
      getActiveIdentity: () => ({ profileId, workspaceId, workspaceRoot }),
      appendAudit: async (entry) => { await audit.append(entry); },
    });
    const records = await queue.list();
    assert.equal(records.length, 1);
    const auditText = await readFile(path.join(stateRoot, "profiles", profileId, "audit", "active.log"), "utf8");
    assert.match(auditText, /APPROVAL_REQUESTED/);
    assert.equal(auditText.includes(expectedRequest.intent.content), false);
    assert.deepEqual({
      requestId: records[0].requestId,
      operationKind: records[0].operationKind,
      decision: records[0].decision,
      execution: records[0].execution,
      runtimeInstanceId: records[0].source.runtimeInstanceId,
      clientId: records[0].source.clientId,
      requestIdSource: records[0].source.requestId,
    }, {
      requestId: result.retry.requestId,
      operationKind: "CREATE_FILE",
      decision: "PENDING",
      execution: "NOT_STARTED",
      runtimeInstanceId,
      clientId,
      requestIdSource: "synthetic-json-rpc-1",
    });
    await assert.rejects(readFile(path.join(workspaceRoot, "create03-bridge-e2e.txt")), { code: "ENOENT" });

    const stages = diagnostics.map((event) => event.stage);
    assert.ok(stages.includes("mcp_create_runtime_identity_validated"));
    assert.ok(stages.includes("mcp_create_client_grant_validated"));
    assert.ok(stages.includes("approval_queue_lock_acquired"));
    assert.ok(stages.includes("approval_queue_audit_completed"));
    assert.ok(stages.includes("approval_queue_document_written"));
    assert.ok(stages.includes("supervisor_response_written"));
    assert.ok(diagnostics.some((event) => event.correlationId === `${runtimeInstanceId}:1`));
    assert.ok(diagnostics.some((event) => event.correlationId === `${runtimeInstanceId}:2`));
    const runtimeDiagnostics = stderr.split("\n").filter((line) => line.startsWith("RUNTIME_DIAG:"))
      .map((line) => JSON.parse(line.slice("RUNTIME_DIAG:".length)));
    assert.ok(runtimeDiagnostics.some((event) => event.stage === "runtime_frame_written"));
    assert.ok(runtimeDiagnostics.some((event) => event.stage === "runtime_response_received"));
    assert.ok(runtimeDiagnostics.some((event) => event.stage === "runtime_late_response_ignored"));
    assert.ok(runtimeDiagnostics.some((event) => event.correlationId === `${runtimeInstanceId}:1`));
    assert.ok(runtimeDiagnostics.some((event) => event.correlationId === `${runtimeInstanceId}:2`));
    const diagnosticText = JSON.stringify([...diagnostics, ...runtimeDiagnostics]);
    assert.equal(diagnosticText.includes(expectedRequest.intent.content), false);
    assert.equal(diagnosticText.includes(expectedRequest.intent.relativePath), false);
  } finally {
    session?.close();
    if (child?.connected) child.disconnect();
    if (child && child.exitCode === null) child.kill();
    secret.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
