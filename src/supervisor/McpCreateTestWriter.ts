import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { McpCreateExecutionMaterial } from "../main/approval/ApprovalQueue.js";

export interface McpCreateTestWriterResult {
  fileId: string;
  sha256: string;
  byteLength: number;
}

export type McpCreateTestWriter = (material: McpCreateExecutionMaterial) => Promise<McpCreateTestWriterResult>;

const MAX_WRITER_OUTPUT_BYTES = 16 * 1024;
const WRITER_TIMEOUT_MS = 20_000;

export function createMcpCreateTestWriter(dllPath: string): McpCreateTestWriter {
  if (!path.isAbsolute(dllPath) || path.basename(dllPath).toLowerCase() !== "windowscreateexperiment.dll") {
    throw new Error("MCP_CREATE_TEST_WRITER_PATH_INVALID");
  }
  const resolvedDllPath = path.resolve(dllPath);

  return async (material) => {
    if (process.platform !== "win32") throw new Error("MCP_CREATE_TEST_WRITER_WINDOWS_REQUIRED");
    if (!path.isAbsolute(material.workspaceRoot) || !path.isAbsolute(material.targetPath)) {
      throw new Error("MCP_CREATE_TEST_WRITER_PATH_INVALID");
    }
    const name = path.basename(material.targetPath);
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")
      || !name.toLowerCase().endsWith(".txt")
      || path.resolve(path.dirname(material.targetPath)).toLowerCase() !== path.resolve(material.workspaceRoot).toLowerCase()) {
      throw new Error("MCP_CREATE_TEST_WRITER_SINGLE_LEVEL_ONLY");
    }
    if (createHash("sha256").update(material.content).digest("hex") !== material.contentDigest) {
      throw new Error("MCP_CREATE_TEST_WRITER_CONTENT_DIGEST_MISMATCH");
    }
    const dllStats = await stat(resolvedDllPath).catch(() => null);
    if (!dllStats?.isFile()) throw new Error("MCP_CREATE_TEST_WRITER_BINARY_UNAVAILABLE");

    const child = spawn("dotnet", [resolvedDllPath, "--test-create", material.workspaceRoot, name, material.contentDigest], {
      cwd: path.dirname(resolvedDllPath),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        C2C_V2_CREATE_TEST_WORKSPACE_ROOT: material.workspaceRoot,
      },
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes <= MAX_WRITER_OUTPUT_BYTES) stdout += chunk;
      else child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes <= MAX_WRITER_OUTPUT_BYTES) stderr += chunk;
      else child.kill();
    });

    const timeout = setTimeout(() => child.kill(), WRITER_TIMEOUT_MS);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.stdin.once("error", reject);
      child.stdin.end(JSON.stringify({ contentBase64: material.content.toString("base64") }), "utf8");
    }).finally(() => clearTimeout(timeout));

    let response: unknown;
    try {
      const lines = stdout.trim().split(/\r?\n/);
      response = JSON.parse(lines[lines.length - 1] ?? "") as unknown;
    } catch {
      throw new Error(`MCP_CREATE_TEST_WRITER_PROTOCOL_ERROR:${result.code ?? "NO_EXIT"}`);
    }
    if (!response || typeof response !== "object") throw new Error("MCP_CREATE_TEST_WRITER_PROTOCOL_ERROR");
    const payload = response as { status?: unknown; code?: unknown; fileId?: unknown; expectedSha256?: unknown; readbackSha256?: unknown; byteLength?: unknown };
    if (result.code !== 0 || payload.status !== "CREATED_AND_VERIFIED"
      || typeof payload.fileId !== "string" || payload.fileId.length > 256
      || payload.expectedSha256 !== material.contentDigest || payload.readbackSha256 !== material.contentDigest
      || payload.byteLength !== material.content.byteLength) {
      const code = typeof payload.code === "string" ? payload.code : String(result.code ?? result.signal ?? "UNKNOWN");
      throw new Error(`MCP_CREATE_TEST_WRITER_FAILED:${code}`);
    }
    return { fileId: payload.fileId, sha256: material.contentDigest, byteLength: material.content.byteLength };
  };
}
