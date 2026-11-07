import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import { startJobTool, jobStatusTool, jobCancelTool } from "../dist/job-tools.js";
import { createMemoryTimeline } from "../dist/job-timeline.js";

const WORKSPACE_ID = "ws_job_timeline";
const CLIENT = "client-timeline";

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "mcp-timeline-"));
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
      job_cancel: { enabled: true, approval: "auto" },
      execute_command: { enabled: true, approval: "auto" },
    },
  }), "utf8");
  const boundary = await McpSecurityBoundary.create(workspace, {
    aclPath: null,
    workspaceId: WORKSPACE_ID,
    profileDir: profile,
  });
  const timeline = createMemoryTimeline();
  const ws = (shellScopeGranted) => ({
    boundary,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: boundary.rootReal,
    profileDir: profile,
    caller: { clientId: CLIENT, requestId: "timeline" },
    shellScopeGranted,
    // 测试注入点：生产 ws 没有这个属性
    timeline: timeline.sink,
  });
  return { parent, ws, timeline };
}

function dump(timeline, label) {
  const groups = timeline.byAttempt();
  const lines = [`\n===== ${label}：${groups.size} 个 attempt =====`];
  for (const [key, events] of groups) {
    lines.push(`\n[${key}]`);
    const t0 = Date.parse(events[0].timestamp);
    for (const event of events) {
      const offset = String(Date.parse(event.timestamp) - t0).padStart(5, " ");
      const extra = [
        event.pid !== undefined ? `pid=${event.pid}` : "",
        event.exit_code !== undefined ? `exit=${event.exit_code}` : "",
      ].filter(Boolean).join(" ");
      lines.push(`  +${offset}ms  ${event.event}${extra ? "  " + extra : ""}`);
    }
  }
  lines.push("\n----- JSONL -----");
  lines.push(timeline.toJsonl().trimEnd());
  console.log(lines.join("\n"));
}

function assertAttemptSettledAfterIo(timeline, { requireCancel = false } = {}) {
  const groups = timeline.byAttempt();
  assert.ok(groups.size > 0, "timeline must contain at least one attempt");
  let sawCancel = false;
  for (const [key, events] of groups) {
    const names = events.map((event) => event.event);
    const settledAt = names.lastIndexOf("CONTROLLER_SETTLED");
    assert.notEqual(settledAt, -1, `${key} must settle`);
    const terminalAt = names.indexOf("TERMINAL_PERSISTED");
    const cancelAt = names.indexOf("CANCEL_PERSISTED");
    const signalAt = names.indexOf("CANCEL_SIGNAL_SENT");
    const exitAt = names.indexOf("PROCESS_EXITED");
    const drainedAt = names.indexOf("OUTPUT_DRAINED");
    if (terminalAt !== -1) assert.ok(terminalAt < settledAt, `${key}: terminal must persist before settle`);
    if (cancelAt !== -1) {
      sawCancel = true;
      assert.ok(cancelAt < signalAt, `${key}: cancellation must persist before termination is requested`);
      assert.ok(signalAt < exitAt, `${key}: termination request must precede child close`);
      assert.ok(exitAt < drainedAt, `${key}: real process close must precede output drain`);
      assert.ok(drainedAt < settledAt, `${key}: output drain must precede settle`);
    }
    let openSaves = 0;
    let maxOpenSaves = 0;
    for (const event of events.slice(0, settledAt + 1)) {
      if (event.event === "STORE_SAVE_BEGIN") {
        openSaves += 1;
        maxOpenSaves = Math.max(maxOpenSaves, openSaves);
      } else if (event.event === "STORE_SAVE_END" || event.event === "STORE_SAVE_ERROR") {
        openSaves -= 1;
      }
    }
    assert.equal(openSaves, 0, `${key}: all saves must finish before settle`);
    assert.equal(maxOpenSaves, 1, `${key}: same-job store saves must be serialized`);
    assert.equal(events.slice(settledAt + 1).some((event) => event.event.startsWith("STORE_")), false,
      `${key}: no store writes may occur after settle`);
  }
  if (requireCancel) assert.equal(sawCancel, true, "cancel timeline must include a persisted cancellation");
}

async function waitTerminal(ws, id, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let status = null;
  while (Date.now() - startedAt < timeoutMs) {
    status = await jobStatusTool(ws, { job_id: id });
    if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "INTERRUPTED"].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return status;
}

test("并发两个任务的时间线", async () => {
  const { parent, ws, timeline } = await setup();
  try {
    const w = ws(true);
    const started = await Promise.all([0, 1].map((index) => startJobTool(w, {
      action: "execute_command",
      command: "node hello.mjs",
      cwd: ".",
      timeout_ms: 30_000,
      idempotency_key: `timeline-concurrent-${index}`,
    })));
    const finals = [];
    for (const item of started) finals.push(await waitTerminal(w, item.job_id));
    dump(timeline, "并发两个任务");
    assertAttemptSettledAfterIo(timeline);
    assert.equal(finals.length, 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("启动后取消的时间线", async () => {
  const { parent, ws, timeline } = await setup();
  try {
    const w = ws(true);
    const started = await startJobTool(w, {
      action: "execute_command",
      command: "node tick.mjs",
      cwd: ".",
      timeout_ms: 60_000,
    });
    // 等 RUNNING 且拿到 pid（事件屏障，不用固定 sleep 猜）
    const startedAt = Date.now();
    let status = null;
    while (Date.now() - startedAt < 10_000) {
      status = await jobStatusTool(w, { job_id: started.job_id });
      if (status.state === "RUNNING" && status.pid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await jobCancelTool(w, { job_id: started.job_id });
    await waitTerminal(w, started.job_id);
    dump(timeline, "启动后取消");
    assertAttemptSettledAfterIo(timeline, { requireCancel: true });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
