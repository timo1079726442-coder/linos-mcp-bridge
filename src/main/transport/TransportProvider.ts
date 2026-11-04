/**
 * TransportProvider — vendor-agnostic abstraction over public connectivity.
 *
 * Per CP1 ARCHITECTURE_V2 §8 (Transport Architecture) + IDENTITY_MODEL_V2 §6:
 *   - Transport Identity = profileId + runtimeId (NOT workspaceId)
 *   - Each provider exposes start/stop/restart/health
 *   - Health separates process / edge / public health / public mcp / oauth discovery
 *
 * CP4 implements CloudflareNamedProvider as the first concrete provider.
 * Future providers (Custom Remote, LocalOnly, etc.) plug into this interface.
 */
export interface TransportHandle {
  url: string;
  startedAt: string;
}

export interface TransportStatus {
  running: boolean;
  url: string | null;
  provider: string;
  edgeConnected: boolean;
  edgeIps: string[];
  lastError: string | null;
  binaryPath: string | null;
  binaryVersion: string | null;
}

export interface TransportHealth {
  binaryFound: boolean;
  binaryPath: string | null;
  binaryVersion: string | null;
  process: { pid: number | null; alive: boolean };
  edge: { connected: boolean; ips: string[]; since: string | null };
  public: { healthStatus: number | null; mcpAnonymous: number | null; oauthDiscoveryOk: boolean; latencyMs: number | null };
  lastError: string | null;
}

export interface TransportConfig {
  provider: string;
  hostname: string;
  zone: string;
  tunnelName: string;
  tunnelId: string | null;
  /** Explicit V2-owned cloudflared executable. Null means PATH resolution. */
  binaryPath: string | null;
  /** Explicit V2-owned credential. Never inferred from ~/.cloudflared. */
  credentialPath?: string | null;
  /** V2-owned config and process-ownership records. */
  configPath?: string | null;
  ownershipPath?: string | null;
  expectedLocalPort: number;
  protocol?: "auto" | "quic" | "http2";
}

export interface TransportProvider {
  readonly id: string;
  readonly displayName: string;
  start(localPort: number): Promise<TransportHandle>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<TransportHandle>;
  getStatus(): TransportStatus;
  health(): Promise<TransportHealth>;
}
