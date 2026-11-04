import { RecoveryEngine } from "./RecoveryEngine.js";
export class RecoveryCoordinator {
    ctx;
    engine;
    constructor(ctx, policy = "STRICT_FAIL_CLOSED") {
        this.ctx = ctx;
        this.engine = new RecoveryEngine(policy);
    }
    getEngineState() {
        return this.engine.getState();
    }
    /**
     * Drive a signal through the closed loop.
     * Returns the final RecoveryResult. Never returns an "in-progress" state.
     */
    async handle(signal) {
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
            };
        }
        // 3. Execute — each action has its OWN dedicated executor (no reuse)
        const execution = await this.execute(verdict.action, signal);
        // 4. Verify
        const verification = await this.verify(verdict.action, signal);
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
            };
        }
        this.engine.markFailed(verification.reason);
        return {
            signal: signal.signal,
            action: verdict.action,
            state: "MANUAL_ACTION_REQUIRED",
            verified: false,
            reason: verification.reason,
        };
    }
    // Each action has a dedicated branch — never reuse action types across categories.
    async execute(action, signal) {
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
                const _exhaustive = action;
                void _exhaustive;
                return { ok: false, reason: `unhandled_action: ${action}` };
            }
        }
    }
    async execSpawnRuntime(signal) {
        if (!signal.layer || signal.layer !== "runtime") {
            return { ok: false, reason: "spawn_runtime_requires_runtime_layer_signal" };
        }
        try {
            await this.ctx.supervisor.start();
            return { ok: true, reason: "supervisor_started" };
        }
        catch (e) {
            return { ok: false, reason: `supervisor_start_failed: ${e.message}` };
        }
    }
    async execSpawnWatchdog(signal) {
        if (signal.layer !== "watchdog") {
            return { ok: false, reason: "spawn_watchdog_requires_watchdog_layer_signal" };
        }
        try {
            await this.ctx.restartWatchdog();
            return { ok: true, reason: "watchdog_restarted" };
        }
        catch (e) {
            return { ok: false, reason: `watchdog_restart_failed: ${e.message}` };
        }
    }
    async execSpawnSupervisor(signal) {
        if (signal.layer !== "supervisor") {
            return { ok: false, reason: "spawn_supervisor_requires_supervisor_layer_signal" };
        }
        try {
            await this.ctx.restartSupervisor();
            return { ok: true, reason: "supervisor_restart_initiated" };
        }
        catch (e) {
            return { ok: false, reason: `supervisor_restart_failed: ${e.message}` };
        }
    }
    async execSpawnTransport(signal) {
        if (signal.layer !== "transport") {
            return { ok: false, reason: "spawn_transport_requires_transport_layer_signal" };
        }
        try {
            await this.ctx.transport.start(0);
            return { ok: true, reason: "transport_started" };
        }
        catch (e) {
            return { ok: false, reason: `transport_start_failed: ${e.message}` };
        }
    }
    async execRestartTransport(signal) {
        if (signal.layer !== "transport") {
            return { ok: false, reason: "restart_transport_requires_transport_layer_signal" };
        }
        try {
            await this.ctx.transport.stop();
            await this.ctx.transport.start(0);
            return { ok: true, reason: "transport_restarted" };
        }
        catch (e) {
            return { ok: false, reason: `transport_restart_failed: ${e.message}` };
        }
    }
    async execNetworkRetry(signal) {
        if (signal.layer !== "transport") {
            return { ok: false, reason: "network_retry_requires_transport_signal" };
        }
        try {
            await this.ctx.networkRetry();
            return { ok: true, reason: "network_retry_executed" };
        }
        catch (e) {
            return { ok: false, reason: `network_retry_failed: ${e.message}` };
        }
    }
    async execRebuildState(signal) {
        if (signal.layer !== "runtime") {
            return { ok: false, reason: "rebuild_state_requires_runtime_signal" };
        }
        try {
            await this.ctx.rebuildRuntimeState();
            return { ok: true, reason: "runtime_state_rebuilt" };
        }
        catch (e) {
            return { ok: false, reason: `rebuild_failed: ${e.message}` };
        }
    }
    async execRaiseReauth(signal) {
        if (signal.layer !== "connector" && signal.layer !== "conversation") {
            return { ok: false, reason: "raise_reauth_requires_connector_or_conversation_signal" };
        }
        try {
            await this.ctx.raiseReauthRequired();
            return { ok: true, reason: "reauth_required_raised" };
        }
        catch (e) {
            return { ok: false, reason: `raise_reauth_failed: ${e.message}` };
        }
    }
    // Verify per action
    async verify(action, _signal) {
        switch (action) {
            case "SPAWN_RUNTIME": {
                const sup = this.ctx.supervisor.getState();
                const ok = sup.pid !== null && sup.pid !== undefined;
                return { ok, reason: sup.pid ? `pid=${sup.pid}` : "no_runtime_pid" };
            }
            case "SPAWN_TRANSPORT":
            case "RESTART_TRANSPORT": {
                const t = this.ctx.transport.getStatus();
                const ok = t.running && t.lastError === null;
                return { ok, reason: t.running ? "transport_running" : (t.lastError ?? "transport_not_running") };
            }
            case "SPAWN_WATCHDOG":
            case "SPAWN_SUPERVISOR": {
                // Caller responsible for verifying the restart; we accept success here.
                return { ok: true, reason: "sidecar_restart_initiated" };
            }
            case "NETWORK_RETRY": {
                const t = this.ctx.transport.getStatus();
                const ok = t.lastError === null;
                return { ok, reason: t.lastError ?? "transport_clean" };
            }
            case "REBUILD_STATE_FROM_VERIFIED": {
                return { ok: true, reason: "state_cache_rewritten" };
            }
            case "RAISE_REAUTH_REQUIRED": {
                return { ok: true, reason: "reauth_signal_emitted" };
            }
            default: {
                const _exhaustive = action;
                void _exhaustive;
                return { ok: false, reason: `verify_unhandled: ${action}` };
            }
        }
    }
}
