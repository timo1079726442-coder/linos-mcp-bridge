import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { appendReadOnlyToolAudit, appendToolAuditEvent, appendToolAuditIntent, appendToolAuditExecutionStarted, appendToolAuditResult, toolAuditPath, verifyToolAudit } from "../dist/tool-audit.js";

const WORKSPACE_ID = "workspace-audit";

async function call(root, profile, name, args, writeScopeGranted = true) {
  return dispatchMcp(
    { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } },
    WORKSPACE_ID,
    root,
    null,
    { writeScopeGranted, shellScopeGranted: true, caller: { clientId: "audit-test-client", requestId: `audit-${name}-${Date.now()}` }, toolPolicyDir: profile },
  );
}

test("tool audit appends a verifiable hash chain without file contents", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-profile-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: { write_file: { enabled: true, approval: "auto" }, update_file: { enabled: true, approval: "auto" } } }), "utf8");
    await call(root, profile, "write_file", { path: "a.txt", content: "TOP-SECRET-CONTENT" });
    await call(root, profile, "update_file", { path: "a.txt", content: "SECOND-SECRET" });
    await assert.rejects(
      () => call(root, profile, "create_file", { path: "b.txt", content: "DENIED" }, false),
      /workspace.write/,
    );

    const raw = await readFile(toolAuditPath(profile, WORKSPACE_ID), "utf8");
    const lines = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(lines.length, 6);
    assert.equal(lines[0].kind, "INTENT_DURABLE");
    assert.equal(lines[0].tool, "write_file");
    assert.equal(lines[0].prevHash, "0".repeat(64));
    assert.equal(lines[1].kind, "RESULT_DURABLE");
    assert.equal(lines[1].prevHash, lines[0].hash);
    assert.equal(lines[1].ok, true);
    assert.equal(lines[2].kind, "INTENT_DURABLE");
    assert.equal(lines[2].tool, "update_file");
    assert.equal(lines[3].kind, "RESULT_DURABLE");
    assert.equal(lines[4].kind, "INTENT_DURABLE");
    assert.equal(lines[5].kind, "RESULT_DURABLE");
    assert.equal(lines[5].ok, false);
    assert.equal(lines[5].errorCode, "INSUFFICIENT_SCOPE");
    assert.equal(raw.includes("TOP-SECRET-CONTENT"), false);
    assert.equal(raw.includes("SECOND-SECRET"), false);
    assert.equal(raw.includes("DENIED"), false);

    const verification = await verifyToolAudit(profile, WORKSPACE_ID);
    assert.equal(verification.ok, true);
    assert.equal(verification.entries, 6);
    assert.deepEqual(verification.pendingOperations, []);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("audit intent failure blocks high-risk write before filesystem side effect", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-failclosed-profile-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "audit-failclosed-root-"));
  const target = path.join(root, "blocked.txt");
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: { write_file: { enabled: true, approval: "auto" } } }), "utf8");
    await writeFile(path.join(profile, "audit"), "not-a-directory", "utf8");
    await assert.rejects(() => call(root, profile, "write_file", { path: "blocked.txt", content: "must-not-write" }), /AUDIT_UNAVAILABLE/);
    await assert.rejects(() => readFile(target, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("audit failure blocks background command start and Git commit", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-command-failclosed-profile-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "audit-command-failclosed-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {
      start_job: { enabled: true, approval: "auto" },
      execute_command: { enabled: true, approval: "auto" },
      git_commit: { enabled: true, approval: "auto" },
    } }), "utf8");
    await writeFile(path.join(profile, "audit"), "not-a-directory", "utf8");
    execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
    execFileSync("git", ["-C", root, "-c", "user.name=Audit Test", "-c", "user.email=audit-test@example.invalid", "commit", "--allow-empty", "-m", "baseline"], { stdio: "ignore" });
    const before = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    await assert.rejects(() => call(root, profile, "start_job", {
      action: "execute_command", command: "node hello.mjs", cwd: ".", timeout_ms: 30_000,
    }), /AUDIT_UNAVAILABLE/);
    await assert.rejects(() => call(root, profile, "git_commit", {
      message: "must-not-commit", cwd: ".",
    }), /AUDIT_UNAVAILABLE/);
    assert.deepEqual((await readdir(profile)).sort(), ["audit", "tool-policy.json"]);
    assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only result returns auditState PENDING when the journal is unavailable", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-readonly-profile-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "audit-readonly-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: { list_directory: { enabled: true, approval: "auto" } } }), "utf8");
    await writeFile(path.join(profile, "audit"), "not-a-directory", "utf8");
    const result = await call(root, profile, "list_directory", { path: "." });
    assert.equal(result._meta.auditState, "PENDING");
    assert.equal(Array.isArray(result.entries), true);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("background job audit persists intent before launch and durable result afterward", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-job-profile-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "audit-job-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {
      start_job: { enabled: true, approval: "auto" },
      execute_command: { enabled: true, approval: "auto" },
      job_status: { enabled: true, approval: "auto" },
    } }), "utf8");
    await writeFile(path.join(root, "hello.mjs"), "console.log('audit-job-ok');\n", "utf8");
    const started = await call(root, profile, "start_job", {
      action: "execute_command", command: "node hello.mjs", cwd: ".", timeout_ms: 30_000, idempotency_key: "audit-job-1",
    });
    assert.equal(started._meta.auditState, "EXECUTION_STARTED_DURABLE");
    const operationId = started._meta.auditOperationId;
    let status = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      status = await call(root, profile, "job_status", { job_id: started.job_id });
      if ((status.state === "SUCCEEDED" || status.state === "FAILED") && status.audit_state === "PERSISTED") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.state, "SUCCEEDED", JSON.stringify(status));
    assert.equal(status.audit_state, "PERSISTED");
    const file = toolAuditPath(profile, WORKSPACE_ID);
    const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const operationEvents = lines.filter((entry) => entry.operationId === operationId);
    assert.deepEqual(operationEvents.map((entry) => entry.kind), ["INTENT_DURABLE", "EXECUTION_STARTED_DURABLE", "RESULT_DURABLE"]);
    assert.equal((await verifyToolAudit(profile, WORKSPACE_ID)).pendingOperations.length, 0);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("tool audit detects a tampered entry", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-tamper-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-tamper-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: { write_file: { enabled: true, approval: "auto" } } }), "utf8");
    await call(root, profile, "write_file", { path: "a.txt", content: "one" });
    const file = toolAuditPath(profile, WORKSPACE_ID);
    const raw = await readFile(file, "utf8");
    const tampered = raw.replace('"tool":"write_file"', '"tool":"delete_file"');
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, tampered, "utf8"));
    const result = await verifyToolAudit(profile, WORKSPACE_ID);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy v0.1.0 audit journal remains verifiable and untouched", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-legacy-profile-"));
  try {
    const auditDir = path.join(profile, "audit");
    await mkdir(auditDir, { recursive: true });
    const entry = {
      seq: 1, at: new Date().toISOString(), prevHash: "0".repeat(64),
      tool: "read_file", ok: true, durationMs: 1,
    };
    const hash = createHash("sha256").update(entry.prevHash).update(JSON.stringify(entry)).digest("hex");
    const legacyPath = path.join(auditDir, "tool-calls.jsonl");
    const legacyBytes = `${JSON.stringify({ ...entry, hash })}\n`;
    await writeFile(legacyPath, legacyBytes, "utf8");
    const result = await verifyToolAudit(profile);
    assert.equal(result.ok, true);
    assert.equal(result.entries, 1);
    assert.deepEqual(result.legacy, { ok: true, entries: 1 });
    assert.equal(await readFile(legacyPath, "utf8"), legacyBytes);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("workspace audit journal persists intent/execution/result with durability receipt", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-journal-state-"));
  const workspace = "workspace_state";
  // 期望值是"实测能力"而不是"声称能力"：win32 上目录项 fsync 不可用。
  const expectedDurability = process.platform === "win32" ? "FILE_SYNC_ONLY" : "FILE_AND_DIRECTORY_SYNC";
  try {
    const intent = await appendToolAuditIntent(profile, workspace, { tool: "git_commit", command: "git commit -m release", clientId: "client-state" }, "operation-state-1");
    assert.equal(intent.seq, 1);
    assert.equal(intent.durability, expectedDurability, "append 回执必须如实报告平台能力");
    const started = await appendToolAuditExecutionStarted(profile, workspace, { tool: "start_job", ok: true }, "operation-state-1");
    assert.equal(started.seq, 2);
    const result = await appendToolAuditResult(profile, workspace, { tool: "git_commit", ok: true, durationMs: 21 }, "operation-state-1");
    assert.equal(result.seq, 3);
    const verification = await verifyToolAudit(profile, workspace);
    assert.equal(verification.ok, true);
    assert.equal(verification.entries, 3);
    assert.deepEqual(verification.pendingOperations, []);
    // 发布门禁项：verify 必须公开与回执一致的持久化等级，禁止把降级说成完整持久化。
    assert.equal(verification.durability, expectedDurability);
    assert.equal(verification.platform, process.platform);
    assert.notEqual(toolAuditPath(profile, workspace), toolAuditPath(profile, "workspace_other"));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("torn audit tail is AUDIT_PENDING and append refuses to extend it", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-journal-torn-"));
  const workspace = "workspace_torn";
  try {
    await appendToolAuditEvent(profile, workspace, "READ_RESULT", { tool: "read_file", ok: true });
    const file = toolAuditPath(profile, workspace);
    const before = await readFile(file, "utf8");
    await writeFile(file, `${before}{\"partial\":`, "utf8");
    const broken = await verifyToolAudit(profile, workspace);
    assert.equal(broken.ok, false);
    assert.equal(broken.errorCode, "AUDIT_PENDING");
    await assert.rejects(
      () => appendToolAuditEvent(profile, workspace, "READ_RESULT", { tool: "read_file", ok: true }),
      /AUDIT_PENDING/,
    );
    assert.equal(await readFile(file, "utf8"), `${before}{\"partial\":`);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("stale O_EXCL lock from a crashed writer is safely reclaimed", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-journal-stale-lock-"));
  const workspace = "workspace_stale_lock";
  try {
    const file = toolAuditPath(profile, workspace);
    const lockPath = `${file}.lock`;
    await mkdir(path.dirname(file), { recursive: true });
    const staleAt = new Date(Date.now() - 60_000);
    await writeFile(lockPath, JSON.stringify({ pid: 0, token: "dead-token", workerId: "dead-worker", createdAt: staleAt.getTime(), heartbeatAt: staleAt.getTime() }), "utf8");
    await utimes(lockPath, staleAt, staleAt);
    const receipt = await appendReadOnlyToolAudit(profile, workspace, { tool: "read_file", ok: true });
    assert.equal(receipt.seq, 1);
    assert.equal((await verifyToolAudit(profile, workspace)).ok, true);
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("audit redacts local user paths, command secrets and client identifiers", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-journal-redaction-"));
  const workspace = "workspace_redaction";
  try {
    await appendToolAuditEvent(profile, workspace, "READ_RESULT", {
      tool: "execute_command", ok: true,
      path: "C:\\Users\\Administrator\\private\\secret.txt",
      command: "node --token=super-secret-value run.mjs",
      clientId: "c2c_client_private_identity",
      idempotencyKey: "private-idempotency-key",
    });
    const raw = await readFile(toolAuditPath(profile, workspace), "utf8");
    assert.equal(raw.includes("Administrator"), false);
    assert.equal(raw.includes("super-secret-value"), false);
    assert.equal(raw.includes("c2c_client_private_identity"), false);
    assert.equal(raw.includes("private-idempotency-key"), false);
    assert.equal(raw.includes("clientIdHash"), true);
    assert.equal(raw.includes("idempotencyKeyHash"), true);
    assert.equal(raw.includes("commandProgram"), true);
    assert.equal(raw.includes("commandSha256"), true);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("separate processes serialize writes into one verifiable workspace journal", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "audit-journal-multiprocess-"));
  const workspace = "workspace_multi";
  try {
    const moduleUrl = pathToFileURL(path.resolve("dist/tool-audit.js")).href;
    const childScript = `
      import { appendReadOnlyToolAudit } from ${JSON.stringify(moduleUrl)};
      import { writeFileSync } from "node:fs";
      const profile = ${JSON.stringify(profile)};
      const workspace = ${JSON.stringify(workspace)};
      try {
        await Promise.all(Array.from({ length: 6 }, (_, index) => appendReadOnlyToolAudit(profile, workspace, {
          tool: "read_file", ok: true, path: "safe.txt", clientId: "client-" + process.pid + "-" + index,
        })));
      } catch (error) {
        writeFileSync(profile + "/audit-child-" + process.pid + ".err", String(error?.stack || error), "utf8");
        process.exit(1);
      }
    `;
    const childScriptPath = path.join(profile, "audit-child.mjs");
    await writeFile(childScriptPath, childScript, "utf8");
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, [childScriptPath], {
      cwd: process.cwd(), stdio: "ignore",
    }));
    const exits = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? -1));
    })));
    if (exits.some((code) => code !== 0)) {
      const names = await readdir(profile);
      const errors = await Promise.all(names.filter((name) => name.startsWith("audit-child-") && name.endsWith(".err"))
        .map(async (name) => `${name}: ${await readFile(path.join(profile, name), "utf8")}`));
      assert.fail(`AUDIT_CHILD_EXIT_${exits.join(",")}: ${errors.join("\n")}`);
    }
    assert.equal(exits.length, 4);
    const verification = await verifyToolAudit(profile, workspace);
    assert.equal(verification.ok, true);
    assert.equal(verification.entries, 24);
    assert.deepEqual(verification.pendingOperations, []);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

