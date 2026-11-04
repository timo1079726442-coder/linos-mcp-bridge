import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { TransportFactory } from "./TransportFactory.js";
import type { ProfileConfig } from "../../shared/types.js";

function profile(overrides: Partial<ProfileConfig["transport"]> = {}): ProfileConfig {
  return {
    schemaVersion: "v2.0",
    profileId: "mb_pf_factory",
    profileName: "Factory Test",
    profileType: "custom",
    createdAt: new Date(0).toISOString(),
    deviceId: "c2c_dev_factory",
    runtimeId: "c2c_rt_factory",
    currentWorkspace: { root: null, workspaceId: null },
    transport: {
      transportId: null,
      provider: "LOCAL_ONLY",
      tunnelName: null,
      tunnelId: null,
      hostname: null,
      zone: null,
      publicMcpUrl: null,
      expectedLocalPort: 48766,
      ...overrides,
    },
    expectedLocalHost: "127.0.0.1",
    runtime: { source: "PACKAGED_V2", binaryPath: null, entryPath: null },
    trustedRedirectPolicy: { source: "BUILTIN_KNOWN_GOOD_ORIGINS", builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] },
    chatgptLaunchUrl: "https://chatgpt.com",
    healthCheckIntervalSec: 30,
    autoStart: { atLogin: true, minimized: false },
    autoRepair: { policy: "STRICT_FAIL_CLOSED", maxRetriesPerDay: 3, cooldownSec: 300 },
  };
}

describe("TransportFactory", () => {
  it("keeps a new profile LOCAL_ONLY", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-factory-local-"));
    const transport = TransportFactory.create(profile(), stateRoot);
    expect(transport.id).toBe("local-only");
  });

  it("creates CloudflareNamedProvider only from a complete V2-owned profile", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-factory-remote-"));
    const transportDir = path.join(stateRoot, "profiles", "mb_pf_factory", "transport");
    const credentialPath = path.join(transportDir, "c2c-v2-preview-590b136e-4641-416d-820b-7708bf9179c0.json");
    await mkdir(transportDir, { recursive: true });
    await writeFile(credentialPath, "test-only");
    const transport = TransportFactory.create(profile({
      provider: "CLOUDFLARE_NAMED",
      tunnelName: "c2c-v2-preview",
      tunnelId: "590b136e-4641-416d-820b-7708bf9179c0",
      hostname: "c2c-v2-preview.example.com",
      zone: "example.com",
      publicMcpUrl: "https://c2c-v2-preview.example.com/mcp",
      credentialPath,
    }), stateRoot);
    expect(transport.id).toBe("cloudflare-named");
  });

  it("fails closed when a remote credential is outside the V2 profile scope", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-factory-boundary-"));
    expect(() => TransportFactory.create(profile({
      provider: "CLOUDFLARE_NAMED",
      tunnelName: "c2c-v2-preview",
      tunnelId: "590b136e-4641-416d-820b-7708bf9179c0",
      hostname: "c2c-v2-preview.example.com",
      publicMcpUrl: "https://c2c-v2-preview.example.com/mcp",
      credentialPath: path.join(stateRoot, "outside.json"),
    }), stateRoot)).toThrow(/CREDENTIAL_OUTSIDE_PROFILE/);
  });

  it("rejects the Legacy production identity", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-factory-company-"));
    expect(() => TransportFactory.create(profile({
      provider: "CLOUDFLARE_NAMED",
      tunnelName: "mcpbridge-tunnel",
      tunnelId: "590b136e-4641-416d-820b-7708bf9179c0",
      hostname: "mcp-legacy.example.com",
      publicMcpUrl: "https://mcp-legacy.example.com/mcp",
      credentialPath: path.join(stateRoot, "profiles", "mb_pf_factory", "transport", "company.json"),
    }), stateRoot)).toThrow(/Reserved|Legacy Production/);
  });

  it("rejects public URLs on LOCAL_ONLY Profiles before Runtime args or diagnostics can expose them", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-factory-local-url-"));
    expect(() => TransportFactory.create(profile({
      publicMcpUrl: "https://example.test/mcp?token=short",
    }), stateRoot)).toThrow("V2_LOCAL_ONLY_PUBLIC_URL_FORBIDDEN");
  });
});

