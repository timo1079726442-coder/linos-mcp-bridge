import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { McpUpdateExecutionMaterial } from "../main/approval/ApprovalQueue.js";

export interface McpUpdateWriterResult {
  fileId: string;
  sha256: string;
  byteLength: number;
}

export type McpUpdateWriter = (material: McpUpdateExecutionMaterial) => Promise<McpUpdateWriterResult>;

const MAX_TARGET_BYTES = 8 * 1024 * 1024;

export function createMcpUpdateWriter(): McpUpdateWriter {
  return async (material) => {
    // On Windows, check-then-rename is not a compare-and-swap: another process
    // can change the target between the last SHA check and fs.rename.
    // Do not allow this writer to replace Windows files until the native
    // atomic/version-bound executor has passed concurrent-writer tests.
    if (process.platform === "win32") {
      throw new Error("MCP_UPDATE_WINDOWS_CAS_UNAVAILABLE");
    }
    if (!path.isAbsolute(material.workspaceRoot) || !path.isAbsolute(material.targetPath)) {
      throw new Error("MCP_UPDATE_WRITER_PATH_INVALID");
    }

    const workspaceRoot = path.resolve(material.workspaceRoot);
    const targetPath = path.resolve(material.targetPath);
    if (!isWithin(workspaceRoot, targetPath) || targetPath === workspaceRoot) {
      throw new Error("MCP_UPDATE_WRITER_OUTSIDE_WORKSPACE");
    }
    if (!/^SHA256:[a-f0-9]{64}$/.test(material.expectedTargetVersion)) {
      throw new Error("MCP_UPDATE_WRITER_EXPECTED_VERSION_INVALID");
    }
    if (createHash("sha256").update(material.content).digest("hex") !== material.contentDigest) {
      throw new Error("MCP_UPDATE_WRITER_CONTENT_DIGEST_MISMATCH");
    }

    const beforeStat = await fs.lstat(targetPath).catch(() => null);
    if (!beforeStat?.isFile() || beforeStat.isSymbolicLink() || beforeStat.size > MAX_TARGET_BYTES) {
      throw new Error("MCP_UPDATE_WRITER_TARGET_UNAVAILABLE");
    }
    const before = await fs.readFile(targetPath);
    try {
      const observedVersion = `SHA256:${digest(before)}`;
      if (observedVersion !== material.expectedTargetVersion) {
        throw new Error("MCP_UPDATE_WRITER_TARGET_CHANGED");
      }
    } finally {
      before.fill(0);
    }

    const tempPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.c2c-update-${randomBytes(12).toString("hex")}.tmp`,
    );
    let tempCreated = false;
    try {
      const handle = await fs.open(tempPath, "wx", beforeStat.mode);
      tempCreated = true;
      try {
        await handle.writeFile(material.content);
        await handle.sync();
      } finally {
        await handle.close();
      }

      const beforeReplace = await fs.readFile(targetPath);
      try {
        if (`SHA256:${digest(beforeReplace)}` !== material.expectedTargetVersion) {
          throw new Error("MCP_UPDATE_WRITER_TARGET_CHANGED");
        }
      } finally {
        beforeReplace.fill(0);
      }

      await fs.rename(tempPath, targetPath);
      tempCreated = false;

      const readback = await fs.readFile(targetPath);
      try {
        const readbackSha256 = digest(readback);
        if (readbackSha256 !== material.contentDigest || readback.byteLength !== material.content.byteLength) {
          throw new Error("MCP_UPDATE_WRITER_READBACK_MISMATCH");
        }
        return {
          fileId: createHash("sha256").update(targetPath.toLowerCase(), "utf8").digest("hex").slice(0, 32),
          sha256: readbackSha256,
          byteLength: readback.byteLength,
        };
      } finally {
        readback.fill(0);
      }
    } finally {
      if (tempCreated) await fs.unlink(tempPath).catch(() => undefined);
    }
  };
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
