import { promises as fs } from "node:fs";
import * as path from "node:path";
import { redactObject } from "./redaction.js";
import { loadFolderGrants, type FolderGrant } from "./folder-grants.js";

export class McpSecurityError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "McpSecurityError";
    this.code = code;
  }
}

/** Central policy for files that must never cross the MCP boundary. */
export class SensitivePathPolicy {
  private readonly exactNames = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "credentials",
    "credential",
    "secrets",
    "secret",
    "secret-store",
    "oauth-store",
    "auth-store",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "known_hosts",
    "passwords",
    "cookies",
    "cookies.sqlite",
  ]);

  isSensitive(target: string): boolean {
    const normalized = target.replaceAll("\\", "/").toLowerCase();
    const parts = normalized.split("/").filter(Boolean);
    return parts.some((part) => {
      if (this.exactNames.has(part)) return true;
      if (/^\.env\./.test(part)) return true;
      if (/\.(pem|key|pfx|p12)$/.test(part)) return true;
      if (/(^|[-_.])(credential|credentials|secret|secrets|oauth-store|auth-store)([-_.]|$)/.test(part)) return true;
      if (/^(cloudflared|token|token-cache|cookie|cookie-store|password-db)/.test(part)) return true;
      return false;
    });
  }
}

export interface ResolvedWorkspacePath {
  absolute: string;
  relative: string;
  sensitive: boolean;
  exists: boolean;
  /** 命中的根目录（主工作区或 ACL 授权目录） */
  root: string;
  rootId: string;
  isPrimary: boolean;
  permission: "read" | "write";
  /** 授权目录下显示绝对路径，主工作区下显示相对路径 */
  display: string;
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const rootValue = normalizeForComparison(root);
  const candidateValue = normalizeForComparison(candidate);
  if (rootValue === candidateValue) return true;
  const relative = path.relative(rootValue, candidateValue);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}

async function findExistingParent(target: string): Promise<string> {
  let cursor = target;
  while (true) {
    try {
      await fs.lstat(cursor);
      return cursor;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new McpSecurityError("path_parent_missing");
      cursor = parent;
    }
  }
}

/** Realpath the deepest existing ancestor and keep the missing tail (for not-yet-created grant dirs). */
async function canonicalizeWithMissingTail(input: string): Promise<string> {
  let cursor = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return missing.length > 0 ? path.resolve(real, ...missing) : real;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(input);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * MCP security boundary. All file access must resolve through this class.
 * It uses both lexical and realpath checks so prefix collisions, junctions,
 * symlinks, UNC paths, different drives, and non-existent descendants fail
 * closed instead of relying on startsWith().
 */
export class McpSecurityBoundary {
  readonly root: string;
  readonly rootReal: string;
  readonly sensitivePaths: SensitivePathPolicy;
  readonly profileDir: string | null;

  private readonly aclPath: string | null;
  private readonly aclWorkspaceId: string | null;
  private grants: FolderGrant[] = [];
  private grantsStamp = "";
  private grantsCheckedAt = 0;

  private constructor(
    root: string,
    rootReal: string,
    options: { aclPath?: string | null; workspaceId?: string; profileDir?: string | null } = {},
  ) {
    this.root = root;
    this.rootReal = rootReal;
    this.sensitivePaths = new SensitivePathPolicy();
    this.aclPath = options.aclPath ?? null;
    this.aclWorkspaceId = options.workspaceId ?? null;
    this.profileDir = options.profileDir ?? null;
  }

  static async create(
    workspaceRoot: string,
    options: { aclPath?: string | null; workspaceId?: string; profileDir?: string | null } = {},
  ): Promise<McpSecurityBoundary> {
    if (!workspaceRoot || workspaceRoot.includes("\0")) {
      throw new McpSecurityError("workspace_root_invalid");
    }
    const root = path.resolve(workspaceRoot);
    let rootReal: string;
    try {
      rootReal = await fs.realpath(root);
    } catch {
      throw new McpSecurityError("workspace_root_missing");
    }
    const boundary = new McpSecurityBoundary(root, rootReal, options);
    await boundary.refreshGrants(true);
    return boundary;
  }

  /** 重新读取文件夹 ACL；1 秒内按 mtime/size 去重，失败则清空授权（失败关闭）。 */
  async refreshGrants(force = false): Promise<void> {
    if (!this.aclPath) return;
    try {
      const stat = await fs.stat(this.aclPath);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (!force && stamp === this.grantsStamp && Date.now() - this.grantsCheckedAt < 1_000) return;
      const loaded = await loadFolderGrants(this.aclPath, this.aclWorkspaceId ?? "");
      this.grants = await Promise.all(loaded.map(async (grant) => ({
        ...grant,
        path: await canonicalizeWithMissingTail(grant.path),
      })));
      this.grants = this.grants.sort((a, b) => b.path.length - a.path.length);
      this.grantsStamp = stamp;
      this.grantsCheckedAt = Date.now();
    } catch {
      this.grants = [];
      this.grantsStamp = "";
      this.grantsCheckedAt = Date.now();
    }
  }

  /**
   * 统一路径解析：相对路径只对主工作区；绝对路径可命中任一 ACL 授权目录。
   * 命中规则按最长前缀；显式规则优先于主工作区默认权限。
   */
  async resolvePath(
    input: string,
    operation: "read" | "write",
    options: { allowMissing?: boolean } = {},
  ): Promise<ResolvedWorkspacePath> {
    if (!input || input.includes("\0")) throw new McpSecurityError("path_invalid");
    await this.refreshGrants();

    const absoluteInput = path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input);
    const lexical = absoluteInput ? path.resolve(input) : path.resolve(this.root, input);
    if (!absoluteInput && !isWithin(this.root, lexical)) {
      throw new McpSecurityError("path_outside_workspace");
    }

    let exists = true;
    let absolute = lexical;
    try {
      absolute = await fs.realpath(lexical);
    } catch {
      exists = false;
      if (!options.allowMissing) throw new McpSecurityError("path_not_found");
      const parent = await findExistingParent(lexical);
      const parentReal = await fs.realpath(parent);
      absolute = path.resolve(parentReal, path.relative(parent, lexical));
    }

    const match = this.matchRoot(absolute);
    if (!match) throw new McpSecurityError("path_outside_workspace");
    if (match.kind === "grant") {
      const grant = match.grant!;
      if (grant.permission === "none") throw new McpSecurityError("acl_denied");
      if (operation === "write" && grant.permission !== "write") {
        throw new McpSecurityError("acl_write_denied");
      }
      if (grant.extensions !== null) {
        const extension = path.extname(absolute).toLowerCase();
        if (!extension || !grant.extensions.includes(extension)) {
          throw new McpSecurityError("acl_extension_denied");
        }
      }
    }

    const relative = path.relative(match.root, absolute).replaceAll("\\", "/") || ".";
    return {
      absolute,
      relative,
      sensitive: this.sensitivePaths.isSensitive(relative),
      exists,
      root: match.root,
      rootId: match.rootId,
      isPrimary: match.kind === "primary",
      permission: match.kind === "primary" ? "write" : match.grant!.permission as "read" | "write",
      display: match.kind === "primary" ? relative : absolute,
    };
  }

  /** 读路径：保留旧签名，绝对路径可命中 ACL 授权目录。 */
  async resolveWorkspacePath(
    input: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<ResolvedWorkspacePath> {
    return this.resolvePath(input, "read", options);
  }

  async resolveWritePath(
    input: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<ResolvedWorkspacePath> {
    return this.resolvePath(input, "write", options);
  }

  /** 主工作区 + 所有 ACL 授权目录（含 deny 规则，便于 UI/工具展示）。 */
  grantRoots(): Array<{
    id: string;
    path: string;
    access: string;
    label: string;
    extensions: string[] | null;
  }> {
    return [
      { id: "workspace", path: this.rootReal, access: "read,write", label: "主工作区", extensions: null },
      ...this.grants.map((grant) => ({
        id: grant.id,
        path: grant.path,
        access: grant.permission === "write" ? "read,write" : grant.permission === "read" ? "read" : "none",
        label: grant.label,
        extensions: grant.extensions,
      })),
    ];
  }

  private matchRoot(absolute: string): {
    kind: "primary" | "grant";
    root: string;
    rootId: string;
    grant?: FolderGrant;
  } | null {
    let best: { kind: "primary" | "grant"; root: string; rootId: string; grant?: FolderGrant } | null = null;
    let bestLength = -1;
    if (isWithin(this.rootReal, absolute)) {
      best = { kind: "primary", root: this.rootReal, rootId: "workspace" };
      bestLength = normalizeForComparison(this.rootReal).length;
    }
    for (const grant of this.grants) {
      if (!isWithin(grant.path, absolute)) continue;
      const length = normalizeForComparison(grant.path).length;
      // 显式规则与主工作区同长时，规则优先（允许用 none 收窄主工作区）。
      if (length >= bestLength) {
        best = { kind: "grant", root: grant.path, rootId: grant.id, grant };
        bestLength = length;
      }
    }
    return best;
  }

  assertReadable(resolved: ResolvedWorkspacePath): void {
    if (resolved.sensitive) throw new McpSecurityError("sensitive_path_denied");
  }

  redact<T>(value: T): T {
    return redactObject(value);
  }

  limit(value: unknown, fallback: number, maximum: number): number {
    const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(0, Math.min(maximum, parsed));
  }
}

export function isSkippableDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".git" || lower === "node_modules" || lower === "dist" || lower.startsWith("release");
}

export function isLikelyBinary(name: string, bytes: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (/\.(7z|avi|bmp|class|dll|doc|docx|exe|gif|ico|jar|jpeg|jpg|lockb|mp3|mp4|pdf|png|pyc|so|sqlite|tar|ttf|wasm|webp|woff|woff2|zip)$/.test(lower)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  return sample.some((byte) => byte === 0);
}
