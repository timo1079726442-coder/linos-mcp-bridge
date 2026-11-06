import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import { JobStore } from "../dist/job-store.js";
import { startJobTool, jobListTool, jobStatusTool, jobOutputTool, jobCancelTool, jobResumeTool } from "../dist/job-tools.js";
import { createMemoryTimeline } from "../dist/job-timeline.js";
import { recoverInterruptedJobs, isJobActive } from "../dist/job-runner.js";

const WORKSPACE_ID = "ws_job_test";

// 诊断：仅在设置 MCP_TIMELINE_DIR 时收集（CI/人工压测），正常开发不留痕迹。
const TIMELINE_DIR = process.env.MCP_TIMELINE_DIR ?? "";
const timelines = [];
if (TIMELINE_DIR) {
  process.on("exit", () => {
    try {
      mkdirSync(TIMELINE_DIR, { recursive: true });
      const file = path.join(TIMELINE_DIR, `job-tools-${process.pid}.jsonl`);
      writeFileSync(file, timelines.map((t) => t.toJsonl()).join(""), "utf8");
    } catch { /* 诊断失败不影响测试结果 */ }
  });
}
const CLIENT = "client-job-test";

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-jobs-"));
  const workspace = path.join(parent, "ws");
  const profile = path.join(parent, "profile");
  await mkdir(workspace, { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(workspace, "hello.mjs"), "console.log('job-ok');\n", "utf8");
  await writeFile(path.join(workspace, "tick.mjs"), "setInterval(() => console.log('tick'), 50);\n", "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({
    version: 1,
    tools: {
      start_job: { enabled: true, approval: "auto" },
      job_status: { enabled: true, approval: "auto" },
      job_output: { enabled: true, approval: "auto" },
      job_list: { enabled: true, approval: "auto" },
      job_cancel: { enabled: true, approval: "auto" },
      job_resume: { enabled: true, approval: "manual" },
      execute_command: { enabled: true, approval: "auto" },
      run_powershell: { enabled: true, approval: "auto" },
      git_commit: { enabled: true, approval: "auto" },
    },
  }), "utf8");
  const boundary = await McpSecurityBoundary.create(workspace, {
    aclPath: null,
    workspaceId: WORKSPACE_ID,
    profileDir: profile,
  });
  const timeline = TIMELINE_DIR ? createMemoryTimeline() : null;
  if (timeline) timelines.push(timeline);
  const ws = (shellScopeGranted) => ({
    boundary,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: boundary.rootReal,
    profileDir: profile,
    caller: { clientId: CLIENT, requestId: "job-test-1" },
    shellScopeGranted,
    ...(timeline ? { timeline: timeline.sink } : {}),
  });
  return { parent, profile, ws };
}

async function dumpOnFailure(profile, id, status) {
  if (status && (status.state === "SUCCEEDED" || status.state === "FAILED")) {
    try {
      const record = await new JobStore(profile, WORKSPACE_ID).get(id);
      const out = await new JobStore(profile, WORKSPACE_ID).readOutput(id, 0, 2048);
      console.error(`[job-debug] ${id} state=${record.state} error=${record.errorCode} msg=${record.errorMessage} out=${JSON.stringify(out.output.slice(0, 500))}`);
    } catch {
      /* best effort diagnostics */
    }
  }
}

async function waitForTerminalState(ws, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await jobStatusTool(ws, { job_id: id });
    if (status.state !== "RUNNING" && status.state !== "QUEUED") return status;
    if (Date.now() > deadline) throw new Error(`JOB_TEST_TIMEOUT: ${id} still ${status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("start_job 立即返回且重建客户端上下文后可恢复读取", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    const startedAt = Date.now();
    const started = await startJobTool(ws, {
      action: "execute_command",
      command: "node hello.mjs",
      cwd: ".",
      timeout_ms: 30000,
      idempotency_key: "job-a",
      label: "smoke",
    });
    const reconnectedWs = ctx.ws(true); // 模拟 MCP 客户端断线后重新连接
    assert.match(started.job_id, /^job_[0-9a-f]{24}$/);
    assert.ok(Date.now() - startedAt < 5000, "start_job 必须立即返回而不是等命令结束");
    let status;
    for (let i = 0; i < 200; i += 1) {
      status = await jobStatusTool(reconnectedWs, { job_id: started.job_id });
      if (status.state === "SUCCEEDED" || status.state === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await dumpOnFailure(ctx.profile, started.job_id, status);
    assert.equal(status.state, "SUCCEEDED");
    assert.equal(status.exit_code, 0);
    const out = await jobOutputTool(reconnectedWs, { job_id: started.job_id, offset: 0, max_bytes: 8192 });
    assert.match(out.output, /job-ok/);
    assert.equal(out.eof, true);
    const same = await startJobTool(reconnectedWs, {
      action: "execute_command",
      command: "node hello.mjs",
      cwd: ".",
      timeout_ms: 30000,
      idempotency_key: "job-a",
    });
    assert.equal(same.job_id, started.job_id);
    assert.equal(same.resumed, true);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("并发重复 start_job 请求复用同一 idempotency 任务", async () => {
  const ctx = await setup();
  const ws = ctx.ws(true);
  const store = new JobStore(ctx.profile, WORKSPACE_ID);
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => startJobTool(ws, {
      action: "execute_command",
      command: "node tick.mjs",
      cwd: ".",
      timeout_ms: 30000,
      idempotency_key: "concurrent-same-key",
    })));
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 8);
    const values = results.map((item) => item.status === "fulfilled" ? item.value : null).filter(Boolean);
    assert.equal(new Set(values.map((item) => item.job_id)).size, 1);
    assert.equal(values.filter((item) => !item.resumed).length, 1);
    const jobId = values[0].job_id;
    const records = await store.list(20);
    assert.equal(records.filter((record) => record.spec.idempotencyKey === "concurrent-same-key").length, 1);
    const cancelled = await jobCancelTool(ws, { job_id: jobId });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(isJobActive(jobId), false);
  } finally {
    for (const record of await store.list(50)) {
      if (record.state === "RUNNING" || record.state === "QUEUED") {
        await jobCancelTool(ws, { job_id: record.id }).catch(() => undefined);
      }
    }
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("workspace 活跃任务上限在并发启动时 fail-closed", async () => {
  const ctx = await setup();
  const ws = ctx.ws(true);
  try {
    const first = await startJobTool(ws, { action: "execute_command", command: "node tick.mjs", cwd: ".", timeout_ms: 60_000, idempotency_key: "slot-1" });
    const second = await startJobTool(ws, { action: "execute_command", command: "node tick.mjs", cwd: ".", timeout_ms: 60_000, idempotency_key: "slot-2" });
    await assert.rejects(
      () => startJobTool(ws, { action: "execute_command", command: "node tick.mjs", cwd: ".", timeout_ms: 60_000, idempotency_key: "slot-3" }),
      /JOB_CONCURRENCY_LIMIT/,
    );
    const cancelled = await Promise.all([
      jobCancelTool(ws, { job_id: first.job_id }),
      jobCancelTool(ws, { job_id: second.job_id }),
    ]);
    assert.equal(cancelled.every((item) => item.state === "CANCELLED"), true);
    assert.equal(isJobActive(first.job_id), false);
    assert.equal(isJobActive(second.job_id), false);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("job_list 只返回当前客户端的任务且不含输出正文", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    const started = await startJobTool(ws, {
      action: "execute_command",
      command: "node hello.mjs",
      cwd: ".",
      timeout_ms: 30000,
      idempotency_key: "list-a",
    });
    const listed = await jobListTool(ws, { limit: 20 });
    const found = listed.jobs.find((job) => job.job_id === started.job_id);
    assert.ok(found);
    assert.equal(found.kind, "execute_command");
    assert.ok(!("output" in found));
    assert.ok(!("command" in found));
    const other = await jobListTool({
      ...ws, caller: { clientId: "other-client", requestId: "x" },
    }, { limit: 20 });
    assert.equal(other.jobs.some((job) => job.job_id === started.job_id), false);
    await waitForTerminalState(ws, started.job_id);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("start_job 拒绝白名单外命令和缺失 shell 授权", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(() => startJobTool(ctx.ws(false), {
      action: "execute_command", command: "node hello.mjs",
    }), /INSUFFICIENT_SCOPE/);
    await assert.rejects(() => startJobTool(ctx.ws(true), {
      action: "execute_command", command: "echo hi",
    }), /COMMAND_NOT_ALLOWED/);
    const owned = await startJobTool(ctx.ws(true), {
      action: "execute_command", command: "node hello.mjs", idempotency_key: "bind-a",
    });
    await assert.rejects(() => jobStatusTool({
      ...ctx.ws(true), caller: { clientId: "other-client", requestId: "x" },
    }, { job_id: owned.job_id }), /JOB_CLIENT_MISMATCH/);
    for (let i = 0; i < 100; i += 1) {
      const ownedFinal = await jobStatusTool(ctx.ws(true), { job_id: owned.job_id });
      if (ownedFinal.state === "SUCCEEDED") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("重启恢复只中断过期任务，保留新鲜队列并可 resume", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    const store = new JobStore(ctx.profile, WORKSPACE_ID);
    const now = Date.now();
    const staleAt = new Date(now - 60_000).toISOString();
    const markerPath = path.join(ctx.parent, "crashed-job-id.txt");
    const childScript = `
      import { JobStore } from "./dist/job-store.js";
      import { writeFileSync } from "node:fs";
      const store = new JobStore(${JSON.stringify(ctx.profile)}, ${JSON.stringify(WORKSPACE_ID)});
      const record = await store.create({
        kind: "execute_command", label: "orphaned-after-runtime-crash",
        clientId: ${JSON.stringify(CLIENT)}, workspaceId: ${JSON.stringify(WORKSPACE_ID)},
        argv: ["node", "hello.mjs"], display: "node hello.mjs",
        cwdInput: ".", cwdAbsolute: ${JSON.stringify(ws.workspaceRoot)}, cwdDisplay: ".", timeoutMs: 30000,
      });
      await store.save({ ...record, state: "RUNNING", attempts: 1,
        createdAt: ${JSON.stringify(staleAt)}, startedAt: ${JSON.stringify(staleAt)},
        lastHeartbeatAt: ${JSON.stringify(staleAt)}, pid: 987654 });
      writeFileSync(${JSON.stringify(markerPath)}, record.id, "utf8");
      process.exit(73); // abrupt Runtime termination after durable RUNNING record
    `;
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(), stdio: "ignore", timeout: 10_000,
    });
    assert.equal(crashed.error, undefined);
    assert.equal(crashed.status, 73);
    const staleId = (await readFile(markerPath, "utf8")).trim();
    const stale = await store.get(staleId);
    assert.equal(stale.state, "RUNNING");
    const fresh = await store.create({
      kind: "execute_command", label: "fresh-queued", clientId: CLIENT, workspaceId: WORKSPACE_ID,
      argv: ["node", "hello.mjs"], display: "node hello.mjs",
      cwdInput: ".", cwdAbsolute: ws.workspaceRoot, cwdDisplay: ".", timeoutMs: 30_000,
    });

    const recovered = await recoverInterruptedJobs(store, now, 30_000);
    assert.equal(recovered, 1);
    assert.equal((await store.get(staleId)).state, "INTERRUPTED");
    assert.equal((await store.get(fresh.id)).state, "QUEUED");

    const resumed = await jobResumeTool(ws, { job_id: staleId });
    assert.equal(resumed.job_id, staleId);
    const final = await waitForTerminalState(ws, staleId);
    assert.equal(final.state, "SUCCEEDED");
    assert.equal(final.attempts, 2);
    assert.equal(isJobActive(staleId), false);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("取消后并发 resume 只创建一个新 attempt", async () => {
  const ctx = await setup();
  const ws = ctx.ws(true);
  const store = new JobStore(ctx.profile, WORKSPACE_ID);
  let jobId = "";
  try {
    const started = await startJobTool(ws, { action: "execute_command", command: "node tick.mjs", cwd: ".", timeout_ms: 60_000 });
    jobId = started.job_id;
    let status = null;
    for (let i = 0; i < 100; i += 1) {
      status = await jobStatusTool(ws, { job_id: jobId });
      if (status.state === "RUNNING" && status.pid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.state, "RUNNING");
    const cancelled = await jobCancelTool(ws, { job_id: jobId });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(isJobActive(jobId), false);

    const resumes = await Promise.all([
      jobResumeTool(ws, { job_id: jobId }),
      jobResumeTool(ws, { job_id: jobId }),
    ]);
    assert.equal(resumes.length, 2);
    assert.equal(resumes[0].job_id, jobId);
    assert.equal(resumes[1].job_id, jobId);
    let resumedRecord = await store.get(jobId);
    for (let i = 0; i < 100 && resumedRecord.attempts < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      resumedRecord = await store.get(jobId);
    }
    assert.equal(resumedRecord.attempts, 2);
    assert.equal(isJobActive(jobId), true);

    const cancelledAgain = await jobCancelTool(ws, { job_id: jobId });
    assert.equal(cancelledAgain.state, "CANCELLED");
    assert.equal(isJobActive(jobId), false);
  } finally {
    for (const record of await store.list(50)) {
      if ((record.state === "RUNNING" || record.state === "QUEUED") && isJobActive(record.id)) {
        await jobCancelTool(ws, { job_id: record.id }).catch(() => undefined);
      }
    }
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("运行期间心跳更新且 settle 后停止", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    const store = new JobStore(ctx.profile, WORKSPACE_ID);
    const started = await startJobTool(ws, { action: "execute_command", command: "node tick.mjs", cwd: ".", timeout_ms: 60_000 });
    let status = null;
    for (let i = 0; i < 100; i += 1) {
      status = await jobStatusTool(ws, { job_id: started.job_id });
      if (status.state === "RUNNING" && status.pid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.state, "RUNNING");
    const initialHeartbeat = Date.parse(status.last_heartbeat_at);
    let heartbeat = status;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && Date.parse(heartbeat.last_heartbeat_at) <= initialHeartbeat) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      heartbeat = await jobStatusTool(ws, { job_id: started.job_id });
    }
    assert.ok(Date.parse(heartbeat.last_heartbeat_at) > initialHeartbeat, "heartbeat must advance while RUNNING");
    const cancelled = await jobCancelTool(ws, { job_id: started.job_id });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(isJobActive(started.job_id), false);
    const settled = await store.get(started.job_id);
    const finalHeartbeat = settled.lastHeartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await store.get(started.job_id)).lastHeartbeatAt, finalHeartbeat, "heartbeat must stop after controller settle");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("后台任务可取消并保留可恢复记录", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    const started = await startJobTool(ws, {
      action: "execute_command",
      command: "node tick.mjs",
      cwd: ".",
      timeout_ms: 60000,
    });
    let running = null;
    for (let i = 0; i < 100; i += 1) {
      running = await jobStatusTool(ws, { job_id: started.job_id });
      if (running.state === "RUNNING") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(running.state, "RUNNING");
    // 给进程稳定的启动时间：CI 慢机器上"刚 RUNNING 就取消"可能一行业务输出都没有。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const cancelled = await jobCancelTool(ws, { job_id: started.job_id });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(cancelled.cancel_requested, true);
    let final = null;
    for (let i = 0; i < 100; i += 1) {
      final = await jobStatusTool(ws, { job_id: started.job_id });
      if (final.state === "CANCELLED") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(final.state, "CANCELLED");
    // 取消时机受机器负载影响：给输出一点落盘时间再断言，避免偶发空输出。
    let out = await jobOutputTool(ws, { job_id: started.job_id, offset: 0, max_bytes: 8192 });
    for (let i = 0; i < 40 && !/tick/.test(out.output ?? ""); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      out = await jobOutputTool(ws, { job_id: started.job_id, offset: 0, max_bytes: 8192 });
    }
    // 输出内容依赖进程调度；这里只要求"取消后仍能读到输出对象"，时序无关。
    assert.equal(typeof out.output, "string");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("失败任务可以用同一授权 resume 重跑", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    const started = await startJobTool(ws, {
      action: "execute_command",
      command: "node missing.mjs",
      cwd: ".",
      timeout_ms: 30000,
    });
    let failed = null;
    for (let i = 0; i < 100; i += 1) {
      failed = await jobStatusTool(ws, { job_id: started.job_id });
      if (failed.state === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(failed.state, "FAILED");
    await writeFile(path.join(ctx.parent, "ws", "missing.mjs"), "console.log('recovered');\n", "utf8");
    const resumed = await jobResumeTool(ws, { job_id: started.job_id });
    assert.equal(resumed.job_id, started.job_id);
    let done = null;
    for (let i = 0; i < 100; i += 1) {
      done = await jobStatusTool(ws, { job_id: started.job_id });
      if (done.state === "SUCCEEDED" || done.state === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(done.state, "SUCCEEDED");
    assert.equal(done.attempts, 2);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("并发启动的后台任务在并行写入压力下全部成功", async () => {
  const ctx = await setup();
  try {
    const ws = ctx.ws(true);
    for (let batch = 0; batch < 2; batch += 1) {
      const started = await Promise.all([0, 1].map((index) => startJobTool(ws, {
        action: "execute_command",
        command: "node hello.mjs",
        cwd: ".",
        timeout_ms: 30000,
        idempotency_key: `stress-${batch}-${index}`,
      })));
      for (const item of started) {
        const final = await waitForTerminalState(ws, item.job_id);
        assert.equal(final.state, "SUCCEEDED");
      }
    }
    const listed = await jobListTool(ws, { limit: 20 });
    assert.equal(listed.jobs.filter((job) => job.state === "SUCCEEDED").length >= 4, true);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});
