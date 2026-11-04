import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  TransportConfig,
  TransportHandle,
  TransportHealth,
  TransportProvider,
  TransportStatus,
} from "./TransportProvider.js";
import { TransportProcessOwnership, type TransportIdentity } from "./TransportProcessOwnership.js";
import { isProcessAlive } from "../process/ProcessScanner.js";

/** Explicit, V2-isolated Cloudflare Named Tunnel transport. */
export class CloudflareNamedProvider implements TransportProvider {
  readonly id = "cloudflare-named";
  readonly displayName = "Cloudflare Named Tunnel";

  private proc: ChildProcess | null = null;
  private adoptedPid: number | null = null;
  private url: string | null = null;
  private edgeIps: string[] = [];
  private edgeConnected = false;
  private lastError: string | null = null;
  private startedAt: string | null = null;
  private readonly ownership: TransportProcessOwnership | null;

  constructor(private readonly cfg: TransportConfig) {
    this.ownership = cfg.ownershipPath ? new TransportProcessOwnership(cfg.ownershipPath) : null;
  }

  async start(localPort: number): Promise<TransportHandle> {
    this.validate(localPort);
    if (this.getStatus().running && this.url) {
      return { url: this.url, startedAt: this.startedAt ?? new Date().toISOString() };
    }

    if (process.env.C2C_TEST_NO_CLOUDFLARED === "1") {
      this.url = `https://${this.cfg.hostname}`;
      this.startedAt = new Date().toISOString();
      this.edgeIps = ["198.41.192.7", "198.41.200.13"];
      this.edgeConnected = true;
      return { url: this.url, startedAt: this.startedAt };
    }

    const identity = this.identity();
    if (!this.cfg.credentialPath || !this.cfg.configPath || !this.ownership) {
      throw new Error("V2_REMOTE_TRANSPORT_REQUIRES_EXPLICIT_CREDENTIAL_CONFIG_AND_OWNERSHIP");
    }
    await fs.access(this.cfg.credentialPath);

    const verdict = await this.ownership.inspect(identity, this.cfg.binaryPath);
    if (verdict === "OWNED_PROCESS") {
      const record = await this.ownership.read();
      if (record) {
        this.adoptedPid = record.pid;
        this.startedAt = record.startedAt;
        this.url = `https://${this.cfg.hostname}`;
        this.lastError = null;
        return { url: this.url, startedAt: this.startedAt };
      }
    }
    if (verdict === "FOREIGN_PROCESS" || verdict === "UNKNOWN") {
      throw new Error(`V2_TRANSPORT_${verdict}`);
    }
    if (verdict === "STALE") await this.ownership.clear();

    const bin = await this.resolveBinary();
    if (!bin) throw new Error("cloudflared_binary_not_found");
    await this.writeConfig(localPort);
    const started = new Date().toISOString();
    const proc = spawn(
      bin,
      [
        "tunnel",
        "--no-autoupdate",
        "--config",
        this.cfg.configPath,
        "run",
        "--credentials-file",
        this.cfg.credentialPath,
        this.cfg.tunnelName,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.proc = proc;
    this.adoptedPid = null;
    this.startedAt = started;
    this.url = `https://${this.cfg.hostname}`;
    this.lastError = null;
    const ready = new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (error: Error) => reject(error));
    });
    proc.on("error", (error: Error) => {
      this.lastError = `cloudflared_spawn_failed: ${error.message}`;
      this.proc = null;
      this.url = null;
    });
    if (proc.pid) await this.ownership.record(identity, proc.pid, started);
    proc.stdout?.on("data", (chunk: Buffer) => this.consumeOutput(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => this.consumeOutput(chunk.toString("utf8")));
    proc.on("exit", () => {
      this.proc = null;
      this.adoptedPid = null;
      this.url = null;
      this.edgeConnected = false;
      void this.ownership?.clear();
    });
    await ready;
    return { url: this.url, startedAt: started };
  }

  async stop(): Promise<void> {
    if (process.env.C2C_TEST_NO_CLOUDFLARED === "1") {
      this.resetState();
      return;
    }
    const identity = this.identity();
    if (this.proc?.pid) {
      const verdict = await this.ownership?.inspect(identity, this.cfg.binaryPath);
      if (verdict !== "OWNED_PROCESS") throw new Error(`V2_TRANSPORT_STOP_${verdict ?? "UNKNOWN"}`);
      await terminateChild(this.proc.pid);
      await this.ownership?.clear();
      this.resetState();
      return;
    }
    if (this.adoptedPid) {
      const verdict = await this.ownership?.terminateIfOwned(identity, this.cfg.binaryPath);
      if (verdict !== "OWNED_PROCESS") throw new Error(`V2_TRANSPORT_STOP_${verdict ?? "UNKNOWN"}`);
    }
    this.resetState();
  }

  async restart(localPort: number): Promise<TransportHandle> {
    await this.stop();
    return this.start(localPort);
  }

  getStatus(): TransportStatus {
    const pid = this.proc?.pid ?? this.adoptedPid ?? null;
    const running = process.env.C2C_TEST_NO_CLOUDFLARED === "1"
      ? this.url !== null
      : pid !== null && isProcessAlive(pid);
    return {
      running,
      url: running ? this.url : null,
      provider: this.id,
      edgeConnected: running && this.edgeConnected,
      edgeIps: [...this.edgeIps],
      lastError: this.lastError,
      binaryPath: this.cfg.binaryPath,
      binaryVersion: null,
    };
  }

  async health(): Promise<TransportHealth> {
    await this.reconcileOwnership();
    const status = this.getStatus();
    let publicHealthStatus: number | null = null;
    let publicMcpAnonymous: number | null = null;
    let oauthDiscoveryOk = false;
    const startMs = Date.now();
    let latencyMs: number | null = null;

    if (status.url) {
      if (process.env.C2C_TEST_NO_CLOUDFLARED === "1") {
        publicHealthStatus = 200;
        publicMcpAnonymous = 401;
        oauthDiscoveryOk = true;
        latencyMs = 0;
      } else {
        try {
          const h = await fetch(`${status.url}/health`, { signal: AbortSignal.timeout(5000) });
          publicHealthStatus = h.status;
          latencyMs = Date.now() - startMs;
        } catch { /* public edge unavailable */ }
        try {
          const m = await fetch(`${status.url}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(5000),
          });
          publicMcpAnonymous = m.status;
        } catch { /* public edge unavailable */ }
        try {
          const o = await fetch(`${status.url}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(5000) });
          oauthDiscoveryOk = o.ok;
        } catch { /* public edge unavailable */ }
        this.edgeConnected = publicHealthStatus === 200 && publicMcpAnonymous === 401 && oauthDiscoveryOk;
      }
    }

    return {
      binaryFound: Boolean(await this.resolveBinary()),
      binaryPath: this.cfg.binaryPath,
      binaryVersion: null,
      process: { pid: this.proc?.pid ?? this.adoptedPid ?? null, alive: status.running },
      edge: { connected: status.edgeConnected, ips: status.edgeIps, since: this.startedAt },
      public: { healthStatus: publicHealthStatus, mcpAnonymous: publicMcpAnonymous, oauthDiscoveryOk, latencyMs },
      lastError: status.lastError,
    };
  }

  private identity(): TransportIdentity {
    if (!this.cfg.tunnelId || !this.cfg.credentialPath) throw new Error("V2_REMOTE_TRANSPORT_IDENTITY_INCOMPLETE");
    return {
      provider: this.id,
      tunnelId: this.cfg.tunnelId,
      tunnelName: this.cfg.tunnelName,
      hostname: this.cfg.hostname,
      credentialPath: this.cfg.credentialPath,
    };
  }

  private async reconcileOwnership(): Promise<void> {
    if (process.env.C2C_TEST_NO_CLOUDFLARED === "1" || this.proc || this.adoptedPid || !this.ownership) return;
    try {
      const verdict = await this.ownership.inspect(this.identity(), this.cfg.binaryPath);
      if (verdict === "OWNED_PROCESS") {
        const record = await this.ownership.read();
        if (record) {
          this.adoptedPid = record.pid;
          this.startedAt = record.startedAt;
          this.url = `https://${this.cfg.hostname}`;
        }
      } else if (verdict === "STALE") {
        await this.ownership.clear();
      } else if (verdict === "FOREIGN_PROCESS" || verdict === "UNKNOWN") {
        this.lastError = `V2_TRANSPORT_${verdict}`;
      }
    } catch (error) {
      this.lastError = String(error).slice(0, 400);
    }
  }

  private validate(localPort: number): void {
    if (localPort !== this.cfg.expectedLocalPort) throw new Error("V2_TRANSPORT_LOCAL_PORT_MISMATCH");
    if (!this.cfg.hostname || !this.cfg.tunnelName || !this.cfg.tunnelId) throw new Error("V2_REMOTE_TRANSPORT_IDENTITY_INCOMPLETE");
  }

  private consumeOutput(line: string): void {
    const ipMatch = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
    if (ipMatch?.[1] && !this.edgeIps.includes(ipMatch[1])) this.edgeIps.push(ipMatch[1]);
    if (/registered tunnel connection/i.test(line)) this.edgeConnected = true;
    if (/\b(error|failed|fatal)\b/i.test(line)) this.lastError = line.slice(0, 400);
  }

  private async writeConfig(localPort: number): Promise<void> {
    if (!this.cfg.configPath || !this.cfg.credentialPath || !this.cfg.tunnelId) throw new Error("V2_REMOTE_TRANSPORT_CONFIG_INCOMPLETE");
    const quote = (value: string): string => JSON.stringify(value);
    const config = [
      `tunnel: ${this.cfg.tunnelId}`,
      `credentials-file: ${quote(this.cfg.credentialPath)}`,
      "ingress:",
      `  - hostname: ${quote(this.cfg.hostname)}`,
      `    service: http://127.0.0.1:${localPort}`,
      "  - service: http_status:404",
      "",
    ].join("\n");
    await fs.mkdir(path.dirname(this.cfg.configPath), { recursive: true });
    const temp = `${this.cfg.configPath}.tmp`;
    await fs.writeFile(temp, config, "utf8");
    await fs.rename(temp, this.cfg.configPath);
  }

  private async resolveBinary(): Promise<string | null> {
    if (this.cfg.binaryPath?.trim()) {
      try { await fs.access(this.cfg.binaryPath.trim()); return this.cfg.binaryPath.trim(); } catch { return null; }
    }
    // 家用机通常没把 cloudflared 加进 PATH，只给裸名会 spawn ENOENT。
    // 依次探测安装器与本项目自动下载的常见位置。
    const candidates = process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
          "C:\\Program Files\\cloudflared\\cloudflared.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "cloudflared", "cloudflared.exe"),
        ]
      : ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try { await fs.access(candidate); return candidate; } catch { /* try next */ }
    }
    return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  }

  private resetState(): void {
    this.proc = null;
    this.adoptedPid = null;
    this.url = null;
    this.edgeIps = [];
    this.edgeConnected = false;
    this.startedAt = null;
  }
}

async function terminateChild(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
}
