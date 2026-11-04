import { AuditChain } from "../audit/AuditChain.js";
import { HealthProbe } from "../health/HealthProbe.js";
import { SupervisorProcess } from "../process/SupervisorProcess.js";
import type { TransportProvider } from "../transport/TransportProvider.js";
import { RecoveryAction, RecoveryEngine, RecoverySignal } from "./RecoveryEngine.js";

/**
 * RecoveryCoordinator — closed-loop recovery executor.
 *
 * Per CP1 RECOVERY_SAFETY_GUARD_V2 §11:
 *   Signal → Diagnose → Safety Gate → Execute → Verify → Audit → HEALTHY | MANUAL
 *
 * Safety Gate:
 *   - PROVEN_SAME_RUNTIME required for any runtime kill / state rebuild
 *   - Foreign Runtime detection → REFUSE auto-kill
 *   - Watchdog missing → SPAWN_WATCHDOG (NOT SPAWN_RUNTIME)
 *
 * Each action has a dedicated executor (no action reuse across categories).
 */
export interface RecoveryContext {
  supervisor: SupervisorProcess;
  transport: TransportProvider;
  audit: AuditChain;
  probe: HealthProbe;
  /** Function that restarts the Watchdog. Watchdog process TBD CP10. */
  restartWatchdog: () => Promise<void>;
  /** Function that restarts the Supervisor itself (the whole process). */
  restartSupervisor: () => Promise<void>;
  /** Function that restarts the Transport (LOCAL_ONLY currently no-op). */
  restartTransport: () => Promise<void>;
  /** Function that performs a network retry backoff cycle. */
  networkRetry: () => Promise<void>;
  /** Function that clears stored OAuth grant (triggers re-auth). */
  raiseReauthRequired: () => Promise<void>;
  /** Function that rebuilds runtime state from verified process. */
  rebuildRuntimeState: () => Promise<void>;
}

export interface RecoveryResult {
  signal: string;
  action: RecoveryAction | null;
  state: "HEALTHY" | "DEGRADED" | "DIAGNOSING" | "SAFE_REPAIR_AVAILABLE" | "REPAIRING" | "VERIFYING" | "RECOVERED" | "MANUAL_ACTION_REQUIRED";
  verified: boolean;
  reason: string;
  actionAttempted: boolean;
  actionSucceeded: boolean;
  postCheckPassed: boolean;
}

export class RecoveryCoordinator {
  private readonly engine: RecoveryEngine;

  constructor(private readonly ctx: RecoveryContext, policy: "STRICT_FAIL_CLOSED" | "SAFE_AUTO_REPAIR" = "STRICT_FAIL_CLOSED") {
    this.engine = new RecoveryEngine(policy);
  }

  getEngineState(): string {
    return this.engine.getState();
  }

  /**
   * Drive a signal through the closed loop.
   * Returns the final RecoveryResult. Never returns an "in-progress" state.
   */
  async handle(signal: RecoverySignal): Promise<RecoveryResult> {
    // 1. Diagnose
    const verdict = this.engine.onSignal(signal);
    await this.ctx.audit.append({
      event: "RECOVERY_DIAGNOSED",
      signal: signal.signal,
      layer: signal.layer,
      severity: signal.severity,
      nextState: verdict.nextState,
      reason: verdict.reason,
    });

    // 2. Safety Gate: if MANUAL or auto-kill requested, refuse immediately
    if (verdict.nextState === "MANUAL_ACTION_REQUIRED") {
      return {
        signal: signal.signal,
        action: verdict.action,
        state: "MANUAL_ACTION_REQUIRED",
        verified: false,
        reason: verdict.reason,
        actionAttempted: false,
        actionSucceeded: false,
        postCheckPassed: false,
      };
    }
    if (verdict.action === null) {
      this.engine.markFailed("no_action_for_signal");
      return {
        signal: signal.signal,
        action: null,
        state: "MANUAL_ACTION_REQUIRED",
        verified: false,
        reason: "no_action_for_signal",
        actionAttempted: false,
        actionSucceeded: false,
        postCheckPassed: false,
      };
    }

    // 3. Execute — each action has its OWN dedicated executor (no reuse)
    const execution = await this.execute(verdict.action, signal);
    await this.ctx.audit.append({
      event: execution.ok ? "RECOVERY_ACTION_EXECUTED" : "RECOVERY_ACTION_FAILED",
      signal: signal.signal,
      layer: signal.layer,
      action: verdict.action,
      outcome: execution.ok ? "initiated" : "failed",
    });

    // 4. Verify only after the executor reports success. A stale healthy state
    // must never turn a failed action into a successful recovery.
    const verification = execution.ok
      ? await this.verify(verdict.action, signal)
      : { ok: false, reason: "recovery_action_failed" };

    // 5. Audit
    await this.ctx.audit.append({
      event: verification.ok ? "RECOVERY_VERIFIED" : "RECOVERY_VERIFY_FAILED",
      signal: signal.signal,
      action: verdict.action,
      result: verification.reason,
    });

    // 6. Final state
    if (verification.ok) {
      this.engine.markVerified();
      return {
        signal: signal.signal,
        action: verdict.action,
        state: "RECOVERED",
        verified: true,
        reason: verification.reason,
        actionAttempted: true,
        actionSucceeded: execution.ok,
        postCheckPassed: true,
      };
    }
    this.engine.markFailed(verification.reason);
    return {
      signal: signal.signal,
      action: verdict.action,
      state: "MANUAL_ACTION_REQUIRED",
      verified: false,
      reason: verification.reason,
      actionAttempted: true,
      actionSucceeded: execution.ok,
      postCheckPassed: false,
    };
  }

  // Each action has a dedicated branch — never reuse action types across categories.
  private async execute(action: RecoveryAction, signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    switch (action) {
      case "SPAWN_RUNTIME":
        return await this.execSpawnRuntime(signal);
      case "SPAWN_WATCHDOG":
        return await this.execSpawnWatchdog(signal);
      case "SPAWN_SUPERVISOR":
        return await this.execSpawnSupervisor(signal);
      case "SPAWN_TRANSPORT":
        return await this.execSpawnTransport(signal);
      case "RESTART_TRANSPORT":
        return await this.execRestartTransport(signal);
      case "NETWORK_RETRY":
        return await this.execNetworkRetry(signal);
      case "REBUILD_STATE_FROM_VERIFIED":
        return await this.execRebuildState(signal);
      case "RAISE_REAUTH_REQUIRED":
        return await this.execRaiseReauth(signal);
      default: {
        // Force exhaustive check
        const _exhaustive: never = action;
        void _exhaustive;
        return { ok: false, reason: `unhandled_action: ${action}` };
      }
    }
  }

  private async execSpawnRuntime(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (!signal.layer || signal.layer !== "runtime") {
      return { ok: false, reason: "spawn_runtime_requires_runtime_layer_signal" };
    }
    try {
      await this.ctx.supervisor.start();
      return { ok: true, reason: "supervisor_started" };
    } catch (e) {
      return { ok: false, reason: `supervisor_start_failed: ${(e as Error).message}` };
    }
  }

  private async execSpawnWatchdog(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "watchdog") {
      return { ok: false, reason: "spawn_watchdog_requires_watchdog_layer_signal" };
    }
    try {
      await this.ctx.restartWatchdog();
      return { ok: true, reason: "watchdog_restarted" };
    } catch (e) {
      return { ok: false, reason: `watchdog_restart_failed: ${(e as Error).message}` };
    }
  }

  private async execSpawnSupervisor(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "supervisor") {
      return { ok: false, reason: "spawn_supervisor_requires_supervisor_layer_signal" };
    }
    try {
      await this.ctx.restartSupervisor();
      return { ok: true, reason: "supervisor_restart_initiated" };
    } catch (e) {
      return { ok: false, reason: `supervisor_restart_failed: ${(e as Error).message}` };
    }
  }

  private async execSpawnTransport(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "transport") {
      return { ok: false, reason: "spawn_transport_requires_transport_layer_signal" };
    }
    try {
      await this.ctx.restartTransport();
      return { ok: true, reason: "transport_start_requested" };
    } catch (e) {
      return { ok: false, reason: `transport_start_failed: ${(e as Error).message}` };
    }
  }

  private async execRestartTransport(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "transport") {
      return { ok: false, reason: "restart_transport_requires_transport_layer_signal" };
    }
    try {
      await this.ctx.restartTransport();
      return { ok: true, reason: "transport_restart_requested" };
    } catch (e) {
      return { ok: false, reason: `transport_restart_failed: ${(e as Error).message}` };
    }
  }

  private async execNetworkRetry(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "transport") {
      return { ok: false, reason: "network_retry_requires_transport_signal" };
    }
    try {
      await this.ctx.networkRetry();
      return { ok: true, reason: "network_retry_executed" };
    } catch (e) {
      return { ok: false, reason: `network_retry_failed: ${(e as Error).message}` };
    }
  }

  private async execRebuildState(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "runtime") {
      return { ok: false, reason: "rebuild_state_requires_runtime_signal" };
    }
    try {
      await this.ctx.rebuildRuntimeState();
      return { ok: true, reason: "runtime_state_rebuilt" };
    } catch (e) {
      return { ok: false, reason: `rebuild_failed: ${(e as Error).message}` };
    }
  }

  private async execRaiseReauth(signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    if (signal.layer !== "connector" && signal.layer !== "conversation") {
      return { ok: false, reason: "raise_reauth_requires_connector_or_conversation_signal" };
    }
    try {
      await this.ctx.raiseReauthRequired();
      return { ok: true, reason: "reauth_required_raised" };
    } catch (e) {
      return { ok: false, reason: `raise_reauth_failed: ${(e as Error).message}` };
    }
  }

  // Verify per action
  private async verify(action: RecoveryAction, _signal: RecoverySignal): Promise<{ ok: boolean; reason: string }> {
    switch (action) {
      case "SPAWN_RUNTIME": {
        const sup = this.ctx.supervisor.getState();
        const ownsLiveChild = typeof (this.ctx.supervisor as SupervisorProcess & { ownsLiveChild?: () => boolean }).ownsLiveChild === "function"
          ? (this.ctx.supervisor as SupervisorProcess & { ownsLiveChild: () => boolean }).ownsLiveChild()
          : this.ctx.supervisor.isAlive();
        if (sup.pid === null || sup.pid === undefined || !ownsLiveChild) {
          return { ok: false, reason: "no_runtime_pid" };
        }
        const expectedWorkspaceId = typeof _signal.evidence.workspaceId === "string"
          ? _signal.evidence.workspaceId
          : null;
        const sample = await this.ctx.probe.probeLocalBridge(sup.port, expectedWorkspaceId);
        const identityOk = expectedWorkspaceId === null || sample.workspaceIdMatches === true;
        const ok = sample.alive && sample.healthEndpointOk && identityOk;
        return { ok, reason: ok ? "runtime_health_verified" : "runtime_health_verification_failed" };
      }
      case "SPAWN_TRANSPORT":
      case "RESTART_TRANSPORT": {
        return await this.verifyRemoteTransport();
      }
      case "SPAWN_WATCHDOG":
      case "SPAWN_SUPERVISOR": {
        // Issuing a restart is not proof that the sidecar recovered. No
        // post-restart probe is currently wired into this coordinator.
        return { ok: false, reason: "sidecar_verification_unavailable" };
      }
      case "NETWORK_RETRY": {
        return await this.verifyRemoteTransport();
      }
      case "REBUILD_STATE_FROM_VERIFIED": {
        return { ok: false, reason: "runtime_state_rebuild_verification_unavailable" };
      }
      case "RAISE_REAUTH_REQUIRED": {
        return { ok: false, reason: "reauthentication_not_completed" };
      }
      default: {
        const _exhaustive: never = action;
        void _exhaustive;
        return { ok: false, reason: `verify_unhandled: ${action}` };
      }
    }
  }

  private async verifyRemoteTransport(): Promise<{ ok: boolean; reason: string }> {
    if (this.ctx.transport.id === "local-only") {
      return { ok: false, reason: "public_transport_not_configured" };
    }
    const status = this.ctx.transport.getStatus();
    if (!status.running) return { ok: false, reason: "transport_process_not_owned_or_running" };
    const health = await this.ctx.transport.health();
    const ok = status.running && health.process.alive &&
      health.edge.connected &&
      health.public.healthStatus === 200 &&
      health.public.mcpAnonymous === 401 &&
      health.public.oauthDiscoveryOk;
    return { ok, reason: ok ? "public_transport_verified" : "public_transport_verification_failed" };
  }
}
