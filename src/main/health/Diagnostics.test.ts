import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "./Diagnostics.js";
import { ProfileStore } from "../profile/ProfileStore.js";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
import { ProfileClientRegistry } from "../oauth/ProfileClientRegistry.js";
import { WorkspaceGrantStore } from "../oauth/WorkspaceGrantStore.js";

let stateRoot: string;
let diagnostics: Diagnostics;

function isolatedProbe() {
  return {
    probeLocalBridge: async (port: number, _expectedWorkspaceId: string | null) => ({
      alive: false,
      healthEndpointOk: false,
      workspaceIdMatches: null,
      port,
      portListening: false,
    }),
    probePublic: async (_url: string | null) => ({ healthStatus: null, mcpAnonymous: null, oauthDiscoveryOk: false }),
  };
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-diag-"));
  const device = new DeviceIdentity(stateRoot);
  await device.getDeviceId();
  const store = new ProfileStore(stateRoot, device);
  await store.create({ profileName: "DIAG", profileType: "custom" });
  diagnostics = new Diagnostics({ stateRoot, probe: isolatedProbe() });
});

describe("Diagnostics (P0-D no hardcoded PASS)", () => {
  it("reports watchdog as NOT_STARTED instead of fake alive=true", async () => {
    const report = await diagnostics.run();
    expect(report.watchdog.alive).toBe(false);
    expect(report.watchdog.status).toBe("NOT_STARTED");
  });

  it("reflects 48766 + LOCAL_ONLY isolated defaults", async () => {
    const report = await diagnostics.run();
    expect(report.profileMetadata).not.toBeNull();
    expect(report.profileMetadata?.transportProvider).toBe("LOCAL_ONLY");
    expect(report.transport.provider).toBe("local-only");
    expect(report.oauthAuthorization?.state).toBe("NOT_CONFIGURED");
  });

  it("reports a registered client without a workspace grant as AUTH_REQUIRED without exposing its identity", async () => {
    const device = new DeviceIdentity(stateRoot);
    const store = new ProfileStore(stateRoot, device);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "c2c-oauth-workspace-"));
    const profile = await store.create({ profileName: "OAUTH", profileType: "custom", initialWorkspaceRoot: workspaceRoot });
    await store.writeActiveProfileId(profile.profileId);
    await new ProfileClientRegistry(stateRoot, profile.profileId).upsert({
      clientId: "private-client-id-fixture",
      clientName: "fixture client",
      redirectUris: ["http://localhost/callback"],
      scopes: ["workspace:read"],
    });

    const report = await new Diagnostics({ stateRoot, probe: isolatedProbe() }).run();

    expect(report.oauthAuthorization).toMatchObject({ state: "AUTH_REQUIRED", activeClientCount: 1, validWorkspaceGrant: false });
    expect(JSON.stringify(report.oauthAuthorization)).not.toContain("private-client-id-fixture");
  });

  it("reports AUTHORIZED only for an active, unexpired grant bound to a registered client", async () => {
    const device = new DeviceIdentity(stateRoot);
    const store = new ProfileStore(stateRoot, device);
    const workspaceRoot = await mkdtemp(join(tmpdir(), "c2c-oauth-authorized-workspace-"));
    const profile = await store.create({ profileName: "OAUTH_READY", profileType: "custom", initialWorkspaceRoot: workspaceRoot });
    await store.writeActiveProfileId(profile.profileId);
    const clientId = "client-fixture";
    await new ProfileClientRegistry(stateRoot, profile.profileId).upsert({
      clientId,
      clientName: "fixture client",
      redirectUris: ["http://localhost/callback"],
      scopes: ["workspace:read"],
    });
    await new WorkspaceGrantStore(stateRoot, profile.profileId).set(profile.currentWorkspace.workspaceId!, {
      clientId,
      accessTokenHash: "sha256-access-hash-fixture",
      refreshTokenHash: "sha256-refresh-hash-fixture",
      scopes: ["workspace:read"],
      audience: profile.currentWorkspace.workspaceId!,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
    });

    const report = await new Diagnostics({ stateRoot, probe: isolatedProbe() }).run();

    expect(report.oauthAuthorization).toMatchObject({ state: "AUTHORIZED", activeClientCount: 1, validWorkspaceGrant: true });
    expect(JSON.stringify(report.oauthAuthorization)).not.toContain("sha256-");
    expect(JSON.stringify(report.oauthAuthorization)).not.toContain(clientId);
  });

  it("reports the actual secret backend instead of hardcoded dpapiOk=true", async () => {
    const report = await diagnostics.run();
    expect(typeof report.secretStore.dpapiOk).toBe("boolean");
    expect(typeof report.secretStore.encryptionBackend).toBe("string");
  });

  it("does not report a missing Runtime as ready", async () => {
    const report = await diagnostics.run();
    expect(report.readiness.layers.runtime).not.toBe("PASS");
  });

  it("returns the complete typed report", async () => {
    const report = await diagnostics.run();
    expect(report.generatedAt).toBeTruthy();
    expect(report.appVersion).toBe("2.0.0");
    expect(report.osVersion).toContain(process.platform);
    expect(report.readiness).toBeDefined();
    expect(report.readiness.layers).toBeDefined();
  });

  it("uses the persisted Active Profile instead of the first directory entry", async () => {
    const device = new DeviceIdentity(stateRoot);
    const store = new ProfileStore(stateRoot, device);
    const first = await store.create({ profileName: "FIRST", profileType: "custom" });
    const selectedWorkspace = await mkdtemp(join(tmpdir(), "c2c-diag-selected-"));
    const selected = await store.create({
      profileName: "SELECTED",
      profileType: "custom",
      initialWorkspaceRoot: selectedWorkspace,
    });
    await store.writeActiveProfileId(selected.profileId);

    const report = await new Diagnostics({ stateRoot, probe: isolatedProbe() }).run();

    expect(report.profileMetadata?.profileId).toBe(selected.profileId);
    expect(report.profileMetadata?.profileName).toBe("SELECTED");
    expect(report.workspace.workspaceId).toBe(selected.currentWorkspace.workspaceId);
    expect(first.profileId).not.toBe(selected.profileId);
  });
});
