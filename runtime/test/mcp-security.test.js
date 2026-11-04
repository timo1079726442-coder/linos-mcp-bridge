import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { ExecutionRecordStore } from "../dist/execution-store.js";

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "c2c-mcp-security-"));
  const root = path.join(parent, "CODE");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "safe.txt"), "hello workspace\nAuthorization: Bearer abc123def456ghi789jkl012\n", "utf8");
  await writeFile(path.join(root, ".env"), "synthetic_secret=do-not-return\n", "utf8");
  return { root, cleanup: () => rm(parent, { recursive: true, force: true }) };
}

async function call(root, name, args = {}, executionStorePath = null) {
  return dispatchMcp(
    { method: "tools/call", params: { name, arguments: args } },
    "test-workspace",
    root,
    executionStorePath,
  );
}

test("workspace boundary rejects traversal and prefix collisions", async () => {
  const { root, cleanup } = await fixture();
  const outside = `${root}_BACKUP`;
  await mkdir(outside, { recursive: true });
  try {
    await assert.rejects(() => call(root, "read_file", { path: "../CODE_BACKUP/secret.txt" }), /path_outside_workspace/);
    await assert.rejects(() => call(root, "read_file", { path: outside }), /path_outside_workspace/);
    await assert.rejects(() => call(root, "read_file", { path: "missing/../outside.txt" }), /path_not_found|path_outside_workspace/);
  } finally {
    await cleanup();
  }
});

test("symlink escapes fail closed when the platform permits symlink creation", async () => {
  const { root, cleanup } = await fixture();
  const outside = path.join(path.dirname(root), "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
  try {
    try {
      await symlink(outside, path.join(root, "linked-outside"), "junction");
    } catch {
      return;
    }
    await assert.rejects(() => call(root, "read_file", { path: "linked-outside/secret.txt" }), /path_outside_workspace/);
  } finally {
    await cleanup();
  }
});

test("read and search redact output and deny sensitive files", async () => {
  const { root, cleanup } = await fixture();
  try {
    const read = await call(root, "read_file", { path: "safe.txt" });
    assert.equal(read.path, "safe.txt");
    assert.ok(read.lines.some((line) => line.includes("[REDACTED:bearer]")));
    await assert.rejects(() => call(root, "read_file", { path: ".env" }), /sensitive_path_denied/);
    const search = await call(root, "search_workspace", { query: "hello", limit: 10 });
    assert.equal(search.count, 1);
    assert.equal(search.matches[0].path, "safe.txt");
    const secretSearch = await call(root, "search_workspace", { query: "synthetic_secret", limit: 10 });
    assert.equal(secretSearch.count, 0);
  } finally {
    await cleanup();
  }
});

test("search_files and file_metadata respect workspace and sensitive-path boundaries", async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(path.join(root, "example-report.txt"), "public test only", "utf8");
    const tools = await dispatchMcp({ method: "tools/list" }, "test-workspace", root);
    assert.equal(tools.tools.some((tool) => tool.name === "search_files"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "file_metadata"), true);
    const found = await call(root, "search_files", { query: "report", limit: 20 });
    assert.equal(found.matches.some((item) => item.path === "example-report.txt"), true);
    const secret = await call(root, "search_files", { query: ".env" });
    assert.equal(secret.matches.length, 0);
    const metadata = await call(root, "file_metadata", { path: "example-report.txt" });
    assert.equal(metadata.type, "file");
    assert.equal(metadata.sizeBytes, Buffer.byteLength("public test only"));
    await assert.rejects(() => call(root, "file_metadata", { path: ".env" }), /sensitive_path_denied/);
    await assert.rejects(() => call(root, "file_metadata", { path: "../outside.txt" }), /path_outside_workspace/);
  } finally {
    await cleanup();
  }
});

test("file_sha256 and compare_files use bounded, non-sensitive workspace files", async () => {
  const { root, cleanup } = await fixture();
  try {
    await writeFile(path.join(root, "copy-a.txt"), "same fixture", "utf8");
    await writeFile(path.join(root, "copy-b.txt"), "same fixture", "utf8");
    await writeFile(path.join(root, "different.txt"), "different", "utf8");
    const listed = await dispatchMcp({ method: "tools/list" }, "test-workspace", root);
    assert.equal(listed.tools.some((tool) => tool.name === "file_sha256"), true);
    assert.equal(listed.tools.some((tool) => tool.name === "compare_files"), true);
    const one = await call(root, "file_sha256", { path: "copy-a.txt" });
    assert.equal(Buffer.from(one.sha256Base64, "base64").length, 32);
    assert.match(one.sha256Base64, /^[A-Za-z0-9+/]{43}=$/);
    const equal = await call(root, "compare_files", { left: "copy-a.txt", right: "copy-b.txt" });
    assert.equal(equal.identical, true);
    assert.equal(equal.left.sha256Base64, equal.right.sha256Base64);
    const unequal = await call(root, "compare_files", { left: "copy-a.txt", right: "different.txt" });
    assert.equal(unequal.identical, false);
    await assert.rejects(() => call(root, "file_sha256", { path: ".env" }), /sensitive_path_denied/);
    await assert.rejects(() => call(root, "compare_files", { left: "../outside.txt", right: "copy-b.txt" }), /path_outside_workspace/);
  } finally { await cleanup(); }
});

test("directory_tree lists bounded safe paths without revealing .env", async () => {
  const { root, cleanup } = await fixture();
  try {
    const tree = await call(root, "directory_tree", { max_depth: 2, max_entries: 20 });
    assert.equal(tree.entries.some((entry) => entry.path === "safe.txt"), true);
    assert.equal(tree.entries.some((entry) => entry.path === ".env"), false);
    assert.ok(tree.count <= 20);
    await assert.rejects(() => call(root, "directory_tree", { path: "../" }), /path_outside_workspace/);
  } finally { await cleanup(); }
});

test("git_status explicitly reports non-git workspace", async () => {
  const { root, cleanup } = await fixture();
  try {
    assert.deepEqual(await call(root, "git_status"), { isRepo: false });
  } finally {
    await cleanup();
  }
});

test("create_file / update_file 是真实工具，受 workspace.write 约束", async () => {
  const { root, cleanup } = await fixture();
  const caller = { clientId: "registered-client-1", requestId: "mcp-write-1" };
  const call = (body, options) => dispatchMcp(body, "test-workspace", root, null, { caller, ...options });
  try {
    await assert.rejects(() => call({
      method: "tools/call", params: { name: "create_file", arguments: { path: "new.txt", content: "synthetic" } },
    }, { writeScopeGranted: false }), /workspace.write/);

    const listed = await call({ method: "tools/list" }, { writeScopeGranted: true });
    assert.equal(listed.tools.some((tool) => tool.name === "create_file"), true);
    assert.equal(listed.tools.some((tool) => tool.name === "update_file"), true);

    const created = await call({
      method: "tools/call", params: { name: "create_file", arguments: { path: "new.txt", content: "synthetic" } },
    }, { writeScopeGranted: true });
    assert.equal(created.ok, true);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "synthetic");

    const updated = await call({
      method: "tools/call", params: { name: "update_file", arguments: { path: "safe.txt", content: "changed" } },
    }, { writeScopeGranted: true });
    assert.equal(updated.ok, true);
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "changed");
  } finally {
    await cleanup();
  }
});


test("execution tools read only registered Execution Store records", async () => {
  const { root, cleanup } = await fixture();
  const storePath = path.join(root, "execution-records");
  try {
    const store = new ExecutionRecordStore(storePath);
    await store.write({
      id: "exec_test_1",
      taskId: "task-test",
      iteration: 1,
      timestamp: new Date().toISOString(),
      changedFiles: ["safe.txt"],
      tests: [{ category: "unit", command: "npm test", passed: true, testCount: 3, failedCount: 0 }],
      status: "PASS",
      summary: "synthetic execution evidence",
      publicOutput: true,
      allowedOutput: "verified workspace_info and git_status",
    });
    const status = await call(root, "test_status", {}, storePath);
    assert.equal(status.available, true);
    assert.equal(status.status, "PASS");
    const summary = await call(root, "execution_summary", {}, storePath);
    assert.equal(summary.records[0].id, "exec_test_1");
    const output = await call(root, "execution_output", { id: "exec_test_1" }, storePath);
    assert.equal(output.output, "verified workspace_info and git_status");
    await assert.rejects(() => call(root, "execution_output", { id: "missing" }, storePath), /execution_output_not_registered/);
  } finally {
    await cleanup();
  }
});

