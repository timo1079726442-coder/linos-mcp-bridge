import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceIdentity } from "../main/profile/DeviceIdentity.js";
import { ProfileStore } from "../main/profile/ProfileStore.js";
import { updateOrdinarySettings } from "./OrdinarySettings.js";

let stateRoot: string;
let store: ProfileStore;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-ordinary-settings-"));
  store = new ProfileStore(stateRoot, new DeviceIdentity(stateRoot));
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

async function createActiveProfile(profileType: "home" | "company" | "custom" = "home") {
  return store.create({ profileName: "Settings fixture", profileType });
}

describe("ordinary settings persistence", () => {
  it("merges only approved fields, persists atomically, and returns verified values", async () => {
    const profile = await createActiveProfile();

    const outcome = await updateOrdinarySettings(store, profile, {
      healthCheckIntervalSec: 120,
      autoStart: { atLogin: false },
    });

    expect(outcome.result).toEqual({
      profileId: profile.profileId,
      values: { healthCheckIntervalSec: 120, autoStart: { atLogin: false, minimized: false } },
      persisted: true,
    });
    const persisted = await store.readConfig(profile.profileId);
    expect(persisted.healthCheckIntervalSec).toBe(120);
    expect(persisted.autoStart).toEqual({ atLogin: false, minimized: false });
    expect(persisted.transport).toEqual(profile.transport);
    expect(persisted.currentWorkspace).toEqual(profile.currentWorkspace);
    expect(persisted.trustedRedirectPolicy).toEqual(profile.trustedRedirectPolicy);
    expect(persisted.autoRepair).toEqual(profile.autoRepair);
  });

  it.each([
    { transport: { expectedLocalPort: 48765 } },
    { currentWorkspace: { root: "C:\\unapproved", workspaceId: "workspace" } },
    { autoRepair: { policy: "SAFE_AUTO_REPAIR" } },
    { secret: "must not be accepted" },
  ])("rejects forbidden top-level fields without changing Profile config (%j)", async (forbidden) => {
    const profile = await createActiveProfile();
    const before = await store.readConfig(profile.profileId);

    await expect(updateOrdinarySettings(store, profile, forbidden)).rejects.toThrow("ORDINARY_SETTINGS_PATCH_FIELD_FORBIDDEN");
    expect(await store.readConfig(profile.profileId)).toEqual(before);
  });

  it("rejects extra fields nested under autoStart without writing", async () => {
    const profile = await createActiveProfile();
    const before = await store.readConfig(profile.profileId);

    await expect(updateOrdinarySettings(store, profile, {
      autoStart: { atLogin: false, unexpected: true },
    })).rejects.toThrow("ORDINARY_SETTINGS_PATCH_FIELD_FORBIDDEN");
    expect(await store.readConfig(profile.profileId)).toEqual(before);
  });

  it.each([4, 3601, 5.5, Number.NaN])("rejects invalid health-check interval %s", async (interval) => {
    const profile = await createActiveProfile();

    await expect(updateOrdinarySettings(store, profile, { healthCheckIntervalSec: interval }))
      .rejects.toThrow("ORDINARY_SETTINGS_INTERVAL_INVALID");
  });

  it("rejects non-boolean autoStart values", async () => {
    const profile = await createActiveProfile();

    await expect(updateOrdinarySettings(store, profile, { autoStart: { minimized: "yes" } }))
      .rejects.toThrow("ORDINARY_SETTINGS_AUTOSTART_INVALID");
  });

  it("blocks Legacy Profiles before writing", async () => {
    const profile = await createActiveProfile("company");
    const before = await store.readConfig(profile.profileId);

    await expect(updateOrdinarySettings(store, profile, { healthCheckIntervalSec: 120 }))
      .rejects.toThrow("COMPANY_PROFILE_PROTECTED");
    expect(await store.readConfig(profile.profileId)).toEqual(before);
  });

  it("requires a resolvable active Profile and rejects stale identity", async () => {
    const profile = await createActiveProfile();
    await rm(join(stateRoot, "active-profile.json"), { force: true });
    await expect(updateOrdinarySettings(store, profile, { healthCheckIntervalSec: 120 }))
      .rejects.toThrow("ACTIVE_PROFILE_UNAVAILABLE");

    const selected = await createActiveProfile("custom");
    await store.writeActiveProfileId(selected.profileId);
    await expect(updateOrdinarySettings(store, profile, { healthCheckIntervalSec: 120 }))
      .rejects.toThrow("ACTIVE_PROFILE_CHANGED");
  });
});
