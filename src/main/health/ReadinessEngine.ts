import type { ReadinessSnapshot, LayerState, ProfileConfig } from "../../shared/types.js";

/**
 * ReadinessEngine — aggregates 6-layer readiness per CP1 ARCHITECTURE_V2 §6.
 *
 * Layers:
 *   RUNTIME_READY      (process / port / identity)
 *   TRANSPORT_READY    (process / edge / public health / mcp / oauth)
 *   CONNECTOR_READY    (OAuth client registry / grants)
 *   CONVERSATION_READY (recent successful workspace_info call)
 *   WORKSPACE_READY    (workspace root / workspaceId)
 *   REPO_READY         (conditional; non-git = NOT_APPLICABLE)
 *
 * Overall color rules:
 *   GREEN  = all REQUIRED layers PASS
 *   YELLOW = at least one DEGRADED, none FAIL
 *   RED    = at least one FAIL
 *   GRAY   = NOT_CONFIGURED (no profile / no workspace)
 *
 * REPO_READY does NOT affect C2C_FULL_READY when NOT_APPLICABLE.
 */
export class ReadinessEngine {
  private lastStateCheckAt: string | null = null;
  private lastFullVerification: string | null = null;
  private lastError: string | null = null;

  compute(
    layers: {
      runtime: LayerState;
      transport: LayerState;
      connector: LayerState;
      conversation: LayerState;
      workspace: LayerState;
      repository: LayerState;
    },
    lastError: string | null = null,
  ): ReadinessSnapshot {
    this.lastStateCheckAt = new Date().toISOString();
    this.lastError = lastError;
    const required: LayerState[] = [
      layers.runtime,
      layers.transport,
      layers.connector,
      layers.conversation,
      layers.workspace,
    ];
    if (layers.repository !== "NOT_APPLICABLE") {
      required.push(layers.repository);
    }
    let overall: "GREEN" | "YELLOW" | "RED" = "GREEN";
    if (required.some((l) => l === "FAIL")) overall = "RED";
    else if (required.some((l) => l === "DEGRADED" || l === "UNKNOWN")) overall = "YELLOW";

    const fullReady = required.every((l) => l === "PASS" || l === "NOT_APPLICABLE");

    if (fullReady) {
      this.lastFullVerification = new Date().toISOString();
    }

    return {
      overall,
      lastStateCheckAt: this.lastStateCheckAt,
      lastFullVerification: this.lastFullVerification,
      lastError: this.lastError,
      layers,
      c2cFullReady: fullReady,
    };
  }

  /** Build initial snapshot when no profile is configured. */
  empty(): ReadinessSnapshot {
    return {
      overall: "GRAY",
      lastStateCheckAt: null,
      lastFullVerification: null,
      lastError: null,
      layers: {
        runtime: "UNKNOWN",
        transport: "UNKNOWN",
        connector: "UNKNOWN",
        conversation: "UNKNOWN",
        workspace: "UNKNOWN",
        repository: "NOT_APPLICABLE",
      },
      c2cFullReady: false,
    };
  }

  /** Decision helper: is the given layer required for C2C_FULL_READY? */
  isLayerRequired(profile: ProfileConfig | null, layer: keyof ReadinessSnapshot["layers"]): boolean {
    if (layer === "repository") {
      // Only required when workspace is a git repo. Caller passes the actual
      // isRepo result; here we conservatively return true; engine will pass
      // NOT_APPLICABLE upstream if non-git.
      return true;
    }
    return true;
  }
}
