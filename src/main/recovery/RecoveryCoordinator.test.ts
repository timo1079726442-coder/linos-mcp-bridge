import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess } from "node:child_process";
import { AuditChain } from "../audit/AuditChain.js";
import { SupervisorProcess } from "../process/SupervisorProcess.js";
import { LocalOnlyTransport } from "../transport/LocalOnlyTransport.js";
import { RecoveryCoordinator, RecoveryContext } from "./RecoveryCoordinator.js";

let stateRoot: string;
let audit: AuditChain;
let supervisor: SupervisorProcess;
let transport: LocalOnlyTransport;
let coord: RecoveryCoordinator;
let transportHealthy: boolean;
let failNetworkRetry: boolean;
let calls: { restartWatchdog: number; restartSupervisor: number; restartTransport: number; networkRetry: number; raiseReauth: number; rebuildState: number };

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-recovery-"));
  audit = new AuditChain(stateRoot, "mb_pf_test");
  await audit.open();
  // Shared mutable state for the stub so getState() reflects what start() did.
  const state: { pid: number | null; port: number; runtimeInstanceId: string | null; startedAt: string | null; lastError: string | null } = {
    pid: null, port: 48766, runtimeInstanceId: null, startedAt: null, lastError: null,
  };
  supervisor = {
    getState: () => ({ ...state }),
    start: async () => {
      state.pid = 99999;
      state.runtimeInstanceId = "ri-stub";
      state.startedAt = new Date().toISOString();
      return { ...state };
    },
    stop: async () => {
      state.pid = null;
      state.runtimeInstanceId = null;
    },
    isAlive: () => state.pid !== null,
  } as unknown as SupervisorProcess;
  transportHealthy = true;
  failNetworkRetry = false;
  // Stub transport whose start() always succeeds (the real LocalOnlyTransport
  // would try to bind a port which fails in CI without privileges).
  transport = {
    id: "cloudflare-named",
    start: async () => ({ url: "local://127.0.0.1:48766", startedAt: new Date().toISOString() }),
    stop: async () => {},
    restart: async () => ({ url: "local://127.0.0.1:48766", startedAt: new Date().toISOString() }),
    getStatus: () => ({
      running: true, url: "local://127.0.0.1:48766", provider: "local-only",
      edgeConnected: false, edgeIps: [], lastError: null,
      binaryPath: null, binaryVersion: null,
    }),
    health: async () => ({
      binaryFound: true, binaryPath: null, binaryVersion: null,
      process: { pid: 1234, alive: true },
      edge: { connected: transportHealthy, ips: [], since: new Date().toISOString() },
      public: {
        healthStatus: transportHealthy ? 200 : 530,
        mcpAnonymous: transportHealthy ? 401 : 530,
        oauthDiscoveryOk: transportHealthy,
        latencyMs: 1,
      },
      lastError: null,
    }),
  } as unknown as LocalOnlyTransport;
  calls = {
    restartWatchdog: 0,
    restartSupervisor: 0,
    restartTransport: 0,
    networkRetry: 0,
    raiseReauth: 0,
    rebuildState: 0,
  };
  const ctx: RecoveryContext = {
    supervisor,
    transport,
    audit,
    probe: {
      probeLocalBridge: async (port, workspaceId) => ({
        alive: true,
        healthEndpointOk: true,
        workspaceIdMatches: workspaceId === null ? null : true,
        port,
      }),
      probePublic: async () => ({ healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false }),
      toLayerStateFromHealth: () => "UNKNOWN" as const,
    },
    restartWatchdog: async () => { calls.restartWatchdog++; },
    restartSupervisor: async () => { calls.restartSupervisor++; },
    restartTransport: async () => { calls.restartTransport++; },
    networkRetry: async () => {
      calls.networkRetry++;
      if (failNetworkRetry) throw new Error("network_retry_failed");
    },
    raiseReauthRequired: async () => { calls.raiseReauth++; },
    rebuildRuntimeState: async () => { calls.rebuildState++; },
  };
  coord = new RecoveryCoordinator(ctx);
});

describe("RecoveryCoordinator (P0-C closed loop)", () => {
  it("P0-C TEST_RECOVERY_RUNTIME_CRASH_CLOSED_LOOP: RuntimePIDMissing → SPAWN_RUNTIME → RECOVERED", async () => {
    const r = await coord.handle({ signal: "RuntimePIDMissing", layer: "runtime", severity: "low", evidence: {} });
    expect(r.action).toBe("SPAWN_RUNTIME");
    expect(r.state).toBe("RECOVERED");
    expect(r.verified).toBe(true);
  });

  it("P0-C TEST_RECOVERY_WATCHDOG_MISSING_CLOSED_LOOP: uses SPAWN_WATCHDOG, NOT SPAWN_RUNTIME", async () => {
    const r = await coord.handle({ signal: "WatchdogMissing", layer: "watchdog", severity: "low", evidence: {} });
    expect(r.action).toBe("SPAWN_WATCHDOG");
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.verified).toBe(false);
    expect(calls.restartWatchdog).toBe(1);
    // CRITICAL: must NOT have invoked restartSupervisor or any runtime action.
    expect(calls.restartSupervisor).toBe(0);
  });

  it("P0-C TEST_RECOVERY_TRANSPORT_CLOSED_LOOP: RESTART_TRANSPORT", async () => {
    const r = await coord.handle({ signal: "TunnelEdgeUnhealthy", layer: "transport", severity: "low", evidence: {} });
    expect(r.action).toBe("RESTART_TRANSPORT");
    expect(r.state).toBe("RECOVERED");
    expect(calls.restartTransport).toBe(1);
  });

  it("P0-C restarts a missing tunnel through the configured-port callback", async () => {
    const r = await coord.handle({ signal: "TunnelProcessMissing", layer: "transport", severity: "low", evidence: {} });
    expect(r.action).toBe("SPAWN_TRANSPORT");
    expect(r.state).toBe("RECOVERED");
    expect(calls.restartTransport).toBe(1);
  });

  it("does not claim recovery when a public endpoint still returns 530", async () => {
    transportHealthy = false;
    const r = await coord.handle({ signal: "Public530", layer: "transport", severity: "high", evidence: {} });
    expect(r.action).toBe("NETWORK_RETRY");
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.verified).toBe(false);
  });

  it("does not claim recovery when the action executor fails despite a healthy probe", async () => {
    failNetworkRetry = true;
    const r = await coord.handle({ signal: "NetworkOffline", layer: "transport", severity: "low", evidence: {} });
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.verified).toBe(false);
  });

  it("does not claim runtime state repair without a real post-check", async () => {
    const r = await coord.handle({ signal: "RuntimeStateDrift", layer: "runtime", severity: "medium", evidence: {} });
    expect(r.action).toBe("REBUILD_STATE_FROM_VERIFIED");
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.verified).toBe(false);
    expect(calls.rebuildState).toBe(1);
  });

  it("P0-C TEST_RECOVERY_VERIFY_FAILS_TO_MANUAL: when executor fails, state falls to MANUAL", async () => {
    // Override supervisor.start to throw
    (supervisor.start as () => Promise<unknown>) = async () => { throw new Error("cannot start"); };
    const r = await coord.handle({ signal: "RuntimePIDMissing", layer: "runtime", severity: "low", evidence: {} });
    expect(r.verified).toBe(false);
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
  });

  it("P0-C TEST_FOREIGN_RUNTIME_NEVER_KILLED: ForeignRuntime → MANUAL without invoking kill", async () => {
    let killed = false;
    (supervisor as unknown as { stop: () => Promise<void> }).stop = async () => { killed = true; };
    const r = await coord.handle({ signal: "ForeignRuntime", layer: "runtime", severity: "critical", evidence: {} });
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.action).toBeNull();
    expect(killed).toBe(false);
  });

  it("P0-C OAuthTokenExpired → RAISE_REAUTH_REQUIRED (Runtime untouched)", async () => {
    const r = await coord.handle({ signal: "OAuthTokenExpired", layer: "connector", severity: "medium", evidence: {} });
    expect(r.action).toBe("RAISE_REAUTH_REQUIRED");
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.verified).toBe(false);
    expect(calls.raiseReauth).toBe(1);
  });

  it("P0-C NetworkOffline → NETWORK_RETRY", async () => {
    const r = await coord.handle({ signal: "NetworkOffline", layer: "transport", severity: "low", evidence: {} });
    expect(r.action).toBe("NETWORK_RETRY");
    expect(calls.networkRetry).toBe(1);
  });

  it("P0-C ClientMetadataChanged → MANUAL (no auto re-pin)", async () => {
    const r = await coord.handle({ signal: "ClientMetadataChanged", layer: "connector", severity: "medium", evidence: {} });
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
  });

  it("P0-C SupervisorLoopGuard → MANUAL", async () => {
    const r = await coord.handle({ signal: "SupervisorLoopGuard", layer: "supervisor", severity: "high", evidence: {} });
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
  });

  it("P0-C ConversationForbidden → MANUAL (label only, Runtime untouched)", async () => {
    let touched = false;
    (supervisor as unknown as { start: () => Promise<unknown> }).start = async () => { touched = true; return {} as ChildProcess; };
    const r = await coord.handle({ signal: "ConversationForbidden", layer: "conversation", severity: "medium", evidence: {} });
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(touched).toBe(false);
  });

  it("P0-C SupervisorMissing → SPAWN_SUPERVISOR", async () => {
    const r = await coord.handle({ signal: "SupervisorMissing", layer: "supervisor", severity: "high", evidence: {} });
    expect(r.action).toBe("SPAWN_SUPERVISOR");
    expect(calls.restartSupervisor).toBe(1);
    expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    expect(r.verified).toBe(false);
  });
});
