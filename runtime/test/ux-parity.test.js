import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import { startJobTool, jobStatusTool, jobOutputTool, jobCancelTool, jobInputTool } from "../dist/job-tools.js";

const WORKSPACE_ID = "ws_ux_parity";
const CLIENT = "client-ux-parity";

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "ux-parity-"));
  const workspace = path.join(parent, "ws");
  const profile = path.join(parent, "profile");
  await mkdir(workspace, { recursive: true });
  await mkdir(profile, { recursive: true });
  // 命令白名单禁止元字符，测试一律用脚本文件而不是 node -e 内联代码。
  await writeFile(path.join(workspace, "echo-stdin.mjs"),
    "process.stdin.on('data', (d) => process.stdout.write('ECHO:' + d));\n", "utf8");
  await writeFile(path.join(workspace, "addition.mjs"),
    "process.stdin.on('data', (d) => process.stdout.write('SUM:' + (Number(String(d).trim()) * 2) + '\\n'));\n", "utf8");
  await writeFile(path.join(workspace, "rows.mjs"),
    "for (let i = 0; i < 200; i += 1) console.log('row-' + i);\n", "utf8");
  await writeFile(path.join(workspace, "sleep.mjs"), "setTimeout(() => {}, 5000);\n", "utf8");
  await writeFile(path.join(workspace, "done.mjs"), "console.log('done');\n", "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({
    version: 1,
    tools: {
      start_job: { enabled: true, approval: "auto" },
      job_status: { enabled: true, approval: "auto" },
      job_output: { enabled: true, approval: "auto" },
      job_input: { enabled: true, approval: "auto" },
      job_cancel: { enabled: true, approval: "auto" },
      execute_command: { enabled: true, approval: "auto" },
    },
  }), "utf8");
  const boundary = await McpSecurityBoundary.create(workspace, {
    aclPath: null,
    workspaceId: WORKSPACE_ID,
    profileDir: profile,
  });
  const ws = {
    boundary,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: boundary.rootReal,
    profileDir: profile,
    caller: { clientId: CLIENT, requestId: "ux-parity-1" },
    shellScopeGranted: true,
  };
  return { parent, profile, ws };
}

async function waitForState(ws, id, wanted, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let status = await jobStatusTool(ws, { job_id: id });
  while (status.state !== wanted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await jobStatusTool(ws, { job_id: id });
  }
  return status;
}

async function waitForOutput(ws, id, needle, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  while (Date.now() < deadline) {
    const chunk = await jobOutputTool(ws, { job_id: id, offset: 0, max_bytes: 32_768 });
    output = String(chunk.output ?? "");
    if (output.includes(needle)) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return output;
}

/** 取消任务并等它真正结束，再清理目录（Windows 上进程占用会让 rmdir 报 EBUSY）。 */
async function stopAndCleanup(ws, parent, jobId) {
  if (jobId) {
    try {
      await jobCancelTool(ws, { job_id: jobId });
      await waitForState(ws, jobId, "CANCELLED", 8_000).catch(() => undefined);
    } catch {
      /* 任务可能已结束 */
    }
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(parent, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

test("UX: interactive 任务可通过 job_input 交互并读回输出", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node echo-stdin.mjs",
      interactive: true,
      timeout_ms: 30_000,
    });
    assert.ok(started.job_id);
    const running = await waitForState(ws, started.job_id, "RUNNING");
    assert.equal(running.state, "RUNNING");

    const written = await jobInputTool(ws, { job_id: started.job_id, input: "hello" });
    assert.equal(written.bytes, 6, "默认追加换行");
    assert.equal(written.newline, true);

    const output = await waitForOutput(ws, started.job_id, "ECHO:hello");
    assert.match(output, /ECHO:hello/);
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});

test("UX: 多轮输入可驱动同一交互进程（REPL 语义）", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node addition.mjs",
      interactive: true,
      timeout_ms: 30_000,
    });
    await waitForState(ws, started.job_id, "RUNNING");

    await jobInputTool(ws, { job_id: started.job_id, input: "21" });
    await waitForOutput(ws, started.job_id, "SUM:42");
    await jobInputTool(ws, { job_id: started.job_id, input: "50" });
    const output = await waitForOutput(ws, started.job_id, "SUM:100");
    assert.match(output, /SUM:42/);
    assert.match(output, /SUM:100/);
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});

test("UX: newline:false 时字节数精确等于输入长度", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node sleep.mjs",
      interactive: true,
      timeout_ms: 30_000,
    });
    await waitForState(ws, started.job_id, "RUNNING");

    const written = await jobInputTool(ws, { job_id: started.job_id, input: "abc", newline: false });
    assert.equal(written.bytes, 3, "不得追加换行");
    assert.equal(written.newline, false);

    const withNewline = await jobInputTool(ws, { job_id: started.job_id, input: "xy" });
    assert.equal(withNewline.bytes, 3, "默认追加换行：2 + 1");
    assert.equal(withNewline.newline, true);
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});

test("UX: 空输入被拒绝", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node sleep.mjs",
      interactive: true,
      timeout_ms: 30_000,
    });
    await waitForState(ws, started.job_id, "RUNNING");
    await assert.rejects(
      () => jobInputTool(ws, { job_id: started.job_id, input: "" }),
      /JOB_INPUT_EMPTY/,
    );
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});

test("UX: 非 interactive 任务拒绝 job_input", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node sleep.mjs",
      timeout_ms: 20_000,
    });
    await waitForState(ws, started.job_id, "RUNNING");
    await assert.rejects(
      () => jobInputTool(ws, { job_id: started.job_id, input: "x" }),
      /JOB_NOT_INTERACTIVE/,
    );
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});

test("UX: 任务结束后 job_input 拒绝写入", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node done.mjs",
      interactive: true,
      timeout_ms: 20_000,
    });
    const finished = await waitForState(ws, started.job_id, "SUCCEEDED");
    assert.equal(finished.state, "SUCCEEDED");
    await assert.rejects(
      () => jobInputTool(ws, { job_id: started.job_id, input: "late" }),
      /JOB_NOT_RUNNING|JOB_NOT_INTERACTIVE/,
    );
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});

test("UX: job_output 负 offset 读取尾部", async () => {
  const { parent, ws } = await setup();
  let started = null;
  try {
    started = await startJobTool(ws, {
      action: "execute_command",
      command: "node rows.mjs",
      timeout_ms: 30_000,
    });
    const finished = await waitForState(ws, started.job_id, "SUCCEEDED");
    assert.equal(finished.state, "SUCCEEDED");

    const tail = await jobOutputTool(ws, { job_id: started.job_id, offset: -40, max_bytes: 200 });
    assert.equal(tail.tail, true);
    assert.ok(tail.offset > 0, "负偏移应换算成实际字节位置");
    assert.match(String(tail.output), /row-199/);

    const head = await jobOutputTool(ws, { job_id: started.job_id, offset: 0, max_bytes: 64 });
    assert.match(String(head.output), /row-0/);
    assert.equal(head.tail, undefined);
  } finally {
    await stopAndCleanup(ws, parent, started?.job_id);
  }
});
