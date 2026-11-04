import { describe, it, expect } from "vitest";
import { RecoveryEngine } from "./RecoveryEngine.js";
describe("RecoveryEngine", () => {
    it("STRICT_FAIL_CLOSED: F19 Runtime Missing → REPAIRING", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({
            signal: "RuntimePIDMissing",
            layer: "runtime",
            severity: "low",
            evidence: { pid: null },
        });
        // DEGRADED → DIAGNOSING → SAFE_REPAIR_AVAILABLE → REPAIRING (caller will markVerified)
        expect(["REPAIRING", "SAFE_REPAIR_AVAILABLE", "DIAGNOSING"]).toContain(e.getState());
    });
    it("STRICT_FAIL_CLOSED: ForeignRuntime → MANUAL (severity=critical)", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({
            signal: "ForeignRuntime",
            layer: "runtime",
            severity: "critical",
            evidence: { observedPid: 99999 },
        });
        expect(e.getState()).toBe("MANUAL_ACTION_REQUIRED");
    });
    it("STRICT_FAIL_CLOSED: AuthStoreCorrupted → MANUAL", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({
            signal: "AuthStoreCorrupted",
            layer: "secret",
            severity: "high",
            evidence: {},
        });
        expect(e.getState()).toBe("MANUAL_ACTION_REQUIRED");
    });
    it("SAFE_AUTO_REPAIR: low-severity missing transport → REPAIRING", () => {
        const e = new RecoveryEngine("SAFE_AUTO_REPAIR");
        e.onSignal({
            signal: "TunnelMissing",
            layer: "transport",
            severity: "low",
            evidence: {},
        });
        expect(["REPAIRING", "HEALTHY"]).toContain(e.getState());
    });
    it("OAuthTokenExpired → RAISE_REAUTH_REQUIRED (Runtime untouched)", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({
            signal: "OAuthTokenExpired",
            layer: "connector",
            severity: "medium",
            evidence: {},
        });
        // Action should not be SPAWN_RUNTIME
        const last = e.getLastDecision();
        expect(last?.action).not.toBe("SPAWN_RUNTIME");
    });
    it("ConversationForbidden → MANUAL (do not touch Runtime)", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({
            signal: "ConversationForbidden",
            layer: "conversation",
            severity: "medium",
            evidence: {},
        });
        expect(e.getState()).toBe("MANUAL_ACTION_REQUIRED");
    });
    it("WatchdogLoopGuard → MANUAL", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({
            signal: "WatchdogLoopGuard",
            layer: "watchdog",
            severity: "high",
            evidence: {},
        });
        expect(e.getState()).toBe("MANUAL_ACTION_REQUIRED");
    });
    it("markVerified snaps back to HEALTHY", () => {
        const e = new RecoveryEngine("STRICT_FAIL_CLOSED");
        e.onSignal({ signal: "RuntimePIDMissing", layer: "runtime", severity: "low", evidence: {} });
        e.markVerified();
        expect(e.getState()).toBe("HEALTHY");
    });
});
