import { describe, expect, it, vi } from "vitest";
import { SupervisorAdapter } from "./SupervisorAdapter.js";
import type { SupervisorClient } from "./SupervisorClient.js";
import { supervisorMethodRequiresAuthorization } from "./SupervisorRequestAuth.js";

describe("ordinary settings Supervisor RPC", () => {
  it("uses the dedicated mutation method with the patch and requires a signed session", async () => {
    const patch = { healthCheckIntervalSec: 90, autoStart: { minimized: true } };
    const call = vi.fn().mockResolvedValue({
      profileId: "profile-test",
      values: { healthCheckIntervalSec: 90, autoStart: { atLogin: true, minimized: true } },
      persisted: true,
    });
    const adapter = new SupervisorAdapter({ call } as unknown as SupervisorClient);

    await expect(adapter.updateOrdinarySettings(patch)).resolves.toMatchObject({
      profileId: "profile-test",
      persisted: true,
    });
    expect(call).toHaveBeenCalledWith({
      method: "settings.ordinary.update",
      params: patch,
      timeoutMs: 30_000,
    });
    expect(supervisorMethodRequiresAuthorization("settings.ordinary.update")).toBe(true);
  });
});
