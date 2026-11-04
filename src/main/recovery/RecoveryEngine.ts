/**
 * RecoveryEngine — POLICY_BASED_RECOVERY state machine.
 *
 * Per CP1 RECOVERY_SAFETY_GUARD_V2 + STATE_MACHINE_V2 §6:
 *
 *   HEALTHY → DEGRADED → DIAGNOSING → SAFE_REPAIR_AVAILABLE → REPAIRING → VERIFYING → RECOVERED
 *                                          ↓
 *                                  MANUAL_ACTION_REQUIRED
 *
 * Policy semantics:
 *   - SAFE_AUTO_REPAIR: trust verdict.action unless explicitly dangerous
 *   - STRICT_FAIL_CLOSED: only escalates DANGEROUS actions to MANUAL.
 *     Routine auto-recovery (spawn runtime / transport, network retry, etc.)
 *     is still executed automatically. Dangerous actions:
 *       - Foreign runtime kill
 *       - Auth Store / Connector delete
 *       - Re-pair
 *       - Recreate Transport Credential
 *       - Change DNS / Hostname
 *       - Modify Workspace
 *     are NEVER executed automatically under either policy.
 */

export type RecoveryState =
  | "HEALTHY"
  | "DEGRADED"
  | "DIAGNOSING"
  | "SAFE_REPAIR_AVAILABLE"
  | "REPAIRING"
  | "VERIFYING"
  | "RECOVERED"
  | "MANUAL_ACTION_REQUIRED";

export type RecoveryPolicy = "STRICT_FAIL_CLOSED" | "SAFE_AUTO_REPAIR";

export type RecoveryAction =
  | "SPAWN_RUNTIME"
  | "SPAWN_WATCHDOG"
  | "SPAWN_SUPERVISOR"
  | "SPAWN_TRANSPORT"
  | "RESTART_TRANSPORT"
  | "NETWORK_RETRY"
  | "REBUILD_STATE_FROM_VERIFIED"
  | "RAISE_REAUTH_REQUIRED";

export interface RecoverySignal {
  signal: string;
  layer: "runtime" | "transport" | "connector" | "conversation" | "workspace" | "repository" | "audit" | "secret" | "supervisor" | "watchdog";
  severity: "low" | "medium" | "high" | "critical";
  evidence: Record<string, unknown>;
}

export interface RecoveryDecision {
  nextState: RecoveryState;
  action: RecoveryAction | null;
  reason: string;
  dangerous: boolean;
  manualHint?: string;
}

export class RecoveryEngine {
  private state: RecoveryState = "HEALTHY";
  private lastDecision: RecoveryDecision | null = null;

  constructor(private readonly policy: RecoveryPolicy = "STRICT_FAIL_CLOSED") {}

  getState(): RecoveryState {
    return this.state;
  }

  getLastDecision(): RecoveryDecision | null {
    return this.lastDecision;
  }

  onSignal(sig: RecoverySignal): RecoveryDecision {
    const verdict = this.classify(sig);

    if (this.state === "HEALTHY") this.state = "DEGRADED";
    if (this.state === "DEGRADED") this.state = "DIAGNOSING";

    if (this.state === "DIAGNOSING") {
      // Dangerous actions NEVER auto-execute (under either policy).
      if (verdict.dangerous) {
        this.state = "MANUAL_ACTION_REQUIRED";
        this.lastDecision = { ...verdict, action: null, reason: `DANGEROUS: ${verdict.reason}` };
        return this.lastDecision;
      }
      if (verdict.action === null) {
        this.state = "MANUAL_ACTION_REQUIRED";
        this.lastDecision = verdict;
        return verdict;
      }
      this.state = "SAFE_REPAIR_AVAILABLE";
    }

    if (this.state === "SAFE_REPAIR_AVAILABLE") {
      this.state = "REPAIRING";
    }

    if (this.state === "REPAIRING") {
      this.lastDecision = verdict;
      return verdict;
    }

    return verdict;
  }

  markVerified(): void {
    if (this.state === "REPAIRING" || this.state === "VERIFYING") {
      this.state = "VERIFYING";
      this.state = "RECOVERED";
      this.state = "HEALTHY";
    }
  }

  markFailed(reason: string): void {
    this.state = "MANUAL_ACTION_REQUIRED";
    this.lastDecision = {
      nextState: this.state,
      action: null,
      reason,
      dangerous: true,
    };
  }

  private classify(sig: RecoverySignal): RecoveryDecision {
    switch (sig.signal) {
      case "RuntimePIDMissing":
      case "RuntimeCrash":
        return {
          nextState: "DIAGNOSING",
          action: "SPAWN_RUNTIME",
          reason: "Runtime process missing; safe to spawn replacement",
          dangerous: false,
        };
      case "RuntimeStateDrift":
        return {
          nextState: "DIAGNOSING",
          action: "REBUILD_STATE_FROM_VERIFIED",
          reason: "runtime.json ≠ observed PID; rebuild from verified process",
          dangerous: false,
          manualHint: "Confirm via Diagnostics before applying",
        };
      case "RuntimeIdentityMismatch":
      case "ForeignRuntime":
      case "ProductionPortOccupied":
        return {
          nextState: "MANUAL_ACTION_REQUIRED",
          action: null,
          reason: `Identity mismatch on ${sig.layer}; cannot auto-kill foreign process`,
          dangerous: true,
          manualHint: "Claim Identity or Force Cleanup via Advanced",
        };
      case "TunnelProcessMissing":
      case "TunnelMissing":
        return {
          nextState: "DIAGNOSING",
          action: "SPAWN_TRANSPORT",
          reason: "Tunnel process missing",
          dangerous: false,
        };
      case "TunnelEdgeUnhealthy":
        return {
          nextState: "DIAGNOSING",
          action: "RESTART_TRANSPORT",
          reason: "Edge not connected",
          dangerous: false,
        };
      case "Public530":
      case "NetworkOffline":
      case "NetworkTransient":
        return {
          nextState: "DIAGNOSING",
          action: "NETWORK_RETRY",
          reason: "Network / public endpoint issue; backoff retry",
          dangerous: false,
        };
      case "OAuthTokenExpired":
      case "OAuthRefreshFailed":
        return {
          nextState: "DIAGNOSING",
          action: "RAISE_REAUTH_REQUIRED",
          reason: "OAuth tokens expired; user must re-auth (Runtime untouched)",
          dangerous: false,
        };
      case "OAuthUnknownClient":
        return {
          nextState: "DIAGNOSING",
          action: "RAISE_REAUTH_REQUIRED",
          reason: "OAuth client unknown; trigger Connection Intent flow",
          dangerous: false,
        };
      case "ClientLost":
      case "ClientMetadataChanged":
        return {
          nextState: "MANUAL_ACTION_REQUIRED",
          action: null,
          reason: "OAuth client metadata changed; awaiting user re-consent",
          dangerous: true,
        };
      case "ConsentDenied":
        return {
          nextState: "DIAGNOSING",
          action: null,
          reason: "User denied Consent; mark connector as denied; do not touch Runtime",
          dangerous: false,
        };
      case "AuthStoreCorrupted":
      case "TunnelCredentialMissing":
      case "ConnectorMissing":
        return {
          nextState: "MANUAL_ACTION_REQUIRED",
          action: null,
          reason: `Cannot auto-recover ${sig.signal}`,
          dangerous: true,
          manualHint: "Investigate via Diagnostics",
        };
      case "WorkspaceMismatch":
        return {
          nextState: "MANUAL_ACTION_REQUIRED",
          action: null,
          reason: "Workspace identity mismatch; user must choose correct workspace",
          dangerous: false,
        };
      case "WatchdogMissing":
        return {
          nextState: "DIAGNOSING",
          action: "SPAWN_WATCHDOG",
          reason: "Watchdog liveness lost; Supervisor spawns a fresh Watchdog",
          dangerous: false,
        };
      case "SupervisorMissing":
        return {
          nextState: "DIAGNOSING",
          action: "SPAWN_SUPERVISOR",
          reason: "Supervisor liveness lost; Watchdog spawns a fresh Supervisor",
          dangerous: false,
        };
      case "WatchdogLoopGuard":
      case "SupervisorLoopGuard":
        return {
          nextState: "MANUAL_ACTION_REQUIRED",
          action: null,
          reason: "Restart budget exhausted (24h x 3); manual intervention required",
          dangerous: true,
        };
      default:
        return {
          nextState: "MANUAL_ACTION_REQUIRED",
          action: null,
          reason: `Unknown signal: ${sig.signal}`,
          dangerous: true,
        };
    }
  }
}