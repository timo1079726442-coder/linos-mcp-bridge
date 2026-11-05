import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DEFAULT_RUNTIME_PORT, isValidRuntimePort, runtimePortError } from "../../shared/localPort.js";
import type {
  DeviceId,
  ProfileId,
  ProfileConfig,
  ProfileSummary,
  ProfileType,
  ServiceConnectionSettingsPatch,
  ServiceConnectionSettingsUpdateResult,
  ServiceConnectionSettingsView,
  ServiceCredentialImportResult,
} from "../../shared/types.js";
import { DeviceIdentity } from "./DeviceIdentity.js";

/**
 * V2IsolationConfig — single source of truth for V2 isolation defaults.
 *
 * Per FOUNDER OPTION_A_PLUS:
 *   - V2_DEFAULT_ISOLATION = TRUE
 *   - V2_LOCAL_PORT = 48766 (NOT 48765)
 *   - V2_DEFAULT_TRANSPORT = LOCAL_ONLY
 *   - V2_PUBLIC_HOSTNAME_DEFAULT = DISABLED
 *   - AUTO_PRODUCTION_TAKEOVER = FALSE
 *   - LEGACY_MIGRATION_MODE_DEFAULT = OFF
 */
export const V2IsolationConfig = {
  V2_DEFAULT_ISOLATION: true,
  V2_LOCAL_PORT: 48766,
  V2_DEFAULT_TRANSPORT: "LOCAL_ONLY",
  V2_PUBLIC_HOSTNAME_DEFAULT: "DISABLED",
  COMPANY_PRODUCTION_PROTECTED: true,
  AUTO_PRODUCTION_TAKEOVER: false,
  LEGACY_MIGRATION_MODE_DEFAULT: false,
  RUNTIME_PROCESS_EXEC_PATH_DEFAULT_REMOVED: true,
  RESERVED_PORT: 48765,
  RESERVED_HOSTNAME: "mcp-legacy.example.com",
  RESERVED_TUNNEL_NAME: "mcpbridge-tunnel",
} as const;

/**
 * ProfileStore — multi-profile state manager with strict isolation.
 */
export class ProfileStore {
  /** @internal - read-only access for sibling modules that need state root. */
  readonly stateRoot: string;
  private readonly device: DeviceIdentity;

  constructor(stateRoot: string, device: DeviceIdentity) {
    this.stateRoot = stateRoot;
    this.device = device;
  }

  profileDir(profileId: ProfileId): string {
    return path.join(this.stateRoot, "profiles", profileId);
  }

  configPath(profileId: ProfileId): string {
    return path.join(this.profileDir(profileId), "config.json");
  }

  private activeProfilePath(): string {
    return path.join(this.stateRoot, "active-profile.json");
  }

  /**
   * Returns the persisted active profile only when it still resolves to a
   * valid v2 ProfileConfig.  Directory enumeration is deliberately not used
   * as an identity signal: NTFS enumeration order is not a product setting.
   */
  async readActiveProfileId(): Promise<ProfileId | null> {
    try {
      const raw = await fs.readFile(this.activeProfilePath(), "utf8");
      const parsed = JSON.parse(raw) as { profileId?: unknown };
      if (typeof parsed.profileId !== "string" || !parsed.profileId) return null;
      await this.readConfig(parsed.profileId as ProfileId);
      return parsed.profileId as ProfileId;
    } catch {
      return null;
    }
  }

  /** Persist the user's active profile selection atomically. */
  async writeActiveProfileId(profileId: ProfileId): Promise<void> {
    await this.readConfig(profileId);
    await fs.mkdir(this.stateRoot, { recursive: true });
    const tmp = `${this.activeProfilePath()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ profileId }, null, 2), "utf8");
    await fs.rename(tmp, this.activeProfilePath());
  }

  async list(): Promise<ProfileSummary[]> {
    const profilesDir = path.join(this.stateRoot, "profiles");
    let entries: string[] = [];
    try {
      entries = await fs.readdir(profilesDir);
    } catch {
      return [];
    }
    const summaries: ProfileSummary[] = [];
    for (const entry of entries) {
      try {
        const config = await this.readConfig(entry);
        summaries.push(toSummary(config));
      } catch {
        // skip malformed
      }
    }
    return summaries;
  }

  async readConfig(profileId: ProfileId): Promise<ProfileConfig> {
    const raw = await fs.readFile(this.configPath(profileId), "utf8");
    const parsed = JSON.parse(raw) as ProfileConfig;
    if (parsed.schemaVersion !== "v2.0") {
      throw new Error(`Unsupported schema version: ${parsed.schemaVersion}`);
    }
    return parsed;
  }

  /**
   * Resolve the one Profile the control plane is allowed to use.
   *
   * The persisted marker is authoritative. For installations created before
   * the marker existed, migrate only when exactly one Profile has a configured
   * workspace. Any ambiguity fails closed instead of relying on filesystem
   * enumeration order.
   */
  async resolveActiveProfile(): Promise<ProfileConfig | null> {
    const profiles = await this.list();
    if (profiles.length === 0) return null;

    const persistedActiveId = await this.readActiveProfileId();
    if (persistedActiveId) {
      return await this.readConfig(persistedActiveId);
    }

    const configured = (await Promise.all(
      profiles.map(async (summary) => this.readConfig(summary.profileId)),
    )).filter((profile) => Boolean(profile.currentWorkspace.root && profile.currentWorkspace.workspaceId));

    if (configured.length !== 1) {
      throw new Error("active_profile_required");
    }

    const active = configured[0]!;
    await this.writeActiveProfileId(active.profileId);
    return active;
  }

  async create(opts: {
    profileName: string;
    profileType: ProfileType;
    initialWorkspaceRoot?: string | null;
    expectedLocalPort?: number;
  }): Promise<ProfileConfig> {
    const expectedLocalPort = opts.expectedLocalPort ?? DEFAULT_RUNTIME_PORT;
    if (!isValidRuntimePort(expectedLocalPort)) throw new Error(runtimePortError(expectedLocalPort));
    const profileId = `mb_pf_${randomBytes(12).toString("base64url")}`;
    const runtimeId = `c2c_rt_${randomBytes(12).toString("base64url")}`;
    const deviceId = await this.device.getDeviceId();
    const now = new Date().toISOString();

    const config: ProfileConfig = {
      schemaVersion: "v2.0",
      profileId,
      profileName: opts.profileName,
      profileType: opts.profileType,
      createdAt: now,
      deviceId,
      runtimeId,
      currentWorkspace: {
        root: opts.initialWorkspaceRoot ?? null,
        workspaceId: opts.initialWorkspaceRoot
          ? await this.computeWorkspaceId(opts.initialWorkspaceRoot)
          : null,
      },
      transport: {
        transportId: null,
        provider: V2IsolationConfig.V2_DEFAULT_TRANSPORT, // LOCAL_ONLY
        tunnelName: null,
        tunnelId: null,
        hostname: null,
        zone: null,
        publicMcpUrl: null,
        expectedLocalPort,
        binaryPath: null,
        credentialPath: null,
      },
      expectedLocalHost: "127.0.0.1",
      runtime: {
        source: "PACKAGED_V2",
        binaryPath: null,
        entryPath: null,
      },
      trustedRedirectPolicy: {
        source: "BUILTIN_KNOWN_GOOD_ORIGINS",
        builtinOrigins: [],
        userApprovedOrigins: [],
        signedPolicyUpdates: [],
      },
      chatgptLaunchUrl: "https://chatgpt.com",
      healthCheckIntervalSec: 30,
      autoStart: { atLogin: true, minimized: false },
      autoRepair: {
        policy: "STRICT_FAIL_CLOSED",
        maxRetriesPerDay: 3,
        cooldownSec: 300,
      },
    };

    // Final safety check: any default-produced config must NOT carry
    // Legacy Production residue. Throw immediately if so.
    enforceIsolatedDefaults(config);

    await fs.mkdir(this.profileDir(profileId), { recursive: true });
    await fs.mkdir(path.join(this.profileDir(profileId), "grants"), { recursive: true });
    await fs.mkdir(path.join(this.profileDir(profileId), "transport"), { recursive: true });
    await fs.mkdir(path.join(this.profileDir(profileId), "audit"), { recursive: true });
    await fs.mkdir(path.join(this.profileDir(profileId), "audit", "archive"), { recursive: true });
    await this.writeConfig(config);
    if ((await this.readActiveProfileId()) === null) {
      await this.writeActiveProfileId(profileId);
    }
    return config;
  }

  async prepareServiceConnectionUpdate(patch: ServiceConnectionSettingsPatch): Promise<{
    candidate: ProfileConfig;
    result: ServiceConnectionSettingsUpdateResult;
  }> {
    const current = await this.readConfig(patch.expectedProfileId);
    if (current.profileId !== patch.expectedProfileId) throw new Error("SERVICE_CONFIG_PROFILE_MISMATCH");

    const provider = normalizeServiceProvider(patch.provider);
    const nextTransport = provider === "LOCAL_ONLY"
      ? {
          ...current.transport,
          provider: "LOCAL_ONLY",
          tunnelName: null,
          tunnelId: null,
          hostname: null,
          zone: null,
          publicMcpUrl: null,
          expectedLocalPort: current.transport.expectedLocalPort,
          binaryPath: null,
          credentialPath: null,
        }
      : await this.buildRemoteTransport(current, patch);

    const candidate: ProfileConfig = { ...current, transport: nextTransport };
    enforceIsolatedDefaults(candidate);
    const changed = JSON.stringify(current.transport) !== JSON.stringify(candidate.transport);
    return {
      candidate,
      result: {
        changed,
        restartRequired: changed,
        settings: toServiceConnectionSettingsView(candidate),
      },
    };
  }

  async getServiceConnectionSettings(profileId: ProfileId): Promise<ServiceConnectionSettingsView> {
    return toServiceConnectionSettingsView(await this.readConfig(profileId));
  }

  async importServiceCredential(profileId: ProfileId, sourcePath: string): Promise<ServiceCredentialImportResult> {
    await this.readConfig(profileId);
    const source = path.resolve(sourcePath);
    if (path.extname(source).toLowerCase() !== ".json") throw new Error("SERVICE_CREDENTIAL_JSON_REQUIRED");
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isFile() || stat.size < 2 || stat.size > 1_000_000) {
      throw new Error("SERVICE_CREDENTIAL_FILE_INVALID");
    }

    const bytes = await fs.readFile(source);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      bytes.fill(0);
      throw new Error("SERVICE_CREDENTIAL_JSON_INVALID");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      bytes.fill(0);
      throw new Error("SERVICE_CREDENTIAL_JSON_INVALID");
    }

    const transportDir = path.resolve(this.profileDir(profileId), "transport");
    await fs.mkdir(transportDir, { recursive: true });
    const fileName = `credential-${randomBytes(12).toString("base64url")}.json`;
    const storedPath = path.join(transportDir, fileName);
    try {
      await fs.writeFile(storedPath, bytes, { flag: "wx", mode: 0o600 });
    } finally {
      bytes.fill(0);
    }
    return { canceled: false, profileId, fileName, storedPath };
  }

  private async buildRemoteTransport(
    current: ProfileConfig,
    patch: ServiceConnectionSettingsPatch,
  ): Promise<ProfileConfig["transport"]> {
    const hostname = requireHostname(patch.hostname ?? current.transport.hostname);
    const tunnelName = requireSafeIdentifier(patch.tunnelName ?? current.transport.tunnelName, "SERVICE_CONFIG_TUNNEL_NAME_REQUIRED");
    const tunnelId = requireSafeIdentifier(patch.tunnelId ?? current.transport.tunnelId, "SERVICE_CONFIG_TUNNEL_ID_REQUIRED");
    const zone = optionalTrimmed(patch.zone === undefined ? current.transport.zone : patch.zone);
    const binaryPath = optionalTrimmed(patch.binaryPath === undefined ? current.transport.binaryPath : patch.binaryPath);
    const credentialPath = optionalTrimmed(patch.credentialPath === undefined ? current.transport.credentialPath : patch.credentialPath);
    if (!credentialPath) throw new Error("SERVICE_CONFIG_CREDENTIAL_REQUIRED");

    const transportDir = path.resolve(this.profileDir(current.profileId), "transport");
    let resolvedCredential = path.resolve(credentialPath);
    if (!isDescendantOrSelf(transportDir, resolvedCredential)) {
      // cloudflared 把命名隧道凭证写在 ~/.cloudflared/<tunnelId>.json，天然在 Profile 外。
      // 安全要求是"凭证必须存放在 Profile 内"，所以这里把凭证复制进 transport/ 后引用副本，
      // 而不是让整个命名隧道流程失败（旧行为会把用户卡死在仅本机模式）。
      const sourceStat = await fs.stat(resolvedCredential).catch(() => null);
      if (!sourceStat?.isFile()) throw new Error("SERVICE_CONFIG_CREDENTIAL_UNAVAILABLE");
      if (sourceStat.size < 2 || sourceStat.size > 1_000_000) throw new Error("SERVICE_CONFIG_CREDENTIAL_FILE_INVALID");
      await fs.mkdir(transportDir, { recursive: true });
      const copyPath = path.join(transportDir, `credential-${randomBytes(12).toString("base64url")}.json`);
      await fs.copyFile(resolvedCredential, copyPath);
      await fs.chmod(copyPath, 0o600).catch(() => undefined);
      resolvedCredential = copyPath;
    }
    const credentialStat = await fs.stat(resolvedCredential).catch(() => null);
    if (!credentialStat?.isFile()) throw new Error("SERVICE_CONFIG_CREDENTIAL_UNAVAILABLE");
    if (binaryPath) {
      const binaryStat = await fs.stat(path.resolve(binaryPath)).catch(() => null);
      if (!binaryStat?.isFile()) throw new Error("SERVICE_CONFIG_BINARY_UNAVAILABLE");
    }

    return {
      ...current.transport,
      provider: "CLOUDFLARE_NAMED",
      tunnelName,
      tunnelId,
      hostname,
      zone,
      publicMcpUrl: `https://${hostname}/mcp`,
      expectedLocalPort: current.transport.expectedLocalPort,
      binaryPath,
      credentialPath: resolvedCredential,
    };
  }

  async writeConfig(config: ProfileConfig): Promise<void> {
    // writeConfig also enforces isolation: any incoming config that tries to
    // bring production residue is rejected before it hits disk.
    enforceIsolatedDefaults(config);
    const target = this.configPath(config.profileId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  async delete(profileId: ProfileId): Promise<void> {
    await fs.rm(this.profileDir(profileId), { recursive: true, force: true });
  }

  async computeWorkspaceId(root: string): Promise<string> {
    let real = root;
    try {
      real = await fs.realpath(root);
    } catch {
      real = root;
    }
    const normalized = process.platform === "win32" || process.platform === "darwin"
      ? real.toLowerCase()
      : real;
    return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  static defaultStateRoot(): string {
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
      return path.join(localAppData, "linos-c2c-control-center");
    }
    return path.join(os.homedir(), ".local", "share", "linos-c2c-control-center");
  }
}

/**
 * enforceIsolatedDefaults — refuse to accept any Profile that defaults to
 * Legacy Production values. Centralized so the rule cannot be bypassed.
 */
export function enforceIsolatedDefaults(config: ProfileConfig): void {
  if (!isValidRuntimePort(config.transport.expectedLocalPort)) {
    throw new Error(
      `V2_ISOLATION: profile ${config.profileId} ${runtimePortError(config.transport.expectedLocalPort)}`,
    );
  }
  const provider = (config.transport.provider ?? "LOCAL_ONLY").replace(/[-\s]/g, "_").toUpperCase();
  const publicUrl = config.transport.publicMcpUrl?.toLowerCase() ?? "";
  const hostname = config.transport.hostname?.toLowerCase() ?? "";
  const tunnelName = config.transport.tunnelName?.toLowerCase() ?? "";
  if (publicUrl.includes(V2IsolationConfig.RESERVED_HOSTNAME)) {
    throw new Error(
      `V2_ISOLATION: profile ${config.profileId} refuses to default-bind ` +
        `Reserved hostname ${V2IsolationConfig.RESERVED_HOSTNAME}`,
    );
  }
  if (provider === "LOCAL_ONLY" && config.transport.publicMcpUrl?.trim()) {
    throw new Error("V2_LOCAL_ONLY_PUBLIC_URL_FORBIDDEN");
  }
  if (hostname.includes(V2IsolationConfig.RESERVED_HOSTNAME)) {
    throw new Error(
      `V2_ISOLATION: profile ${config.profileId} refuses to use ` +
        `Reserved hostname ${V2IsolationConfig.RESERVED_HOSTNAME}`,
    );
  }
  if (tunnelName.includes(V2IsolationConfig.RESERVED_TUNNEL_NAME)) {
    throw new Error(
      `V2_ISOLATION: profile ${config.profileId} refuses to default-use ` +
        `Reserved tunnel ${V2IsolationConfig.RESERVED_TUNNEL_NAME}`,
    );
  }
  if (config.transport.credentialPath?.toLowerCase().includes(V2IsolationConfig.RESERVED_TUNNEL_NAME)) {
    throw new Error(
      `V2_ISOLATION: profile ${config.profileId} refuses to use Legacy Production credential identity`,
    );
  }
}

function normalizeServiceProvider(value: string): "LOCAL_ONLY" | "CLOUDFLARE_NAMED" {
  const normalized = value.trim().replace(/[-\s]/g, "_").toUpperCase();
  if (normalized === "LOCAL_ONLY" || normalized === "CLOUDFLARE_NAMED") return normalized;
  throw new Error("SERVICE_CONFIG_PROVIDER_UNSUPPORTED");
}

function requireHostname(value: string | null | undefined): string {
  const hostname = value?.trim().toLowerCase() ?? "";
  if (!hostname || hostname.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) || hostname.includes("..")) {
    throw new Error("SERVICE_CONFIG_HOSTNAME_INVALID");
  }
  return hostname;
}

function requireSafeIdentifier(value: string | null | undefined, code: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) throw new Error(code);
  return normalized;
}

function optionalTrimmed(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized || null;
}

function isDescendantOrSelf(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  const normalizedTarget = path.resolve(target).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

export function toServiceConnectionSettingsView(c: ProfileConfig): ServiceConnectionSettingsView {
  const provider = normalizeServiceProvider(c.transport.provider ?? "LOCAL_ONLY");
  return {
    profileId: c.profileId,
    provider,
    expectedLocalHost: c.expectedLocalHost,
    expectedLocalPort: c.transport.expectedLocalPort,
    hostname: c.transport.hostname,
    tunnelName: c.transport.tunnelName,
    tunnelId: c.transport.tunnelId,
    zone: c.transport.zone,
    publicMcpUrl: c.transport.publicMcpUrl,
    binaryPath: c.transport.binaryPath ?? null,
    credentialConfigured: Boolean(c.transport.credentialPath?.trim()),
    chatgptLaunchUrl: c.chatgptLaunchUrl,
  };
}

function toSummary(c: ProfileConfig): ProfileSummary {
  return {
    profileId: c.profileId,
    profileName: c.profileName,
    profileType: c.profileType,
    createdAt: c.createdAt,
    currentWorkspaceRoot: c.currentWorkspace.root,
    currentWorkspaceId: c.currentWorkspace.workspaceId,
    transportProvider: c.transport.provider,
    publicMcpUrl: c.transport.publicMcpUrl,
  };
}
