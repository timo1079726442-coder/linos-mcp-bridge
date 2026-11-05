import type {
  TransportConfig,
  TransportHandle,
  TransportHealth,
  TransportProvider,
  TransportStatus,
} from "./TransportProvider.js";

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
export class LocalOnlyTransport implements TransportProvider {
  readonly id = "local-only";
  readonly displayName = "Local Only (no public surface)";

  private localPort: number | null = null;

  async start(localPort: number): Promise<TransportHandle> {
    this.localPort = localPort;
    return { url: `local://127.0.0.1:${localPort}`, startedAt: new Date().toISOString() };
  }

  async stop(): Promise<void> {
    this.localPort = null;
  }

  async restart(localPort: number): Promise<TransportHandle> {
    return this.start(localPort);
  }

  getStatus(): TransportStatus {
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

  async health(): Promise<TransportHealth> {
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