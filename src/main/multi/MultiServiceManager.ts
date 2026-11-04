/**
 * MultiServiceManager — 每个服务一个独立 Supervisor + 独立 state-root + 独立 Runtime。
 *
 * 默认仍是一台机器一个稳定端口；只有用户显式“新增服务”时才启动第二个。
 * 每个服务有自己的 Profile、OAuth 客户端、审计、工具策略和命名隧道。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { SupervisorAdapter } from "../ipc/SupervisorAdapter.js";
import { SupervisorClient } from "../ipc/SupervisorClient.js";
import { ProfileStore } from "../profile/ProfileStore.js";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
import { provisionNamedTunnel } from "../tunnel/NamedTunnelProvisioner.js";
import { locateCloudflared } from "../tunnel/LocalTunnelManager.js";
import { isValidRuntimePort, runtimePortError } from "../../shared/localPort.js";
import type {
  ManagedServiceCreateInput,
  ManagedServiceCreateResult,
  ManagedServiceView,
} from "../../shared/multiService.js";

interface ServiceRecord {
  id: string;
  name: string;
  port: number;
  workspace: string;
  hostname: string | null;
  profileId: string | null;
  createdAt: string;
}

export interface MultiServiceOptions {
  stateRoot: string;
  supervisorEntry: string;
  sessionRootKeyProvider: () => Promise<Buffer>;
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

async function waitHealthy(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`SERVICE_RUNTIME_NOT_READY:${port}`);
}

export class MultiServiceManager {
  private readonly root: string;
  private readonly clients = new Map<string, SupervisorClient>();

  constructor(private readonly opts: MultiServiceOptions) {
    this.root = path.join(opts.stateRoot, "services");
  }

  private dir(id: string): string {
    return path.join(this.root, id);
  }

  private async readRecord(id: string): Promise<ServiceRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir(id), "service.json"), "utf8")) as ServiceRecord;
    } catch {
      return null;
    }
  }

  private async writeRecord(record: ServiceRecord): Promise<void> {
    await fs.mkdir(this.dir(record.id), { recursive: true });
    await fs.writeFile(path.join(this.dir(record.id), "service.json"), JSON.stringify(record, null, 2), "utf8");
  }

  private clientFor(id: string): SupervisorClient {
    const existing = this.clients.get(id);
    if (existing) return existing;
    const client = new SupervisorClient({
      stateRoot: this.dir(id),
      supervisorEntry: this.opts.supervisorEntry,
      sessionRootKeyProvider: this.opts.sessionRootKeyProvider,
    });
    this.clients.set(id, client);
    return client;
  }

  private async adapterFor(id: string): Promise<SupervisorAdapter> {
    return new SupervisorAdapter(this.clientFor(id));
  }

  private async inspect(record: ServiceRecord): Promise<ManagedServiceView> {
    let status: ManagedServiceView["status"] = "UNKNOWN";
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/health`, { signal: AbortSignal.timeout(1_000) });
      status = response.ok ? "RUNNING" : "STOPPED";
    } catch {
      status = "STOPPED";
    }
    let publicMcpUrl: string | null = null;
    if (record.profileId) {
      try {
        const config = JSON.parse(await fs.readFile(
          path.join(this.dir(record.id), "profiles", record.profileId, "config.json"),
          "utf8",
        )) as { transport?: { publicMcpUrl?: string | null } };
        publicMcpUrl = config.transport?.publicMcpUrl ?? null;
      } catch {
        /* ignore */
      }
    }
    return {
      id: record.id,
      name: record.name,
      port: record.port,
      workspace: record.workspace,
      hostname: record.hostname,
      publicMcpUrl,
      profileId: record.profileId,
      status,
      createdAt: record.createdAt,
    };
  }

  async list(): Promise<ManagedServiceView[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    const rows: ManagedServiceView[] = [];
    for (const id of names) {
      const record = await this.readRecord(id);
      if (record) rows.push(await this.inspect(record));
    }
    return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(input: ManagedServiceCreateInput): Promise<ManagedServiceCreateResult> {
    const workspace = input.workspace.trim();
    if (!workspace) throw new Error("SERVICE_WORKSPACE_REQUIRED");
    if (!isValidRuntimePort(input.port)) throw new Error(runtimePortError(input.port));
    if (!(await portAvailable(input.port))) throw new Error(`SERVICE_PORT_IN_USE:${input.port}`);
    const hostname = input.hostname?.trim().toLowerCase() || null;
    if (hostname && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) throw new Error("SERVICE_HOSTNAME_INVALID");

    const id = `svc_${randomBytes(6).toString("base64url")}`;
    const record: ServiceRecord = {
      id,
      name: input.name.trim() || `MCP 服务 ${input.port}`,
      port: input.port,
      workspace,
      hostname,
      profileId: null,
      createdAt: new Date().toISOString(),
    };
    await this.writeRecord(record);

    try {
      // 先在独立 state-root 里写好 Profile，再启动 Supervisor；
      // Supervisor 启动时会以该 Active Profile 启动 Runtime，避免热切换。
      const store = new ProfileStore(this.dir(id), new DeviceIdentity(this.dir(id)));
      const profile = await store.create({
        profileName: record.name,
        profileType: "custom",
        initialWorkspaceRoot: workspace,
        expectedLocalPort: input.port,
      });
      record.profileId = profile.profileId;
      await this.writeRecord(record);

      const client = this.clientFor(id);
      await client.ensureConnected();
      await waitHealthy(input.port);
      const adapter = new SupervisorAdapter(client);

      if (hostname) {
        const provisioned = await provisionNamedTunnel({
          hostname,
          tunnelName: `linos-${id}`,
          port: input.port,
        });
        if (process.env.C2C_TRACE_MULTI === "1") console.error("MULTI stage: tunnel-provisioned", provisioned.tunnelId);
        if (!provisioned.ok) throw new Error("SERVICE_TUNNEL_PROVISION_FAILED");
        const transportDir = path.join(this.dir(id), "profiles", profile.profileId, "transport");
        await fs.mkdir(transportDir, { recursive: true });
        const credentialPath = path.join(transportDir, `${provisioned.tunnelId}.json`);
        await fs.copyFile(provisioned.credentialPath, credentialPath);
        const binaryPath = await locateCloudflared();
        if (!binaryPath) throw new Error("SERVICE_CLOUDFLARED_NOT_FOUND");
        await adapter.updateServiceConnectionSettings({
          expectedProfileId: profile.profileId,
          provider: "CLOUDFLARE_NAMED",
          hostname: provisioned.hostname,
          tunnelName: provisioned.tunnelName,
          tunnelId: provisioned.tunnelId,
          zone: provisioned.zone,
          credentialPath,
          binaryPath,
        } as Parameters<typeof adapter.updateServiceConnectionSettings>[0]);
        if (process.env.C2C_TRACE_MULTI === "1") console.error("MULTI stage: transport-updated");
        await adapter.restartTransport();
        if (process.env.C2C_TRACE_MULTI === "1") console.error("MULTI stage: transport-restarted");
      }

      if (process.env.C2C_TRACE_MULTI === "1") console.error("MULTI stage: pairing");
      const pairingResponse = await fetch(`http://127.0.0.1:${input.port}/oauth/pairing`, { method: "POST" });
      if (!pairingResponse.ok) throw new Error("SERVICE_PAIRING_UNAVAILABLE");
      const pairing = await pairingResponse.json() as { code: string; expiresAt: number };
      const view = await this.inspect(record);
      return { service: view, pairingCode: pairing.code, expiresAt: pairing.expiresAt };
    } catch (error) {
      await this.writeRecord(record);
      throw error;
    }
  }

  async start(id: string): Promise<void> {
    const record = await this.readRecord(id);
    if (!record?.profileId) throw new Error("SERVICE_PROFILE_MISSING");
    const client = this.clientFor(id);
    await client.ensureConnected();
    await waitHealthy(record.port);
  }

  async stop(id: string): Promise<void> {
    const pipeFile = path.join(this.dir(id), "supervisor-pipe.txt");
    const running = await fs.access(pipeFile).then(() => true).catch(() => false);
    if (!running) return;
    const client = this.clientFor(id);
    await client.call({ method: "shutdown", timeoutMs: 15_000 }).catch(() => undefined);
    await client.close();
    this.clients.delete(id);
  }
}


