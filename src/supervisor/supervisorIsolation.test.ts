import { describe, it, expect } from "vitest";
import { V2_ISOLATION } from "./supervisorMain.js";

describe("V2 Isolation Defaults (OPTION_A_PLUS)", () => {
  it("V2_LOCAL_PORT is 48767 (NOT 48765)", () => {
    expect(V2_ISOLATION.V2_LOCAL_PORT).toBe(48767);
    expect(V2_ISOLATION.V2_LOCAL_PORT).not.toBe(48765);
  });

  it("V2_DEFAULT_TRANSPORT is LOCAL_ONLY", () => {
    expect(V2_ISOLATION.V2_DEFAULT_TRANSPORT).toBe("LOCAL_ONLY");
  });

  it("V2_DEFAULT_ISOLATION is TRUE", () => {
    expect(V2_ISOLATION.V2_DEFAULT_ISOLATION).toBe(true);
  });

  it("AUTO_PRODUCTION_TAKEOVER is FALSE", () => {
    expect(V2_ISOLATION.AUTO_PRODUCTION_TAKEOVER).toBe(false);
  });

  it("COMPANY_PRODUCTION_PROTECTED is TRUE", () => {
    expect(V2_ISOLATION.COMPANY_PRODUCTION_PROTECTED).toBe(true);
  });

  it("LEGACY_MIGRATION_MODE_DEFAULT is FALSE", () => {
    expect(V2_ISOLATION.LEGACY_MIGRATION_MODE_DEFAULT).toBe(false);
  });

  it("V2_PUBLIC_HOSTNAME_DEFAULT is DISABLED", () => {
    expect(V2_ISOLATION.V2_PUBLIC_HOSTNAME_DEFAULT).toBe("DISABLED");
  });
});

