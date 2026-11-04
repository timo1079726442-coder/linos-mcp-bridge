import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTaskService, AGENT_DISPATCH_ENABLED } from "./AgentTaskService.js";
import { FileAgentTaskRepository } from "./AgentTaskStore.js";
import type { ActiveAgentTaskScope, ResolvedAgentTaskBinding, SubmitAgentTaskRequest, TrustedAgentTaskBindingResolver, TrustedAgentTaskScopeResolver } from "./AgentTaskStore.js";

const roots: string[] = [];
const FIXED_TIME = Date.UTC(2026, 9, 12, 12, 0, 0);
const DIGEST_A = "a".repeat(64);
const COMMIT_A = "b".repeat(40);

function makeRequest(overrides: Partial<SubmitAgentTaskRequest> = {}): SubmitAgentTaskRequest {
  return {
    idempotencyKey: "submit-1",
    agentId: "agent-local-default",
    worktreeId: "worktree-1",
    specificationSha256: DIGEST_A,
    ...overrides,
  };
}

function makeResolver(root: string, overrides: Partial<ResolvedAgentTaskBinding> = {}): TrustedAgentTaskBindingResolver {
  return {
    resolveBinding: async (selection) => ({
      profileId: "profile-1",
      workspaceId: "workspace-1",
      agentId: selection.agentId,
      authorizedExecutorId: null,
      branch: "agent/task-1",
      worktreeId: selection.worktreeId,
      worktreePath: `worktrees/${selection.worktreeId}`,
      baseCommit: COMMIT_A,
      workspaceRoot: path.join(root, "workspace"),
      worktreeRoot: path.join(root, "worktrees", selection.worktreeId),
      ...overrides,
    }),
  };
}

function makeScopeResolver(overrides: Partial<ActiveAgentTaskScope> = {}): TrustedAgentTaskScopeResolver {
  return {
    resolveActiveScope: async () => ({ profileId: "profile-1", workspaceId: "workspace-1", ...overrides }),
  };
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-agent-task-"));
  roots.push(root);
  const repository = new FileAgentTaskRepository(path.join(root, "state"), "profile-1");
  let nextId = 0;
  const service = new AgentTaskService({
    repository,
    bindingResolver: makeResolver(root),
    activeScopeResolver: makeScopeResolver(),
    now: () => FIXED_TIME,
    createTaskId: () => `task_test_${++nextId}`,
  });
  return { root, repository, service };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentTaskService v1", () => {
  it("keeps dispatch disabled and stores only trusted BLOCKED(NO_EXECUTOR) binding", async () => {
    const { root, service } = await makeFixture();

    expect(AGENT_DISPATCH_ENABLED).toBe(false);
    expect(service.agentDispatchEnabled).toBe(false);
    const submitted = await service.submit(makeRequest());

    expect(submitted.replayed).toBe(false);
    expect(submitted.task).toMatchObject({
      taskId: "task_test_1",
      status: "BLOCKED",
      reasonCode: "NO_EXECUTOR",
      attemptId: null,
      executorId: null,
      binding: {
        workspaceId: "workspace-1",
        profileId: "profile-1",
        agentId: "agent-local-default",
        authorizedExecutorId: null,
        branch: "agent/task-1",
        worktreeId: "worktree-1",
        worktreePath: "worktrees/worktree-1",
        baseCommit: COMMIT_A,
      },
    });
    const result = await service.result(submitted.task.taskId);
    expect(result).toEqual({
      taskId: "task_test_1",
      available: false,
      status: "BLOCKED",
      reasonCode: "NO_EXECUTOR",
      result: null,
    });
    expect(Object.keys(submitted.task.binding)).toEqual([
      "profileId", "workspaceId", "agentId", "authorizedExecutorId", "branch", "worktreeId", "worktreePath", "baseCommit",
    ]);
    const publicProjection = JSON.stringify({ status: submitted.task, result });
    expect(publicProjection).not.toContain("workspaceRootSha256");
    expect(publicProjection).not.toContain("worktreeRootSha256");
    expect(publicProjection).not.toContain(root);
    expect(path.isAbsolute(submitted.task.binding.worktreePath)).toBe(false);
    await expect(service.evidence(submitted.task.taskId)).resolves.toEqual([{
      evidenceId: "task_test_1.blocked.1",
      taskId: "task_test_1",
      attemptId: null,
      sequence: 1,
      kind: "TASK_BLOCKED",
      source: "CONTROL_PLANE",
      occurredAt: new Date(FIXED_TIME).toISOString(),
      reasonCode: "NO_EXECUTOR",
    }]);
    const persisted = await readFile(path.join(root, "state", "profiles", "profile-1", "agent-tasks.json"), "utf8");
    expect(persisted).not.toContain(root);
  });

  it("rejects client-supplied identity, root, branch, worktree path, or completion claims", async () => {
    const { repository, service } = await makeFixture();
    const malicious = {
      ...makeRequest(),
      profileId: "profile-attacker",
      workspaceId: "workspace-attacker",
      branch: "main",
      worktreePath: "C:/outside",
      baseCommit: "c".repeat(40),
      workspaceRoot: "C:/outside",
      worktreeRoot: "C:/outside",
      status: "SUCCEEDED",
      result: { status: "PASS", summary: "claimed complete" },
      prompt: "private task body sentinel",
    } as SubmitAgentTaskRequest;

    await expect(service.submit(malicious)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(repository.get("task_test_1")).resolves.toBeNull();
  });

  it("rejects submit without trusted Supervisor binding resolver and creates no record", async () => {
    const { root, repository } = await makeFixture();
    const service = new AgentTaskService({
      repository,
      now: () => FIXED_TIME,
      createTaskId: () => "task_no_resolver",
    });

    await expect(service.submit(makeRequest())).rejects.toMatchObject({ code: "TRUSTED_BINDING_UNAVAILABLE" });
    await expect(repository.get("task_no_resolver")).resolves.toBeNull();
    await expect(readFile(path.join(root, "state", "profiles", "profile-1", "agent-tasks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects resolver identity mismatch and malformed Git/root resolution before persistence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-agent-task-mismatch-"));
    roots.push(root);
    const repository = new FileAgentTaskRepository(path.join(root, "state"), "profile-1");
    const mismatched = new AgentTaskService({
      repository,
      bindingResolver: makeResolver(root, { agentId: "agent-other" }),
      activeScopeResolver: makeScopeResolver(),
      createTaskId: () => "task_mismatch",
    });
    await expect(mismatched.submit(makeRequest())).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    await expect(repository.get("task_mismatch")).resolves.toBeNull();

    const invalidGit = new AgentTaskService({
      repository,
      bindingResolver: makeResolver(root, { branch: "../outside" }),
      activeScopeResolver: makeScopeResolver(),
      createTaskId: () => "task_invalid_git",
    });
    await expect(invalidGit.submit(makeRequest())).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    await expect(repository.get("task_invalid_git")).resolves.toBeNull();

    const invalidRoot = new AgentTaskService({
      repository,
      bindingResolver: makeResolver(root, { worktreeRoot: "relative-worktree-root" }),
      activeScopeResolver: makeScopeResolver(),
      createTaskId: () => "task_invalid_root",
    });
    await expect(invalidRoot.submit(makeRequest())).rejects.toMatchObject({ code: "BINDING_MISMATCH" });

    const inactiveProfile = new AgentTaskService({
      repository,
      bindingResolver: makeResolver(root, { profileId: "profile-2" }),
      activeScopeResolver: makeScopeResolver(),
      createTaskId: () => "task_inactive_profile",
    });
    await expect(inactiveProfile.submit(makeRequest())).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    await expect(repository.get("task_inactive_profile")).resolves.toBeNull();
  });

  it("keeps dispatch off even when a trusted resolver identifies an authorized executor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-agent-task-authorized-"));
    roots.push(root);
    const service = new AgentTaskService({
      repository: new FileAgentTaskRepository(path.join(root, "state"), "profile-1"),
      bindingResolver: makeResolver(root, { authorizedExecutorId: "executor-local-1" }),
      activeScopeResolver: makeScopeResolver(),
      now: () => FIXED_TIME,
      createTaskId: () => "task_dispatch_off",
    });

    const submitted = await service.submit(makeRequest());
    expect(submitted.task.status).toBe("BLOCKED");
    expect(submitted.task.reasonCode).toBe("DISPATCH_DISABLED");
    expect(submitted.task.executorId).toBeNull();
    expect(submitted.task.binding.authorizedExecutorId).toBe("executor-local-1");
  });

  it("returns the original blocked task for idempotent replay and rejects a changed request digest", async () => {
    const { service } = await makeFixture();
    const first = await service.submit(makeRequest());
    const replay = await service.submit(makeRequest());

    expect(replay.replayed).toBe(true);
    expect(replay.task.taskId).toBe(first.task.taskId);
    await expect(service.submit(makeRequest({ specificationSha256: "c".repeat(64) })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("scopes idempotency by trusted profile and workspace", async () => {
    const { root, repository, service } = await makeFixture();
    const first = await service.submit(makeRequest());
    const otherProfile = new AgentTaskService({
      repository: new FileAgentTaskRepository(path.join(root, "state"), "profile-2"),
      bindingResolver: makeResolver(root, { profileId: "profile-2" }),
      activeScopeResolver: makeScopeResolver({ profileId: "profile-2" }),
      now: () => FIXED_TIME,
      createTaskId: () => "task_profile_2",
    });
    const otherWorkspace = new AgentTaskService({
      repository,
      bindingResolver: makeResolver(root, { workspaceId: "workspace-2" }),
      activeScopeResolver: makeScopeResolver({ workspaceId: "workspace-2" }),
      now: () => FIXED_TIME,
      createTaskId: () => "task_workspace_2",
    });

    const profileTask = await otherProfile.submit(makeRequest());
    const workspaceTask = await otherWorkspace.submit(makeRequest());
    expect(new Set([first.task.taskId, profileTask.task.taskId, workspaceTask.task.taskId]).size).toBe(3);
  });

  it("never reports a blocked task cancelled", async () => {
    const { service } = await makeFixture();
    const submitted = await service.submit(makeRequest());

    await expect(service.cancel(submitted.task.taskId)).resolves.toEqual({
      taskId: submitted.task.taskId,
      accepted: false,
      status: "BLOCKED",
      reasonCode: "TASK_NOT_ACTIVE",
    });
    await expect(service.status(submitted.task.taskId)).resolves.toMatchObject({ status: "BLOCKED" });
  });

  it("masks task existence after active Profile/Workspace changes and without a scope resolver", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-agent-task-active-scope-"));
    roots.push(root);
    const repository = new FileAgentTaskRepository(path.join(root, "state"), "profile-1");
    const activeScope: ActiveAgentTaskScope = { profileId: "profile-1", workspaceId: "workspace-1" };
    const service = new AgentTaskService({
      repository,
      bindingResolver: makeResolver(root),
      activeScopeResolver: { resolveActiveScope: async () => ({ ...activeScope }) },
      now: () => FIXED_TIME,
      createTaskId: () => "task_scope_bound",
    });
    const submitted = await service.submit(makeRequest());
    const assertHiddenFromQueries = async (queryService: AgentTaskService): Promise<void> => {
      const queries: Array<() => Promise<unknown>> = [
        () => queryService.status(submitted.task.taskId),
        () => queryService.cancel(submitted.task.taskId),
        () => queryService.result(submitted.task.taskId),
        () => queryService.evidence(submitted.task.taskId),
      ];
      for (const query of queries) {
        await expect(query()).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      }
    };

    activeScope.workspaceId = "workspace-2";
    await assertHiddenFromQueries(service);
    activeScope.profileId = "profile-2";
    await assertHiddenFromQueries(service);

    const noScopeResolver = new AgentTaskService({ repository, bindingResolver: makeResolver(root) });
    await assertHiddenFromQueries(noScopeResolver);
  });

  it("rejects unsafe client IDs and malformed specification digests", async () => {
    const { service } = await makeFixture();
    const invalidRequests: SubmitAgentTaskRequest[] = [
      makeRequest({ worktreeId: "../outside" }),
      makeRequest({ agentId: "bad agent" }),
      makeRequest({ specificationSha256: "not-a-sha256" }),
    ];

    for (const request of invalidRequests) {
      await expect(service.submit(request)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("persists only blocked records and reads them after repository recreation", async () => {
    const { root, service } = await makeFixture();
    const submitted = await service.submit(makeRequest());
    const restarted = new AgentTaskService({
      repository: new FileAgentTaskRepository(path.join(root, "state"), "profile-1"),
      bindingResolver: makeResolver(root),
      activeScopeResolver: makeScopeResolver(),
      now: () => FIXED_TIME + 1_000,
    });

    await expect(restarted.status(submitted.task.taskId)).resolves.toMatchObject({
      status: "BLOCKED",
      reasonCode: "NO_EXECUTOR",
      attemptId: null,
      executorId: null,
    });
    await expect(restarted.result(submitted.task.taskId)).resolves.toMatchObject({ available: false, result: null });
  });

  it("rejects a forged success state from corrupted local storage", async () => {
    const { root, service } = await makeFixture();
    const submitted = await service.submit(makeRequest());
    const filePath = path.join(root, "state", "profiles", "profile-1", "agent-tasks.json");
    const document = JSON.parse(await readFile(filePath, "utf8")) as { records: Array<Record<string, unknown>> };
    document.records[0] = { ...document.records[0], status: "SUCCEEDED", reasonCode: undefined };
    await writeFile(filePath, JSON.stringify(document), "utf8");

    await expect(service.status(submitted.task.taskId)).rejects.toMatchObject({ code: "TASK_STORE_CORRUPT" });
  });

  it("atomically deduplicates concurrent submissions across repository instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-agent-task-concurrent-"));
    roots.push(root);
    const stateRoot = path.join(root, "state");
    const firstService = new AgentTaskService({
      repository: new FileAgentTaskRepository(stateRoot, "profile-1"),
      bindingResolver: makeResolver(root),
      activeScopeResolver: makeScopeResolver(),
      now: () => FIXED_TIME,
      createTaskId: () => "task_concurrent_a",
    });
    const secondService = new AgentTaskService({
      repository: new FileAgentTaskRepository(stateRoot, "profile-1"),
      bindingResolver: makeResolver(root),
      activeScopeResolver: makeScopeResolver(),
      now: () => FIXED_TIME,
      createTaskId: () => "task_concurrent_b",
    });

    const [first, second] = await Promise.all([
      firstService.submit(makeRequest()),
      secondService.submit(makeRequest()),
    ]);

    expect(first.task.taskId).toBe(second.task.taskId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
  });
});
