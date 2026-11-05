/**
 * WritePolicyStore — owner-authorized local write policy.
 *
 * LIN-C2C-20261014-WRITE-AUTHORIZATION.
 *
 * Single JSON file at `<stateRoot>/write-policy.json`. The C2C control center
 * (Electron main) writes it; the codex-with-chatgpt-poc bridge (on the same
 * machine, different stateRoot) reads it via the absolute path exposed here.
 *
 * Policy is owner-controlled: when `enabled === true`, the C2C supervisor's
 * MCP CREATE path checks the request's resolved path against
 * `allowedDirectories`. The same file is consulted by the codex bridge's
 * `create_file` tool.
 *
 * OAuth and audit chain remain in effect regardless of this policy.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { WritePolicy, WritePolicyUpdate, WriteToolId, WriteToolToggles } from "../../shared/types.js";
import { DEFAULT_WRITE_TOOL_TOGGLES, WRITE_POLICY_SCHEMA_VERSION } from "../../shared/types.js";

export const DEFAULT_MAX_BYTES_PER_WRITE = 1_048_576; // 1 MB
export const DEFAULT_MAX_ALLOWED_DIRECTORIES = 50;

export const DEFAULT_WRITE_POLICY: WritePolicy = {
  schemaVersion: WRITE_POLICY_SCHEMA_VERSION,
  enabled: false,
  powershellEnabled: false,
  tools: { ...DEFAULT_WRITE_TOOL_TOGGLES },
  deviceId: null,
  profileId: null,
  workspaceId: null,
  workspaceRoot: null,
  allowedDirectories: [],
  allowedFiles: [],
  maxBytesPerWrite: DEFAULT_MAX_BYTES_PER_WRITE,
  maxAllowedDirectories: DEFAULT_MAX_ALLOWED_DIRECTORIES,
  maxAllowedFiles: 100,
  updatedAt: "1970-01-01T00:00:00.000Z",
  updatedBy: "default",
};

export interface PolicyValidationError {
  field: "allowedDirectories" | "maxBytesPerWrite" | "maxAllowedDirectories";
  reason: string;
}

function freshDefaultPolicy(): WritePolicy {
  return { ...DEFAULT_WRITE_POLICY, tools: { ...DEFAULT_WRITE_TOOL_TOGGLES } };
}

export class WritePolicyStore {
  constructor(private readonly stateRoot: string) {}

  /** Absolute path to the policy file. Agent bridge reads this directly. */
  policyFilePath(): string {
    return path.join(this.stateRoot, "write-policy.json");
  }

  /**
   * Load the policy. If the file is missing or malformed, return a
   * fail-closed default ({ enabled: false, allowedDirectories: [] }).
   */
  async load(): Promise<WritePolicy> {
    let raw: string;
    try {
      raw = await fs.readFile(this.policyFilePath(), "utf8");
    } catch {
      return freshDefaultPolicy();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return freshDefaultPolicy();
    }
    if (!isCompatibleWritePolicy(parsed)) {
      return freshDefaultPolicy();
    }
    const legacy = parsed as Partial<WritePolicy>;
    const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
    const tools = schemaVersion === 1
      ? migrateLegacyTools(legacy.enabled === true, legacy.powershellEnabled === true)
      : readToolToggles((legacy as { tools?: unknown }).tools);
    return {
      ...DEFAULT_WRITE_POLICY,
      ...legacy,
      schemaVersion: WRITE_POLICY_SCHEMA_VERSION,
      powershellEnabled: tools.powershell,
      tools,
      deviceId: typeof legacy.deviceId === "string" ? legacy.deviceId : null,
      profileId: typeof legacy.profileId === "string" ? legacy.profileId : null,
      workspaceId: typeof legacy.workspaceId === "string" ? legacy.workspaceId : null,
      workspaceRoot: typeof legacy.workspaceRoot === "string" ? path.resolve(legacy.workspaceRoot) : null,
      allowedDirectories: dedupeAndNormalize(legacy.allowedDirectories ?? []),
      allowedFiles: dedupeAndNormalize(legacy.allowedFiles ?? []),
      maxAllowedFiles: Number.isInteger(legacy.maxAllowedFiles) && legacy.maxAllowedFiles! > 0
        ? Math.min(1000, legacy.maxAllowedFiles!)
        : 100,
    };
  }

  /**
   * Apply an update and persist atomically (.tmp + rename). Returns the new
   * policy plus a flag indicating whether anything actually changed.
   */
  async update(
    update: WritePolicyUpdate,
    actor: string,
  ): Promise<{ policy: WritePolicy; changed: boolean }> {
    const current = await this.load();
    const nextTools = update.tools !== undefined ? { ...current.tools, ...update.tools } : { ...current.tools };
    // Keep the legacy shell flag and the per-tool powershell toggle in sync.
    if (update.tools?.powershell !== undefined) {
      nextTools.powershell = update.tools.powershell;
    } else if (update.powershellEnabled !== undefined) {
      nextTools.powershell = update.powershellEnabled;
    }
    const next: WritePolicy = {
      ...current,
      ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
      powershellEnabled: nextTools.powershell,
      tools: nextTools,
      ...(update.deviceId !== undefined ? { deviceId: update.deviceId } : {}),
      ...(update.profileId !== undefined ? { profileId: update.profileId } : {}),
      ...(update.workspaceId !== undefined ? { workspaceId: update.workspaceId } : {}),
      ...(update.workspaceRoot !== undefined
        ? { workspaceRoot: update.workspaceRoot === null ? null : path.resolve(update.workspaceRoot) }
        : {}),
      ...(update.allowedDirectories !== undefined
        ? { allowedDirectories: dedupeAndNormalize(update.allowedDirectories) }
        : {}),
      ...(update.allowedFiles !== undefined
        ? { allowedFiles: dedupeAndNormalize(update.allowedFiles) }
        : {}),
      ...(update.maxBytesPerWrite !== undefined
        ? { maxBytesPerWrite: update.maxBytesPerWrite }
        : {}),
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    if (next.allowedDirectories.length > next.maxAllowedDirectories
      || next.allowedFiles.length > next.maxAllowedFiles) {
      throw new Error("WRITE_POLICY_PATH_LIMIT_EXCEEDED");
    }
    const changed = !shallowEqualPolicy(current, next);
    if (changed) {
      await this.persist(next);
    }
    return { policy: next, changed };
  }

  /**
   * Add a single allowed directory. Returns the updated policy and a flag
   * indicating whether it was new. Enforces the per-policy cap.
   */
  async addAllowedDirectory(
    rawPath: string,
    actor: string,
  ): Promise<{ policy: WritePolicy; added: boolean; reason?: "duplicate" | "cap_exceeded" }> {
    const normalized = normalizeDirectoryPath(rawPath);
    if (!normalized) {
      return { policy: await this.load(), added: false, reason: "duplicate" };
    }
    const current = await this.load();
    if (current.allowedDirectories.includes(normalized)) {
      return { policy: current, added: false, reason: "duplicate" };
    }
    if (current.allowedDirectories.length >= current.maxAllowedDirectories) {
      return { policy: current, added: false, reason: "cap_exceeded" };
    }
    const next: WritePolicy = {
      ...current,
      allowedDirectories: [...current.allowedDirectories, normalized],
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    await this.persist(next);
    return { policy: next, added: true };
  }

  async removeAllowedDirectory(
    rawPath: string,
    actor: string,
  ): Promise<{ policy: WritePolicy; removed: boolean }> {
    const normalized = normalizeDirectoryPath(rawPath);
    const current = await this.load();
    const next = current.allowedDirectories.filter((entry) => entry !== normalized);
    if (next.length === current.allowedDirectories.length) {
      return { policy: current, removed: false };
    }
    const updated: WritePolicy = {
      ...current,
      allowedDirectories: next,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    await this.persist(updated);
    return { policy: updated, removed: true };
  }

  async addAllowedFile(
    rawPath: string,
    actor: string,
  ): Promise<{ policy: WritePolicy; added: boolean; reason?: "duplicate" | "cap_exceeded" }> {
    const normalized = normalizeDirectoryPath(rawPath);
    if (!normalized) {
      return { policy: await this.load(), added: false, reason: "duplicate" };
    }
    const current = await this.load();
    if (current.allowedFiles.includes(normalized)) {
      return { policy: current, added: false, reason: "duplicate" };
    }
    if (current.allowedFiles.length >= current.maxAllowedFiles) {
      return { policy: current, added: false, reason: "cap_exceeded" };
    }
    const next: WritePolicy = {
      ...current,
      allowedFiles: [...current.allowedFiles, normalized],
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    await this.persist(next);
    return { policy: next, added: true };
  }

  async removeAllowedFile(
    rawPath: string,
    actor: string,
  ): Promise<{ policy: WritePolicy; removed: boolean }> {
    const normalized = normalizeDirectoryPath(rawPath);
    const current = await this.load();
    const next = current.allowedFiles.filter((entry) => entry !== normalized);
    if (next.length === current.allowedFiles.length) {
      return { policy: current, removed: false };
    }
    const updated: WritePolicy = {
      ...current,
      allowedFiles: next,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    await this.persist(updated);
    return { policy: updated, removed: true };
  }

  /**
   * Validate a candidate write target against the policy.
   * - returns `null` when the write is permitted
   * - returns a reason string when the write must be denied
   */
  async checkPath(absoluteTargetPath: string): Promise<null | "WRITE_DISABLED" | "WRITE_NOT_ALLOWED_FOR_PATH"> {
    const policy = await this.load();
    if (!policy.enabled) return "WRITE_DISABLED";
    const resolvedTarget = normalizePathCase(path.resolve(absoluteTargetPath));
    const allowedByDirectory = policy.allowedDirectories.some((dir) => {
      const resolvedDir = normalizePathCase(path.resolve(dir));
      const dirWithSep = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
      return resolvedTarget === resolvedDir || resolvedTarget.startsWith(dirWithSep);
    });
    const allowedByFile = policy.allowedFiles.some((file) =>
      resolvedTarget === normalizePathCase(path.resolve(file))
    );
    if (!allowedByDirectory && !allowedByFile) return "WRITE_NOT_ALLOWED_FOR_PATH";
    return null;
  }

  async checkPowerShellEnabled(workspaceRoot: string): Promise<boolean> {
    const policy = await this.load();
    if (!policy.powershellEnabled) return false;
    if (policy.workspaceRoot === null) return true;
    return normalizePathCase(path.resolve(policy.workspaceRoot))
      === normalizePathCase(path.resolve(workspaceRoot));
  }

  private async persist(policy: WritePolicy): Promise<void> {
    await fs.mkdir(this.stateRoot, { recursive: true });
    const tmp = this.policyFilePath() + ".tmp";
    const serialized = JSON.stringify(policy, null, 2);
    await fs.writeFile(tmp, serialized, "utf8");
    await fs.rename(tmp, this.policyFilePath());
  }
}

// --- helpers ---

function normalizeDirectoryPath(rawPath: string): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  // Reject obviously-invalid input early. We still resolve later so callers
  // get the OS-normalized form.
  if (trimmed.includes("\u0000")) return null;
  return path.resolve(trimmed);
}

function dedupeAndNormalize(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const n = normalizeDirectoryPath(p);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function isCompatibleWritePolicy(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== WRITE_POLICY_SCHEMA_VERSION && v.schemaVersion !== 1) return false;
  if (typeof v.enabled !== "boolean") return false;
  if (!Array.isArray(v.allowedDirectories) || !v.allowedDirectories.every((p) => typeof p === "string")) return false;
  if (typeof v.maxBytesPerWrite !== "number" || !Number.isFinite(v.maxBytesPerWrite) || v.maxBytesPerWrite < 1) return false;
  if (typeof v.maxAllowedDirectories !== "number" || !Number.isInteger(v.maxAllowedDirectories) || v.maxAllowedDirectories < 0) return false;
  if (typeof v.updatedAt !== "string" || typeof v.updatedBy !== "string") return false;
  if (v.powershellEnabled !== undefined && typeof v.powershellEnabled !== "boolean") return false;
  if (v.deviceId !== undefined && v.deviceId !== null && typeof v.deviceId !== "string") return false;
  if (v.profileId !== undefined && v.profileId !== null && typeof v.profileId !== "string") return false;
  if (v.workspaceId !== undefined && v.workspaceId !== null && typeof v.workspaceId !== "string") return false;
  if (v.workspaceRoot !== undefined && v.workspaceRoot !== null && typeof v.workspaceRoot !== "string") return false;
  if (v.allowedFiles !== undefined
    && (!Array.isArray(v.allowedFiles) || !v.allowedFiles.every((p) => typeof p === "string"))) return false;
  if (v.maxAllowedFiles !== undefined
    && (typeof v.maxAllowedFiles !== "number" || !Number.isInteger(v.maxAllowedFiles) || v.maxAllowedFiles < 0)) return false;
  if (v.tools !== undefined) {
    if (!v.tools || typeof v.tools !== "object" || Array.isArray(v.tools)) return false;
    for (const [key, flag] of Object.entries(v.tools as Record<string, unknown>)) {
      if (!(key in DEFAULT_WRITE_TOOL_TOGGLES) || typeof flag !== "boolean") return false;
    }
  }
  return true;
}

function normalizePathCase(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function shallowEqualPolicy(a: WritePolicy, b: WritePolicy): boolean {
  if (a.enabled !== b.enabled || a.powershellEnabled !== b.powershellEnabled
    || a.deviceId !== b.deviceId || a.profileId !== b.profileId
    || a.workspaceId !== b.workspaceId || a.workspaceRoot !== b.workspaceRoot
    || a.maxBytesPerWrite !== b.maxBytesPerWrite) return false;
  for (const key of Object.keys(DEFAULT_WRITE_TOOL_TOGGLES) as WriteToolId[]) {
    if (a.tools[key] !== b.tools[key]) return false;
  }
  if (!sameStrings(a.allowedDirectories, b.allowedDirectories)) return false;
  if (!sameStrings(a.allowedFiles, b.allowedFiles)) return false;
  return true;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** v1 had one file switch and one shell switch; preserve their meaning per tool. */
function migrateLegacyTools(enabled: boolean, shell: boolean): WriteToolToggles {
  return {
    createFile: enabled,
    updateFile: enabled,
    deleteFile: false,
    executeCommand: shell,
    gitCommit: shell,
    powershell: shell,
  };
}

function readToolToggles(value: unknown): WriteToolToggles {
  const result = { ...DEFAULT_WRITE_TOOL_TOGGLES };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const key of Object.keys(DEFAULT_WRITE_TOOL_TOGGLES) as WriteToolId[]) {
    if ((value as Record<string, unknown>)[key] === true) result[key] = true;
  }
  return result;
}
