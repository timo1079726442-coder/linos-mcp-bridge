import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditChain } from "../audit/AuditChain.js";
import { RecoveryCoordinator } from "./RecoveryCoordinator.js";
let stateRoot;
let audit;
let supervisor;
let transport;
let coord;
let calls;
beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "c2c-recovery-"));
    audit = new AuditChain(stateRoot, "mb_pf_test");
    await audit.open();
    // Shared mutable state for the stub so getState() reflects what start() did.
    const state = {
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
    };
    // Stub transport whose start() always succeeds (the real LocalOnlyTransport
    // would try to bind a port which fails in CI without privileges).
    transport = {
        start: async () => ({ url: "local://127.0.0.1:48766", startedAt: new Date().toISOString() }),
        stop: async () => { },
        restart: async () => ({ url: "local://127.0.0.1:48766", startedAt: new Date().toISOString() }),
        getStatus: () => ({
            running: true, url: "local://127.0.0.1:48766", provider: "local-only",
            edgeConnected: false, edgeIps: [], lastError: null,
            binaryPath: null, binaryVersion: null,
        }),
        health: async () => ({
            binaryFound: false, binaryPath: null, binaryVersion: null,
            process: { pid: null, alive: false },
            edge: { connected: false, ips: [], since: null },
            public: { healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false, latencyMs: null },
            lastError: null,
        }),
    };
    calls = {
        restartWatchdog: 0,
        restartSupervisor: 0,
        restartTransport: 0,
        networkRetry: 0,
        raiseReauth: 0,
        rebuildState: 0,
    };
    const ctx = {
        supervisor,
        transport,
        audit,
        probe: {
            probeLocalBridge: async () => ({ alive: false, healthEndpointOk: false, workspaceIdMatches: null, port: null }),
            probePublic: async () => ({ healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false }),
            toLayerStateFromHealth: () => "UNKNOWN",
        },
        restartWatchdog: async () => { calls.restartWatchdog++; },
        restartSupervisor: async () => { calls.restartSupervisor++; },
        restartTransport: async () => { calls.restartTransport++; },
        networkRetry: async () => { calls.networkRetry++; },
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
        expect(r.state).toBe("RECOVERED");
        expect(calls.restartWatchdog).toBe(1);
        // CRITICAL: must NOT have invoked restartSupervisor or any runtime action.
        expect(calls.restartSupervisor).toBe(0);
    });
    it("P0-C TEST_RECOVERY_TRANSPORT_CLOSED_LOOP: RESTART_TRANSPORT", async () => {
        const r = await coord.handle({ signal: "TunnelEdgeUnhealthy", layer: "transport", severity: "low", evidence: {} });
        expect(r.action).toBe("RESTART_TRANSPORT");
        expect(r.state).toBe("RECOVERED");
    });
    it("P0-C TEST_RECOVERY_VERIFY_FAILS_TO_MANUAL: when executor fails, state falls to MANUAL", async () => {
        // Override supervisor.start to throw
        supervisor.start = async () => { throw new Error("cannot start"); };
        const r = await coord.handle({ signal: "RuntimePIDMissing", layer: "runtime", severity: "low", evidence: {} });
        expect(r.verified).toBe(false);
        expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
    });
    it("P0-C TEST_FOREIGN_RUNTIME_NEVER_KILLED: ForeignRuntime → MANUAL without invoking kill", async () => {
        let killed = false;
        supervisor.stop = async () => { killed = true; };
        const r = await coord.handle({ signal: "ForeignRuntime", layer: "runtime", severity: "critical", evidence: {} });
        expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
        expect(r.action).toBeNull();
        expect(killed).toBe(false);
    });
    it("P0-C OAuthTokenExpired → RAISE_REAUTH_REQUIRED (Runtime untouched)", async () => {
        const r = await coord.handle({ signal: "OAuthTokenExpired", layer: "connector", severity: "medium", evidence: {} });
        expect(r.action).toBe("RAISE_REAUTH_REQUIRED");
        expect(r.state).toBe("RECOVERED");
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
        supervisor.start = async () => { touched = true; return {}; };
        const r = await coord.handle({ signal: "ConversationForbidden", layer: "conversation", severity: "medium", evidence: {} });
        expect(r.state).toBe("MANUAL_ACTION_REQUIRED");
        expect(touched).toBe(false);
    });
    it("P0-C SupervisorMissing → SPAWN_SUPERVISOR", async () => {
        const r = await coord.handle({ signal: "SupervisorMissing", layer: "supervisor", severity: "high", evidence: {} });
        expect(r.action).toBe("SPAWN_SUPERVISOR");
        expect(calls.restartSupervisor).toBe(1);
    });
});
