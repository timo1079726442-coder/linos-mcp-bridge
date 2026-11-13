import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";

const WORKSPACE_ID = "ws_filters";
const CALLER = { clientId: "filters-client", requestId: "req-filters" };

const DAY_MS = 24 * 60 * 60 * 1000;

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-filters-"));
  const workspace = path.join(parent, "ws");
  const profile = path.join(parent, "profile");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "generated"), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(workspace, ".gitignore"), "generated/\n*.log\n", "utf8");
  await writeFile(path.join(workspace, "src", "fresh.js"), "export const fresh = 1;\n", "utf8");
  await writeFile(path.join(workspace, "src", "stale.js"), "export const stale = 1;\n", "utf8");
  await writeFile(path.join(workspace, "generated", "bundle.js"), "bundle\n", "utf8");
  await writeFile(path.join(workspace, "debug.log"), "log\n", "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {} }), "utf8");

  const now = Date.now();
  await utimes(path.join(workspace, "src", "fresh.js"), new Date(now), new Date(now));
  const old = new Date(now - 30 * DAY_MS);
  await utimes(path.join(workspace, "src", "stale.js"), old, old);
  await utimes(path.join(workspace, "generated", "bundle.js"), old, old);
  await utimes(path.join(workspace, "debug.log"), old, old);
  return { parent, workspace, profile };
}

function call(profile, workspace, name, args) {
  return dispatchMcp({ method: "tools/call", params: { name, arguments: args } }, WORKSPACE_ID, workspace, null, {
    toolPolicyDir: profile,
    caller: CALLER,
  });
}

test("project_snapshot: 默认按 .gitignore 过滤后再统计", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    const snapshot = await call(profile, workspace, "project_snapshot", { path: ".", max_depth: 3 });
    const tree = snapshot.tree;
    assert.ok(tree.includes("src/"));
    assert.ok(tree.includes("src/fresh.js"));
    assert.equal(tree.some((entry) => entry.startsWith("generated")), false, "generated/ 应被忽略");
    assert.equal(tree.some((entry) => entry.endsWith(".log")), false, "*.log 应被忽略");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("project_snapshot: use_gitignore=false 时仍可用 ignore 精确排除", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    const snapshot = await call(profile, workspace, "project_snapshot", {
      path: ".",
      max_depth: 3,
      use_gitignore: false,
      ignore: ["generated/"],
    });
    const tree = snapshot.tree;
    assert.ok(tree.includes("debug.log"), "关闭 gitignore 后 *.log 不再被排除");
    assert.equal(tree.some((entry) => entry.startsWith("generated")), false, "ignore 参数仍然生效");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("search_files: modified_after 只保留近期修改的文件", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const result = await call(profile, workspace, "search_files", {
      query: ".js",
      path: ".",
      modified_after: since,
    });
    const paths = result.matches.map((match) => match.path);
    assert.ok(paths.includes("src/fresh.js"));
    assert.equal(paths.includes("src/stale.js"), false, "30 天前的文件应被时间过滤");
    assert.ok(result.timeFiltered >= 1, "应报告被时间过滤掉的数量");
    const fresh = result.matches.find((match) => match.path === "src/fresh.js");
    assert.ok(typeof fresh.modifiedAt === "string", "命中的文件应带 modifiedAt");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("search_files: modified_before 只保留较早的文件", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    const before = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const result = await call(profile, workspace, "search_files", {
      query: "stale",
      path: ".",
      modified_before: before,
    });
    const paths = result.matches.map((match) => match.path);
    assert.deepEqual(paths, ["src/stale.js"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("search_files: 目录不受时间过滤影响，便于继续定位", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const result = await call(profile, workspace, "search_files", { query: "src", path: ".", modified_after: since });
    assert.equal(result.matches.some((match) => match.type === "directory" && match.path === "src"), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("search_files: 非法时间戳被拒绝", async () => {
  const { parent, workspace, profile } = await setup();
  try {
    await assert.rejects(
      () => call(profile, workspace, "search_files", { query: "a", modified_after: "not-a-date" }),
      /invalid_modified_after/,
    );
    await assert.rejects(
      () => call(profile, workspace, "search_files", { query: "a", modified_before: 12345 }),
      /invalid_modified_before/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------- 结构审计与清单也遵循同一套忽略规则 ----------

async function setupAudit() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-audit-ignore-"));
  const workspace = path.join(parent, "ws");
  const profile = path.join(parent, "profile");
  await mkdir(path.join(workspace, "generated"), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(workspace, ".gitignore"), "generated/\n", "utf8");
  await writeFile(path.join(workspace, "README.md"), "# demo\n", "utf8");
  // 只有在被忽略的目录里才存在测试文件：忽略生效时 Has tests 必须为 false。
  await writeFile(path.join(workspace, "generated", "a.test.js"), "test\n", "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {} }), "utf8");
  return { parent, workspace, profile };
}

test("audit_project_structure: 被忽略目录里的测试不再影响判定", async () => {
  const { parent, workspace, profile } = await setupAudit();
  try {
    const withIgnore = await call(profile, workspace, "audit_project_structure", { path: "." });
    const testsCheck = withIgnore.checks.find((entry) => entry.id === "tests");
    assert.equal(testsCheck.passed, false, "generated/ 被忽略后不应看到其中的测试");

    const withoutIgnore = await call(profile, workspace, "audit_project_structure", { path: ".", use_gitignore: false });
    const testsCheck2 = withoutIgnore.checks.find((entry) => entry.id === "tests");
    assert.equal(testsCheck2.passed, true, "关闭忽略后应能看到测试目录内容");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("generate_project_inventory: 清单跳过被忽略目录", async () => {
  const { parent, workspace, profile } = await setupAudit();
  try {
    const inventory = await call(profile, workspace, "generate_project_inventory", { path: "." });
    const paths = inventory.rows.map((row) => row.path);
    assert.ok(paths.includes("README.md"));
    assert.equal(paths.includes("generated"), false, "被忽略目录不应出现在清单里");

    const full = await call(profile, workspace, "generate_project_inventory", { path: ".", ignore: ["!generated/"] });
    assert.equal(full.rows.map((row) => row.path).includes("generated"), true, "! 反向包含应把它带回来");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
