/**
 * folder-grants — 读取控制中心写入的文件夹 ACL（可按盘、任意目录）。
 *
 * 文件：`<profile>/folder-acl.json`（由主进程 FolderAclStore 原子写入）
 * 规则：path 必须绝对路径；permission = read | write | none；extensions 为 null 或
 *       带点的小写扩展名列表（读/写都受它限制）。
 * 缺文件/损坏/工作区不匹配 → 不授予任何额外目录（失败关闭）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface FolderGrant {
  id: string;
  path: string;
  permission: "read" | "write" | "none";
  extensions: string[] | null;
  label: string;
}

interface AclDocument {
  schemaVersion?: unknown;
  workspaceId?: unknown;
  rules?: unknown;
}

const MAX_BYTES = 2 * 1024 * 1024;

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function normalizeExtension(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || !normalized.startsWith(".") || /[\\/\s*?]/.test(normalized)) return null;
  return normalized;
}

export function parseGrants(raw: unknown, workspaceId: string): FolderGrant[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const doc = raw as AclDocument;
  if (doc.workspaceId !== undefined && doc.workspaceId !== workspaceId) return [];
  if (!Array.isArray(doc.rules)) return [];
  const grants: FolderGrant[] = [];
  for (const entry of doc.rules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    if (!isAbsolutePath(rule.path)) continue;
    if (rule.permission !== "read" && rule.permission !== "write" && rule.permission !== "none") continue;
    const extensions = Array.isArray(rule.extensions)
      ? [...new Set(rule.extensions.map(normalizeExtension).filter((v): v is string => v !== null))]
      : null;
    grants.push({
      id: typeof rule.id === "string" && rule.id.length <= 80 ? rule.id : "grant",
      path: path.resolve(rule.path),
      permission: rule.permission,
      extensions,
      label: typeof rule.label === "string" ? rule.label.slice(0, 100) : "",
    });
  }
  // 最长路径优先，调用方按顺序取第一个匹配即可。
  return grants.sort((a, b) => b.path.length - a.path.length);
}

export async function loadFolderGrants(
  aclPath: string,
  workspaceId: string,
): Promise<FolderGrant[]> {
  try {
    const stat = await fs.stat(aclPath);
    if (!stat.isFile() || stat.size > MAX_BYTES) return [];
    const text = await fs.readFile(aclPath, "utf8");
    return parseGrants(JSON.parse(text), workspaceId);
  } catch {
    return [];
  }
}
