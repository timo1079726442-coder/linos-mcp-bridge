import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorAgentTaskAdapter } from "./AgentTaskAdapter.js";

const roots: string[] = [];

async function makeAdapter() {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-supervisor-agent-task-"));
  roots.push(root);
  const adapter = new SupervisorAgentTaskAdapter({
    stateRoot: path.join(root, "state"),
    profileId: "profile-fixture",
    resolveActiveScope: async () => ({ profileId: "profile-fixture", workspaceId: "workspace-fixture" }),
  });
  return { root, adapter };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SupervisorAgentTaskAdapter fail-closed binding", () => {
  it("advertises missing trusted catalog and rejects submission without creating a task", async () => {
    const { root, adapter } = await makeAdapter();

    expect(adapter.availability()).toEqual({
      dispatchEnabled: false,
      trustedBindingAvailable: false,
      executorCatalogAvailable: false,
      reasonCode: "TRUSTED_CATALOG_UNAVAILABLE",
    });
    await expect(adapter.submit({
      idempotencyKey: "fixture-submit",
      agentId: "agent-fixture",
      worktreeId: "worktree-fixture",
      specificationSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "TRUSTED_BINDING_UNAVAILABLE" });
    await expect(readFile(path.join(root, "state", "profiles", "profile-fixture", "agent-tasks.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not manufacture status, result, cancellation, or evidence for a rejected request", async () => {
    const { adapter } = await makeAdapter();

    await expect(adapter.status("task_forged")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(adapter.cancel("task_forged")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(adapter.result("task_forged")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(adapter.evidence("task_forged")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});
