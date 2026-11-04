import { describe, expect, it } from "vitest";
import type { ReadinessSnapshot } from "../shared/types.js";
import { readStableReadiness } from "./readinessPolling.ts";

const snapshot = (runtime: ReadinessSnapshot["layers"]["runtime"]): ReadinessSnapshot => ({
  overall: runtime === "PASS" ? "YELLOW" : "RED",
  lastStateCheckAt: new Date().toISOString(),
  lastFullVerification: null,
  lastError: null,
  layers: { runtime, transport: "NOT_APPLICABLE", connector: "UNKNOWN", conversation: "UNKNOWN", workspace: "UNKNOWN", repository: "NOT_APPLICABLE" },
  c2cFullReady: false,
});

describe("readStableReadiness", () => {
  it("retries a transient runtime restart state", async () => {
    const values = [snapshot("FAIL"), snapshot("PASS")];
    const result = await readStableReadiness(async () => values.shift() ?? snapshot("PASS"), 3);
    expect(result.layers.runtime).toBe("PASS");
  });

  it("retries a transient IPC read failure", async () => {
    let first = true;
    const result = await readStableReadiness(async () => {
      if (first) {
        first = false;
        throw new Error("supervisor_connection_closed");
      }
      return snapshot("PASS");
    }, 3);
    expect(result.layers.runtime).toBe("PASS");
  });
});
