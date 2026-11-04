import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { McpSecurityBoundary } from "../dist/security-boundary.js";
import {
  applyPatchTool,
  createFileTool,
  deleteFileTool,
  listRoots,
  moveFileTool,
  updateFileTool,
  writeFileTool,
} from "../dist/fs-tools.js";

const WORKSPACE_ID = "ws_acl_test";

async function setup(rules = []) {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-grants-"));
  const workspace = path.join(parent, "ws");
  const outside = path.join(parent, "outside");
  const profile = path.join(parent, "profile");
  await mkdir(workspace);
  await mkdir(outside);
  await mkdir(profile);
  await writeFile(path.join(profile, "folder-acl.json"), JSON.stringify({
    schemaVersion: 2,
    profileId: "mb_pf_test",
    workspaceId: WORKSPACE_ID,
    workspaceRoot: workspace,
    revision: 1,
    rules,
  }), "utf8");
  const boundary = await McpSecurityBoundary.create(workspace, {
    aclPath: path.join(profile, "folder-acl.json"),
    workspaceId: WORKSPACE_ID,
    profileDir: profile,
  });
  return { parent, workspace, outside, profile, boundary };
}

test("ACL 授权目录可跨出工作区，读/写/扩展名按规则生效", async () => {
  const ctx = await setup([{
    id: "g1", path: "", permission: "write", label: "外部", extensions: [".md", ".txt"],
  }]);
  try {
    // 规则路径必须在 setup 后写入（需要 outside 的绝对路径）。
    await writeFile(path.join(ctx.profile, "folder-acl.json"), JSON.stringify({
      schemaVersion: 2, profileId: "mb_pf_test", workspaceId: WORKSPACE_ID,
      workspaceRoot: ctx.workspace, revision: 2,
      rules: [{ id: "g1", path: ctx.outside, permission: "write", label: "外部", extensions: [".md", ".txt"] }],
    }), "utf8");
    await ctx.boundary.refreshGrants(true);

    const roots = await listRoots(ctx.boundary);
    assert.equal(roots.count, 2);
    assert.equal(roots.roots[1].id, "g1");
    assert.equal(roots.roots[1].access, "read,write");

    const written = await writeFileTool(ctx.boundary, {
      path: path.join(ctx.outside, "note.md"), content: "hello\n",
    });
    assert.equal(written.ok, true);
    assert.equal(await readFile(path.join(ctx.outside, "note.md"), "utf8"), "hello\n");

    await assert.rejects(
      () => writeFileTool(ctx.boundary, { path: path.join(ctx.outside, "evil.exe"), content: "x" }),
      /acl_extension_denied/,
    );
    const read = await ctx.boundary.resolvePath(path.join(ctx.outside, "note.md"), "read");
    assert.equal(read.isPrimary, false);
    assert.equal(read.rootId, "g1");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("ACL none 规则收窄主工作区；未授权目录拒绝", async () => {
  const ctx = await setup();
  try {
    await writeFile(path.join(ctx.profile, "folder-acl.json"), JSON.stringify({
      schemaVersion: 2, profileId: "mb_pf_test", workspaceId: WORKSPACE_ID,
      workspaceRoot: ctx.workspace, revision: 2,
      rules: [{ id: "deny", path: path.join(ctx.workspace, "blocked"), permission: "none", label: "deny", extensions: null }],
    }), "utf8");
    await ctx.boundary.refreshGrants(true);
    await mkdir(path.join(ctx.workspace, "blocked"));
    await assert.rejects(() => writeFileTool(ctx.boundary, { path: "blocked/a.txt", content: "x" }), /acl_denied/);
    await assert.rejects(() => writeFileTool(ctx.boundary, { path: path.join(ctx.outside, "a.txt"), content: "x" }), /path_outside_workspace/);
    await writeFileTool(ctx.boundary, { path: "ok.txt", content: "x" });
    assert.equal((await stat(path.join(ctx.workspace, "ok.txt"))).isFile(), true);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("delete/move/apply_patch 走授权目录并保留备份与 SHA 校验", async () => {
  const ctx = await setup();
  try {
    await writeFile(path.join(ctx.profile, "folder-acl.json"), JSON.stringify({
      schemaVersion: 2, profileId: "mb_pf_test", workspaceId: WORKSPACE_ID,
      workspaceRoot: ctx.workspace, revision: 2,
      rules: [{ id: "g1", path: ctx.outside, permission: "write", label: "外部", extensions: null }],
    }), "utf8");
    await ctx.boundary.refreshGrants(true);

    const file = path.join(ctx.outside, "move.txt");
    await writeFile(file, "0123456789", "utf8");

    await assert.rejects(
      () => deleteFileTool(ctx.boundary, { path: file, expected_sha256: "deadbeef" }),
      /SHA256_MISMATCH/,
    );
    const deleted = await deleteFileTool(ctx.boundary, { path: file });
    assert.equal(deleted.ok, true);
    assert.equal(await stat(file).then(() => true).catch(() => false), false);
    assert.ok(deleted.backupPath && (await stat(deleted.backupPath)).isFile());

    const source = path.join(ctx.outside, "source.txt");
    await writeFile(source, "move me", "utf8");
    const moved = await moveFileTool(ctx.boundary, {
      source, destination: path.join(ctx.outside, "dest.txt"),
    });
    assert.equal(moved.ok, true);
    assert.equal(await readFile(path.join(ctx.outside, "dest.txt"), "utf8"), "move me");
    assert.ok(moved.backupPath);
    await assert.rejects(
      () => moveFileTool(ctx.boundary, { source: path.join(ctx.outside, "dest.txt"), destination: path.join(ctx.outside, "dest.txt") }),
      /DESTINATION_EXISTS/,
    );

    const patchTarget = path.join(ctx.outside, "patch.txt");
    await writeFile(patchTarget, "alpha beta gamma", "utf8");
    const patched = await applyPatchTool(ctx.boundary, {
      path: patchTarget, edits: [{ old_text: "beta", new_text: "BETA" }],
    });
    assert.equal(patched.applied, 1);
    assert.equal(await readFile(patchTarget, "utf8"), "alpha BETA gamma");
    await assert.rejects(
      () => applyPatchTool(ctx.boundary, { path: patchTarget, edits: [{ old_text: "a", new_text: "b" }] }),
      /EDIT_NOT_UNIQUE/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});


test("create_file / update_file 与 48765 对齐：拒绝已存在、SHA 校验、备份", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-create-"));
  try {
    const boundary = await McpSecurityBoundary.create(parent, { profileDir: parent });
    const created = await createFileTool(boundary, { path: "a.txt", content: "one" });
    assert.equal(created.created, true);
    await assert.rejects(() => createFileTool(boundary, { path: "a.txt", content: "two" }), /TARGET_EXISTS/);
    const overwritten = await createFileTool(boundary, { path: "a.txt", content: "two", overwrite: true });
    assert.equal(overwritten.created, false);
    assert.ok(overwritten.backupPath);

    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(Buffer.from("two", "utf8")).digest("hex");
    await assert.rejects(
      () => updateFileTool(boundary, { path: "a.txt", content: "three", expected_sha256: "deadbeef" }),
      /SHA256_MISMATCH/,
    );
    const updated = await updateFileTool(boundary, { path: "a.txt", content: "three", expected_sha256: sha });
    assert.equal(updated.previousSha256, sha);
    assert.equal(await readFile(path.join(parent, "a.txt"), "utf8"), "three");
    await assert.rejects(() => updateFileTool(boundary, { path: "missing.txt", content: "x" }), /path_not_found/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});


