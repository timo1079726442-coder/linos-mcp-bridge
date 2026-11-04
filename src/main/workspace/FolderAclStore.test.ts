import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAclStore } from "./FolderAclStore.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "c2c-folder-acl-"));
  roots.push(root);
  return root;
}

function makeStore(root: string, workspaceId = "workspace-a") {
  const workspaceRoot = path.join(root, "workspace");
  return {
    workspaceRoot,
    store: new FolderAclStore({
      stateRoot: path.join(root, "state"),
      profileId: "profile-a",
      workspaceId,
      workspaceRoot,
      now: () => Date.UTC(2026, 0, 1),
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FolderAclStore", () => {
  it("allows the primary workspace by default and binds persisted ACL state to its Workspace", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    await mkdir(workspaceRoot);
    await expect(store.checkAccess(path.join(workspaceRoot, "file.ts"), "write")).resolves.toMatchObject({
      allowed: true,
      ruleId: "workspace",
    });
    await expect(store.checkAccess(path.join(root, "outside", "file.ts"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "NO_MATCH",
    });
    await store.add({ path: workspaceRoot, permission: "write" });

    const otherWorkspace = makeStore(root, "workspace-b").store;
    await expect(otherWorkspace.checkAccess(path.join(workspaceRoot, "file.ts"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "ACL_SCOPE_MISMATCH",
    });
  });

  it("enforces extension allowlists, including extensionless targets", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    await mkdir(workspaceRoot);
    await store.add({ path: workspaceRoot, permission: "write", extensions: [".ts"] });

    await expect(store.checkAccess(path.join(workspaceRoot, "new.ts"), "write")).resolves.toMatchObject({ allowed: true });
    await expect(store.checkAccess(path.join(workspaceRoot, "README"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "EXTENSION_NOT_ALLOWED",
    });
    await expect(store.checkAccess(path.join(workspaceRoot, "note.md"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "EXTENSION_NOT_ALLOWED",
    });
  });

  it("does not fall back to a parent grant when the most-specific extension policy rejects a file", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    const nested = path.join(workspaceRoot, "restricted");
    await mkdir(nested, { recursive: true });
    await store.add({ path: workspaceRoot, permission: "write" });
    await store.add({ path: nested, permission: "write", extensions: [".txt"] });

    await expect(store.checkAccess(path.join(nested, "allowed.txt"), "write")).resolves.toMatchObject({ allowed: true });
    await expect(store.checkAccess(path.join(nested, "blocked.exe"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "EXTENSION_NOT_ALLOWED",
    });
  });

  it("rejects duplicate canonical paths and keeps the existing narrower grant", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    await mkdir(workspaceRoot);
    await store.add({ path: workspaceRoot, permission: "read" });
    await expect(store.add({ path: workspaceRoot, permission: "write" })).rejects.toMatchObject({
      code: "ACL_DUPLICATE_RULE_PATH",
    });
    await expect(store.checkAccess(path.join(workspaceRoot, "file.txt"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "INSUFFICIENT_PERMISSION",
    });
  });

  it("honors the most-specific deny rule and redacts labels before persistence", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    const privateDir = path.join(workspaceRoot, "private");
    await mkdir(privateDir, { recursive: true });
    await store.add({ path: workspaceRoot, permission: "write", label: "General" });
    await store.add({ path: privateDir, permission: "none", label: "Authorization: Bearer redaction-sentinel" });

    await expect(store.checkAccess(path.join(privateDir, "file.ts"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "DENY_RULE",
    });
    const state = await readFile(path.join(root, "state", "profiles", "profile-a", "folder-acl.json"), "utf8");
    expect(state).not.toContain("redaction-sentinel");
  });

  it("does not lose concurrent ACL additions from separate store instances", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    const nested = path.join(workspaceRoot, "nested");
    await mkdir(nested, { recursive: true });
    const secondStore = makeStore(root).store;
    await Promise.all([
      store.add({ path: workspaceRoot, permission: "read", label: "Workspace" }),
      secondStore.add({ path: nested, permission: "write", label: "Nested" }),
    ]);

    await expect(store.list()).resolves.toHaveLength(2);
  });

  it("resolves a directory junction before matching rules", async () => {
    const root = await makeRoot();
    const { workspaceRoot, store } = makeStore(root);
    const outside = path.join(root, "outside");
    await mkdir(workspaceRoot);
    await mkdir(outside);
    const junction = path.join(workspaceRoot, "linked-outside");
    await symlink(outside, junction, "junction");
    await writeFile(path.join(outside, "escape.ts"), "safe fixture", "utf8");

    await expect(store.checkAccess(path.join(junction, "escape.ts"), "write")).resolves.toMatchObject({
      allowed: false,
      reason: "NO_MATCH",
    });
  });
});
