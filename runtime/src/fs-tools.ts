/**
 * fs-tools — runtime 内的直接文件能力（受工具策略开关 + 本机审批控制）。
 *
 * 路径统一走 McpSecurityBoundary：主工作区 + 控制中心授权的任意目录（可跨盘）。
 * 删除/移动/覆盖写之前先备份到 `<profile>/backups/runtime/`，并做 SHA/链接检查。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { McpSecurityBoundary } from "./security-boundary.js";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function backupFile(boundary: McpSecurityBoundary, absolute: string): Promise<string | null> {
  if (!boundary.profileDir) return null;
  const dir = path.join(boundary.profileDir, "backups", "runtime");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${path.basename(absolute)}`);
  await fs.copyFile(absolute, target);
  return target;
}

async function lstatRegularFile(absolute: string): Promise<{ size: number }> {
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("TARGET_NOT_REGULAR_FILE");
  if (stat.nlink !== 1) throw new Error("TARGET_HARDLINK_DENIED");
  return { size: stat.size };
}

export async function listRoots(boundary: McpSecurityBoundary): Promise<{
  roots: Array<{ id: string; path: string; access: string; label: string; extensions: string[] | null }>;
  count: number;
}> {
  const roots = boundary.grantRoots();
  return { roots, count: roots.length };
}

export async function writeFileTool(
  boundary: McpSecurityBoundary,
  args: { path?: unknown; content?: unknown; createDirectories?: unknown },
): Promise<{ ok: true; filePath: string; bytes: number; created: boolean; backupPath: string | null }> {
  const target = typeof args.path === "string" ? args.path.trim() : "";
  if (!target) throw new Error("PATH_REQUIRED");
  const content = typeof args.content === "string" ? args.content : "";
  const resolved = await boundary.resolveWritePath(target, { allowMissing: true });
  if (resolved.sensitive) throw new Error("SENSITIVE_PATH_DENIED");

  const existed = await fs.access(resolved.absolute).then(() => true).catch(() => false);
  if (existed) await lstatRegularFile(resolved.absolute);
  const parent = path.dirname(resolved.absolute);
  const parentStat = await fs.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) {
    if (args.createDirectories !== true) throw new Error("TARGET_PARENT_MISSING");
    await fs.mkdir(parent, { recursive: true });
  }
  const backupPath = existed ? await backupFile(boundary, resolved.absolute) : null;
  await fs.writeFile(resolved.absolute, content, "utf8");
  const stat = await fs.stat(resolved.absolute);
  return { ok: true, filePath: resolved.display, bytes: stat.size, created: !existed, backupPath };
}

export async function createFileTool(
  boundary: McpSecurityBoundary,
  args: { path?: unknown; content?: unknown; createDirectories?: unknown; overwrite?: unknown },
): Promise<{ ok: true; filePath: string; bytes: number; created: boolean; backupPath: string | null }> {
  const target = typeof args.path === "string" ? args.path.trim() : "";
  if (!target) throw new Error("PATH_REQUIRED");
  const resolved = await boundary.resolveWritePath(target, { allowMissing: true });
  if (resolved.sensitive) throw new Error("SENSITIVE_PATH_DENIED");
  const existed = await fs.access(resolved.absolute).then(() => true).catch(() => false);
  if (existed && args.overwrite !== true) throw new Error("TARGET_EXISTS");
  return await writeFileTool(boundary, args);
}

export async function updateFileTool(
  boundary: McpSecurityBoundary,
  args: { path?: unknown; content?: unknown; expected_sha256?: unknown; createDirectories?: unknown },
): Promise<{
  ok: true;
  filePath: string;
  bytes: number;
  previousSha256: string;
  backupPath: string | null;
}> {
  const target = typeof args.path === "string" ? args.path.trim() : "";
  if (!target) throw new Error("PATH_REQUIRED");
  const content = typeof args.content === "string" ? args.content : "";
  const resolved = await boundary.resolveWritePath(target);
  if (resolved.sensitive) throw new Error("SENSITIVE_PATH_DENIED");
  await lstatRegularFile(resolved.absolute);
  const before = await fs.readFile(resolved.absolute);
  const previousSha256 = sha256(before);
  if (typeof args.expected_sha256 === "string" && args.expected_sha256.trim()
    && args.expected_sha256.trim().toLowerCase() !== previousSha256) {
    throw new Error("SHA256_MISMATCH");
  }
  const backupPath = await backupFile(boundary, resolved.absolute);
  await fs.writeFile(resolved.absolute, content, "utf8");
  const stat = await fs.stat(resolved.absolute);
  return { ok: true, filePath: resolved.display, bytes: stat.size, previousSha256, backupPath };
}

export async function deleteFileTool(
  boundary: McpSecurityBoundary,
  args: { path?: unknown; expected_sha256?: unknown },
): Promise<{ ok: true; filePath: string; bytes: number; sha256: string; backupPath: string | null }> {
  const target = typeof args.path === "string" ? args.path.trim() : "";
  if (!target) throw new Error("PATH_REQUIRED");
  const resolved = await boundary.resolveWritePath(target);
  if (resolved.sensitive) throw new Error("SENSITIVE_PATH_DENIED");
  const { size } = await lstatRegularFile(resolved.absolute);
  const before = await fs.readFile(resolved.absolute);
  const digest = sha256(before);
  if (typeof args.expected_sha256 === "string" && args.expected_sha256.trim()
    && args.expected_sha256.trim().toLowerCase() !== digest) {
    throw new Error("SHA256_MISMATCH");
  }
  const backupPath = await backupFile(boundary, resolved.absolute);
  await fs.unlink(resolved.absolute);
  return { ok: true, filePath: resolved.display, bytes: size, sha256: digest, backupPath };
}

export async function moveFileTool(
  boundary: McpSecurityBoundary,
  args: { source?: unknown; destination?: unknown; expected_sha256?: unknown },
): Promise<{
  ok: true;
  source: string;
  destination: string;
  bytes: number;
  sha256: string;
  backupPath: string | null;
}> {
  const from = typeof args.source === "string" ? args.source.trim() : "";
  const to = typeof args.destination === "string" ? args.destination.trim() : "";
  if (!from || !to) throw new Error("SOURCE_AND_DESTINATION_REQUIRED");
  const source = await boundary.resolveWritePath(from);
  const destination = await boundary.resolveWritePath(to, { allowMissing: true });
  if (source.sensitive || destination.sensitive) throw new Error("SENSITIVE_PATH_DENIED");
  const { size } = await lstatRegularFile(source.absolute);
  const before = await fs.readFile(source.absolute);
  const digest = sha256(before);
  if (typeof args.expected_sha256 === "string" && args.expected_sha256.trim()
    && args.expected_sha256.trim().toLowerCase() !== digest) {
    throw new Error("SHA256_MISMATCH");
  }
  if (await fs.access(destination.absolute).then(() => true).catch(() => false)) {
    throw new Error("DESTINATION_EXISTS");
  }
  const parent = path.dirname(destination.absolute);
  const parentStat = await fs.stat(parent).catch(() => null);
  if (!parentStat?.isDirectory()) throw new Error("DESTINATION_PARENT_MISSING");
  const backupPath = await backupFile(boundary, source.absolute);
  try {
    await fs.rename(source.absolute, destination.absolute);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw error;
    await fs.copyFile(source.absolute, destination.absolute);
    await fs.unlink(source.absolute);
  }
  return {
    ok: true,
    source: source.display,
    destination: destination.display,
    bytes: size,
    sha256: digest,
    backupPath,
  };
}

export async function applyPatchTool(
  boundary: McpSecurityBoundary,
  args: { path?: unknown; edits?: unknown },
): Promise<{ ok: true; filePath: string; applied: number; bytes: number; backupPath: string | null }> {
  const target = typeof args.path === "string" ? args.path.trim() : "";
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (!target) throw new Error("PATH_REQUIRED");
  if (edits.length < 1 || edits.length > 50) throw new Error("EDITS_REQUIRED");
  const resolved = await boundary.resolveWritePath(target);
  if (resolved.sensitive) throw new Error("SENSITIVE_PATH_DENIED");
  await lstatRegularFile(resolved.absolute);
  let content = await fs.readFile(resolved.absolute, "utf8");
  for (const raw of edits) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("EDIT_INVALID");
    const edit = raw as { old_text?: unknown; new_text?: unknown };
    if (typeof edit.old_text !== "string" || !edit.old_text || typeof edit.new_text !== "string") {
      throw new Error("EDIT_INVALID");
    }
    const first = content.indexOf(edit.old_text);
    if (first < 0) throw new Error("EDIT_NOT_FOUND");
    if (content.indexOf(edit.old_text, first + edit.old_text.length) >= 0) throw new Error("EDIT_NOT_UNIQUE");
    content = content.slice(0, first) + edit.new_text + content.slice(first + edit.old_text.length);
  }
  const backupPath = await backupFile(boundary, resolved.absolute);
  await fs.writeFile(resolved.absolute, content, "utf8");
  const stat = await fs.stat(resolved.absolute);
  return { ok: true, filePath: resolved.display, applied: edits.length, bytes: stat.size, backupPath };
}
