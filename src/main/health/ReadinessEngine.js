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
    lastFullVerification = null;
    lastError = null;
    compute(layers, lastError = null) {
        this.lastError = lastError;
        const required = [
            layers.runtime,
            layers.transport,
            layers.connector,
            layers.conversation,
            layers.workspace,
        ];
        if (layers.repository !== "NOT_APPLICABLE") {
            required.push(layers.repository);
        }
        let overall = "GREEN";
        if (required.some((l) => l === "FAIL"))
            overall = "RED";
        else if (required.some((l) => l === "DEGRADED" || l === "UNKNOWN"))
            overall = "YELLOW";
        const fullReady = required.every((l) => l === "PASS" || l === "NOT_APPLICABLE");
        if (overall !== "GREEN" || fullReady) {
            this.lastFullVerification = new Date().toISOString();
        }
        return {
            overall,
            lastFullVerification: this.lastFullVerification,
            lastError: this.lastError,
            layers,
            c2cFullReady: fullReady,
        };
    }
    /** Build initial snapshot when no profile is configured. */
    empty() {
        return {
            overall: "GRAY",
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
    isLayerRequired(profile, layer) {
        if (layer === "repository") {
            // Only required when workspace is a git repo. Caller passes the actual
            // isRepo result; here we conservatively return true; engine will pass
            // NOT_APPLICABLE upstream if non-git.
            return true;
        }
        return true;
    }
}
