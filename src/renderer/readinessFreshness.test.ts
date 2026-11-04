import { describe, expect, it } from "vitest";
import type { ReadinessSnapshot } from "../shared/types.js";
import { getReadinessFreshness } from "./readinessFreshness.ts";

const snapshot = (lastStateCheckAt: string | null): ReadinessSnapshot => ({
  overall: "YELLOW",
  lastStateCheckAt,
  lastFullVerification: null,
  lastError: null,
  layers: {
    runtime: "PASS",
    transport: "UNKNOWN",
    connector: "UNKNOWN",
    conversation: "UNKNOWN",
    workspace: "PASS",
    repository: "NOT_APPLICABLE",
  },
  c2cFullReady: false,
});

describe("readiness freshness", () => {
  it("classifies current and expired observations against the threshold", () => {
    const now = Date.parse("2026-10-08T10:01:00.000Z");
    expect(getReadinessFreshness(snapshot("2026-10-08T10:00:00.000Z"), now).status).toBe("FRESH");
    expect(getReadinessFreshness(snapshot("2026-10-08T09:59:59.999Z"), now).status).toBe("STALE");
  });

  it("fails closed for missing, invalid, or future observation times", () => {
    const now = Date.parse("2026-10-08T10:01:00.000Z");
    expect(getReadinessFreshness(null, now).status).toBe("NO_OBSERVATION");
    expect(getReadinessFreshness(snapshot("not-a-time"), now).status).toBe("INVALID_OBSERVATION");
    expect(getReadinessFreshness(snapshot("2026-10-08T10:02:00.000Z"), now).status).toBe("INVALID_OBSERVATION");
  });
});
