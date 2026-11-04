import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore, V2IsolationConfig } from "./ProfileStore.js";
import { DeviceIdentity } from "./DeviceIdentity.js";
import type { ProfileConfig } from "../../shared/types.js";

let stateRoot: string;
let store: ProfileStore;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-profile-"));
  const device = new DeviceIdentity(stateRoot);
  await device.getDeviceId();
  store = new ProfileStore(stateRoot, device);
});

describe("ProfileStore", () => {
  it("creates a profile with default config (V2 isolated: 48767 + LOCAL_ONLY)", async () => {
    const cfg = await store.create({ profileName: "COMPANY", profileType: "company" });
    expect(cfg.profileName).toBe("COMPANY");
    expect(cfg.profileType).toBe("company");
    expect(cfg.profileId.startsWith("mb_pf_")).toBe(true);
    expect(cfg.runtimeId.startsWith("c2c_rt_")).toBe(true);
    expect(cfg.runtime.source).toBe("PACKAGED_V2");
    expect(cfg.transport.expectedLocalPort).toBe(48767);
    expect(cfg.transport.provider).toBe("LOCAL_ONLY");
  });

  it("isolates profiles by profileId", async () => {
    await store.create({ profileName: "A", profileType: "company" });
    await store.create({ profileName: "B", profileType: "home" });
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.profileName).sort()).toEqual(["A", "B"]);
  });

  it("persists the active profile instead of relying on directory enumeration order", async () => {
    const first = await store.create({ profileName: "FIRST", profileType: "custom" });
    const workspace = await mkdtemp(join(tmpdir(), "c2c-active-ws-"));
    const selected = await store.create({
      profileName: "SELECTED",
      profileType: "custom",
      initialWorkspaceRoot: workspace,
    });

    await store.writeActiveProfileId(selected.profileId);

    expect(await store.readActiveProfileId()).toBe(selected.profileId);
    expect(await store.readConfig(first.profileId)).toBeTruthy();
  });

  it("migrates a legacy installation only when exactly one Profile has a workspace", async () => {
    await store.create({ profileName: "EMPTY", profileType: "custom" });
    const workspace = await mkdtemp(join(tmpdir(), "c2c-migrate-ws-"));
    const configured = await store.create({
      profileName: "CONFIGURED",
      profileType: "custom",
      initialWorkspaceRoot: workspace,
    });
    await rm(join(stateRoot, "active-profile.json"), { force: true });

    const resolved = await store.resolveActiveProfile();

    expect(resolved?.profileId).toBe(configured.profileId);
    expect(await store.readActiveProfileId()).toBe(configured.profileId);
  });

  it("fails closed when multiple legacy Profiles have workspaces", async () => {
    const firstWorkspace = await mkdtemp(join(tmpdir(), "c2c-ambiguous-a-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "c2c-ambiguous-b-"));
    await store.create({ profileName: "FIRST", profileType: "custom", initialWorkspaceRoot: firstWorkspace });
    await store.create({ profileName: "SECOND", profileType: "custom", initialWorkspaceRoot: secondWorkspace });
    await rm(join(stateRoot, "active-profile.json"), { force: true });

    await expect(store.resolveActiveProfile()).rejects.toThrow("active_profile_required");
  });

  it("computes workspaceId as sha256(lowercase(realpath))[:12]", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2c-ws-"));
    const expectedId = await store.computeWorkspaceId(dir);
    expect(expectedId).toHaveLength(12);
    expect(expectedId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns same workspaceId for same path (case-insensitive on win32)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2c-ws-"));
    const id1 = await store.computeWorkspaceId(dir.toUpperCase());
    const id2 = await store.computeWorkspaceId(dir.toLowerCase());
    if (process.platform === "win32") {
      expect(id1).toBe(id2);
    } else {
      // On non-windows, uppercase and lowercase are different
      expect(id1).not.toBe(id2);
    }
  });

  it("atomic write prevents half-written configs", async () => {
    const cfg = await store.create({ profileName: "ATOMIC", profileType: "custom" });
    // Modify + write; simulate concurrent read in between should still see valid JSON
    const tampered = { ...cfg, profileName: "TAMPERED" };
    await store.writeConfig(tampered);
    const readBack = await store.readConfig(cfg.profileId);
    expect(readBack.profileName).toBe("TAMPERED");
  });

  it("delete removes all profile data", async () => {
    const cfg = await store.create({ profileName: "DEL", profileType: "custom" });
    await store.delete(cfg.profileId);
    const list = await store.list();
    expect(list.find((s) => s.profileId === cfg.profileId)).toBeUndefined();
  });

  // P0-A — new profile defaults are 100% isolated (CP0 Founder OPTION_A_PLUS)
  it("P0-A TEST_NEW_PROFILE_DEFAULT_ISOLATED: new profile uses 48767 + LOCAL_ONLY", async () => {
    const cfg = await store.create({ profileName: "ISOLATED", profileType: "custom" });
    expect(cfg.transport.expectedLocalPort).toBe(48767);
    expect(cfg.transport.provider).toBe("LOCAL_ONLY");
    expect(cfg.transport.hostname).toBeNull();
    expect(cfg.transport.tunnelName).toBeNull();
    expect(cfg.transport.tunnelId).toBeNull();
    expect(cfg.transport.publicMcpUrl).toBeNull();
  });

  it("P0-A TEST_NEW_PROFILE_NEVER_DEFAULTS_48765: new profile refuses 48765", async () => {
    const cfg = await store.create({ profileName: "OK", profileType: "custom" });
    expect(cfg.transport.expectedLocalPort).not.toBe(48765);
  });

  it("accepts a per-machine runtime port and rejects reserved/privileged ports", async () => {
    const custom = await store.create({ profileName: "CUSTOM PORT", profileType: "custom", expectedLocalPort: 48800 });
    expect(custom.transport.expectedLocalPort).toBe(48800);
    await expect(store.create({ profileName: "BAD", profileType: "custom", expectedLocalPort: 48765 }))
      .rejects.toThrow(/RUNTIME_PORT_INVALID/);
    await expect(store.create({ profileName: "BAD2", profileType: "custom", expectedLocalPort: 80 }))
      .rejects.toThrow(/RUNTIME_PORT_INVALID/);
  });
  it("P0-A writeConfig rejects production-port config", async () => {
    const cfg = await store.create({ profileName: "TEST", profileType: "custom" });
    const tampered = {
      ...cfg,
      transport: { ...cfg.transport, expectedLocalPort: 48765 },
    };
    await expect(store.writeConfig(tampered as ProfileConfig)).rejects.toThrow(/RUNTIME_PORT_INVALID/);
  });

  it("P0-A writeConfig rejects production-hostname config", async () => {
    const cfg = await store.create({ profileName: "TEST", profileType: "custom" });
    const tampered = {
      ...cfg,
      transport: { ...cfg.transport, publicMcpUrl: "https://mcp-legacy.example.com/mcp" },
    };
    await expect(store.writeConfig(tampered as ProfileConfig)).rejects.toThrow(/PRODUCTION/i);
  });

  it("imports a tunnel credential into the current Profile transport directory without reusing the source path", async () => {
    const cfg = await store.create({ profileName: "REMOTE", profileType: "custom" });
    const source = join(stateRoot, "selected-cloudflare.json");
    await writeFile(source, JSON.stringify({ accountTag: "fixture", tunnelSecret: "fixture-only" }), "utf8");

    const imported = await store.importServiceCredential(cfg.profileId, source);
    expect(imported.canceled).toBe(false);
    expect(imported.profileId).toBe(cfg.profileId);
    expect(imported.storedPath).not.toBe(source);
    expect(imported.storedPath?.startsWith(join(store.profileDir(cfg.profileId), "transport"))).toBe(true);
    expect(JSON.parse(await readFile(imported.storedPath!, "utf8"))).toEqual({
      accountTag: "fixture",
      tunnelSecret: "fixture-only",
    });
  });

  it("rejects a non-JSON tunnel credential before copying", async () => {
    const cfg = await store.create({ profileName: "REMOTE", profileType: "custom" });
    const source = join(stateRoot, "selected-cloudflare.txt");
    await writeFile(source, "not-json", "utf8");
    await expect(store.importServiceCredential(cfg.profileId, source)).rejects.toThrow("SERVICE_CREDENTIAL_JSON_REQUIRED");
  });

  it("service config builds an isolated Cloudflare profile and derives the public MCP URL", async () => {
    const cfg = await store.create({ profileName: "REMOTE", profileType: "custom" });
    const transportDir = join(store.profileDir(cfg.profileId), "transport");
    await mkdir(transportDir, { recursive: true });
    const credentialPath = join(transportDir, "preview-tunnel.json");
    await writeFile(credentialPath, "{}", "utf8");

    const prepared = await store.prepareServiceConnectionUpdate({
      expectedProfileId: cfg.profileId,
      provider: "CLOUDFLARE_NAMED",
      hostname: "c2c-v2-preview.example.test",
      tunnelName: "c2c-v2-preview",
      tunnelId: "preview-tunnel-id",
      credentialPath,
    });

    expect(prepared.result.changed).toBe(true);
    expect(prepared.result.restartRequired).toBe(true);
    expect(prepared.candidate.transport.expectedLocalPort).toBe(48767);
    expect(prepared.candidate.transport.publicMcpUrl).toBe("https://c2c-v2-preview.example.test/mcp");
    expect(prepared.result.settings.credentialConfigured).toBe(true);
  });

  it("service config refuses Legacy Production hostname", async () => {
    const cfg = await store.create({ profileName: "REMOTE", profileType: "custom" });
    const transportDir = join(store.profileDir(cfg.profileId), "transport");
    await mkdir(transportDir, { recursive: true });
    const credentialPath = join(transportDir, "preview-tunnel.json");
    await writeFile(credentialPath, "{}", "utf8");

    await expect(store.prepareServiceConnectionUpdate({
      expectedProfileId: cfg.profileId,
      provider: "CLOUDFLARE_NAMED",
      hostname: V2IsolationConfig.PROTECTED_PRODUCTION_HOSTNAME,
      tunnelName: "safe-preview-name",
      tunnelId: "preview-tunnel-id",
      credentialPath,
    })).rejects.toThrow(/PRODUCTION/i);
  });

  it("service config adopts a credential written outside the Profile by copying it inside", async () => {
    // cloudflared 把命名隧道凭证写在 ~/.cloudflared/<tunnelId>.json，天然在 Profile 外。
    // 旧行为直接拒绝，会让命名隧道流程永远失败；现在复制进 transport/ 后引用副本。
    const cfg = await store.create({ profileName: "REMOTE", profileType: "custom" });
    const outside = join(stateRoot, "foreign-credential.json");
    await writeFile(outside, JSON.stringify({ TunnelID: "preview-tunnel-id", TunnelSecret: "s" }), "utf8");

    const prepared = await store.prepareServiceConnectionUpdate({
      expectedProfileId: cfg.profileId,
      provider: "CLOUDFLARE_NAMED",
      hostname: "c2c-v2-preview.example.test",
      tunnelName: "c2c-v2-preview",
      tunnelId: "preview-tunnel-id",
      credentialPath: outside,
    });

    const transportDir = join(store.profileDir(cfg.profileId), "transport");
    const adopted = prepared.candidate.transport.credentialPath ?? "";
    expect(adopted.startsWith(transportDir)).toBe(true);
    expect(adopted).not.toBe(outside);
    expect(await readFile(adopted, "utf8")).toContain("preview-tunnel-id");
    expect(prepared.result.settings.credentialConfigured).toBe(true);
  });

  it("service config rejects an outside credential that does not exist", async () => {
    const cfg = await store.create({ profileName: "REMOTE", profileType: "custom" });
    await expect(store.prepareServiceConnectionUpdate({
      expectedProfileId: cfg.profileId,
      provider: "CLOUDFLARE_NAMED",
      hostname: "c2c-v2-preview.example.test",
      tunnelName: "c2c-v2-preview",
      tunnelId: "preview-tunnel-id",
      credentialPath: join(stateRoot, "missing-credential.json"),
    })).rejects.toThrow("SERVICE_CONFIG_CREDENTIAL_UNAVAILABLE");
  });
});



