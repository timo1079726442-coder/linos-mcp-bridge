import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpUpdateWriter } from "./McpUpdateWriter.js";

const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("McpUpdateWriter", () => {
  it.skipIf(process.platform !== "win32")("rejects all Windows replacements until native CAS validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-update-writer-"));
    roots.push(root);
    const targetPath = path.join(root, "update.txt");
    const before = "before-update\n";
    const after = "after-update\n";
    await writeFile(targetPath, before, "utf8");
    await expect(createMcpUpdateWriter()({
      workspaceRoot: root,
      targetPath,
      content: Buffer.from(after, "utf8"),
      contentDigest: sha256(after),
      expectedTargetVersion: `SHA256:${sha256(before)}`,
    })).rejects.toThrow("MCP_UPDATE_WINDOWS_CAS_UNAVAILABLE");
    expect(await readFile(targetPath, "utf8")).toBe(before);
  });
  it.skipIf(process.platform === "win32")("atomically replaces an existing file and verifies the readback digest on non-Windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-update-writer-"));
    roots.push(root);
    const targetPath = path.join(root, "update.txt");
    const before = "before-update\n";
    const after = "after-update\n";
    await writeFile(targetPath, before, "utf8");

    const writer = createMcpUpdateWriter();
    const result = await writer({
      workspaceRoot: root,
      targetPath,
      content: Buffer.from(after, "utf8"),
      contentDigest: sha256(after),
      expectedTargetVersion: `SHA256:${sha256(before)}`,
    });

    expect(await readFile(targetPath, "utf8")).toBe(after);
    expect(result.sha256).toBe(sha256(after));
    expect(result.byteLength).toBe(Buffer.byteLength(after, "utf8"));
    expect(result.fileId).toMatch(/^[a-f0-9]{32}$/);
  });

  it.skipIf(process.platform === "win32")("refuses a stale expected version and preserves the current file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-update-writer-"));
    roots.push(root);
    const targetPath = path.join(root, "update.txt");
    const current = "changed-by-someone-else\n";
    const after = "assistant-update\n";
    await writeFile(targetPath, current, "utf8");

    const writer = createMcpUpdateWriter();
    await expect(writer({
      workspaceRoot: root,
      targetPath,
      content: Buffer.from(after, "utf8"),
      contentDigest: sha256(after),
      expectedTargetVersion: `SHA256:${sha256("old-version\n")}`,
    })).rejects.toThrow("MCP_UPDATE_WRITER_TARGET_CHANGED");

    expect(await readFile(targetPath, "utf8")).toBe(current);
  });
});
