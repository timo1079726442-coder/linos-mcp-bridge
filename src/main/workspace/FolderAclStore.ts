import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { AtomicJsonFileError, readAtomicJson, withAtomicJsonFileLock, writeAtomicJson } from "../storage/AtomicJsonFile.js";
import { redactString } from "../redaction/Redactor.js";
import { isPathWithin, normalizePathForComparison, resolvePathWithinWorkspace } from "./PathContainment.js";

export type FolderPermission = "read" | "write" | "none";
export type FolderOperation = "read" | "write";

export interface FolderAclRule {
  id: string;
  path: string;
  permission: FolderPermission;
  label: string;
  /** Lowercase extensions with leading dots; extensionless targets are denied. */
  extensions: string[] | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type AccessVerdict =
  | {
    allowed: true;
    profileId: string;
    workspaceId: string;
    canonicalPath: string;
    operation: FolderOperation;
    ruleId: string;
    aclRevision: number;
  }
  | {
    allowed: false;
    profileId: string;
    workspaceId: string;
    canonicalPath: string | null;
    operation: FolderOperation;
    ruleId: string | null;
    reason: "INVALID_PATH" | "WORKSPACE_UNAVAILABLE" | "OUTSIDE_WORKSPACE" | "PATH_UNRESOLVABLE" | "NO_RULES" | "NO_MATCH" | "DENY_RULE" | "INSUFFICIENT_PERMISSION" | "EXTENSION_NOT_ALLOWED" | "AMBIGUOUS_RULE" | "ACL_SCOPE_MISMATCH" | "ACL_STORE_CORRUPT" | "ACL_STORE_UNAVAILABLE";
  };

interface FolderAclDocument {
  schemaVersion: 2;
  profileId: string;
  workspaceId: string;
  workspaceRoot: string;
  revision: number;
  rules: FolderAclRule[];
}

export interface FolderAclStoreOptions {
  stateRoot: string;
  profileId: string;
  profileName?: string;
  workspaceId: string;
  workspaceRoot: string | null;
  now?: () => number;
}

export class FolderAclStoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FolderAclStoreError";
  }
}

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const STALE_AFTER_MS = 60_000;

export class FolderAclStore {
  private readonly stateRoot: string;
  private readonly now: () => number;

  constructor(private readonly options: FolderAclStoreOptions) {
    assertSafeIdentity(options.profileId, "ACL_BAD_PROFILE_ID");
    assertSafeIdentity(options.workspaceId, "ACL_BAD_WORKSPACE_ID");
    if (!path.isAbsolute(options.stateRoot)) throw new FolderAclStoreError("ACL_STATE_ROOT_NOT_ABSOLUTE");
    this.stateRoot = path.resolve(options.stateRoot);
    this.now = options.now ?? Date.now;
  }

  private filePath(): string {
    return path.join(this.stateRoot, "profiles", this.options.profileId, "folder-acl.json");
  }

  private async canonicalWorkspaceRoot(): Promise<string> {
    if (!this.options.workspaceRoot) throw new FolderAclStoreError("ACL_WORKSPACE_REQUIRED");
    const result = await resolvePathWithinWorkspace(this.options.workspaceRoot, this.options.workspaceRoot);
    if (!result.ok) throw new FolderAclStoreError("ACL_WORKSPACE_UNAVAILABLE");
    return result.workspaceRoot;
  }

  private async readDocument(): Promise<FolderAclDocument> {
    const workspaceRoot = await this.canonicalWorkspaceRoot();
    let raw: unknown;
    try {
      raw = await readAtomicJson<unknown>(this.filePath(), MAX_DOCUMENT_BYTES);
    } catch (error: unknown) {
      if (error instanceof AtomicJsonFileError) throw new FolderAclStoreError("ACL_STORE_CORRUPT");
      throw new FolderAclStoreError("ACL_STORE_UNAVAILABLE");
    }

    if (raw === undefined) {
      return { schemaVersion: 2, profileId: this.options.profileId, workspaceId: this.options.workspaceId, workspaceRoot, revision: 0, rules: [] };
    }
    if (!isFolderAclDocument(raw) || raw.profileId !== this.options.profileId) {
      throw new FolderAclStoreError("ACL_STORE_CORRUPT");
    }
    if (raw.workspaceId !== this.options.workspaceId || normalizePathForComparison(raw.workspaceRoot) !== normalizePathForComparison(workspaceRoot)) {
      throw new FolderAclStoreError("ACL_SCOPE_MISMATCH");
    }
    return raw;
  }

  async list(): Promise<FolderAclRule[]> {
    const document = await this.readDocument();
    return document.rules.map((rule) => ({ ...rule, extensions: rule.extensions ? [...rule.extensions] : null }));
  }

  async listSnapshot(): Promise<{
    profileId: string;
    workspaceId: string;
    observedAt: string;
    staleAfterMs: number;
    revision: number;
    entries: Array<{
      ruleId: string;
      profileId: string;
      profileName: string;
      workspaceId: string;
      folderPath: string;
      access: "READ_ONLY" | "READ_WRITE" | "DENY";
      extensionPolicy: { mode: "ALLOW_ALL"; deniedExtensions: string[] } | { mode: "ALLOW_LIST"; allowedExtensions: string[]; deniedExtensions: string[] };
      inheritance: "DIRECT";
      updatedAt: string;
      revision: number;
    }>;
  }> {
    const document = await this.readDocument();
    return {
      profileId: this.options.profileId,
      workspaceId: this.options.workspaceId,
      observedAt: new Date(this.now()).toISOString(),
      staleAfterMs: STALE_AFTER_MS,
      revision: document.revision,
      entries: document.rules.map((rule) => ({
        ruleId: rule.id,
        profileId: this.options.profileId,
        profileName: this.options.profileName ?? this.options.profileId,
        workspaceId: this.options.workspaceId,
        folderPath: rule.path,
        access: rule.permission === "read" ? "READ_ONLY" : rule.permission === "write" ? "READ_WRITE" : "DENY",
        extensionPolicy: rule.extensions === null
          ? { mode: "ALLOW_ALL", deniedExtensions: [] }
          : { mode: "ALLOW_LIST", allowedExtensions: [...rule.extensions], deniedExtensions: [] },
        inheritance: "DIRECT",
        updatedAt: rule.updatedAt,
        revision: rule.revision,
      })),
    };
  }

  async add(opts: { path: string; permission: FolderPermission; label?: string; extensions?: string[] | null }): Promise<FolderAclRule> {
    if (opts.permission !== "read" && opts.permission !== "write" && opts.permission !== "none") {
      throw new FolderAclStoreError("ACL_BAD_PERMISSION");
    }
    if (typeof opts.path !== "string" || !path.isAbsolute(opts.path)) throw new FolderAclStoreError("ACL_PATH_NOT_ABSOLUTE");
    if (opts.label !== undefined && typeof opts.label !== "string") throw new FolderAclStoreError("ACL_BAD_LABEL");

    let canonicalPath: string;
    try { canonicalPath = await canonicalizeTarget(opts.path); } catch { throw new FolderAclStoreError("ACL_PATH_UNRESOLVABLE"); }
    let stats;
    try { stats = await fs.stat(canonicalPath); } catch { throw new FolderAclStoreError("ACL_PATH_UNAVAILABLE"); }
    if (!stats.isDirectory()) throw new FolderAclStoreError("ACL_RULE_PATH_NOT_DIRECTORY");

    if (opts.extensions !== undefined && opts.extensions !== null && !Array.isArray(opts.extensions)) {
      throw new FolderAclStoreError("ACL_BAD_EXTENSION");
    }
    const extensions = opts.extensions == null ? null : [...new Set(opts.extensions.map(normalizeExtension))];
    const timestamp = new Date(this.now()).toISOString();
    const ruleId = `fac_${randomBytes(9).toString("base64url")}`;
    const label = sanitizeDisplayText(opts.label ?? "", 100);

    return withAtomicJsonFileLock(this.filePath(), async () => {
      const document = await this.readDocument();
      const canonicalPathKey = normalizePathForComparison(canonicalPath);
      if (document.rules.some((existing) => normalizePathForComparison(existing.path) === canonicalPathKey)) {
        throw new FolderAclStoreError("ACL_DUPLICATE_RULE_PATH");
      }
      document.revision += 1;
      const rule: FolderAclRule = {
        id: ruleId,
        path: canonicalPath,
        permission: opts.permission,
        label,
        extensions,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: document.revision,
      };
      document.rules.push(rule);
      await writeAtomicJson(this.filePath(), document);
      return { ...rule, extensions: rule.extensions ? [...rule.extensions] : null };
    });
  }

  async remove(ruleId: string, expectedRevision: number): Promise<{ removed: boolean; revision: number }> {
    if (!ruleId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new FolderAclStoreError("ACL_BAD_REVISION");
    return withAtomicJsonFileLock(this.filePath(), async () => {
      const document = await this.readDocument();
      const index = document.rules.findIndex((rule) => rule.id === ruleId);
      if (index < 0) return { removed: false, revision: document.revision };
      if (document.rules[index]?.revision !== expectedRevision) throw new FolderAclStoreError("ACL_STALE_REVISION");
      document.rules.splice(index, 1);
      document.revision += 1;
      await writeAtomicJson(this.filePath(), document);
      return { removed: true, revision: document.revision };
    });
  }

  async checkAccess(absPath: string, operation: FolderOperation): Promise<AccessVerdict> {
    const denied = (reason: Extract<AccessVerdict, { allowed: false }> ["reason"], canonicalPath: string | null = null): AccessVerdict => ({
      allowed: false,
      profileId: this.options.profileId,
      workspaceId: this.options.workspaceId,
      canonicalPath,
      operation,
      ruleId: null,
      reason,
    });
    if (operation !== "read" && operation !== "write") return denied("INVALID_PATH");

    let canonicalTarget: string;
    try {
      canonicalTarget = await canonicalizeTarget(
        path.isAbsolute(absPath) ? absPath : path.resolve(this.options.workspaceRoot ?? "", absPath),
      );
    } catch {
      return denied("PATH_UNRESOLVABLE");
    }
    const targetStat = await fs.stat(canonicalTarget).catch(() => null);
    if (targetStat && !targetStat.isFile() && !targetStat.isDirectory()) {
      return denied("INVALID_PATH", canonicalTarget);
    }

    let document: FolderAclDocument;
    try {
      document = await this.readDocument();
    } catch (error: unknown) {
      if (error instanceof FolderAclStoreError && error.code === "ACL_SCOPE_MISMATCH") return denied("ACL_SCOPE_MISMATCH", canonicalTarget);
      if (error instanceof FolderAclStoreError && error.code === "ACL_STORE_CORRUPT") return denied("ACL_STORE_CORRUPT", canonicalTarget);
      return denied("ACL_STORE_UNAVAILABLE", canonicalTarget);
    }

    const targetExtension = path.extname(canonicalTarget).toLowerCase();
    const pathMatching = document.rules.filter((rule) => isPathWithin(rule.path, canonicalTarget));
    // 没有显式规则时，主工作区默认允许；显式规则可以收窄（none）或扩展（任意目录）。
    if (pathMatching.length === 0) {
      if (this.options.workspaceRoot) {
        const canonicalRoot = await fs.realpath(path.resolve(this.options.workspaceRoot)).catch(() => null);
        if (canonicalRoot && isPathWithin(canonicalRoot, canonicalTarget)) {
          return {
            allowed: true,
            profileId: this.options.profileId,
            workspaceId: this.options.workspaceId,
            canonicalPath: canonicalTarget,
            operation,
            ruleId: "workspace",
            aclRevision: document.revision,
          };
        }
      }
      return denied("NO_MATCH", canonicalTarget);
    }
    // Select the most-specific path first. A child policy must never fall back to a
    // broader parent grant merely because the child's extension allowlist rejects a target.
    const longest = Math.max(...pathMatching.map((rule) => normalizePathForComparison(rule.path).length));
    const mostSpecific = pathMatching.filter((rule) => normalizePathForComparison(rule.path).length === longest);
    if (mostSpecific.length !== 1) return denied("AMBIGUOUS_RULE", canonicalTarget);

    // An extension allowlist never admits extensionless or dotfile targets.
    const selected = mostSpecific[0]!;
    if (selected.extensions !== null && !(targetExtension && selected.extensions.includes(targetExtension))) {
      return denied("EXTENSION_NOT_ALLOWED", canonicalTarget);
    }
    const denyRule = mostSpecific.find((rule) => rule.permission === "none");
    if (denyRule) return {
      allowed: false,
      profileId: this.options.profileId,
      workspaceId: this.options.workspaceId,
      canonicalPath: canonicalTarget,
      operation,
      ruleId: denyRule.id,
      reason: "DENY_RULE",
    };

    const permitted = mostSpecific.find((rule) => rule.permission === "write" || (operation === "read" && rule.permission === "read"));
    if (!permitted) return {
      allowed: false,
      profileId: this.options.profileId,
      workspaceId: this.options.workspaceId,
      canonicalPath: canonicalTarget,
      operation,
      ruleId: mostSpecific[0]?.id ?? null,
      reason: "INSUFFICIENT_PERMISSION",
    };
    return {
      allowed: true,
      profileId: this.options.profileId,
      workspaceId: this.options.workspaceId,
      canonicalPath: canonicalTarget,
      operation,
      ruleId: permitted.id,
      aclRevision: document.revision,
    };
  }
}

/** Canonicalize an absolute target, allowing a missing leaf (for not-yet-created files). */
async function canonicalizeTarget(input: string): Promise<string> {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) {
    throw new Error("INVALID_PATH");
  }
  let cursor = path.resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return missing.length > 0 ? path.resolve(real, ...missing) : real;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function normalizeExtension(value: string): string {  if (typeof value !== "string") throw new FolderAclStoreError("ACL_BAD_EXTENSION");
  const normalized = value.trim().toLowerCase();
  if (!normalized || /[\\/\s*?]/.test(normalized) || normalized === ".") throw new FolderAclStoreError("ACL_BAD_EXTENSION");
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function sanitizeDisplayText(value: string, maxLength: number): string {
  return redactString(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function isFolderAclDocument(value: unknown): value is FolderAclDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FolderAclDocument>;
  if (candidate.schemaVersion !== 2 || typeof candidate.profileId !== "string" || typeof candidate.workspaceId !== "string"
    || typeof candidate.workspaceRoot !== "string" || !Number.isSafeInteger(candidate.revision) || !Array.isArray(candidate.rules)) return false;
  const seen = new Set<string>();
  return candidate.rules.every((rule) => {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || seen.has(rule.id)
      || typeof rule.path !== "string" || !path.isAbsolute(rule.path)
      || (rule.permission !== "read" && rule.permission !== "write" && rule.permission !== "none")
      || typeof rule.label !== "string" || typeof rule.createdAt !== "string" || !Number.isFinite(Date.parse(rule.createdAt))
      || typeof rule.updatedAt !== "string" || !Number.isFinite(Date.parse(rule.updatedAt))
      || !Number.isSafeInteger(rule.revision) || rule.revision < 1
      || (rule.extensions !== null && (!Array.isArray(rule.extensions) || rule.extensions.some((ext) => typeof ext !== "string" || ext !== ext.toLowerCase() || !ext.startsWith("."))))) return false;
    seen.add(rule.id);
    return true;
  });
}

function assertSafeIdentity(value: string, code: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new FolderAclStoreError(code);
}

