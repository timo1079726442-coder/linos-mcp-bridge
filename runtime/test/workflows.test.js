import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { __resetWorkflowsForTest } from "../dist/workflow-ledger.js";

const CALLER = Object.freeze({ clientId: "c2c_client_WORKFLOW_TEST", requestId: 11 });
const WORKSPACE_ID = "ws_workflow_test";

async function setup(policy = {}) {
  __resetWorkflowsForTest();
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-workflow-"));
  const root = path.join(parent, "workspace");
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(root);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({
    version: 1,
    tools: {
      workflow_commit: { enabled: true, approval: "auto" },
      ...policy,
    },
  }), "utf8");
  return { parent, root, profile };
}

async function call(ctx, name, args = {}, caller = CALLER) {
  return dispatchMcp(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
    WORKSPACE_ID,
    ctx.root,
    path.join(ctx.profile, "executions"),
    { caller, writeScopeGranted: true, toolPolicyDir: ctx.profile },
  );
}

test("工作流：准备 → 本机激活 → 记录进度 → 取消", async () => {
  const ctx = await setup();
  try {
    const prepared = await call(ctx, "workflow_prepare", {
      name: "只读巡检",
      goal: "检查项目结构并汇总测试状态",
      allowed_actions: ["workspace_info", "list_directory", "read_file", "git_status"],
      max_tool_calls: 5,
    });
    assert.equal(prepared.phase, "PREPARED");
    assert.equal(prepared.local_owner_approval_required, true);
    assert.match(prepared.workflow_id, /^[0-9a-f]{32}$/);
    assert.equal(prepared.remaining_tool_calls, 5);
    assert.equal(prepared.access_granted_by_workflow, false);

    await assert.rejects(
      () => call(ctx, "workflow_continue", {
        workflow_id: prepared.workflow_id,
        step_summary: "先看结构",
        tool_calls_used: 1,
        next_action: "list_directory",
      }),
      /WORKFLOW_NOT_ACTIVE/,
    );

    const active = await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });
    assert.equal(active.phase, "ACTIVE");
    assert.equal(active.local_owner_approved, true);
    assert.equal(active.permission_granted, false);

    const idempotent = await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });
    assert.equal(idempotent.phase, "ACTIVE");

    const step = await call(ctx, "workflow_continue", {
      workflow_id: prepared.workflow_id,
      step_summary: "读取目录与 git 状态",
      tool_calls_used: 2,
      next_action: "git_status",
    });
    assert.equal(step.tool_calls_used, 2);
    assert.equal(step.remaining_tool_calls, 3);
    assert.equal(step.last_event, "PROGRESS_RECORDED");
    assert.equal(step.steps.length, 1);

    const status = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id, include_events: true });
    assert.equal(status.phase, "ACTIVE");
    assert.equal(status.steps.length, 1);

    const cancelled = await call(ctx, "workflow_cancel", { workflow_id: prepared.workflow_id });
    assert.equal(cancelled.phase, "CANCELLED");
    const afterCancel = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id });
    assert.equal(afterCancel.phase, "CANCELLED");
    await assert.rejects(
      () => call(ctx, "workflow_continue", {
        workflow_id: prepared.workflow_id,
        step_summary: "取消后继续",
        next_action: "read_file",
      }),
      /WORKFLOW_NOT_ACTIVE/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("工作流：预算、动作范围与明文凭据都被拒绝", async () => {
  const ctx = await setup();
  try {
    const prepared = await call(ctx, "workflow_prepare", {
      name: "预算测试",
      goal: "验证预算与范围",
      allowed_actions: ["read_file"],
      max_tool_calls: 2,
    });
    await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });

    await assert.rejects(
      () => call(ctx, "workflow_continue", {
        workflow_id: prepared.workflow_id,
        step_summary: "越界动作",
        tool_calls_used: 1,
        next_action: "list_directory",
      }),
      /WORKFLOW_SCOPE_DENIED/,
    );
    await assert.rejects(
      () => call(ctx, "workflow_continue", {
        workflow_id: prepared.workflow_id,
        step_summary: "写入不允许",
        tool_calls_used: 1,
        file_writes_used: 1,
        next_action: "read_file",
      }),
      /UNSAFE_WORKFLOW_SCOPE/,
    );
    await assert.rejects(
      () => call(ctx, "workflow_continue", {
        workflow_id: prepared.workflow_id,
        step_summary: "password=abc123",
        tool_calls_used: 1,
        next_action: "read_file",
      }),
      /UNSAFE_WORKFLOW_NOTES/,
    );
    await assert.rejects(
      () => call(ctx, "workflow_continue", {
        workflow_id: prepared.workflow_id,
        step_summary: "一次用光",
        tool_calls_used: 3,
        next_action: "read_file",
      }),
      /WORKFLOW_BUDGET_EXCEEDED/,
    );
    const status = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id });
    assert.equal(status.phase, "STOPPED");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("工作流：stop_on_error 生效且跨客户端不可见", async () => {
  const ctx = await setup();
  try {
    const prepared = await call(ctx, "workflow_prepare", {
      name: "错误停止",
      goal: "验证出错停止",
      max_tool_calls: 4,
    });
    await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });
    const stopped = await call(ctx, "workflow_continue", {
      workflow_id: prepared.workflow_id,
      step_summary: "读取失败",
      tool_calls_used: 1,
      observed_error: "not_found",
      next_action: "read_file",
    });
    assert.equal(stopped.phase, "STOPPED");

    const other = Object.freeze({ clientId: "c2c_client_OTHER", requestId: 12 });
    await assert.rejects(
      () => call(ctx, "workflow_status", { workflow_id: prepared.workflow_id }, other),
      /WORKFLOW_NOT_FOUND/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("工作流：人工审批模式下本机通道不可用时失败关闭", async () => {
  const ctx = await setup({ workflow_commit: { enabled: true, approval: "manual" } });
  try {
    const prepared = await call(ctx, "workflow_prepare", { name: "需本机确认", goal: "验证审批门" });
    await assert.rejects(
      () => call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id }),
      /CONTROL_BRIDGE_UNAVAILABLE/,
    );
    const status = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id });
    assert.equal(status.phase, "PREPARED");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("workflow_run_step 真正执行只读动作并消耗预算", async () => {
  const ctx = await setup();
  try {
    await writeFile(path.join(ctx.root, "note.md"), "# hi\n", "utf8");
    const prepared = await call(ctx, "workflow_prepare", {
      name: "执行步骤",
      goal: "列出目录并读取文件",
      allowed_actions: ["list_directory", "read_file"],
      max_tool_calls: 3,
    });
    await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });

    const listed = await call(ctx, "workflow_run_step", {
      workflow_id: prepared.workflow_id,
      action: "list_directory",
      arguments: { path: "." },
    });
    assert.equal(listed.step.action, "list_directory");
    assert.equal(listed.step.step_number, 1);
    assert.ok(Array.isArray(listed.step.result.entries));
    assert.equal(listed.tool_calls_used, 1);
    assert.equal(listed.last_event, "STEP_EXECUTED");

    const read = await call(ctx, "workflow_run_step", {
      workflow_id: prepared.workflow_id,
      action: "read_file",
      arguments: { path: "note.md" },
    });
    assert.equal(read.step.step_number, 2);
    assert.match((read.step.result.lines || []).join("\n"), /# hi/);
    assert.equal(read.remaining_tool_calls, 1);

    const status = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id, include_events: true });
    assert.equal(status.steps.length, 2);
    assert.deepEqual(status.steps.map((step) => step.action), ["list_directory", "read_file"]);
    assert.deepEqual(status.steps.map((step) => step.ok), [true, true]);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("workflow_run_step 拒绝计划外/不可执行/已关闭的动作", async () => {
  const ctx = await setup({ read_file: { enabled: false, approval: "auto" } });
  try {
    const prepared = await call(ctx, "workflow_prepare", {
      name: "范围检查",
      goal: "验证步骤范围",
      allowed_actions: ["list_directory", "read_file"],
      max_tool_calls: 5,
    });
    await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });

    await assert.rejects(
      () => call(ctx, "workflow_run_step", { workflow_id: prepared.workflow_id, action: "workspace_info" }),
      /WORKFLOW_SCOPE_DENIED/,
    );
    await assert.rejects(
      () => call(ctx, "workflow_run_step", { workflow_id: prepared.workflow_id, action: "commit_operation" }),
      /WORKFLOW_ACTION_NOT_EXECUTABLE/,
    );
    await assert.rejects(
      () => call(ctx, "workflow_run_step", {
        workflow_id: prepared.workflow_id, action: "read_file", arguments: { path: "note.md" },
      }),
      /TOOL_DISABLED/,
    );
    const status = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id });
    assert.equal(status.phase, "ACTIVE");
    assert.equal(status.tool_calls_used, 0);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("workflow_run_step 失败按 stop_on_error 停止，且不再执行", async () => {
  const ctx = await setup();
  try {
    const prepared = await call(ctx, "workflow_prepare", {
      name: "失败停止",
      goal: "验证失败停止",
      allowed_actions: ["read_file"],
      max_tool_calls: 2,
    });
    await call(ctx, "workflow_commit", { workflow_id: prepared.workflow_id });

    await assert.rejects(
      () => call(ctx, "workflow_run_step", {
        workflow_id: prepared.workflow_id, action: "read_file", arguments: { path: "missing.md" },
      }),
      /path_not_found/,
    );
    const stopped = await call(ctx, "workflow_status", { workflow_id: prepared.workflow_id });
    assert.equal(stopped.phase, "STOPPED");
    assert.equal(stopped.tool_calls_used, 1);
    assert.equal(stopped.last_event, "STEP_FAILED");

    await assert.rejects(
      () => call(ctx, "workflow_run_step", {
        workflow_id: prepared.workflow_id, action: "read_file", arguments: { path: "x.md" },
      }),
      /WORKFLOW_NOT_ACTIVE/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("已认证客户端的 tools/list 包含 6 个工作流工具", async () => {
  const ctx = await setup();
  try {
    const listed = await dispatchMcp(
      { method: "tools/list", params: {} },
      WORKSPACE_ID,
      ctx.root,
      path.join(ctx.profile, "executions"),
      { caller: CALLER, toolPolicyDir: ctx.profile },
    );
    const names = listed.tools.map((tool) => tool.name);
    for (const name of ["workflow_prepare", "workflow_commit", "workflow_status", "workflow_continue", "workflow_cancel", "workflow_run_step"]) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(listed.tools.length, 75);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});









