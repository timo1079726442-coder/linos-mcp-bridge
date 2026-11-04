import { describe, expect, it } from "vitest";
import {
  buildDangerousPermissionsViewModel,
  type DangerousPermissionsSnapshot,
} from "./dangerousPermissionsModel.ts";

const activeProfileId = "profile-home";

function snapshot(overrides: Partial<DangerousPermissionsSnapshot> = {}): DangerousPermissionsSnapshot {
  return {
    observedAt: "2026-10-08T08:00:00.000Z",
    profileId: activeProfileId,
    shell: {
      state: "DISABLED",
      profileId: activeProfileId,
      confirmedLocally: false,
      reason: null,
    },
    auditMode: { state: "UNKNOWN", reason: null },
    ...overrides,
  };
}

describe("dangerous permissions view model", () => {
  it("fails closed and reports unknown when the state API is absent", () => {
    const result = buildDangerousPermissionsViewModel(null, activeProfileId);
    expect(result.shellState).toBe("UNKNOWN");
    expect(result.shellLabel).toContain("接口尚未接入");
    expect(result.auditModeState).toBe("UNKNOWN");
  });

  it("does not trust a shell grant without local confirmation and current-profile binding", () => {
    const result = buildDangerousPermissionsViewModel(snapshot({
      shell: {
        state: "ENABLED",
        profileId: "profile-company",
        confirmedLocally: false,
        reason: null,
      },
    }), activeProfileId, true);
    expect(result.shellState).toBe("UNKNOWN");
    expect(result.shellLabel).toContain("按关闭处理");
  });

  it("does not reuse even a disabled state or audit status from another profile", () => {
    const result = buildDangerousPermissionsViewModel(snapshot({
      profileId: "profile-company",
      shell: {
        state: "DISABLED",
        profileId: "profile-company",
        confirmedLocally: false,
        reason: null,
      },
      auditMode: { state: "DISABLED", reason: null },
    }), activeProfileId, true);
    expect(result.shellState).toBe("UNKNOWN");
    expect(result.auditModeState).toBe("UNKNOWN");
    expect(result.shellLabel).toContain("按关闭处理");
  });

  it("does not reuse even a disabled state or audit status from another profile", () => {
    const result = buildDangerousPermissionsViewModel(snapshot({
      profileId: "profile-company",
      shell: {
        state: "DISABLED",
        profileId: "profile-company",
        confirmedLocally: false,
        reason: null,
      },
      auditMode: { state: "DISABLED", reason: null },
    }), activeProfileId, true);
    expect(result.shellState).toBe("UNKNOWN");
    expect(result.auditModeState).toBe("UNKNOWN");
    expect(result.shellLabel).toContain("按关闭处理");
  });

  it("shows enabled only when the trusted snapshot confirms the active profile locally", () => {
    const result = buildDangerousPermissionsViewModel(snapshot({
      shell: {
        state: "ENABLED",
        profileId: activeProfileId,
        confirmedLocally: true,
        reason: null,
      },
    }), activeProfileId, true);
    expect(result.shellState).toBe("ENABLED");
    expect(result.shellLabel).toContain("仅限当前 Profile");
  });
});
