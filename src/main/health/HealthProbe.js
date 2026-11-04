/**
 * HealthProbe — minimal, capability-aware probe utilities used by the
 * ReadinessEngine. CP1 RECOVERY_SAFETY_GUARD_V2 makes the runtime layer
 * not strictly trusted (capability MAC at /admin/*); probes used here
 * remain at public endpoints and only touch the localhost bridge.
 */
export class HealthProbe {
    async probeLocalBridge(port, expectedWorkspaceId) {
        if (port <= 0) {
            return { alive: false, healthEndpointOk: false, workspaceIdMatches: null, port };
        }
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!res.ok)
                return { alive: true, healthEndpointOk: false, workspaceIdMatches: null, port };
            const body = (await res.json());
            return {
                alive: true,
                healthEndpointOk: true,
                workspaceIdMatches: expectedWorkspaceId === null || body.workspaceId === undefined
                    ? null
                    : body.workspaceId === expectedWorkspaceId,
                port,
            };
        }
        catch {
            return { alive: false, healthEndpointOk: false, workspaceIdMatches: null, port };
        }
    }
    async probePublic(publicUrl) {
        if (!publicUrl) {
            return { healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false };
        }
        let healthStatus = null;
        let mcpAnonymous = null;
        let oauthDiscoveryOk = false;
        try {
            const h = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(5000) });
            healthStatus = h.status;
        }
        catch {
            // unreachable
        }
        try {
            const m = await fetch(`${publicUrl}/mcp`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
                signal: AbortSignal.timeout(5000),
            });
            mcpAnonymous = m.status;
        }
        catch {
            // unreachable
        }
        try {
            const o = await fetch(`${publicUrl}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(5000) });
            oauthDiscoveryOk = o.ok;
        }
        catch {
            // unreachable
        }
        return { healthStatus, mcpAnonymous, oauthDiscoveryOk };
    }
    toLayerStateFromHealth(localOk, publicOk) {
        if (localOk && publicOk)
            return "PASS";
        if (localOk && !publicOk)
            return "DEGRADED";
        if (!localOk)
            return "FAIL";
        return "UNKNOWN";
    }
}
