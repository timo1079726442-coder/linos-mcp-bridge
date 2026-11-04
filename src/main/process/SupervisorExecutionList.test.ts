// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SupervisorProcess } from "./SupervisorProcess.js";

describe("SupervisorProcess execution list availability", () => {
  it("does not present an explicitly unavailable empty store as available", async () => {
    const supervisor = new SupervisorProcess("unused-state-root", "pf_test", {
      deviceId: "dev_test",
      profileId: "pf_test",
      runtimeId: "rt_test",
      workspaceRoot: "D:\\isolated-workspace",
      port: 48766,
      binaryPath: "node",
      entryPath: "runtime/dist/main.js",
      runtimeInstanceSecret: Buffer.alloc(32, 7),
      commandImage: "node",
      stateRoot: "unused-state-root",
    } as never);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ available: false, records: [] }),
    })));
    try {
      const result = await supervisor.listExecutionRecords();
      expect(result).toEqual({
        available: false,
        source: "execution-store",
        runtimeInstanceId: null,
        records: [],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
