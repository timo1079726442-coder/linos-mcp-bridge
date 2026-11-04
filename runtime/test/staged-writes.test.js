import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { __resetWriteOperationsForTest } from "../dist/write-operations.js";

const CALLER = Object.freeze({ clientId: "c2c_client_STAGED_TEST", requestId: 1 });
const WORKSPACE_ID = "ws_staged_test";

async function setup(overrides = {}, options = {}) {
  __resetWriteOperationsForTest();
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-staged-"));
  const root = path.join(parent, "workspace");
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(root);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({
    version: 1,
    tools: {
      commit_operation: { enabled: true, approval: "auto" },
      commit_operations: { enabled: true, approval: "auto" },
      ...overrides,
    },
  }), "utf8");
  return { parent, root, profile, ...options };
}

async function call(ctx, name, args, options = {}) {
  return dispatchMcp(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } },
    WORKSPACE_ID,
    ctx.root,
    path.join(ctx.profile, "executions"),
    {
      caller: CALLER,
      writeScopeGranted: true,
      toolPolicyDir: ctx.profile,
      ...options,
    },
  );
}

async function exists(file) {
  return stat(file).then(() => true).catch(() => false);
}

test("prepare_write 只暂存，commit 才落盘且读回复核", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "docs"));
    const prepared = await call(ctx, "prepare_write", {
      path: "docs/note.md", content: "hello\n", mode: "create",
    });
    assert.equal(prepared.status, "PENDING_LOCAL_APPROVAL");
    assert.equal(prepared.file_count, 1);
    assert.equal(prepared.added, 1);
    assert.match(prepared.operation_id, /^[0-9a-f]{32}$/);
    assert.match(prepared.files[0].after_sha256_b64, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(prepared.files[0].before_sha256_b64, null);
    assert.equal(await exists(path.join(ctx.root, "docs", "note.md")), false);

    const committed = await call(ctx, "commit_operation", { operation_id: prepared.operation_id });
    assert.equal(committed.status, "COMMITTED");
    assert.equal(committed.files_changed, 1);
    assert.equal(committed.readback_verified, true);
    assert.equal(committed.files[0].verified, true);
    assert.equal(committed.files[0].sha256_b64, prepared.files[0].after_sha256_b64);
    assert.equal(await readFile(path.join(ctx.root, "docs", "note.md"), "utf8"), "hello\n");

    await assert.rejects(
      () => call(ctx, "commit_operation", { operation_id: prepared.operation_id }),
      /OPERATION_NOT_FOUND/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("暂存后目标被改动时拒绝覆盖", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "src"));
    await writeFile(path.join(ctx.root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const prepared = await call(ctx, "prepare_write", {
      path: "src/a.ts", content: "export const a = 2;\n", mode: "overwrite",
    });
    await writeFile(path.join(ctx.root, "src", "a.ts"), "export const a = 99;\n", "utf8");
    await assert.rejects(
      () => call(ctx, "commit_operation", { operation_id: prepared.operation_id }),
      /VERSION_CHANGED/,
    );
    assert.equal(await readFile(path.join(ctx.root, "src", "a.ts"), "utf8"), "export const a = 99;\n");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("路径越界、隐藏文件、非文本扩展名都被拒绝", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "sub"));
    await assert.rejects(
      () => call(ctx, "prepare_write", { path: "../outside.md", content: "x", mode: "create" }),
      /PATH_INVALID/,
    );
    await assert.rejects(
      () => call(ctx, "prepare_write", { path: "sub/../../outside.md", content: "x", mode: "create" }),
      /PATH_INVALID/,
    );
    await assert.rejects(
      () => call(ctx, "prepare_write", { path: ".env", content: "x", mode: "create" }),
      /HIDDEN_TARGET_BLOCKED|SENSITIVE_PATH_DENIED/,
    );
    await assert.rejects(
      () => call(ctx, "prepare_write", { path: "sever.exe", content: "x", mode: "create" }),
      /FILE_TYPE_WRITE_BLOCKED/,
    );
    // 现在允许自动创建缺失父目录（Agent 写新目录下的文件需要），不再要求父目录预先存在。
    const created = await call(ctx, "prepare_write", { path: "nope/missing.md", content: "x", mode: "create" });
    assert.equal(created.status, "PENDING_LOCAL_APPROVAL");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("批量暂存拒绝重复目标，按顺序提交并逐笔报告", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "batch"));
    await assert.rejects(
      () => call(ctx, "batch_prepare_write", {
        files: [
          { path: "batch/a.md", content: "a", mode: "create" },
          { path: "batch/A.md", content: "b", mode: "create" },
        ],
      }),
      /DUPLICATE_TARGET/,
    );
    const first = await call(ctx, "batch_prepare_write", {
      files: [
        { path: "batch/a.md", content: "alpha\n", mode: "create" },
        { path: "batch/b.md", content: "beta\n", mode: "create" },
      ],
    });
    assert.equal(first.file_count, 2);
    const second = await call(ctx, "prepare_write", {
      path: "batch/c.md", content: "gamma\n", mode: "create",
    });
    await call(ctx, "cancel_pending_operation", { operation_id: second.operation_id });

    const result = await call(ctx, "commit_operations", {
      operation_ids: [first.operation_id, second.operation_id],
      continue_on_error: true,
    });
    assert.equal(result.status, "PARTIAL_OR_BLOCKED");
    assert.deepEqual(result.operations.map((entry) => entry.status), ["COMMITTED", "BLOCKED"]);
    assert.equal(result.files_changed, 2);
    assert.equal(await readFile(path.join(ctx.root, "batch", "a.md"), "utf8"), "alpha\n");
    assert.equal(await exists(path.join(ctx.root, "batch", "c.md")), false);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("batch_replace_text 要求唯一命中并生成可提交草稿", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "docs"));
    const file = path.join(ctx.root, "docs", "readme.md");
    await writeFile(file, "alpha beta alpha\n", "utf8");
    await assert.rejects(
      () => call(ctx, "batch_replace_text", { replacements: [{ path: "docs/readme.md", find: "alpha", replace: "x" }] }),
      /REPLACEMENT_NOT_UNIQUE/,
    );
    const prepared = await call(ctx, "batch_replace_text", {
      replacements: [{ path: "docs/readme.md", find: "beta", replace: "BETA" }],
    });
    assert.equal(await readFile(file, "utf8"), "alpha beta alpha\n");
    await call(ctx, "commit_operation", { operation_id: prepared.operation_id });
    assert.equal(await readFile(file, "utf8"), "alpha BETA alpha\n");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("项目骨架要求目录与 .brainn 已存在，提交后一次生成四个文件", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "proj"));
    await assert.rejects(
      () => call(ctx, "prepare_project_scaffold", { project_path: "proj", profile: "node" }),
      /SCAFFOLD_CREATE_BRAINN_DIR_FIRST/,
    );
    await mkdir(path.join(ctx.root, "proj", ".brainn"));
    const prepared = await call(ctx, "prepare_project_scaffold", { project_path: "proj", profile: "node" });
    assert.equal(prepared.file_count, 4);
    assert.equal(await exists(path.join(ctx.root, "proj", "PROJECT.md")), false);
    await call(ctx, "commit_operation", { operation_id: prepared.operation_id });
    for (const name of ["PROJECT.md", "LLM.md", "STATUS.md"]) {
      assert.equal(await exists(path.join(ctx.root, "proj", name)), true, name);
    }
    const meta = JSON.parse(await readFile(path.join(ctx.root, "proj", ".brainn", "project.json"), "utf8"));
    assert.equal(meta.profile, "node");
    assert.equal(meta.status, "DRAFT_NOT_APPROVED");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("待提交列表与取消只影响当前客户端草稿", async () => {
  const ctx = await setup();
  try {
    await mkdir(path.join(ctx.root, "tmp"));
    const prepared = await call(ctx, "prepare_write", {
      path: "tmp/x.md", content: "x\n", mode: "create",
    });
    const listed = await call(ctx, "list_pending_operations", {});
    assert.equal(listed.total_pending, 1);
    assert.equal(listed.operations[0].operation_id, prepared.operation_id);
    assert.equal(JSON.stringify(listed).includes("x\\n"), false);

    const cancelled = await call(ctx, "cancel_pending_operation", { operation_id: prepared.operation_id });
    assert.equal(cancelled.status, "CANCELLED");
    const after = await call(ctx, "list_pending_operations", {});
    assert.equal(after.total_pending, 0);
    await assert.rejects(
      () => call(ctx, "commit_operation", { operation_id: prepared.operation_id }),
      /OPERATION_NOT_FOUND/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("人工审批模式下本机通道不可用时失败关闭", async () => {
  const ctx = await setup({ commit_operation: { enabled: true, approval: "manual" } });
  try {
    await mkdir(path.join(ctx.root, "tmp"));
    const prepared = await call(ctx, "prepare_write", {
      path: "tmp/manual.md", content: "manual\n", mode: "create",
    });
    await assert.rejects(
      () => call(ctx, "commit_operation", { operation_id: prepared.operation_id }),
      /CONTROL_BRIDGE_UNAVAILABLE/,
    );
    assert.equal(await exists(path.join(ctx.root, "tmp", "manual.md")), false);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("执行写入必须带 workspace.write，策略关闭时拒绝", async () => {
  const ctx = await setup({ prepare_write: { enabled: false, approval: "auto" } });
  try {
    await assert.rejects(
      () => call(ctx, "prepare_write", { path: "x.md", content: "x", mode: "create" }, { writeScopeGranted: false }),
      /INSUFFICIENT_SCOPE/,
    );
    await assert.rejects(
      () => call(ctx, "prepare_write", { path: "x.md", content: "x", mode: "create" }),
      /TOOL_DISABLED/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("已认证客户端的 tools/list 包含暂存-提交工具", async () => {
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
    for (const name of [
      "prepare_write", "batch_prepare_write", "batch_replace_text", "prepare_project_scaffold",
      "list_pending_operations", "cancel_pending_operation", "commit_operation", "commit_operations",
    ]) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(listed.tools.length, 74);
    const commit = listed.tools.find((tool) => tool.name === "commit_operation");
    assert.deepEqual(commit.inputSchema.required, ["operation_id"]);
    assert.equal(commit.inputSchema.additionalProperties, false);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});







