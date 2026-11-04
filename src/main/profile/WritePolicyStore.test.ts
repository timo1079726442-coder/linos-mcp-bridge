import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_WRITE_POLICY, WritePolicyStore } from "./WritePolicyStore.js";

let stateRoot: string;
let store: WritePolicyStore;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-write-policy-"));
  store = new WritePolicyStore(stateRoot);
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

describe("WritePolicyStore", () => {
  it("defaults both capabilities off and with empty allowlists", async () => {
    const policy = await store.load();
    expect(policy.enabled).toBe(false);
    expect(policy.powershellEnabled).toBe(false);
    expect(policy.allowedDirectories).toEqual([]);
    expect(policy.allowedFiles).toEqual([]);
  });

  it("migrates a legacy policy without enabling PowerShell", async () => {
    await writeFile(store.policyFilePath(), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      allowedDirectories: [resolve("docs")],
      maxBytesPerWrite: 1024,
      maxAllowedDirectories: 50,
      updatedAt: new Date().toISOString(),
      updatedBy: "legacy-owner",
    }));

    const policy = await store.load();
    expect(policy.enabled).toBe(true);
    expect(policy.powershellEnabled).toBe(false);
    expect(policy.allowedDirectories).toEqual([resolve("docs")]);
    expect(policy.allowedFiles).toEqual([]);
  });

  it("persists separate file and PowerShell settings with workspace identity", async () => {
    const workspaceRoot = resolve("workspace-a");
    const { policy, changed } = await store.update({
      enabled: true,
      powershellEnabled: false,
      deviceId: "device-a",
      profileId: "profile-a",
      workspaceId: "workspace-a-id",
      workspaceRoot,
      allowedDirectories: [join(workspaceRoot, "src")],
      allowedFiles: [join(workspaceRoot, "README.md")],
    }, "owner");

    expect(changed).toBe(true);
    expect(policy.enabled).toBe(true);
    expect(policy.powershellEnabled).toBe(false);
    expect(policy.deviceId).toBe("device-a");
    expect(policy.profileId).toBe("profile-a");
    expect(policy.workspaceId).toBe("workspace-a-id");
    expect(policy.workspaceRoot).toBe(workspaceRoot);
    expect((await store.load()).allowedFiles).toEqual([join(workspaceRoot, "README.md")]);
  });

  it("allows a target in an allowed directory or exact-file list only when file writes are enabled", async () => {
    const workspaceRoot = resolve("workspace-b");
    const directory = join(workspaceRoot, "src");
    const exactFile = join(workspaceRoot, "notes.txt");
    await store.update({
      enabled: true,
      workspaceRoot,
      allowedDirectories: [directory],
      allowedFiles: [exactFile],
    }, "owner");

    expect(await store.checkPath(join(directory, "index.ts"))).toBeNull();
    expect(await store.checkPath(exactFile)).toBeNull();
    expect(await store.checkPath(join(workspaceRoot, "other.txt"))).toBe("WRITE_NOT_ALLOWED_FOR_PATH");

    await store.update({ enabled: false }, "owner");
    expect(await store.checkPath(exactFile)).toBe("WRITE_DISABLED");
  });

  it("enforces allowlist caps for directories and exact files", async () => {
    await writeFile(store.policyFilePath(), JSON.stringify({
      ...DEFAULT_WRITE_POLICY,
      maxAllowedDirectories: 1,
      maxAllowedFiles: 1,
    }));
    await store.addAllowedDirectory(resolve("one"), "owner");
    const directoryResult = await store.addAllowedDirectory(resolve("two"), "owner");
    expect(directoryResult.added).toBe(false);
    expect(directoryResult.reason).toBe("cap_exceeded");

    await store.addAllowedFile(resolve("one.txt"), "owner");
    const fileResult = await store.addAllowedFile(resolve("two.txt"), "owner");
    expect(fileResult.added).toBe(false);
    expect(fileResult.reason).toBe("cap_exceeded");
  });

  it("keeps the PowerShell toggle independent and bound to the configured workspace", async () => {
    const workspaceA = resolve("workspace-a");
    const workspaceB = resolve("workspace-b");
    await store.update({
      enabled: false,
      powershellEnabled: true,
      workspaceRoot: workspaceA,
    }, "owner");

    expect(await store.checkPowerShellEnabled(workspaceA)).toBe(true);
    expect(await store.checkPowerShellEnabled(workspaceB)).toBe(false);
    expect((await store.load()).enabled).toBe(false);
  });

  it("fails closed for malformed policy data", async () => {
    await writeFile(store.policyFilePath(), "{not-json");
    const policy = await store.load();
    expect(policy.enabled).toBe(false);
    expect(policy.powershellEnabled).toBe(false);
    expect(policy.allowedDirectories).toEqual([]);
    expect(policy.allowedFiles).toEqual([]);
    await expect(readFile(store.policyFilePath(), "utf8")).resolves.toBe("{not-json");
  });
});
