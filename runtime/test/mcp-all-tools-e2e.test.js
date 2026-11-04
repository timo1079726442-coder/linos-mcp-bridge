import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { ExecutionRecordStore } from "../dist/execution-store.js";
import {
  ExecutionStoreProducer,
  RUNTIME_READY_PUBLIC_OUTPUT,
  RUNTIME_READY_RECORD_ID,
} from "../dist/execution-producer.js";

const execFileAsync = promisify(execFile);

async function call(root, name, args = {}, executionStorePath = null) {
  return dispatchMcp(
    { method: "tools/call", params: { name, arguments: args } },
    "e2e-workspace",
    root,
    executionStorePath,
  );
}

async function git(root, args) {
  return execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("MCP tools/list and all 34 read-only/dry-run tools execute through the real dispatch path", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "c2c-mcp-all-tools-"));
  const root = path.join(parent, "workspace");
  const storePath = path.join(parent, "execution-records");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "README.md"), "MCP E2E baseline\n", "utf8");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { shadcn: "4.0.0", "lucide-react": "0.1.0" } }), "utf8");
    await writeFile(path.join(root, "components.json"), JSON.stringify({ style: "new-york", rsc: false, tsx: true, aliases: { ui: "@/components/ui" }, tailwind: {} }), "utf8");
    await mkdir(path.join(root, "src", "components", "ui"), { recursive: true });
    await writeFile(path.join(root, "src", "components", "ui", "button.tsx"), "export const Button = () => null;\n", "utf8");
    await mkdir(path.join(root, "artifacts"), { recursive: true });
    await writeFile(path.join(root, "artifacts", "DIAGNOSTIC_REPORT.md"), "# Diagnostic\nMCP E2E report\n", "utf8");
    await mkdir(path.join(root, "build"), { recursive: true });
    await writeFile(path.join(root, "build", "old-result.txt"), "generated\n", "utf8");
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "c2c-e2e@example.invalid"]);
    await git(root, ["config", "user.name", "C2C E2E"]);
    await git(root, ["add", "README.md"]);
    await git(root, ["commit", "-m", "e2e baseline"]);
    await writeFile(path.join(root, "README.md"), "MCP E2E changed\n", "utf8");
    await writeFile(path.join(root, "sample.csv"), "date,orders\n2026-10-15,2\n", "utf8");
    await writeFile(path.join(root, "another.csv"), "date,orders,new_col\n2026-10-15,2,ok\n", "utf8");

    const store = new ExecutionRecordStore(storePath);
    const producer = new ExecutionStoreProducer(store);
    const produced = await producer.publishRuntimeReady({
      expectedPort: 48766,
      boundPort: 48766,
      workspaceExists: true,
      workspaceId: "e2e-workspace",
    });
    assert.equal(produced?.id, RUNTIME_READY_RECORD_ID);

    const listed = await dispatchMcp({ method: "tools/list", params: {} }, "e2e-workspace", root, storePath);
    assert.equal(listed.tools.length, 34);
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      "workspace_info",
      "list_directory",
      "read_file",
      "search_workspace",
      "search_files",
      "file_metadata",
      "directory_tree",
      "file_sha256",
      "compare_files",
      "csv_preview",
      "csv_schema_diff",
      "batch_read_files",
      "batch_file_status",
      "prepare_batch_write_plan",
      "project_snapshot",
      "batch_search_patterns",
      "audit_project_structure",
      "generate_project_inventory",
      "detect_archive_candidates",
      "list_artifacts",
      "read_latest_report",
      "shadcn_info",
      "shadcn_local_components",
      "git_status",
      "git_diff",
      "git_recent_commits",
      "git_changed_files",
      "git_local_branches",
      "test_inventory",
      "test_status",
      "execution_summary",
      "execution_output",
      "mcp_self_check",
      "capability_manifest",
    ]);
    for (const tool of listed.tools) {
      assert.deepEqual(tool.inputSchema.type, "object");
      assert.deepEqual(tool.inputSchema.additionalProperties, false);
    }
    assert.deepEqual(listed.tools.find((tool) => tool.name === "workspace_info").inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });

    const workspace = await call(root, "workspace_info", {}, storePath);
    assert.equal(workspace.workspaceId, "e2e-workspace");
    assert.equal(workspace.isGitRepo, true);

    const directory = await call(root, "list_directory", { path: "." }, storePath);
    assert.ok(directory.entries.some((entry) => entry.name === "README.md"));

    const file = await call(root, "read_file", { path: "README.md" }, storePath);
    assert.ok(file.lines.some((line) => line.includes("MCP E2E changed")));

    const search = await call(root, "search_workspace", { query: "MCP E2E changed" }, storePath);
    assert.equal(search.count, 1);
    assert.equal(search.matches[0].path, "README.md");

    const byName = await call(root, "search_files", { query: "README" }, storePath);
    assert.equal(byName.matches.some((item) => item.path === "README.md"), true);
    const metadata = await call(root, "file_metadata", { path: "README.md" }, storePath);
    assert.equal(metadata.type, "file");
    const tree = await call(root, "directory_tree", { max_depth: 2 }, storePath);
    assert.equal(tree.entries.some((entry) => entry.path === "README.md"), true);
    const fingerprint = await call(root, "file_sha256", { path: "README.md" }, storePath);
    assert.equal(Buffer.from(fingerprint.sha256Base64, "base64").length, 32);
    assert.match(fingerprint.sha256Base64, /^[A-Za-z0-9+/]{43}=$/);
    const equal = await call(root, "compare_files", { left: "README.md", right: "README.md" }, storePath);
    assert.equal(equal.identical, true);
    const csv = await call(root, "csv_preview", { path: "sample.csv" }, storePath);
    assert.deepEqual(csv.headers, ["date", "orders"]);
    const csvSchema = await call(root, "csv_schema_diff", { left: "sample.csv", right: "another.csv" }, storePath);
    assert.deepEqual(csvSchema.addedColumns, ["new_col"]);

    const batchRead = await call(root, "batch_read_files", { paths: ["README.md"] }, storePath);
    assert.equal(batchRead.count, 1);
    assert.equal(batchRead.files[0].ok, true);
    assert.match(batchRead.files[0].text, /MCP E2E changed/);

    const batchStatus = await call(root, "batch_file_status", { paths: ["README.md", "missing.txt"] }, storePath);
    assert.equal(batchStatus.count, 2);
    assert.equal(batchStatus.items[0].exists, true);
    assert.equal(batchStatus.items[1].exists, false);

    const writePlan = await call(root, "prepare_batch_write_plan", { writes: [
      { path: "README.md", content: "MCP E2E changed\n" },
      { path: "new-file.txt", content: "new content\n" },
    ] }, storePath);
    assert.equal(writePlan.mutationPerformed, false);
    assert.equal(writePlan.itemCount, 2);
    assert.equal(writePlan.items[0].operation, "UPDATE");
    assert.equal(writePlan.items[0].noOp, true);
    assert.equal(writePlan.items[1].operation, "CREATE");
    assert.equal(writePlan.approvalProtocolReady, false);

    const snapshot = await call(root, "project_snapshot", { max_depth: 2, max_files: 100 }, storePath);
    assert.ok(snapshot.tree.includes("README.md"));
    assert.equal(snapshot.fileCount >= 1, true);

    const patternSearch = await call(root, "batch_search_patterns", { patterns: ["MCP E2E", "not-present"] }, storePath);
    assert.equal(patternSearch.groups[0].count >= 1, true);
    assert.equal(patternSearch.groups[1].count, 0);

    const audit = await call(root, "audit_project_structure", {}, storePath);
    assert.equal(Array.isArray(audit.checks), true);
    assert.deepEqual(audit.packageMarkers, ["package.json"]);

    const inventory = await call(root, "generate_project_inventory", {}, storePath);
    assert.equal(inventory.rows.some((row) => row.path === "README.md"), true);

    const archiveCandidates = await call(root, "detect_archive_candidates", {}, storePath);
    assert.equal(archiveCandidates.destructiveActionPerformed, false);
    assert.equal(archiveCandidates.candidates.some((item) => item.path === "build"), true);

    const artifacts = await call(root, "list_artifacts", {}, storePath);
    assert.equal(artifacts.artifacts.some((item) => item.path === "artifacts/DIAGNOSTIC_REPORT.md"), true);

    const latestReport = await call(root, "read_latest_report", { filename_contains: "diagnostic" }, storePath);
    assert.equal(latestReport.available, true);
    assert.match(latestReport.text, /MCP E2E report/);

    const selfCheck = await call(root, "mcp_self_check", {}, storePath);
    assert.equal(selfCheck.ok, true);
    assert.equal(selfCheck.toolRegistry.readOnlyToolCount, 34);
    assert.equal(selfCheck.toolRegistry.stagedWriteTools.includes("commit_operation"), true);
    assert.equal(selfCheck.authorization.directFilesystemWriterExposed, true);

    const manifest = await call(root, "capability_manifest", {}, storePath);
    assert.equal(manifest.runtimeTools.length, 34);
    assert.equal(manifest.localDesktopOnly.some((item) => item.name === "screen_window_capture_and_annotation"), true);
    assert.equal(manifest.conditional.some((item) => item.name === "commit_operation"), true);
    assert.equal(manifest.intentionallyUnavailable.some((item) => item.name === "atomic_cross_file_transaction"), true);

    const shadcnInfo = await call(root, "shadcn_info", {}, storePath);
    assert.equal(shadcnInfo.configured, true);
    assert.equal(shadcnInfo.localCliDependencyPresent, true);
    assert.equal(shadcnInfo.executionPolicy.externalCliExecuted, false);

    const localComponents = await call(root, "shadcn_local_components", {}, storePath);
    assert.equal(localComponents.componentCount, 1);
    assert.equal(localComponents.registrySearchExecuted, false);

    const status = await call(root, "git_status", {}, storePath);
    assert.equal(status.isRepo, true);
    assert.equal(status.dirty, true);

    const diff = await call(root, "git_diff", { scope: "unstaged", max_bytes: 100_000 }, storePath);
    assert.equal(diff.isRepo, true);
    assert.match(diff.diff, /MCP E2E changed/);

    const commits = await call(root, "git_recent_commits", { limit: 5 }, storePath);
    assert.equal(commits.isRepo, true);
    assert.equal(commits.records.length >= 1, true);
    const changed = await call(root, "git_changed_files", {}, storePath);
    assert.equal(changed.paths.includes("README.md"), true);
    const branches = await call(root, "git_local_branches", {}, storePath);
    assert.equal(branches.branches.includes(branches.activeBranch), true);
    const testInventory = await call(root, "test_inventory", {}, storePath);
    assert.equal(testInventory.execution, "NOT_EXECUTED");

    const testStatus = await call(root, "test_status", {}, storePath);
    assert.equal(testStatus.status, "PASS");

    const summary = await call(root, "execution_summary", { limit: 1 }, storePath);
    assert.equal(summary.records[0].id, RUNTIME_READY_RECORD_ID);
    assert.equal(summary.records[0].publicOutput, true);

    const output = await call(root, "execution_output", { id: RUNTIME_READY_RECORD_ID }, storePath);
    assert.equal(output.output, RUNTIME_READY_PUBLIC_OUTPUT);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
