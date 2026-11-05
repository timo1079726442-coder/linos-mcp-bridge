/**
 * V2 Supervisor — independent per-user background process.
 *
 * Per ADR-V2-003 Option B + ADR-V2-002 + FOUNDER OPTION_A_PLUS:
 *   - Runs as detached background process; survives UI exit
 *   - Spawns and supervises Runtime child process on V2_LOCAL_PORT=48766
 *   - LOCAL_ONLY transport (no Cloudflare, no DNS, no public hostname)
 *   - Exposes Named Pipe IPC for Electron Main to query state
 *   - Bidirectional heartbeat with Watchdog
 *   - Restart budget persisted to disk
 *   - AuditChain for all decisions
 *   - ConnectionIntentStore with real CSPRNG
 *
 * Isolation rule: a profile must not bind the reserved port or reserved hostname.
 */
import * as net from "node:net";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { ProfileStore } from "../main/profile/ProfileStore.js";
import { isValidRuntimePort, runtimePortError, firstBootPort } from "../shared/localPort.js";
import { DeviceIdentity } from "../main/profile/DeviceIdentity.js";
import { TransactionJournalStore } from "../main/workspace/TransactionJournal.js";
import { RecoveryEngine } from "../main/recovery/RecoveryEngine.js";
import { ReadinessEngine } from "../main/health/ReadinessEngine.js";
import { HealthProbe } from "../main/health/HealthProbe.js";
import { SupervisorProcess } from "../main/process/SupervisorProcess.js";
import type { CodexExecutionCompletionEvent } from "../main/process/SupervisorProcess.js";
import { SupervisorInstanceLock } from "../main/process/SupervisorInstanceLock.js";
import { RecoveryCoordinator } from "../main/recovery/RecoveryCoordinator.js";
import { SecretGenerator } from "../main/security/SecretGenerator.js";
import { RuntimeResolver } from "../main/runtime/RuntimeResolver.js";
import { TransportFactory } from "../main/transport/TransportFactory.js";
import type { TransportProvider } from "../main/transport/TransportProvider.js";
import { AuditChain } from "../main/audit/AuditChain.js";
import { ConnectionIntentStore } from "../main/oauth/ConnectionIntent.js";
import { WorkspaceTransactionCoordinator } from "../main/workspace/TransactionCoordinator.js";
import { WorkspaceManager } from "../main/workspace/WorkspaceManager.js";
import { WorkspaceGrantStore } from "../main/oauth/WorkspaceGrantStore.js";
import { ProfileClientRegistry } from "../main/oauth/ProfileClientRegistry.js";
import { readConnectorEvidence, readConversationEvidence } from "../main/health/ReadinessEvidence.js";
import { Diagnostics } from "../main/health/Diagnostics.js";
import { FaultKnowledgeService } from "../main/health/FaultKnowledgeService.js";
import { SecurityControlService } from "./SecurityControlService.js";
import { createMcpCreateTestWriter } from "./McpCreateTestWriter.js";
import type { RuntimeBridgeDiagnosticSink, RuntimeCreateIntentHandler } from "../main/process/RuntimeSupervisorBridge.js";
import { SupervisorAgentTaskAdapter } from "./AgentTaskAdapter.js";
import { updateOrdinarySettings as persistOrdinarySettings } from "./OrdinarySettings.js";
import {
  createSupervisorRpcAuthOkProof,
  createSupervisorRpcChallenge,
  createSupervisorRpcResponseFrame,
  deriveSupervisorRpcSessionKey,
  SUPERVISOR_RPC_AUTH_KIND,
  SUPERVISOR_RPC_AUTH_OK_KIND,
  SUPERVISOR_RPC_CHALLENGE_KIND,
  verifySupervisorRpcProof,
  SupervisorRequestVerifier,
  supervisorMethodRequiresAuthorization,
} from "../main/ipc/SupervisorRequestAuth.js";
import type { SupervisorRequestAuthorization, SupervisorRpcResponsePayload } from "../main/ipc/SupervisorRequestAuth.js";
import { redactObject } from "../main/redaction/Redactor.js";
import type { DiagnosticsReport, ProfileConfig } from "../shared/types.js";
import { isRunRepairRequest } from "../shared/types.js";

const STATE_ROOT = process.argv[2] ?? ProfileStore.defaultStateRoot();
const PIPE_NAME = `\\\\.\\pipe\\C2CSupervisor-${randomBytes(4).toString("hex")}`;
const RESTART_BUDGET_FILE = path.join(STATE_ROOT, "restart-budget.json");

/**
 * 本机允许签发的全部 scope（与 Runtime 的 DEFAULT_SCOPES 一致）。
 * 只有用户显式打开"全权模式"时，它才作为 Intent 的授权上限，
 * 由 Runtime 在授权时并入令牌——ChatGPT 自己只会申请 workspace.read。
 */
const ALL_ALLOWED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "workspace.write",
  "workspace.shell",
  "offline_access",
] as const;

let isQuittingSupervisor = false;
let recoveryCoordinator: RecoveryCoordinator | null = null;
let faultKnowledge: FaultKnowledgeService | null = null;

function createBridgeDiagnosticSink(filePath: string): RuntimeBridgeDiagnosticSink {
  let writes = Promise.resolve();
  return (event) => {
    if (!/^[a-z0-9_]{1,80}$/.test(event.stage)
      || typeof event.correlationId !== "string" || event.correlationId.length > 160
      || !Number.isFinite(event.elapsedMs) || (event.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(event.errorCode))) return;
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      process: "supervisor",
      stage: event.stage,
      correlationId: event.correlationId,
      elapsedMs: Math.max(0, Math.round(event.elapsedMs)),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    })}\n`;
    writes = writes.then(async () => {
      const current = await fs.stat(filePath).catch(() => null);
      if (current && current.size + Buffer.byteLength(line, "utf8") > 512 * 1024) return;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, "utf8");
    }).catch(() => { /* diagnostics must not affect authorization or queue writes */ });
  };
}

export const V2_ISOLATION = {
  V2_DEFAULT_ISOLATION: true,
  V2_LOCAL_PORT: 48766,
  V2_DEFAULT_TRANSPORT: "LOCAL_ONLY",
  V2_PUBLIC_HOSTNAME_DEFAULT: "DISABLED",
  COMPANY_PRODUCTION_PROTECTED: true,
  AUTO_PRODUCTION_TAKEOVER: false,
  LEGACY_MIGRATION_MODE_DEFAULT: false,
  RUNTIME_PROCESS_EXEC_PATH_DEFAULT_REMOVED: true,
} as const;

function packagedAppRoot(): string | undefined {
  const supervisorEntry = process.argv[1];
  if (!supervisorEntry) return undefined;
  const normalized = supervisorEntry.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();

  // Packaged with asar:
  //   <install>/resources/app.asar/dist/supervisor/supervisorMain.js
  // appRoot is the asar path itself; the runtime is addressed inside it.
  const asarMarker = "/app.asar";
  const asarIndex = lower.indexOf(asarMarker);
  if (asarIndex >= 0) return supervisorEntry.slice(0, asarIndex + asarMarker.length);

  // Unpacked (asar disabled):
  //   <install>/resources/app/dist/supervisor/supervisorMain.js
  // appRoot is the unpacked app directory; the runtime lives at
  // <appRoot>/runtime/dist/main.js.
  const unpackedMarker = "/resources/app/";
  const unpackedIndex = lower.indexOf(unpackedMarker);
  if (unpackedIndex >= 0) {
    return supervisorEntry.slice(0, unpackedIndex + "/resources/app".length);
  }

  return undefined;
}

interface RestartBudget {
  windowStartedAt: number;
  supervisor: number;
  watchdog: number;
}

async function readBudget(): Promise<RestartBudget> {
  try {
    const raw = await fs.readFile(RESTART_BUDGET_FILE, "utf8");
    const b = JSON.parse(raw) as RestartBudget;
    if (Date.now() - b.windowStartedAt > 24 * 60 * 60 * 1000) {
      return { windowStartedAt: Date.now(), supervisor: 0, watchdog: 0 };
    }
    return b;
  } catch {
    return { windowStartedAt: Date.now(), supervisor: 0, watchdog: 0 };
  }
}

async function writeBudget(b: RestartBudget): Promise<void> {
  await fs.mkdir(STATE_ROOT, { recursive: true });
  await fs.writeFile(RESTART_BUDGET_FILE, JSON.stringify(b, null, 2), "utf8");
}

async function consumeBudget(side: "supervisor" | "watchdog"): Promise<{ remaining: number; loopGuard: boolean }> {
  const b = await readBudget();
  b[side] += 1;
  await writeBudget(b);
  return { remaining: Math.max(0, 3 - b[side]), loopGuard: b[side] >= 3 };
}

function enforceIsolation(config: {
  expectedLocalPort: number;
  publicMcpUrl: string | null;
  hostname: string | null;
  tunnelName: string | null;
  legacyMigrationMode: boolean;
}): void {
  if (!isValidRuntimePort(config.expectedLocalPort)) {
    throw new Error(`V2_ISOLATION: ${runtimePortError(config.expectedLocalPort)}`);
  }
  if (config.publicMcpUrl?.toLowerCase().includes("mcp-legacy.example.com")) {
    throw new Error("V2_ISOLATION: refusing to bind Legacy Production hostname");
  }
  if (config.hostname?.toLowerCase().includes("mcp-legacy.example.com")) {
    throw new Error("V2_ISOLATION: refusing Legacy Production hostname identity");
  }
  if (config.tunnelName?.toLowerCase().includes("mcpbridge-tunnel")) {
    throw new Error("V2_ISOLATION: refusing to use Legacy Production tunnel");
  }
}

async function readMainSessionKey(): Promise<Buffer | null> {
  const input = process.stdin;
  if (input.isTTY || input.destroyed || input.readableEnded) return null;
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let timer: NodeJS.Timeout;
    const finish = (key: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      resolve(key);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (buffer.length > 1024) return finish(null);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const frame = JSON.parse(buffer.slice(0, newline)) as { kind?: unknown; key?: unknown };
        if (frame.kind !== "C2C_MAIN_SESSION_V1" || typeof frame.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(frame.key)) return finish(null);
        const key = Buffer.from(frame.key, "base64url");
        finish(key.length === 32 ? key : null);
      } catch {
        finish(null);
      }
    };
    const onEnd = (): void => finish(null);
    const onError = (): void => finish(null);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    timer = setTimeout(() => finish(null), 750);
    input.resume();
  });
}

async function main(): Promise<void> {
  const requestRootKey = await readMainSessionKey();
  const supervisorLock = await SupervisorInstanceLock.acquire(STATE_ROOT);
  process.once("exit", () => supervisorLock.releaseSync());
  console.log(
    JSON.stringify({
      event: "supervisor:boot",
      stateRoot: STATE_ROOT,
      pipe: PIPE_NAME,
      pid: process.pid,
      isolation: V2_ISOLATION,
      foonote: "FOUNDER OPTION_A_PLUS: V2 isolated from Legacy Production",
    }),
  );

  const device = new DeviceIdentity(STATE_ROOT);
  const deviceId = await device.getDeviceId();
  const profileStore = new ProfileStore(STATE_ROOT, device);

  const resolvedActive = await profileStore.resolveActiveProfile();
  // 关键：ProfileStore.create 会把 provider 初始化为 LOCAL_ONLY，
  // 所以不能用 provider === null 判断"首次启动"，否则 --port/env 永远不生效。
  const isFreshProfile = resolvedActive === null;
  let active: ProfileConfig = resolvedActive ?? await profileStore.create({
      profileName: "V2_LOCAL",
      profileType: "custom",
    });

  let profileNeedsWrite = false;
  if (active.runtime.source !== "PACKAGED_V2") {
    active.runtime.source = "PACKAGED_V2";
    profileNeedsWrite = true;
  }
  // Preserve an explicitly configured remote transport across Supervisor
  // restarts. The old unconditional rewrite here silently downgraded every
  // remote Profile back to LOCAL_ONLY.
  // 首启端口：只有从未配过 transport 的 Profile 才看 CLI 标记；
  // 已有配置一律沿用，CLI 永远不得覆盖。非法 env 值直接回退默认值并大声记录。
  const transportNeverConfigured = isFreshProfile || active.transport.provider === null;
  if (transportNeverConfigured) {
    active.transport.provider = V2_ISOLATION.V2_DEFAULT_TRANSPORT;
    const cliPortRaw = (process.env.C2C_V2_FIRST_BOOT_PORT ?? "").trim();
    const cliPort = /^\d+$/.test(cliPortRaw) && isValidRuntimePort(Number(cliPortRaw)) ? Number(cliPortRaw) : null;
    if (cliPortRaw && cliPort === null) {
      console.error(JSON.stringify({ event: "cli-first-boot-port-invalid", raw: cliPortRaw, error: runtimePortError(cliPortRaw) }));
    }
    active.transport.expectedLocalPort = firstBootPort(
      cliPort,
      null,
      active.transport.expectedLocalPort,
      V2_ISOLATION.V2_LOCAL_PORT,
    );
    profileNeedsWrite = true;
  }
  if (profileNeedsWrite) {
    await profileStore.writeConfig(active);
  }

  enforceIsolation({
    expectedLocalPort: active.transport.expectedLocalPort,
    publicMcpUrl: active.transport.publicMcpUrl,
    hostname: active.transport.hostname,
    tunnelName: active.transport.tunnelName,
    legacyMigrationMode: false,
  });

  const recovery = new RecoveryEngine("STRICT_FAIL_CLOSED");
  const readiness = new ReadinessEngine();
  const probe = new HealthProbe();
  const journalStore = new TransactionJournalStore(STATE_ROOT, active.profileId);
  const audit = new AuditChain(STATE_ROOT, active.profileId);
  await audit.open({ integrityRecovery: "quarantine" });
  await audit.append({ event: "SUPERVISOR_BOOT", pid: process.pid, isolation: V2_ISOLATION });

  const intentStore = new ConnectionIntentStore(STATE_ROOT, active.profileId);
  const grantStore = new WorkspaceGrantStore(STATE_ROOT, active.profileId);
  const transaction = new WorkspaceTransactionCoordinator({
    profileStore,
    audit,
    journalStore,
    probe,
    readiness,
    grantStore,
  });
  const workspaceManager = new WorkspaceManager();
  let activeSupervisor: SupervisorProcess | null = null;
  const testWriterDllPath = process.env.C2C_V2_CREATE_TEST_WRITER_DLL ?? "";
  const testWriterDllAvailable = path.isAbsolute(testWriterDllPath)
    && path.basename(testWriterDllPath).toLowerCase() === "windowscreateexperiment.dll"
    && await fs.stat(testWriterDllPath).then((stats) => stats.isFile()).catch(() => false);
  const mcpCreateTestWriter = testWriterDllAvailable ? createMcpCreateTestWriter(testWriterDllPath) : undefined;
  // UPDATE remains non-executable until a Windows native compare-and-swap writer
  // proves no external modification can be lost between version check and replace.
  const mcpUpdateWriter = undefined;
  const bridgeDiagnosticSink: RuntimeBridgeDiagnosticSink | undefined = mcpCreateTestWriter
    && process.env.C2C_V2_CREATE_TEST_WORKSPACE_ROOT
    ? createBridgeDiagnosticSink(path.join(STATE_ROOT, "profiles", active.profileId, "runtime-supervisor-bridge-supervisor.jsonl"))
    : undefined;
  const securityControl = new SecurityControlService({
    stateRoot: STATE_ROOT,
    getActiveProfile: () => active,
    mcpCreateTestWorkspaceRoot: process.env.C2C_V2_CREATE_TEST_WORKSPACE_ROOT ?? null,
    mcpCreateTestWriter,
    mcpUpdateWriter,
    getRuntimeIdentity: () => {
      if (!activeSupervisor?.ownsLiveChild()) return null;
      return {
        deviceId,
        profileId: active.profileId,
        runtimeId: active.runtimeId,
        runtimeInstanceId: activeSupervisor.getState().runtimeInstanceId,
        workspaceId: active.currentWorkspace.workspaceId,
        workspaceRoot: active.currentWorkspace.root,
      };
    },
    appendAudit: (entry) => audit.append(entry),
    onMcpCreateDiagnostic: bridgeDiagnosticSink,
  });
  const onMcpCreateIntent: RuntimeCreateIntentHandler | undefined = await securityControl.isMcpCreateTestModeEnabled()
    ? async (request) => {
        // TypeScript narrows request.intent, not the enclosing request union.
        // Rebuild the exact request shape, preserving the discriminant without casts.
        const { runtimeInstanceId, correlationId, caller } = request;
        if (request.intent.operation === "CREATE") {
          return securityControl.requestMcpCreateIntent({ runtimeInstanceId, correlationId, caller, intent: request.intent });
        }
        return securityControl.requestMcpUpdateIntent({ runtimeInstanceId, correlationId, caller, intent: request.intent });
      }
    : undefined;
  const agentTasks = new SupervisorAgentTaskAdapter({
    stateRoot: STATE_ROOT,
    profileId: active.profileId,
    resolveActiveScope: async () => {
      const profileId = active.profileId;
      const workspaceId = active.currentWorkspace.workspaceId;
      return profileId && workspaceId ? { profileId, workspaceId } : null;
    },
  });

  let transport: TransportProvider = TransportFactory.create(active, STATE_ROOT);
  const resolver = new RuntimeResolver();
  const resolved = await resolver.resolve({
    profileSource: active.runtime.source,
    workspaceRoot: active.currentWorkspace.root ?? process.cwd(),
    appRoot: packagedAppRoot(),
  });

  const supervisor = new SupervisorProcess(STATE_ROOT, active.profileId, {
    deviceId,
    profileId: active.profileId,
    runtimeId: active.runtimeId,
    workspaceRoot: active.currentWorkspace.root ?? process.cwd(),
    port: active.transport.expectedLocalPort,
    binaryPath: resolved.binaryPath,
    entryPath: resolved.entryPath,
    runtimeInstanceSecret: SecretGenerator.generateRuntimeInstanceSecret(),
    stateRoot: STATE_ROOT,
    publicMcpUrl: active.transport.publicMcpUrl,
    commandImage: resolved.binaryPath,
    onMcpCreateIntent,
    onMcpCreateDiagnostic: bridgeDiagnosticSink,
  });
  activeSupervisor = supervisor;

  // IPC
  const server = net.createServer((socket) => {
    const challenge = createSupervisorRpcChallenge();
    let verifier: SupervisorRequestVerifier | null = null;
    let sessionKey: Buffer | null = null;
    let lastRequestSequence = 0;
    let buf = "";
    const writeResponse = (response: SupervisorRpcResponsePayload): void => {
      if (!sessionKey || socket.destroyed) return;
      socket.write(JSON.stringify(createSupervisorRpcResponseFrame(sessionKey, response)) + "\n");
    };
    const authTimer = setTimeout(() => socket.destroy(), 3000);
    socket.setNoDelay(true);
    socket.write(JSON.stringify({ kind: SUPERVISOR_RPC_CHALLENGE_KIND, challenge }) + "\n");
    socket.on("error", () => clearTimeout(authTimer));
    socket.on("close", () => clearTimeout(authTimer));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 1024 * 1024) { socket.destroy(); return; }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (!verifier) {
          let frame: { kind?: unknown; clientNonce?: unknown; proof?: unknown };
          try { frame = JSON.parse(line) as { kind?: unknown; clientNonce?: unknown; proof?: unknown }; }
          catch { socket.destroy(); return; }
          if (frame.kind !== SUPERVISOR_RPC_AUTH_KIND || typeof frame.clientNonce !== "string" || typeof frame.proof !== "string" ||
              !verifySupervisorRpcProof(requestRootKey, challenge, frame.clientNonce, frame.proof)) {
            socket.destroy();
            return;
          }
          sessionKey = deriveSupervisorRpcSessionKey(requestRootKey!, challenge, frame.clientNonce);
          verifier = new SupervisorRequestVerifier(sessionKey);
          clearTimeout(authTimer);
          const proof = createSupervisorRpcAuthOkProof(sessionKey, challenge, frame.clientNonce);
          socket.write(JSON.stringify({ kind: SUPERVISOR_RPC_AUTH_OK_KIND, proof }) + "\n");
          continue;
        }
        let envelope: { sequence?: unknown };
        try { envelope = JSON.parse(line) as { sequence?: unknown }; }
        catch { socket.destroy(); return; }
        if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence !== lastRequestSequence + 1) {
          socket.destroy();
          return;
        }
        lastRequestSequence = envelope.sequence as number;
        const requestSequence = lastRequestSequence;
        const connectionVerifier = verifier;
        void handleIpc(line, socket, connectionVerifier, requestSequence, writeResponse).catch(async (error: unknown) => {
          const code = safeIpcErrorCode(error);
          await audit.append({ event: "IPC_ERROR", error: code }).catch(() => undefined);
          const id = safeRequestId(line) ?? "invalid-request";
          writeResponse({ id, sequence: requestSequence, ok: false, error: code });
        });
      }
    });
  });
  server.listen(PIPE_NAME, () => {
    console.log(JSON.stringify({ event: "supervisor:listening", pipe: PIPE_NAME }));
    // P0-1: Publish pipe name for the Electron Main SupervisorClient to find.
    void fs.writeFile(path.join(STATE_ROOT, "supervisor-pipe.txt"), PIPE_NAME).catch(() => {
      // best-effort
    });
  });

  async function handleIpc(
    line: string,
    socket: net.Socket,
    requestVerifier: SupervisorRequestVerifier,
    requestSequence: number,
    writeResponse: (response: SupervisorRpcResponsePayload) => void,
  ): Promise<void> {
    const req = JSON.parse(line) as { id: string; sequence?: number; method: string; params?: unknown; authorization?: SupervisorRequestAuthorization };
    let result: unknown = null;
    try {
      if (req.sequence !== requestSequence) throw new Error("supervisor_request_sequence_invalid");
      if (supervisorMethodRequiresAuthorization(req.method) && !requestVerifier.verify(req, req.authorization)) {
        throw new Error(requestVerifier.available ? "supervisor_auth_invalid" : "supervisor_auth_session_unavailable");
      }
      switch (req.method) {
        case "ping":
          result = {
            ok: true,
            ts: Date.now(),
            deviceId,
            profileId: active.profileId,
            runtimeId: active.runtimeId,
            isolation: V2_ISOLATION,
          };
          break;
        case "readiness.get":
          result = await computeReadiness();
          break;
        case "diagnostics.run":
          result = await runDiagnostics();
          break;
        case "security.folder-acl.get":
          result = await securityControl.getFolderAcl();
          break;
        case "security.folder-acl.get-for-confirmation":
          result = await securityControl.getFolderAclRuleForConfirmation(req.params as Parameters<SecurityControlService["getFolderAclRuleForConfirmation"]>[0]);
          break;
        case "security.folder-acl.add":
          result = await securityControl.addFolderAclRule(req.params as Parameters<SecurityControlService["addFolderAclRule"]>[0]);
          break;
        case "security.folder-acl.remove":
          result = await securityControl.removeFolderAclRule(req.params as Parameters<SecurityControlService["removeFolderAclRule"]>[0]);
          break;
        case "security.folder-acl.check":
          result = await securityControl.checkFolderAccess(req.params as Parameters<SecurityControlService["checkFolderAccess"]>[0]);
          break;
        case "security.approvals.list":
          result = await securityControl.listApprovals();
          break;
        case "security.approvals.get":
          result = await securityControl.getApproval(String((req.params as { requestId?: string } | undefined)?.requestId ?? ""));
          break;
        case "security.approvals.decide":
          result = await securityControl.decideApproval(req.params as Parameters<SecurityControlService["decideApproval"]>[0]);
          break;
        case "security.approvals.revoke":
          result = await securityControl.revokeApproval(req.params as Parameters<SecurityControlService["revokeApproval"]>[0]);
          break;
        case "security.approvals.execute":
          result = await securityControl.executeApprovedWrite(req.params as Parameters<SecurityControlService["executeApprovedWrite"]>[0]);
          break;
        case "diagnostics.fault-cases.list":
          if (!faultKnowledge) throw new Error("fault_knowledge_unavailable");
          result = await faultKnowledge.listFaultCases((req.params ?? {}) as Parameters<FaultKnowledgeService["listFaultCases"]>[0]);
          break;
        case "diagnostics.repair-options.match":
          if (!faultKnowledge) throw new Error("fault_knowledge_unavailable");
          result = await faultKnowledge.matchRepairOptions((req.params ?? {}) as Parameters<FaultKnowledgeService["matchRepairOptions"]>[0]);
          break;
        case "diagnostics.repair.run": {
          if (!faultKnowledge) throw new Error("fault_knowledge_unavailable");
          const params = (req.params ?? {}) as {
            request?: Parameters<FaultKnowledgeService["runRepair"]>[0];
            nativeConfirmation?: string;
          };
          if (!isRunRepairRequest(params.request)) throw new Error("repair_request_invalid");
          const nativeConfirmation = params.nativeConfirmation === "LOCAL_CONFIRMED"
            ? "LOCAL_CONFIRMED"
            : params.nativeConfirmation === "LOCAL_CANCELLED" ? "LOCAL_CANCELLED" : "NOT_REQUIRED";
          result = await faultKnowledge.runRepair(params.request, nativeConfirmation);
          break;
        }
        case "diagnostics.repair-history.list":
          if (!faultKnowledge) throw new Error("fault_knowledge_unavailable");
          result = await faultKnowledge.listRepairHistory((req.params ?? {}) as Parameters<FaultKnowledgeService["listRepairHistory"]>[0]);
          break;
        case "profile.list":
          result = await profileStore.list();
          break;
        case "profile.create": {
          const params = (req.params ?? {}) as {
            profileName?: string;
            profileType?: "remote" | "local" | "custom";
            initialWorkspaceRoot?: string | null;
            expectedLocalPort?: number;
          };
          if (!params.profileName || !params.profileType) throw new Error("profile_name_and_type_required");
          const created = await profileStore.create({
            profileName: params.profileName,
            profileType: params.profileType,
            initialWorkspaceRoot: params.initialWorkspaceRoot ?? null,
            expectedLocalPort: params.expectedLocalPort,
          });
          result = toSummary(created);
          break;
        }
        case "profile.get-active":
          result = active;
          break;
        case "profile.service.get":
          result = await profileStore.getServiceConnectionSettings(active.profileId);
          break;
        case "profile.service.importCredential": {
          const params = (req.params ?? {}) as { sourcePath?: unknown };
          if (typeof params.sourcePath !== "string" || !params.sourcePath.trim()) {
            throw new Error("SERVICE_CREDENTIAL_SOURCE_REQUIRED");
          }
          const imported = await profileStore.importServiceCredential(active.profileId, params.sourcePath);
          await audit.append({
            event: "SERVICE_CREDENTIAL_IMPORTED",
            profileId: active.profileId,
            fileName: imported.fileName,
          });
          result = imported;
          break;
        }
        case "profile.service.update": {
          const patch = (req.params ?? {}) as Parameters<ProfileStore["prepareServiceConnectionUpdate"]>[0];
          if (patch.expectedProfileId !== active.profileId) throw new Error("SERVICE_CONFIG_PROFILE_MISMATCH");
          const prepared = await profileStore.prepareServiceConnectionUpdate(patch);
          if (!prepared.result.changed) {
            result = prepared.result;
            break;
          }

          const previous = active;
          let stoppedOldTransport = false;
          let persistedCandidate = false;
          try {
            await transport.stop();
            stoppedOldTransport = true;
            await profileStore.writeConfig(prepared.candidate);
            persistedCandidate = true;
            await audit.append({
              event: "SERVICE_CONNECTION_SETTINGS_UPDATED",
              profileId: prepared.candidate.profileId,
              provider: prepared.candidate.transport.provider,
              restartRequired: true,
            });
            active = prepared.candidate;
            // Runtime 的 OAuth issuer 来自 publicMcpUrl，必须同步给 Runtime 子进程配置，
            // 否则后续重启仍会沿用启动时的旧值（127.0.0.1）。
            activeSupervisor?.applyTransportIdentity(active.transport.publicMcpUrl, active.transport.expectedLocalPort);
            // 配置切换后必须重建 TransportProvider；否则 restartTransport
            // 仍会调用启动时的 LOCAL_ONLY 实例，永远不会启动 cloudflared。
            try { transport = TransportFactory.create(prepared.candidate, STATE_ROOT); } catch (e) { console.error("TRANSPORT_REBUILD_FAILED", e instanceof Error ? e.stack : String(e)); throw e; }
            // 立刻把新 Transport 拉起来；调用方即使忘了点「重启隧道」，配置也已经生效。
            try {
              await transport.start(active.transport.expectedLocalPort);
            } catch (e) {
              console.error("TRANSPORT_APPLY_START_FAILED", e instanceof Error ? e.stack : String(e));
            }
            result = prepared.result;
          } catch (error) {
            if (persistedCandidate) {
              await profileStore.writeConfig(previous).catch(() => undefined);
            }
            active = previous;
            transport = TransportFactory.create(previous, STATE_ROOT);
            if (stoppedOldTransport) {
              await transport.start(previous.transport.expectedLocalPort).catch(() => undefined);
            }
            throw error;
          }
          break;
        }
        case "settings.ordinary.update": {
          const updated = await persistOrdinarySettings(profileStore, active, req.params);
          active = updated.profile;
          result = updated.result;
          break;
        }
        case "profile.set-active": {
          const profileId = String((req.params as { profileId?: string } | undefined)?.profileId ?? "");
          if (!profileId) throw new Error("profile_id_required");
          if (profileId !== active.profileId) {
            // Switching the control-plane profile while a Runtime is running
            // would cross identity boundaries. Require a clean Supervisor
            // restart rather than silently reusing the current child.
            throw new Error("profile_switch_requires_supervisor_restart");
          }
          result = null;
          break;
        }
        case "profile.restore": {
          // Restore is scoped to the CURRENT profile only: the incoming config
          // must carry the same profileId, a v2.0 schema, and pass isolation
          // enforcement (no Legacy Production residue). Keys/secrets are NOT
          // part of the config backup and are never touched here.
          const incoming = (req.params ?? {}) as Partial<ProfileConfig>;
          if (incoming.schemaVersion !== "v2.0") throw new Error("backup_schema_unsupported");
          if (!incoming.profileId || incoming.profileId !== active.profileId) {
            throw new Error("backup_profile_mismatch");
          }
          const restored = await profileStore.writeConfig(incoming as ProfileConfig);
          active = await profileStore.readConfig(active.profileId);
          await audit.append({ event: "PROFILE_RESTORED", profileId: active.profileId });
          result = toSummary(active);
          break;
        }
        case "workspace.validate":
          result = await workspaceManager.validate(String((req.params as { root?: string } | undefined)?.root ?? ""));
          break;
        case "workspace.detect":
          result = await workspaceManager.detect(String((req.params as { root?: string } | undefined)?.root ?? ""));
          break;
        case "workspace.git-changes":
          result = await workspaceManager.gitChanges(String((req.params as { root?: string } | undefined)?.root ?? ""));
          break;
        case "intent.create":
          const currentRuntimeInstanceId = supervisor.getState().runtimeInstanceId;
          if (!currentRuntimeInstanceId) throw new Error("runtime_not_ready_for_oauth_intent");
          if (!active.currentWorkspace.workspaceId) throw new Error("workspace_required_for_oauth_intent");
          // 全权模式：用户显式要求让 ChatGPT 具备与 Agent 同等的工具能力。
          // 只把这些 scope 作为"上限"写进 Intent，Runtime 授权时才会并入令牌。
          const grantAllScopes = (req.params as { grantAllScopes?: boolean } | undefined)?.grantAllScopes === true;
          result = await intentStore.create({
            deviceId,
            runtimeId: active.runtimeId,
            runtimeInstanceId: currentRuntimeInstanceId,
            workspaceId: active.currentWorkspace.workspaceId,
            requestedScopes: grantAllScopes ? [...ALL_ALLOWED_SCOPES] : [],
          });
          const createdIntent = result as Awaited<ReturnType<ConnectionIntentStore["create"]>>;
          try {
            await supervisor.bindOAuthIntent(createdIntent);
            await audit.append({ event: "INTENT_CREATED", intentId: createdIntent.intentId });
          } catch (error) {
            await intentStore.transition(createdIntent.intentId, "REVOKED", {
              revokeReason: "runtime_intent_binding_failed",
            });
            await audit.append({ event: "INTENT_BIND_FAILED", intentId: createdIntent.intentId });
            throw error;
          }
          break;
        case "intent.list":
          result = await intentStore.listActive();
          break;
        case "execution.record": {
          const event = (req.params ?? {}) as CodexExecutionCompletionEvent;
          const recorded = await supervisor.recordExecutionCompletion(event);
          await audit.append({
            event: "CODEX_EXECUTION_RECORDED",
            taskId: event.taskId,
            iteration: event.iteration,
            status: event.status,
            recordId: recorded.id,
          });
          result = recorded;
          break;
        }
        case "execution.list": {
          const limit = Number((req.params as { limit?: number } | undefined)?.limit);
          result = await supervisor.listExecutionRecords(Number.isInteger(limit) ? limit : 20);
          break;
        }
        case "execution.output": {
          const id = String((req.params as { id?: string } | undefined)?.id ?? "");
          result = await supervisor.getExecutionOutput(id);
          break;
        }
        case "agent-task.availability":
          result = agentTasks.availability();
          break;
        case "agent-task.submit":
          result = await agentTasks.submit(req.params as Parameters<SupervisorAgentTaskAdapter["submit"]>[0]);
          break;
        case "agent-task.status":
          result = await agentTasks.status(String((req.params as { taskId?: string } | undefined)?.taskId ?? ""));
          break;
        case "agent-task.cancel":
          result = await agentTasks.cancel(String((req.params as { taskId?: string } | undefined)?.taskId ?? ""));
          break;
        case "agent-task.result":
          result = await agentTasks.result(String((req.params as { taskId?: string } | undefined)?.taskId ?? ""));
          break;
        case "agent-task.evidence":
          result = await agentTasks.evidence(String((req.params as { taskId?: string } | undefined)?.taskId ?? ""));
          break;
        case "workspace.change.prepare":
          result = await transaction.prepare({
            profileId: active.profileId,
            newWorkspaceRoot: (req.params as { newWorkspaceRoot: string }).newWorkspaceRoot,
          });
          break;
        case "workspace.change.commit":
          const committed = await transaction.commit({
            profileId: active.profileId,
          });
          result = committed;
          active = await profileStore.readConfig(active.profileId);
          if (committed.action === "commit" && active.currentWorkspace.root) {
            const restarted = await supervisor.restartForWorkspace(active.currentWorkspace.root);
            const invalidated = restarted.runtimeInstanceId
              ? await intentStore.invalidateForOldRuntime(restarted.runtimeInstanceId)
              : 0;
            if (invalidated > 0) {
              await audit.append({
                event: "INTENT_INVALIDATED_ON_RUNTIME_RESTART",
                count: invalidated,
                newRuntimeInstanceId: restarted.runtimeInstanceId,
              });
            }
          }
          break;
        case "watchdog.heartbeat":
          // V2 没有独立 Watchdog 进程；这里保留 RPC 兼容（旧调用方不会报错），
          // 但不再参与任何"缺失检测"，避免刷出不存在的故障。
          result = { ok: true, accepted: false, reason: "watchdog_not_applicable_in_v2" };
          break;
        case "profile.port.update": {
          // 更换本机端口：校验 → 查占用 → 停旧 Runtime → 写配置 → 新端口起 Runtime。
          // 端口策略：只按真实占用判断，不再保留任何内部端口。
          const nextPort = Number((req.params as { port?: number } | undefined)?.port);
          if (!isValidRuntimePort(nextPort)) throw new Error(`RUNTIME_PORT_INVALID:${String(nextPort)}`);
          if (nextPort === active.transport.expectedLocalPort) {
            result = { ok: true, changed: false, port: nextPort };
            break;
          }
          const inUse = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: "127.0.0.1", port: nextPort });
            const done = (value: boolean): void => { socket.destroy(); resolve(value); };
            socket.once("connect", () => done(true));
            socket.once("error", () => done(false));
            socket.setTimeout(800, () => done(false));
          });
          if (inUse) throw new Error(`RUNTIME_PORT_IN_USE:${nextPort}`);
          const previousProfile = active;
          try {
            await supervisor.stop();
            active = { ...active, transport: { ...active.transport, expectedLocalPort: nextPort } };
            await profileStore.writeConfig(active);
            activeSupervisor?.applyTransportIdentity(active.transport.publicMcpUrl, nextPort);
            await supervisor.start();
            await transport.start(nextPort).catch(() => undefined);
          } catch (error) {
            active = previousProfile;
            await profileStore.writeConfig(previousProfile).catch(() => undefined);
            activeSupervisor?.applyTransportIdentity(previousProfile.transport.publicMcpUrl, previousProfile.transport.expectedLocalPort);
            await supervisor.start().catch(() => undefined);
            throw error;
          }
          await audit.append({
            event: "RUNTIME_PORT_CHANGED",
            from: previousProfile.transport.expectedLocalPort,
            to: nextPort,
          });
          result = { ok: true, changed: true, port: nextPort };
          break;
        }
        case "runtime.restart": {
          // 重启本 Runtime（不触碰其它进程与服务）。
          // 每次重启前同步一次 transport 标识，确保 OAuth issuer 与当前公网地址一致。
          activeSupervisor?.applyTransportIdentity(active.transport.publicMcpUrl, active.transport.expectedLocalPort);
          const before = supervisor.getState();
          await supervisor.stop();
          const after = await supervisor.start();
          await audit.append({
            event: "RUNTIME_RESTARTED_BY_UI",
            previousPid: before.pid,
            pid: after.pid,
            port: after.port,
          });
          result = { ok: true, previousPid: before.pid, state: after };
          break;
        }
        case "transport.restart": {
          try {
            await transport.stop();
            await transport.start(active.transport.expectedLocalPort);
          } catch (error) {
            console.error("TRANSPORT_RESTART_FAILED", error instanceof Error ? error.stack : String(error));
            throw error;
          }
          await audit.append({
            event: "TRANSPORT_RESTARTED_BY_UI",
            provider: transport.id,
            port: active.transport.expectedLocalPort,
          });
          result = { ok: true, provider: transport.id, port: active.transport.expectedLocalPort };
          break;
        }
        case "shutdown":
          result = { ok: true };
          writeResponse({ id: req.id, sequence: requestSequence, ok: true, data: result });
          await shutdown();
          return;
        default:
          writeResponse({ id: req.id, sequence: requestSequence, ok: false, error: "unknown_method" });
          return;
      }
      writeResponse({ id: req.id, sequence: requestSequence, ok: true, data: result });
    } catch (e) {
      writeResponse({ id: req.id, sequence: requestSequence, ok: false, error: safeIpcErrorCode(e) });
    }
  }

  function safeIpcErrorCode(error: unknown): string {
    const candidate = error instanceof Error ? error.message : "";
    return /^[A-Za-z0-9_.:-]{1,100}$/.test(candidate) ? candidate : "SUPERVISOR_REQUEST_FAILED";
  }

  function safeRequestId(line: string): string | null {
    try {
      const value = (JSON.parse(line) as { id?: unknown }).id;
      return typeof value === "string" && value.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function computeReadiness(): Promise<unknown> {
    const port = active.transport.expectedLocalPort;
    const local = await probe.probeLocalBridge(port, active.currentWorkspace.workspaceId);
    const transportHealth = await transport.health();
    const remoteTransport = active.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED";
    const publicReady = transportHealth.public.healthStatus === 200 &&
      transportHealth.public.mcpAnonymous === 401 &&
      transportHealth.public.oauthDiscoveryOk &&
      transportHealth.edge.connected;
    const connectorEvidence = await readConnectorEvidence(
      STATE_ROOT,
      active.profileId,
      active.currentWorkspace.workspaceId,
    );
    const conversationEvidence = await readConversationEvidence(
      path.join(STATE_ROOT, "profiles", active.profileId),
    );
    const layers = {
      runtime: local.healthEndpointOk ? "PASS" : "FAIL",
      transport: remoteTransport
        ? (publicReady ? "PASS" : (transportHealth.process.alive ? "DEGRADED" : "FAIL"))
        : "NOT_APPLICABLE",
      connector: connectorEvidence.state,
      conversation: conversationEvidence.state,
      workspace: local.workspaceIdMatches === true ? "PASS" : "UNKNOWN",
      repository: active.currentWorkspace.root
        ? (await isGitRepo(active.currentWorkspace.root) ? "PASS" : "NOT_APPLICABLE")
        : "NOT_APPLICABLE",
    };
    return readiness.compute(layers as Parameters<typeof readiness.compute>[0], null);
  }

  async function collectDiagnostics(): Promise<DiagnosticsReport> {
    const diag = new Diagnostics({
      stateRoot: STATE_ROOT,
      supervisor,
      supervisorPid: process.pid,
      supervisorStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      watchdogProbe: async () => {
        // V2 架构里没有独立 Watchdog 进程（旧架构遗留）。诚实报告"未启用"，
        // 而不是永远 DEAD —— 后者会让诊断页和审计长期显示一个不存在的故障。
        return { alive: false, lastHeartbeatAt: null, status: "NOT_STARTED" as const };
      },
    });
    return diag.run();
  }

  async function runDiagnostics(): Promise<unknown> {
    const report = await collectDiagnostics();
    try {
      await faultKnowledge?.recordDiagnostics(report);
    } catch {
      // Diagnostics remain visible if the append-only audit projection is frozen.
      // Fault APIs fail closed and report the projection as unavailable.
    }
    // P0-7: Diagnostic Bundle is ALWAYS redacted before crossing any boundary
    // (UI / file export / IPC / logs). Default-deny specific secret-shaped fields.
    return redactObject({ ...report, isolation: V2_ISOLATION });
  }

  try {
    await supervisor.start();

    // P0-3: Wire Runtime lifecycle → RecoveryCoordinator (closed loop).
    // On unexpected Runtime exit, emit a signal that drives recovery.
    const recovery = new RecoveryCoordinator({
      supervisor,
      transport,
      audit,
      probe,
      restartWatchdog: async () => {
        // Watchdog is a separate process started via HKCU\...\Run.
        // No-op here; the OS launcher handles it.
      },
      restartSupervisor: async () => {
        // In-process restart: signal ourselves to exit; Watchdog will respawn.
        console.log(JSON.stringify({ event: "supervisor:self_restart_requested" }));
        isQuittingSupervisor = true;
        process.exit(0);
      },
      restartTransport: async () => {
        await transport.stop();
        await transport.start(active.transport.expectedLocalPort);
      },
      networkRetry: async () => {
        if (transport.id !== "local-only") await transport.health();
      },
      raiseReauthRequired: async () => {
        // CP7 will wire real re-auth signal; for now mark intent as needing refresh.
        await audit.append({ event: "REAUTH_REQUIRED_RAISED" });
      },
      rebuildRuntimeState: async () => {
        // Real implementation requires the runtime's /admin/challenge response.
        // Stub: log and let recovery markVerified if Runtime is healthy.
        await audit.append({ event: "REBUILD_RUNTIME_STATE_REQUESTED" });
      },
    });
    recoveryCoordinator = recovery;
    faultKnowledge = new FaultKnowledgeService({
      boundProfileId: active.profileId,
      audit,
      currentProfile: () => profileStore.resolveActiveProfile(),
      diagnostics: collectDiagnostics,
      supervisor,
      transport,
      recover: (signal) => recovery.handle(signal),
    });
    supervisor.on("exit", (code: number | null) => {
      void audit.append({ event: "RUNTIME_EXIT_OBSERVED", code });
      void recovery
        .handle({
          signal: "RuntimeCrash",
          layer: "runtime",
          severity: code === 0 ? "low" : "high",
          evidence: { code },
        })
        .catch((e) => console.error("recovery failed:", e));
    });

    // After new Runtime instance, invalidate old Intents
    const newRi = supervisor.getState().runtimeInstanceId;
    if (newRi) {
      const count = await intentStore.invalidateForOldRuntime(newRi);
      if (count > 0) {
        await audit.append({ event: "INTENT_INVALIDATED_ON_RUNTIME_RESTART", count, newRuntimeInstanceId: newRi });
      }
    }
    await audit.append({
      event: "RUNTIME_STARTED",
      pid: supervisor.getState().pid,
      port: supervisor.getState().port,
      runtimeInstanceId: newRi,
    });
    console.log(JSON.stringify({ event: "supervisor:runtime:started", state: supervisor.getState() }));
  } catch (e) {
    await audit.append({ event: "RUNTIME_START_FAILED", error: String(e) });
    console.error(JSON.stringify({ event: "supervisor:runtime:failed", error: String(e) }));
  }

  try {
    await transport.start(active.transport.expectedLocalPort);
    await audit.append({ event: "TRANSPORT_STARTED", provider: transport.id });
    console.log(JSON.stringify({ event: "supervisor:transport:started", provider: transport.id }));
  } catch (e) {
    await audit.append({ event: "TRANSPORT_START_FAILED", error: String(e) });
  }

  // V2 没有独立 Watchdog 进程：不再定时刷 WATCHDOG_MISSING（那是个不存在的故障），
  // 只在启动时留一条说明，诊断页统一显示"未启用"。
  await audit.append({ event: "WATCHDOG_NOT_APPLICABLE", reason: "V2 has no separate watchdog process" }).catch(() => undefined);

  const startTime = Date.now();

  const shutdown = async (): Promise<void> => {
    await audit.append({ event: "SUPERVISOR_SHUTDOWN_BEGIN" });
    try {
      const proof = await supervisor.stop();
      await audit.append({ event: "RUNTIME_STOP_RESULT", proof });
    } catch (e) {
      await audit.append({ event: "RUNTIME_STOP_FAILED", error: String(e) });
    }
    try {
      await transport.stop();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await supervisorLock.release();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("git rev-parse --is-inside-work-tree", { cwd: root, encoding: "utf8" });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function toSummary(c: ProfileConfig): {
  profileId: string;
  profileName: string;
  profileType: string;
  createdAt: string;
  currentWorkspaceRoot: string | null;
  currentWorkspaceId: string | null;
  transportProvider: string | null;
  publicMcpUrl: string | null;
  expectedLocalPort: number;
} {
  return {
    profileId: c.profileId,
    profileName: c.profileName,
    profileType: c.profileType,
    createdAt: c.createdAt,
    currentWorkspaceRoot: c.currentWorkspace.root,
    currentWorkspaceId: c.currentWorkspace.workspaceId,
    transportProvider: c.transport.provider,
    publicMcpUrl: c.transport.publicMcpUrl,
    expectedLocalPort: c.transport.expectedLocalPort,
  };
}

// Importing the Supervisor module in tests must not start a real background
// process or bind 48766. Only the direct `node supervisorMain.js` entry
// point owns the lifecycle.
const invokedAsSupervisor = Boolean(
  process.argv[1] && /(?:^|[\\/])supervisorMain\.(?:js|ts)$/i.test(process.argv[1]),
);
if (invokedAsSupervisor) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}



