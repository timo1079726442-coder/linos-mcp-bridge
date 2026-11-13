import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseIgnoreRules, isIgnored } from "../dist/ignore-rules.js";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import { dispatchMcp } from "../dist/mcp-tools.js";

const WORKSPACE_ID = "ws_ignore";
const CALLER = { clientId: "ignore-client", requestId: "req-ignore" };

function ignored(rules, target, isDir = false) {
  return isIgnored(target, isDir, parseIgnoreRules(rules));
}

// ---------- 纯匹配器 ----------

test("ignore: 目录规则只作用于目录", () => {
  const rules = ["node_modules/"];
  assert.equal(ignored(rules, "node_modules", true), true);
  assert.equal(ignored(rules, "packages/a/node_modules", true), true);
  assert.equal(ignored(rules, "node_modules", false), false, "同名文件不受目录规则影响");
});

test("ignore: 不含斜杠的模式匹配任意层级", () => {
  const rules = ["*.log"];
  assert.equal(ignored(rules, "app.log"), true);
  assert.equal(ignored(rules, "logs/deep/app.log"), true);
  assert.equal(ignored(rules, "app.log.txt"), false);
});

test("ignore: 含斜杠的模式按锚定语义", () => {
  const rules = ["generated/**"];
  assert.equal(ignored(rules, "generated/bundle.js"), true);
  assert.equal(ignored(rules, "generated/a/b/c.js"), true);
  assert.equal(ignored(rules, "src/generated/bundle.js"), false);
});

test("ignore: 前导斜杠锚定根目录", () => {
  const rules = ["/build"];
  assert.equal(ignored(rules, "build", true), true);
  assert.equal(ignored(rules, "sub/build", true), false);
});

test("ignore: ! 反向包含，后匹配优先", () => {
  const rules = ["*.log", "!keep.log"];
  assert.equal(ignored(rules, "a.log"), true);
  assert.equal(ignored(rules, "keep.log"), false);
  // 顺序反过来则全部忽略
  assert.equal(ignored(["!keep.log", "*.log"], "keep.log"), true);
});

test("ignore: 注释与空行被忽略", () => {
  const rules = ["# comment", "", "   ", "*.tmp"];
  assert.equal(ignored(rules, "x.tmp"), true);
  assert.equal(ignored(rules, "# comment"), false);
});

test("ignore: ? 只匹配单个非斜杠字符", () => {
  const rules = ["file?.txt"];
  assert.equal(ignored(rules, "file1.txt"), true);
  assert.equal(ignored(rules, "file12.txt"), false);
});

// ---------- 集成：directory_tree ----------

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-ignore-"));
  const workspace = path.join(parent, "ws");
  const profile = path.join(parent, "profile");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(workspace, "logs"), { recursive: true });
  await mkdir(path.join(workspace, "generated"), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(workspace, "src", "index.js"), "export {};\n", "utf8");
  await writeFile(path.join(workspace, "node_modules", "pkg", "index.js"), "x\n", "utf8");
  await writeFile(path.join(workspace, "logs", "app.log"), "log\n", "utf8");
  await writeFile(path.join(workspace, "generated", "bundle.js"), "bundle\n", "utf8");
  await writeFile(path.join(workspace, "keep.md"), "# keep\n", "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {} }), "utf8");
  return { parent, workspace, profile };
}

function callTree(profile, root, args) {
  return dispatchMcp({ method: "tools/call", params: { name: "directory_tree", arguments: args } }, WORKSPACE_ID, root, null, {
    toolPolicyDir: profile,
    caller: CALLER,
  });
}

test("directory_tree: 默认按 .gitignore 过滤", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    await writeFile(path.join(workspace, ".gitignore"), "generated/\n*.log\n", "utf8");
    const tree = await callTree(profile, workspace, { max_depth: 3, max_entries: 100 });
    const paths = tree.entries.map((entry) => entry.path);
    assert.ok(paths.includes("keep.md"));
    assert.ok(paths.includes("src/index.js"));
    assert.equal(paths.some((entry) => entry.startsWith("generated")), false, ".gitignore 的 generated/ 应被过滤");
    assert.equal(paths.some((entry) => entry.endsWith(".log")), false, "*.log 应被过滤");
    assert.ok(tree.ignored >= 2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory_tree: use_gitignore=false 时不读取 .gitignore", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    await writeFile(path.join(workspace, ".gitignore"), "generated/\n", "utf8");
    const tree = await callTree(profile, workspace, { max_depth: 3, use_gitignore: false, ignore: ["*.md"] });
    const paths = tree.entries.map((entry) => entry.path);
    assert.equal(paths.some((entry) => entry.startsWith("generated")), true, "关闭后不应按 .gitignore 过滤");
    assert.equal(paths.includes("keep.md"), false, "ignore 参数仍然生效");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("directory_tree: 未命中忽略规则时保持原有输出字段", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    const tree = await callTree(profile, workspace, { max_depth: 2 });
    assert.ok(Array.isArray(tree.entries));
    assert.equal(typeof tree.count, "number");
    assert.equal(typeof tree.truncated, "boolean");
    assert.equal(tree.ignored, undefined, "没有忽略项时不返回 ignored 字段");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
