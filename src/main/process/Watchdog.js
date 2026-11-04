/**
 * Watchdog — per ADR-V2-003 Option B + ADR-V2-002.
 *
 * Bidirectional Liveness Coordination:
 *   - Watchdog monitors Supervisor (pid + named pipe ping, every 5s)
 *   - Supervisor monitors Watchdog (pid + named pipe ping, every 5s)
 *   - Either side abnormal exit → survivor restarts with exponential backoff
 *   - 24h budget: max 3 restarts; exceeded → LOOP_GUARD + MANUAL
 *   - Both dead → Windows Login Autostart or App bootstrap
 *
 * In CP3 this is a single-node in-process implementation that exposes the
 * state machine; CP3.1 splits it into a real separate process binary.
 */
export class Watchdog {
    budget = new RestartBudget();
    liveness = new LivenessTracker();
    /**
     * Tick the watchdog. Called every 5s by Supervisor (or by Watchdog's own
     * internal timer in standalone mode).
     */
    tick(observedSupervisorAlive, observedWatchdogAlive) {
        this.liveness.record("supervisor", observedSupervisorAlive);
        this.liveness.record("watchdog", observedWatchdogAlive);
        if (!observedSupervisorAlive) {
            return {
                action: "RESTART_SUPERVISOR",
                budget: this.budget.consume("supervisor"),
                loopGuard: this.budget.exceeded("supervisor"),
            };
        }
        if (!observedWatchdogAlive) {
            return {
                action: "RESTART_WATCHDOG",
                budget: this.budget.consume("watchdog"),
                loopGuard: this.budget.exceeded("watchdog"),
            };
        }
        return { action: "NONE", budget: this.budget.remaining("supervisor"), loopGuard: false };
    }
    currentBudget(side) {
        return {
            remaining: this.budget.remaining(side),
            loopGuard: this.budget.exceeded(side),
        };
    }
}
class LivenessTracker {
    lastSeen = new Map();
    record(side, alive) {
        if (alive)
            this.lastSeen.set(side, Date.now());
    }
    isFresh(side, maxAgeMs = 15000) {
        const ts = this.lastSeen.get(side);
        if (!ts)
            return false;
        return Date.now() - ts <= maxAgeMs;
    }
}
class RestartBudget {
    windowStart = Date.now();
    counts = new Map();
    consume(side) {
        // Reset every 24h
        if (Date.now() - this.windowStart > 24 * 60 * 60 * 1000) {
            this.counts.clear();
        }
        const cur = (this.counts.get(side) ?? 0) + 1;
        this.counts.set(side, cur);
        return Math.max(0, 3 - cur);
    }
    remaining(side) {
        return Math.max(0, 3 - (this.counts.get(side) ?? 0));
    }
    exceeded(side) {
        return (this.counts.get(side) ?? 0) >= 3;
    }
}
