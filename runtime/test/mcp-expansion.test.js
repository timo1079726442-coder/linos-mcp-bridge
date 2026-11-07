import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { parseCsvPreview } from "../dist/csv-preview.js";

function invoke(root, name, args = {}) {
  return dispatchMcp({ method: "tools/call", params: { name, arguments: args } }, "test-workspace", root);
}

test("CSV parser handles BOM, quoted commas, embedded line breaks and escaped quotes", () => {
  const parsed = parseCsvPreview('\uFEFF日期,搜索词,备注\r\n2026-10-15,"折扣,促销","两行\n描述"\r\n2026-10-16,"""测试""",正常\r\n', 2);
  assert.deepEqual(parsed.headers, ["日期", "搜索词", "备注"]);
  assert.deepEqual(parsed.rows, [["2026-10-15", "折扣,促销", "两行\n描述"], ["2026-10-16", '"测试"', "正常"]]);
  assert.equal(parsed.truncated, false);
});
test("CSV parser bounds previews and rejects malformed quotes", () => {
  const parsed = parseCsvPreview("字段\n1\n2\n3\n", 1);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.truncated, true);
  assert.throws(() => parseCsvPreview('name\n"unterminated'), /csv_unclosed_quote/);
  assert.throws(() => parseCsvPreview('name\ninvalid"quote'), /csv_invalid_quotes/);
});
test("CSV MCP tool only reads CSV files in the workspace", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-csv-preview-"));
  const root = path.join(parent, "workspace");
  await mkdir(root);
  try {
    await writeFile(path.join(root, "report.csv"), "\uFEFFdate,orders\r\n2026-10-15,12\r\n", "utf8");
    await writeFile(path.join(root, ".env"), "synthetic=[REDACTED]", "utf8");
    const listed = await dispatchMcp({ method: "tools/list" }, "test-workspace", root);
    for (const tool of ["csv_preview", "csv_schema_diff", "git_recent_commits", "git_changed_files", "git_local_branches", "test_inventory"]) {
      assert.ok(listed.tools.some((entry) => entry.name === tool), tool);
    }
    const preview = await invoke(root, "csv_preview", { path: "report.csv" });
    assert.deepEqual(preview.headers, ["date", "orders"]);
    assert.deepEqual(preview.rows, [["2026-10-15", "12"]]);
    await writeFile(path.join(root, "incoming.csv"), "date,orders,refunds\n2026-10-15,12,1\n", "utf8");
    const changes = await invoke(root, "csv_schema_diff", { left: "report.csv", right: "incoming.csv" });
    assert.equal(changes.requiresReview, true);
    assert.deepEqual(changes.addedColumns, ["refunds"]);
    assert.deepEqual(changes.removedColumns, []);
    const same = await invoke(root, "csv_schema_diff", { left: "report.csv", right: "report.csv" });
    assert.equal(same.sameOrder, true);
    assert.equal(same.requiresReview, false);
    await assert.rejects(() => invoke(root, "csv_schema_diff", { left: "../outside.csv", right: "report.csv" }), /path_outside_workspace/);
    await assert.rejects(() => invoke(root, "csv_preview", { path: "../report.csv" }), /path_outside_workspace/);
    await assert.rejects(() => invoke(root, "csv_preview", { path: ".env" }), /csv_extension_required/);
    const notRepo = await invoke(root, "git_recent_commits", {});
    assert.equal(notRepo.isRepo, false);
    assert.deepEqual(notRepo.records, []);
    assert.equal(notRepo._meta.auditState, "PENDING");
    const noBranches = await invoke(root, "git_local_branches", {});
    assert.equal(noBranches.isRepo, false);
    assert.deepEqual(noBranches.branches, []);
    assert.equal(noBranches._meta.auditState, "PENDING");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test", lint: "echo lint", secret_task: "never expose command" } }), "utf8");
    await writeFile(path.join(root, "check.test.js"), "test fixture", "utf8");
    const inventory = await invoke(root, "test_inventory", {});
    assert.ok(inventory.npmScriptNames.includes("test"));
    assert.ok(inventory.testFiles.includes("check.test.js"));
    assert.equal(inventory.execution, "NOT_EXECUTED");
    assert.equal(JSON.stringify(inventory).includes("never expose command"), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
test("Git tools read only from an isolated synthetic repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-git-tools-"));
  const git = (args) => execFileSync("git", args, { cwd: root, timeout: 10_000, windowsHide: true, stdio: "pipe" });
  try {
    git(["init", "-q"]);
    await writeFile(path.join(root, "tracked.txt"), "old\n", "utf8");
    git(["add", "tracked.txt"]);
    git(["-c", "user.name=C2C Test", "-c", "user.email=c2c@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "initial commit"]);
    await writeFile(path.join(root, "tracked.txt"), "new\n", "utf8");
    const localBranches = await invoke(root, "git_local_branches", { limit: 10 });
    assert.equal(localBranches.isRepo, true);
    assert.equal(localBranches.branches.includes(localBranches.activeBranch), true);
    const recent = await invoke(root, "git_recent_commits", { limit: 5 });
    assert.equal(recent.isRepo, true);
    assert.equal(recent.records.length, 1);
    assert.equal(recent.records[0].subject, "initial commit");
    const changed = await invoke(root, "git_changed_files", { scope: "unstaged" });
    assert.deepEqual(changed.paths, ["tracked.txt"]);
    const staged = await invoke(root, "git_changed_files", { scope: "staged" });
    assert.deepEqual(staged.paths, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
