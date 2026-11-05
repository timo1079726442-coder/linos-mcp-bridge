import { describe, it, expect } from "vitest";
import { RuntimeResolver } from "./RuntimeResolver.js";

describe("RuntimeResolver (FOUNDER OPTION_A_PLUS §7)", () => {
  it("PACKAGED_V2 without bundle dir throws", async () => {
    delete process.env.C2C_RUNTIME_BUNDLE_DIR;
    delete process.env.C2C_RUNTIME_ENTRY;
    const r = new RuntimeResolver();
    await expect(
      r.resolve({ profileSource: "PACKAGED_V2", workspaceRoot: "C:\workspace" }),
    ).rejects.toThrow(/RUNTIME_NOT_FOUND/);
  });

  it("EXTERNAL_DEV without env var throws", async () => {
    delete process.env.C2C_RUNTIME_EXTERNAL_DIR;
    const r = new RuntimeResolver();
    await expect(
      r.resolve({ profileSource: "EXTERNAL_DEV", workspaceRoot: "C:\workspace" }),
    ).rejects.toThrow(/EXTERNAL_DEV requires C2C_RUNTIME_EXTERNAL_DIR/);
  });

  it("LEGACY_MIGRATION without env gate throws", async () => {
    delete process.env.LEGACY_MIGRATION_MODE;
    delete process.env.C2C_LEGACY_RUNTIME_DIR;
    const r = new RuntimeResolver();
    await expect(
      r.resolve({ profileSource: "LEGACY_MIGRATION", workspaceRoot: "C:\workspace" }),
    ).rejects.toThrow(/LEGACY_MIGRATION_MODE not enabled/);
  });

  it("LEGACY_MIGRATION with gate but no dir throws", async () => {
    process.env.LEGACY_MIGRATION_MODE = "true";
    delete process.env.C2C_LEGACY_RUNTIME_DIR;
    const r = new RuntimeResolver();
    await expect(
      r.resolve({ profileSource: "LEGACY_MIGRATION", workspaceRoot: "C:\workspace" }),
    ).rejects.toThrow(/C2C_LEGACY_RUNTIME_DIR/);
  });

  it("PACKAGED_V2 with explicit C2C_RUNTIME_BUNDLE_DIR resolves when file exists", async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "c2c-rt-"));
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "main.js"), "// stub");
    process.env.C2C_RUNTIME_BUNDLE_DIR = dir;
    delete process.env.C2C_RUNTIME_ENTRY;
    try {
      const r = new RuntimeResolver();
      const res = await r.resolve({ profileSource: "PACKAGED_V2", workspaceRoot: "C:\workspace" });
      expect(res.source).toBe("PACKAGED_V2");
      expect(res.entryPath).toBe(join(dir, "dist", "main.js"));
      await r.validate(res);
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.C2C_RUNTIME_BUNDLE_DIR;
    }
  });

  it("PACKAGED_V2 with explicit C2C_RUNTIME_ENTRY resolves when file exists", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "c2c-rt-entry-"));
    const entry = join(dir, "main.js");
    await writeFile(entry, "// stub");
    process.env.C2C_RUNTIME_ENTRY = entry;
    delete process.env.C2C_RUNTIME_BUNDLE_DIR;
    try {
      const r = new RuntimeResolver();
      const res = await r.resolve({ profileSource: "PACKAGED_V2", workspaceRoot: "C:\workspace" });
      expect(res.entryPath).toBe(entry);
      await r.validate(res);
    } finally {
      await rm(dir, { recursive: true, force: true });
      delete process.env.C2C_RUNTIME_ENTRY;
    }
  });

  it("打包运行时忽略宿主继承的 C2C_RUNTIME_ENTRY（防旧安装污染）", async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const appRoot = await mkdtemp(join(tmpdir(), "c2c-app-"));
    const foreign = await mkdtemp(join(tmpdir(), "c2c-old-"));
    const bundledDir = join(appRoot, "resources", "app", "runtime", "dist");
    await mkdir(bundledDir, { recursive: true });
    await writeFile(join(bundledDir, "main.js"), "// bundled");
    const foreignEntry = join(foreign, "main.js");
    await writeFile(foreignEntry, "// old install");
    process.env.C2C_RUNTIME_ENTRY = foreignEntry;
    delete process.env.C2C_RUNTIME_BUNDLE_DIR;
    delete process.env.C2C_ALLOW_RUNTIME_OVERRIDE;
    try {
      const r = new RuntimeResolver();
      const res = await r.resolve({ profileSource: "PACKAGED_V2", workspaceRoot: "C:\workspace", appRoot });
      expect(res.entryPath).toBe(join(bundledDir, "main.js"));
      expect(res.entryPath).not.toBe(foreignEntry);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(foreign, { recursive: true, force: true });
      delete process.env.C2C_RUNTIME_ENTRY;
    }
  });
});