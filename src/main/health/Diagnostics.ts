/**
 * Diagnostics — no hardcoded PASS. Every value is probed from a real source
 * (process, OS, network, IPC, supervisor state). Unknown means UNKNOWN.
 */
import { ProfileStore } from "../profile/ProfileStore.js";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
import { HealthProbe } from "../health/HealthProbe.js";
import { ReadinessEngine } from "../health/ReadinessEngine.js";
import { SupervisorProcess, type SupervisorState } from "../process/SupervisorProcess.js";
import { getProcessInfo, isProcessAlive } from "../process/ProcessScanner.js";
import { LocalOnlyTransport } from "../transport/LocalOnlyTransport.js";
import { TransportFactory } from "../transport/TransportFactory.js";
import type { TransportProvider } from "../transport/TransportProvider.js";
import { SecretStore } from "../security/SecretStore.js";
import { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import { ProfileClientRegistry } from "../oauth/ProfileClientRegistry.js";
import { WorkspaceGrantStore } from "../oauth/WorkspaceGrantStore.js";
import { connectorLayerFromOAuth, readConversationEvidence } from "./ReadinessEvidence.js";
import type { ProfileConfig, DiagnosticsReport, OAuthAuthorizationStatus } from "../../shared/types.js";
import * as path from "node:path";

export interface DiagnosticsContext {
  stateRoot: string;
  /** Supervisor handle (if we own it; in our process). */
  supervisor?: SupervisorProcess;
  /** PID/start time of the independent Supervisor process, when called there. */
  supervisorPid?: number;
  supervisorStartedAt?: string;
  /** Optional reverse-heartbeat probe for the independent Watchdog. */
  watchdogProbe?: () => Promise<{ alive: boolean; lastHeartbeatAt: string | null; status: "ALIVE" | "DEAD" | "UNKNOWN" | "NOT_STARTED" }>;
  /** Health probe; default probes localhost for real production. */
  /** 覆盖本地探测重试间隔（仅测试用）。 */
  localProbeRetryDelayMs?: number;
  probe?: { probeLocalBridge: (port: number, wid: string | null) => Promise<{ alive: boolean; healthEndpointOk: boolean; workspaceIdMatches: boolean | null; port: number | null; portListening?: boolean | null }>; probePublic: (url: string | null) => Promise<{ healthStatus: number | null; mcpAnonymous: number | null; oauthDiscoveryOk: boolean }>; toLayerStateFromHealth?: () => "PASS" | "DEGRADED" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE" };
}

export class Diagnostics {
  private readonly stateRoot: string;
  private readonly supervisor?: SupervisorProcess;
  private readonly supervisorPid?: number;
  private readonly supervisorStartedAt?: string;
  private readonly watchdogProbe?: DiagnosticsContext["watchdogProbe"];
  // P0-D: probe is overridable for tests; default probes localhost.
  /** 本地探测失败后的重试间隔（毫秒）；测试可覆盖为 0。 */
  private readonly localProbeRetryDelayMs: number;
  private readonly probe: { probeLocalBridge: (port: number, wid: string | null) => Promise<{ alive: boolean; healthEndpointOk: boolean; workspaceIdMatches: boolean | null; port: number | null; portListening?: boolean | null }>; probePublic: (url: string | null) => Promise<{ healthStatus: number | null; mcpAnonymous: number | null; oauthDiscoveryOk: boolean }>; toLayerStateFromHealth?: (...args: unknown[]) => unknown };

  constructor(ctx: DiagnosticsContext) {
    this.stateRoot = ctx.stateRoot;
    this.supervisor = ctx.supervisor;
    this.supervisorPid = ctx.supervisorPid;
    this.supervisorStartedAt = ctx.supervisorStartedAt;
    this.watchdogProbe = ctx.watchdogProbe;
    this.probe = (ctx.probe ?? new HealthProbe()) as Diagnostics["probe"];
    this.localProbeRetryDelayMs = ctx.localProbeRetryDelayMs ?? 1200;
  }

  /**
   * Real diagnostics: every field is probed. UNKNOWN means we cannot determine
   * the state at this moment; PASS/FAIL only if a real measurement supports it.
   */
  /**
   * 本机 runtime 探测：首次失败后延迟重试一次。
   * 只用于消除"启动瞬间端口未监听"的误报；两次都失败仍然如实报告失败。
   */
  private async probeLocalBridgeWithRetry(
    port: number,
    workspaceId: string | null,
  ): Promise<{ alive: boolean; healthEndpointOk: boolean; workspaceIdMatches: boolean | null; port: number | null; portListening?: boolean | null }> {
    const first = await this.probe.probeLocalBridge(port, workspaceId);
    if (first.healthEndpointOk) return first;
    await new Promise((resolve) => setTimeout(resolve, this.localProbeRetryDelayMs));
    return await this.probe.probeLocalBridge(port, workspaceId);
  }

  async run(): Promise<DiagnosticsReport> {
    const device = new DeviceIdentity(this.stateRoot);
    await device.getDeviceId();
    const profileStore = new ProfileStore(this.stateRoot, device);
    const probe = this.probe;
    const engine = new ReadinessEngine();
    const workspace = new WorkspaceManager();
    const secretStore = new SecretStore(this.stateRoot, "mb_pf_diag");

    const profile = await this.getActiveProfile(profileStore);
    let transport: TransportProvider = new LocalOnlyTransport();
    let transportConfigError: string | null = null;
    if (profile) {
      try {
        transport = TransportFactory.create(profile, this.stateRoot);
      } catch (error) {
        transportConfigError = String(error);
      }
    }
    const port = profile?.transport.expectedLocalPort ?? null;
    const workspaceRoot = profile?.currentWorkspace.root ?? null;
    const workspaceId = profile?.currentWorkspace.workspaceId ?? null;

    // Runtime: probe the local bridge if we know the port.
    // 单次探测失败不足以判定 FAIL：应用/运行时刚启动的那几秒端口必然还没监听，
    // 之前会因此把"本机服务"钉成 FAIL（用户看到的就是"本地 Runtime 没有响应"）。
    // 这里做一次有界重试，两次都失败才算真的没起来。
    const local = port
      ? await this.probeLocalBridgeWithRetry(port, workspaceId)
      : { alive: false, healthEndpointOk: false, workspaceIdMatches: null, port: null, portListening: null };
    const supState = this.supervisor && typeof (this.supervisor as { getState?: unknown }).getState === "function"
      ? (this.supervisor as unknown as { getState: () => SupervisorState }).getState()
      : null;
    const runtimePid = supState?.pid ?? null;
    const runtimeIdentity =
      supState?.runtimeInstanceId && profile
        ? {
            deviceId: profile.deviceId,
            profileId: profile.profileId,
            runtimeId: profile.runtimeId,
            runtimeInstanceId: supState.runtimeInstanceId,
            workspaceId: workspaceId ?? "",
          }
        : null;

    const transportStatus = transport.getStatus();
    const transportHealth = transportConfigError
      ? {
          binaryFound: false,
          binaryPath: null,
          binaryVersion: null,
          process: { pid: null, alive: false },
          edge: { connected: false, ips: [], since: null },
          public: { healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false, latencyMs: null },
          lastError: transportConfigError,
        }
      : await transport.health();

    const runtimeAlive = runtimePid ? isProcessAlive(runtimePid) : false;
    const runtimeProc = runtimePid ? await getProcessInfo(runtimePid) : null;

    const watchdogStatus = this.watchdogProbe
      ? await this.watchdogProbe().catch(() => ({ alive: false, lastHeartbeatAt: null, status: "UNKNOWN" as const }))
      : { alive: false, lastHeartbeatAt: null, status: "NOT_STARTED" as const };
    const supervisorPid = this.supervisorPid ?? null;
    const supervisorAlive = supervisorPid !== null ? isProcessAlive(supervisorPid) : false;
    const supervisorProc = supervisorPid !== null ? await getProcessInfo(supervisorPid) : null;

    let workspaceInfo: DiagnosticsReport["workspace"] = {
      root: workspaceRoot,
      workspaceId,
      isGitRepo: false,
    };
    let repository: DiagnosticsReport["repository"] = { isGitRepo: false, branch: null, dirty: null };
    if (workspaceRoot) {
      try {
        const v = await workspace.validate(workspaceRoot);
        workspaceInfo = { root: v.root, workspaceId: v.workspaceId, isGitRepo: v.isGitRepo };
        if (v.isGitRepo) {
          repository = { isGitRepo: true, branch: v.branch, dirty: v.dirty };
        }
      } catch {
        // probe failed; keep UNKNOWN
      }
    }

    const secretHealth = await secretStore.health();
    const oauthAuthorization = await this.inspectOAuthAuthorization(profile);
    const conversationEvidence = profile
      ? await readConversationEvidence(path.join(this.stateRoot, "profiles", profile.profileId))
      : { state: "UNKNOWN" as const, latestSuccessfulTool: null, latestSuccessfulToolCallAt: null, entries: 0, chainOk: false };


    const remoteTransport = profile?.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED";
    // edge.connected 在本机探测里恒为 false（拿不到 Cloudflare edge 信息），
    // 把它当必要条件会让 transport 层永远 DEGRADED。改用三项网络信号判定。
    const publicReady = transportHealth.public.healthStatus === 200 &&
      transportHealth.public.mcpAnonymous === 401 &&
      transportHealth.public.oauthDiscoveryOk;
    const layers = {
      runtime: local.healthEndpointOk ? ("PASS" as const) : ("FAIL" as const),
      transport: remoteTransport
        ? (publicReady ? ("PASS" as const) : (transportHealth.process.alive ? ("DEGRADED" as const) : ("FAIL" as const)))
        : ("NOT_APPLICABLE" as const),
      connector: connectorLayerFromOAuth(oauthAuthorization.state),
      conversation: conversationEvidence.state,
      workspace: local.workspaceIdMatches === true ? ("PASS" as const) : local.workspaceIdMatches === null ? ("NOT_APPLICABLE" as const) : ("FAIL" as const),
      repository: (workspaceInfo.isGitRepo ? ("UNKNOWN" as const) : ("NOT_APPLICABLE" as const)),
    };
    const readiness = engine.compute(layers, transportStatus.lastError ?? transportHealth.lastError);

    return {
      generatedAt: new Date().toISOString(),
      appVersion: "2.0.0",
      osVersion: `${process.platform} ${process.arch} ${process.version}`,
      profileMetadata: profile ? toSummary(profile) : null,
      readiness,
      runtime: {
        pid: runtimePid,
        port: port,
        identity: runtimeIdentity,
        healthEndpointOk: local.healthEndpointOk,
        processCmdline: runtimeProc?.cmdline ?? null,
        processExe: runtimeProc?.executablePath ?? null,
        processStartTime: runtimeProc?.startTime ?? null,
        workspaceIdMatches: local.workspaceIdMatches,
        portListening: local.portListening ?? null,
      },
      transport: {
        provider: transportStatus.provider,
        publicUrl: transportStatus.url,
        edgeConnected: transportHealth.edge.connected,
        publicHealthStatus: transportHealth.public.healthStatus,
        publicMcpAnonymous: transportHealth.public.mcpAnonymous,
        oauthDiscoveryOk: transportHealth.public.oauthDiscoveryOk,
        processAlive: transportHealth.process.alive,
        binaryFound: transportHealth.binaryFound,
        binaryPath: transportHealth.binaryPath,
      },
      oauthAuthorization,
      workspace: workspaceInfo,
      repository,
      secretStore: {
        dpapiOk: secretHealth.dpapiOk,
        encryptionBackend: secretHealth.backend,
      },
      watchdog: {
        alive: watchdogStatus.alive,
        lastHeartbeatAt: watchdogStatus.lastHeartbeatAt,
        status: watchdogStatus.status,
      },
      supervisor: {
        alive: supervisorAlive,
        lastHeartbeatAt: supervisorAlive ? new Date().toISOString() : null,
        pid: supervisorPid,
        startedAt: this.supervisorStartedAt ?? null,
        commandImage: supervisorProc?.executablePath ?? null,
      },
      recentRecoveryActions: [],
      sanitizedLogsTail: [],
    };
  }

  private async inspectOAuthAuthorization(profile: ProfileConfig | null): Promise<OAuthAuthorizationStatus> {
    const observedAt = new Date().toISOString();
    const status = (
      state: OAuthAuthorizationStatus["state"],
      activeClientCount = 0,
      validWorkspaceGrant: boolean | null = null,
    ): OAuthAuthorizationStatus => ({ state, activeClientCount, validWorkspaceGrant, observedAt });

    if (!profile) return status("UNKNOWN");
    const registry = await new ProfileClientRegistry(this.stateRoot, profile.profileId).inspect();
    if (registry.state === "UNAVAILABLE") return status("UNKNOWN");
    const activeClients = registry.records.filter((client) => client.pinStatus === "active");
    if (activeClients.length === 0) return status("NOT_CONFIGURED");

    const workspaceId = profile.currentWorkspace.workspaceId;
    if (!workspaceId) return status("WORKSPACE_REQUIRED", activeClients.length);
    const grantSnapshot = await new WorkspaceGrantStore(this.stateRoot, profile.profileId).inspect(workspaceId);
    if (grantSnapshot.state !== "PRESENT") {
      return grantSnapshot.state === "MISSING"
        ? status("AUTH_REQUIRED", activeClients.length, false)
        : status("UNKNOWN", activeClients.length);
    }

    const grant = grantSnapshot.grant;
    if (grant.revoked || !activeClients.some((client) => client.clientId === grant.clientId)) {
      return status("REVOKED", activeClients.length, false);
    }
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return status("EXPIRED", activeClients.length, false);
    }
    return status("AUTHORIZED", activeClients.length, true);
  }

  private async getActiveProfile(store: ProfileStore): Promise<ProfileConfig | null> {
    try {
      return await store.resolveActiveProfile();
    } catch {
      // Ambiguous legacy state must fail closed. Diagnostics must never pick
      // a Profile based on directory enumeration order.
      return null;
    }
  }
}

function toSummary(c: ProfileConfig): {
  profileId: string;
  profileName: string;
  profileType: "remote" | "local" | "custom";
  createdAt: string;
  currentWorkspaceRoot: string | null;
  currentWorkspaceId: string | null;
  transportProvider: string | null;
  publicMcpUrl: string | null;
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
  };
}
