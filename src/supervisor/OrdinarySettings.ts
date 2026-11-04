import type { ProfileConfig, OrdinarySettingsPatch, OrdinarySettingsValues } from "../shared/types.js";
import type { ProfileStore } from "../main/profile/ProfileStore.js";

export interface OrdinarySettingsUpdateOutcome {
  profile: ProfileConfig;
  result: {
    profileId: string;
    values: OrdinarySettingsValues;
    persisted: true;
  };
}

/** Persist only the explicitly approved, non-security Profile fields. */
export async function updateOrdinarySettings(
  profileStore: ProfileStore,
  activeProfile: ProfileConfig | null,
  rawPatch: unknown,
): Promise<OrdinarySettingsUpdateOutcome> {
  if (!activeProfile) throw new Error("ACTIVE_PROFILE_UNAVAILABLE");

  const activeProfileId = await profileStore.readActiveProfileId();
  if (!activeProfileId) throw new Error("ACTIVE_PROFILE_UNAVAILABLE");
  if (activeProfileId !== activeProfile.profileId) throw new Error("ACTIVE_PROFILE_CHANGED");

  const current = await profileStore.readConfig(activeProfileId);
  if (current.profileType === "company") throw new Error("COMPANY_PROFILE_PROTECTED");

  const patch = validateOrdinarySettingsPatch(rawPatch);
  const updated: ProfileConfig = {
    ...current,
    ...(patch.healthCheckIntervalSec === undefined
      ? {}
      : { healthCheckIntervalSec: patch.healthCheckIntervalSec }),
    ...(patch.autoStart === undefined
      ? {}
      : { autoStart: { ...current.autoStart, ...patch.autoStart } }),
  };

  await profileStore.writeConfig(updated);
  const persisted = await profileStore.readConfig(activeProfileId);
  if (!matchesPatch(persisted, patch)) {
    throw new Error("ORDINARY_SETTINGS_PERSISTENCE_MISMATCH");
  }

  const values: OrdinarySettingsValues = {
    healthCheckIntervalSec: persisted.healthCheckIntervalSec,
    autoStart: { ...persisted.autoStart },
  };
  return {
    profile: persisted,
    result: { profileId: persisted.profileId, values, persisted: true },
  };
}

function validateOrdinarySettingsPatch(raw: unknown): OrdinarySettingsPatch {
  if (!isRecord(raw)) throw new Error("ORDINARY_SETTINGS_PATCH_INVALID");
  const keys = Object.keys(raw);
  if (keys.length === 0) throw new Error("ORDINARY_SETTINGS_PATCH_EMPTY");
  if (keys.some((key) => key !== "healthCheckIntervalSec" && key !== "autoStart")) {
    throw new Error("ORDINARY_SETTINGS_PATCH_FIELD_FORBIDDEN");
  }

  const patch: OrdinarySettingsPatch = {};
  if (Object.hasOwn(raw, "healthCheckIntervalSec")) {
    const interval = raw.healthCheckIntervalSec;
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 5 || interval > 3600) {
      throw new Error("ORDINARY_SETTINGS_INTERVAL_INVALID");
    }
    patch.healthCheckIntervalSec = interval;
  }

  if (Object.hasOwn(raw, "autoStart")) {
    const autoStart = raw.autoStart;
    if (!isRecord(autoStart)) throw new Error("ORDINARY_SETTINGS_AUTOSTART_INVALID");
    const autoStartKeys = Object.keys(autoStart);
    if (autoStartKeys.length === 0) throw new Error("ORDINARY_SETTINGS_PATCH_EMPTY");
    if (autoStartKeys.some((key) => key !== "atLogin" && key !== "minimized")) {
      throw new Error("ORDINARY_SETTINGS_PATCH_FIELD_FORBIDDEN");
    }

    const validated: NonNullable<OrdinarySettingsPatch["autoStart"]> = {};
    for (const key of autoStartKeys) {
      const value = autoStart[key];
      if (typeof value !== "boolean") throw new Error("ORDINARY_SETTINGS_AUTOSTART_INVALID");
      if (key === "atLogin") validated.atLogin = value;
      if (key === "minimized") validated.minimized = value;
    }
    patch.autoStart = validated;
  }

  return patch;
}

function matchesPatch(config: ProfileConfig, patch: OrdinarySettingsPatch): boolean {
  if (
    patch.healthCheckIntervalSec !== undefined &&
    config.healthCheckIntervalSec !== patch.healthCheckIntervalSec
  ) return false;
  if (patch.autoStart?.atLogin !== undefined && config.autoStart.atLogin !== patch.autoStart.atLogin) return false;
  if (patch.autoStart?.minimized !== undefined && config.autoStart.minimized !== patch.autoStart.minimized) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
