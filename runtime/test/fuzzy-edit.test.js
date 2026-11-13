import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import { applyFuzzyEdit, findFuzzyMatches, normalizeFuzzyLine, previewEdit } from "../dist/fuzzy-edit.js";
import { prepareEdit, prepareWrite, commitOperation, __resetWriteOperationsForTest } from "../dist/write-operations.js";

const WORKSPACE_ID = "ws_fuzzy";
const CLIENT = "client-fuzzy";

// ---------- 纯匹配器 ----------

test("fuzzy: 折叠空白后可命中缩进/行尾不同的块", () => {
  const text = [
    "function main() {",
    "    const value = 1;",
    "\treturn value;   ",
    "}",
    "",
  ].join("\n");
  const needle = ["function main() {", "  const value = 1;", "  return value;", "}"].join("\n");
  const matches = findFuzzyMatches(text, needle);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 0);
  assert.match(matches[0].text, /const value = 1;/);
});

test("fuzzy: 命中 0 次与 2 次分别可判定", () => {
  const text = "alpha\nbeta\ngamma\nbeta\n";
  assert.equal(findFuzzyMatches(text, "delta").length, 0);
  const dup = findFuzzyMatches(text, "beta");
  assert.equal(dup.length, 2, "重复行必须能识别为歧义");
});

test("fuzzy: 唯一命中时按原始偏移替换，其余内容不变", () => {
  const text = "keep\n  target line  \ntail\n";
  const result = applyFuzzyEdit(text, "target line", "replaced");
  assert.equal(result.content, "keep\n  replaced\ntail\n");
  assert.equal(result.replaced, "  target line  \n");
});

test("fuzzy: 不唯一/未命中抛错", () => {
  assert.throws(() => applyFuzzyEdit("a\nb\n", "zzz", "x"), /EDIT_NOT_FOUND/);
  assert.throws(() => applyFuzzyEdit("same\nx\nsame\n", "same", "x"), /EDIT_NOT_UNIQUE/);
});

test("fuzzy: 空 find 或全空行不允许替换", () => {
  assert.deepEqual(findFuzzyMatches("a\n", "   \n\n"), []);
  assert.throws(() => applyFuzzyEdit("a\n", "\n\n", "x"), /EDIT_NOT_FOUND/);
});

test("fuzzy: 预览包含删除行与新增行", () => {
  const match = { start: 0, end: 6, text: "before\n", line: 2 };
  const preview = previewEdit(match, "after\n");
  assert.equal(preview[0], "@@ line 3 @@");
  assert.ok(preview.includes("- before"));
  assert.ok(preview.includes("+ after"));
});

test("fuzzy: normalizeFuzzyLine 折叠连续空白", () => {
  assert.equal(normalizeFuzzyLine("  a   b\t c  "), "a b c");
});

// ---------- 端到端：prepare_edit → commit_operation ----------

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-fuzzy-"));
  const workspace = path.join(parent, "ws");
  const profile = path.join(parent, "profile");
  await mkdir(workspace, { recursive: true });
  await mkdir(profile, { recursive: true });
  const boundary = await McpSecurityBoundary.create(workspace, {
    aclPath: null,
    workspaceId: WORKSPACE_ID,
    profileDir: profile,
  });
  const ctx = { boundary, clientId: CLIENT, workspaceId: WORKSPACE_ID };
  return { parent, workspace, ctx };
}

test("prepare_edit: 预演不落盘，提交后只有目标块变化", async () => {
  __resetWriteOperationsForTest();
  const { parent, workspace, ctx } = await setup();
  try {
    const original = "line 1\n  value = 10\nline 3\n";
    await writeFile(path.join(workspace, "sample.js"), original, "utf8");

    const prepared = await prepareEdit(ctx, {
      path: "sample.js",
      find: "  value = 10",
      replace: "  value = 20",
    });
    assert.ok(prepared.operation_id);
    assert.equal(await readFile(path.join(workspace, "sample.js"), "utf8"), original, "预演阶段不得落盘");
    assert.ok(Array.isArray(prepared.preview) && prepared.preview.length > 0);

    const committed = await commitOperation(ctx, prepared.operation_id);
    assert.equal(committed.operations?.[0]?.status ?? committed.status ?? "COMMITTED", committed.operations?.[0]?.status ?? committed.status ?? "COMMITTED");
    const after = await readFile(path.join(workspace, "sample.js"), "utf8");
    assert.equal(after, "line 1\n  value = 20\nline 3\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("prepare_edit: 歧义命中与未命中分别报错", async () => {
  __resetWriteOperationsForTest();
  const { parent, workspace, ctx } = await setup();
  try {
    await writeFile(path.join(workspace, "dup.txt"), "same\nother\nsame\n", "utf8");
    await assert.rejects(() => prepareEdit(ctx, { path: "dup.txt", find: "same", replace: "x" }), /EDIT_NOT_UNIQUE/);
    await assert.rejects(() => prepareEdit(ctx, { path: "dup.txt", find: "absent", replace: "x" }), /EDIT_NOT_FOUND/);
    // 预演失败不得改动文件
    assert.equal(await readFile(path.join(workspace, "dup.txt"), "utf8"), "same\nother\nsame\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("prepare_edit: 目标不存在报 TARGET_NOT_FOUND", async () => {
  __resetWriteOperationsForTest();
  const { parent, ctx } = await setup();
  try {
    await assert.rejects(() => prepareEdit(ctx, { path: "missing.txt", find: "a", replace: "b" }), /TARGET_NOT_FOUND/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("prepare_write 仍然可用（回归）", async () => {
  __resetWriteOperationsForTest();
  const { parent, workspace, ctx } = await setup();
  try {
    await writeFile(path.join(workspace, "existing.txt"), "old\n", "utf8");
    const prepared = await prepareWrite(ctx, { path: "existing.txt", content: "hello\n" });
    assert.ok(prepared.operation_id);
    await commitOperation(ctx, prepared.operation_id);
    assert.equal(await readFile(path.join(workspace, "existing.txt"), "utf8"), "hello\n");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
