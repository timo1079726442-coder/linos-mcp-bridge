import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import { executeCommand, gitCommit, runPowerShell } from "../dist/command-tools.js";

function run(argv, cwd) {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function gitRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-cmd-"));
  await run(["git", "init"], root);
  await run(["git", "config", "user.email", "test@example.com"], root);
  await run(["git", "config", "user.name", "Test"], root);
  await writeFile(path.join(root, "a.txt"), "hello\n", "utf8");
  await run(["git", "add", "a.txt"], root);
  return root;
}

test("execute_command 只放行白名单且无 shell", async () => {
  const root = await gitRepo();
  try {
    const boundary = await McpSecurityBoundary.create(root);
    const status = await executeCommand(boundary, { command: "git status --short" });
    assert.equal(status.ok, true);
    assert.match(String(status.stdout), /A\s+a\.txt/);
    // git 写操作现已放开（像本地 agent 一样），但仍禁止任意可执行文件。
    await assert.rejects(() => executeCommand(boundary, { command: "curl http://example.com" }), /COMMAND_NOT_ALLOWED/);
    await assert.rejects(() => executeCommand(boundary, { command: "echo hi" }), /COMMAND_NOT_ALLOWED/);
    await assert.rejects(() => executeCommand(boundary, { command: "python -c print(1)" }), /COMMAND_NOT_ALLOWED|COMMAND_ARGUMENT_DENIED|COMMAND_METACHAR_DENIED/);
    await assert.rejects(() => executeCommand(boundary, { command: "git status | more" }), /COMMAND_METACHAR_DENIED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_commit 只提交已暂存改动并返回提交号", async () => {
  const root = await gitRepo();
  try {
    const boundary = await McpSecurityBoundary.create(root);
    const committed = await gitCommit(boundary, { message: "test commit" });
    assert.equal(committed.ok, true);
    assert.match(committed.commit, /^[0-9a-f]{7,}$/);
    assert.ok(committed.branch.length > 0);
    await assert.rejects(() => gitCommit(boundary, { message: "again" }), /NO_STAGED_CHANGES/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run_powershell 以当前用户运行并返回输出", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-ps-"));
  try {
    const boundary = await McpSecurityBoundary.create(root);
    const result = await runPowerShell(boundary, { command: "Write-Output 'hello-from-ps'" });
    assert.equal(result.ok, true);
    assert.match(String(result.stdout), /hello-from-ps/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


