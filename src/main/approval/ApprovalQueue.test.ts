import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalQueue, type ApprovalAuditEvent, type ApprovalQueueIdentity } from "./ApprovalQueue.js";
import { FolderAclStore } from "../workspace/FolderAclStore.js";

const roots: string[] = [];

async function makeContext(options: { addWriteRule?: boolean; time?: { value: number } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-approval-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspaceRoot);
  const acl = new FolderAclStore({ stateRoot, profileId: "profile-a", workspaceId: "workspace-a", workspaceRoot });
  if (options.addWriteRule === false) await acl.add({ path: workspaceRoot, permission: "none" });
  else await acl.add({ path: workspaceRoot, permission: "write", extensions: [".txt", ".json"] });
  const identity: { value: ApprovalQueueIdentity } = {
    value: { profileId: "profile-a", workspaceId: "workspace-a", workspaceRoot },
  };
  const auditEvents: ApprovalAuditEvent[] = [];
  const makeQueue = () => new ApprovalQueue({
    stateRoot,
    profileId: "profile-a",
    workspaceId: "workspace-a",
    workspaceRoot,
    acl,
    getActiveIdentity: () => identity.value,
    appendAudit: async (event) => { auditEvents.push(event); },
    now: () => options.time?.value ?? Date.UTC(2026, 0, 1),
  });
  return { root, workspaceRoot, stateRoot, acl, identity, auditEvents, makeQueue, time: options.time };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ApprovalQueue", () => {
  it("requires ACL permission and stores only bound digests, not file contents", async () => {
    const denied = await makeContext({ addWriteRule: false });
    const deniedQueue = denied.makeQueue();
    await expect(deniedQueue.requestWrite({ targetPath: path.join(denied.workspaceRoot, "new.txt"), content: "fixture", summary: "Create" }))
      .rejects.toThrow("APPROVAL_ACL_DENY_RULE");

    const context = await makeContext();
    const queue = context.makeQueue();
    const record = await queue.requestWrite({
      targetPath: path.join(context.workspaceRoot, "new.txt"),
      content: "private-content-sentinel",
      summary: "Authorization: Bearer private-summary-sentinel; create a text file",
    });
    const persisted = await readFile(path.join(context.stateRoot, "profiles", "profile-a", "approval-queue.json"), "utf8");
    expect(persisted).not.toContain("private-content-sentinel");
    expect(persisted).not.toContain("private-summary-sentinel");
    expect(record).toMatchObject({
      operationKind: "CREATE_FILE",
      expectedTargetVersion: "ABSENT",
      decision: "PENDING",
      execution: "NOT_STARTED",
      attemptCount: 0,
    });
    expect(context.auditEvents.map((event) => event.event)).toEqual(["APPROVAL_REQUESTED"]);
    expect(JSON.stringify(context.auditEvents)).not.toContain("private-content-sentinel");
  });

  it("binds CREATE-only requests to the authenticated MCP caller and request", async () => {
    const context = await makeContext();
    const queue = context.makeQueue();
    const source = {
      kind: "MCP" as const,
      clientId: "registered-client-1",
      requestId: "json-rpc-42",
      runtimeInstanceId: "c2c_ri_live-instance-12345678",
    };
    const record = await queue.requestWrite({
      targetPath: path.join(context.workspaceRoot, "identity.txt"),
      content: "approved bytes",
      summary: "MCP CREATE",
      createOnly: true,
      source,
    });
    expect(record.source).toEqual(source);
    expect(context.auditEvents.at(-1)).toMatchObject({ source });

    const queuePath = path.join(context.stateRoot, "profiles", "profile-a", "approval-queue.json");
    const persisted = JSON.parse(await readFile(queuePath, "utf8"));
    persisted.records[0].source.clientId = "forged-client";
    await writeFile(queuePath, JSON.stringify(persisted), "utf8");
    await expect(queue.list()).rejects.toThrow("APPROVAL_STORE_CORRUPT");
  });

  it("reuses one pending MCP CREATE across timeout retries and blocks conflicting payloads", async () => {
    const context = await makeContext();
    const queue = context.makeQueue();
    const targetPath = path.join(context.workspaceRoot, "retry.txt");
    const source = {
      kind: "MCP" as const,
      clientId: "registered-client-1",
      requestId: "json-rpc-retry-1",
      runtimeInstanceId: "c2c_ri_live-instance-12345678",
    };
    const first = await queue.requestWrite({ targetPath, content: "same bytes", summary: "MCP CREATE", createOnly: true, source });
    const retrySameRequest = await queue.requestWrite({ targetPath, content: "same bytes", summary: "MCP CREATE", createOnly: true, source });
    const retryNewRequestId = await queue.requestWrite({
      targetPath,
      content: "same bytes",
      summary: "MCP CREATE",
      createOnly: true,
      source: { ...source, requestId: "json-rpc-retry-2" },
    });

    expect(retrySameRequest.requestId).toBe(first.requestId);
    expect(retryNewRequestId.requestId).toBe(first.requestId);
    expect(context.auditEvents).toHaveLength(1);
    await expect(queue.requestWrite({
      targetPath,
      content: "different bytes",
      summary: "MCP CREATE",
      createOnly: true,
      source: { ...source, requestId: "json-rpc-retry-3" },
    })).rejects.toThrow("APPROVAL_TARGET_PENDING");
    await expect(queue.list()).resolves.toHaveLength(1);
  });

  it("reuses one pending MCP UPDATE across timeout retries and binds the original target version", async () => {
    const context = await makeContext();
    const queue = context.makeQueue();
    const targetPath = path.join(context.workspaceRoot, "update-retry.txt");
    await writeFile(targetPath, "before", "utf8");
    const source = {
      kind: "MCP" as const,
      clientId: "registered-client-1",
      requestId: "json-rpc-update-1",
      runtimeInstanceId: "c2c_ri_live-instance-12345678",
    };

    const first = await queue.requestWrite({
      targetPath,
      content: "after",
      summary: "MCP UPDATE",
      replaceOnly: true,
      source,
    });
    const sameRequest = await queue.requestWrite({
      targetPath,
      content: "after",
      summary: "MCP UPDATE",
      replaceOnly: true,
      source,
    });
    const newRequestId = await queue.requestWrite({
      targetPath,
      content: "after",
      summary: "MCP UPDATE",
      replaceOnly: true,
      source: { ...source, requestId: "json-rpc-update-2" },
    });

    expect(first.operationKind).toBe("REPLACE_FILE");
    expect(first.expectedTargetVersion).toMatch(/^SHA256:[a-f0-9]{64}$/);
    expect(sameRequest.requestId).toBe(first.requestId);
    expect(newRequestId.requestId).toBe(first.requestId);
    expect(context.auditEvents).toHaveLength(1);

    await expect(queue.requestWrite({
      targetPath,
      content: "conflicting",
      summary: "MCP UPDATE",
      replaceOnly: true,
      source: { ...source, requestId: "json-rpc-update-3" },
    })).rejects.toThrow("APPROVAL_TARGET_PENDING");
  });

  it("rejects replace-only requests when the target is absent", async () => {
    const context = await makeContext();
    await expect(context.makeQueue().requestWrite({
      targetPath: path.join(context.workspaceRoot, "missing.txt"),
      content: "new bytes",
      summary: "MCP UPDATE",
      replaceOnly: true,
    })).rejects.toThrow("APPROVAL_TARGET_UNAVAILABLE");
  });

  it("rejects CREATE-only requests when the target already exists", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "already.txt");
    await writeFile(targetPath, "preserve me", "utf8");
    await expect(context.makeQueue().requestWrite({
      targetPath,
      content: "replace attempt",
      summary: "MCP CREATE",
      createOnly: true,
    })).rejects.toThrow("APPROVAL_TARGET_EXISTS");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("preserve me");
  });

  it("rejects no-op writes where the target already matches the requested content", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "same.txt");
    await writeFile(targetPath, "already correct", "utf8");
    await expect(context.makeQueue().requestWrite({ targetPath, content: "already correct", summary: "No change" }))
      .rejects.toThrow("APPROVAL_NO_OP");
  });

  it("fails closed when the persisted queue is corrupt", async () => {
    const context = await makeContext();
    const queuePath = path.join(context.stateRoot, "profiles", "profile-a", "approval-queue.json");
    await mkdir(path.dirname(queuePath), { recursive: true });
    await writeFile(queuePath, "{not valid JSON", "utf8");
    await expect(context.makeQueue().list()).rejects.toThrow("APPROVAL_STORE_CORRUPT");
  });

  it("binds approval to Workspace, ACL revision, target version, content, and exact revision", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "existing.txt");
    await writeFile(targetPath, "before", "utf8");
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath, content: "after", summary: "Replace file" });
    await writeFile(targetPath, "changed after request", "utf8");

    const stale = await queue.decide({ requestId: request.requestId, expectedRevision: request.revision, decision: "APPROVE" });
    expect(stale).toMatchObject({ decision: "STALE", execution: "NOT_STARTED", failureCode: "APPROVAL_TARGET_CHANGED" });
    await expect(queue.decide({ requestId: stale.requestId, expectedRevision: request.revision, decision: "APPROVE" })).rejects.toThrow("APPROVAL_STALE_REVISION");
  });

  it("fails closed without returning a path or content when no safe writer is installed", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "new.txt");
    const payload = Buffer.from("approved bytes");
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath, content: payload, summary: "Create file" });
    const approved = await queue.decide({ requestId: request.requestId, expectedRevision: request.revision, decision: "APPROVE" });
    const started = await queue.beginExecution({ requestId: approved.requestId, expectedRevision: approved.revision, content: payload });
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    const authorization = await queue.authorizeExecution(started.permit.token);
    expect(authorization).toEqual({ allowed: false, code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" });
    await expect(queue.authorizeExecution(started.permit.token)).resolves.toMatchObject({ allowed: false });
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(queue.get(request.requestId)).resolves.toMatchObject({
      decision: "APPROVED",
      execution: "FAILED",
      verification: "UNAVAILABLE",
      failureCode: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
      attemptCount: 1,
    });
  });

  it("records failed verification and enforces the two-attempt limit", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "retry.txt");
    const payload = Buffer.from("expected");
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath, content: payload, summary: "Create file" });
    let record = await queue.decide({ requestId: request.requestId, expectedRevision: request.revision, decision: "APPROVE" });

    const first = await queue.beginExecution({ requestId: record.requestId, expectedRevision: record.revision, content: payload });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    record = await queue.failExecution(first.permit.token, "APPROVAL_EXECUTOR_FAILED");
    expect(record).toMatchObject({ execution: "FAILED", verification: "UNAVAILABLE", attemptCount: 1 });

    record = await queue.decide({ requestId: record.requestId, expectedRevision: record.revision, decision: "APPROVE" });
    const second = await queue.beginExecution({ requestId: record.requestId, expectedRevision: record.revision, content: payload });
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;
    record = await queue.failExecution(second.permit.token, "APPROVAL_EXECUTOR_TIMEOUT");
    expect(record).toMatchObject({ execution: "FAILED", attemptCount: 2, attemptLimit: 2 });
    await expect(queue.decide({ requestId: record.requestId, expectedRevision: record.revision, decision: "APPROVE" })).rejects.toThrow("APPROVAL_NOT_DECIDABLE");
    expect(context.auditEvents.filter((event) => event.event === "APPROVAL_EXECUTION_STARTED")).toHaveLength(2);
    expect(context.auditEvents.filter((event) => event.event === "APPROVAL_EXECUTION_FAILED")).toHaveLength(2);
  });

  it("reports a stale target before execution and never claims a write occurred", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "mismatch.txt");
    const payload = Buffer.from("approved bytes");
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath, content: payload, summary: "Create file" });
    const approved = await queue.decide({ requestId: request.requestId, expectedRevision: request.revision, decision: "APPROVE" });
    await writeFile(targetPath, "different bytes", "utf8");
    await expect(queue.reportExecutionUnavailable({ requestId: approved.requestId, expectedRevision: approved.revision })).resolves.toMatchObject({
      status: "UNAVAILABLE",
      code: "APPROVAL_TARGET_CHANGED",
      record: {
        decision: "STALE",
        execution: "NOT_STARTED",
        failureCode: "APPROVAL_TARGET_CHANGED",
      },
    });
  });

  it("records a confirmed execution action as unavailable without changing approval or files", async () => {
    const context = await makeContext();
    const targetPath = path.join(context.workspaceRoot, "blocked.txt");
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath, content: "approved", summary: "Create file" });
    const approved = await queue.decide({ requestId: request.requestId, expectedRevision: request.revision, decision: "APPROVE" });

    const outcome = await queue.reportExecutionUnavailable({ requestId: approved.requestId, expectedRevision: approved.revision });
    expect(outcome).toMatchObject({ status: "UNAVAILABLE", code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE" });
    expect(outcome.record).toMatchObject({ decision: "APPROVED", execution: "NOT_STARTED", attemptCount: 0 });
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(context.auditEvents.at(-1)).toMatchObject({
      event: "APPROVAL_EXECUTION_BLOCKED",
      resultCode: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
    });
  });

  it("expires requests and records a profile switch as stale", async () => {
    const time = { value: Date.UTC(2026, 0, 1) };
    const context = await makeContext({ time });
    const targetPath = path.join(context.workspaceRoot, "expires.txt");
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath, content: "x", summary: "Create file" });
    const second = await queue.requestWrite({ targetPath: path.join(context.workspaceRoot, "other.txt"), content: "y", summary: "Create file" });
    time.value += 11 * 60 * 1000;
    const expired = await queue.list();
    expect(expired).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: request.requestId, decision: "EXPIRED", failureCode: "APPROVAL_EXPIRED" }),
      expect.objectContaining({ requestId: second.requestId, decision: "EXPIRED", failureCode: "APPROVAL_EXPIRED" }),
    ]));

    context.identity.value = { profileId: "profile-b", workspaceId: "workspace-a", workspaceRoot: context.workspaceRoot };
    const secondExpired = expired.find((record) => record.requestId === second.requestId);
    if (!secondExpired) throw new Error("EXPIRED_REQUEST_NOT_FOUND");
    const stale = await queue.decide({ requestId: second.requestId, expectedRevision: secondExpired.revision, decision: "APPROVE" });
    expect(stale).toMatchObject({ decision: "STALE", execution: "NOT_STARTED", failureCode: "APPROVAL_PROFILE_CHANGED" });
    expect(request.decision).toBe("PENDING");
  });

  it("rejects approval reads and marks decisions stale when Workspace root changes under the same IDs", async () => {
    const context = await makeContext();
    const queue = context.makeQueue();
    const request = await queue.requestWrite({
      targetPath: path.join(context.workspaceRoot, "workspace-root-change.txt"),
      content: "bound content",
      summary: "Create file",
    });

    context.identity.value = {
      profileId: "profile-a",
      workspaceId: "workspace-a",
      workspaceRoot: path.join(context.root, "other-workspace"),
    };
    await expect(queue.list()).rejects.toThrow("APPROVAL_WORKSPACE_CHANGED");

    const stale = await queue.decide({
      requestId: request.requestId,
      expectedRevision: request.revision,
      decision: "APPROVE",
    });
    expect(stale).toMatchObject({
      decision: "STALE",
      execution: "NOT_STARTED",
      failureCode: "APPROVAL_WORKSPACE_CHANGED",
    });
    expect(stale.contentDigest).toBe(request.contentDigest);
    expect(stale.expectedTargetVersion).toBe("ABSENT");
  });

  it("marks a running attempt failed after restart instead of claiming success", async () => {
    const context = await makeContext();
    const queue = context.makeQueue();
    const request = await queue.requestWrite({ targetPath: path.join(context.workspaceRoot, "restart.txt"), content: "bytes", summary: "Create file" });
    const approved = await queue.decide({ requestId: request.requestId, expectedRevision: request.revision, decision: "APPROVE" });
    const started = await queue.beginExecution({ requestId: approved.requestId, expectedRevision: approved.revision, content: "bytes" });
    expect(started.allowed).toBe(true);
    queue.abandonOutstandingPermitsOnShutdown();
    const afterRestart = context.makeQueue();
    await expect(afterRestart.list()).resolves.toMatchObject([{ execution: "FAILED", verification: "UNAVAILABLE", failureCode: "APPROVAL_EXECUTION_INTERRUPTED" }]);
  });
});


