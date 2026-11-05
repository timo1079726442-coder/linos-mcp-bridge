/**
 * LocalOnlyTransport — V2 default transport.
 *
 * Per ADR-0002 §2:
 *   - V2_DEFAULT_TRANSPORT = LOCAL_ONLY
 *   - No Cloudflare tunnel; no DNS; no public hostname
 *   - Readiness layer reports NOT_APPLICABLE
 *   - Diagnostics reports provider=local-only, edgeConnected=false
 *
 * This transport NEVER makes network calls. It exists so the Runtime can
 * be exercised end-to-end via the loopback bridge alone, which is sufficient
 * for local diagnostics, Recovery testing, and onboarding without touching
 * Legacy Production.
 */
export class LocalOnlyTransport {
    id = "local-only";
    displayName = "Local Only (no public surface)";
    localPort = null;
    async start(localPort) {
        this.localPort = localPort;
        return { url: `local://127.0.0.1:${localPort}`, startedAt: new Date().toISOString() };
    }
    async stop() {
        this.localPort = null;
    }
    async restart(localPort) {
        return this.start(localPort);
    }
    getStatus() {
        return {
            running: this.localPort !== null,
            url: this.localPort !== null ? `local://127.0.0.1:${this.localPort}` : null,
            provider: this.id,
            edgeConnected: false,
            edgeIps: [],
            lastError: null,
            binaryPath: null,
            binaryVersion: null,
        };
    }
    async health() {
        return {
            binaryFound: false,
            binaryPath: null,
            binaryVersion: null,
            process: { pid: null, alive: false },
            edge: { connected: false, ips: [], since: null },
            public: {
                healthStatus: null,
                mcpAnonymous: null,
                oauthDiscoveryOk: false,
                latencyMs: null,
            },
            lastError: null,
        };
    }
}
