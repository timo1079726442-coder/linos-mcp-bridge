import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  isLikelyBinary,
  isSkippableDirectory,
  McpSecurityBoundary,
  McpSecurityError,
} from "./security-boundary.js";

const MAX_BATCH_READ_FILES = 50;
const MAX_BATCH_STATUS_PATHS = 250;
const MAX_BATCH_PATTERNS = 20;
const MAX_PATTERN_RESULTS = 100;
const MAX_PROJECT_FILES = 2_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 512_000;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 100_000;

export interface AdvancedToolContext {
  workspaceRoot: string;
  boundary: McpSecurityBoundary;
}

interface WalkEntry {
  relative: string;
  absolute: string;
  kind: "file" | "dir";
  depth: number;
  size?: number;
  mtimeMs?: number;
}

export async function batchReadFiles(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const paths = stringArray(args.paths, 1, MAX_BATCH_READ_FILES, "batch_read_paths_invalid");
  const maxChars = clampInteger(args.max_chars_per_file, DEFAULT_READ_CHARS, 100, MAX_READ_CHARS);
  const files: Array<Record<string, unknown>> = [];

  for (const requested of paths) {
    try {
      const resolved = await ctx.boundary.resolveWorkspacePath(requested);
      ctx.boundary.assertReadable(resolved);
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) throw new McpSecurityError("not_a_file");
      if (stat.size > MAX_FILE_BYTES) throw new McpSecurityError("file_too_large");
      const bytes = await fs.readFile(resolved.absolute);
      if (isLikelyBinary(resolved.relative, bytes)) throw new McpSecurityError("binary_file_denied");
      const text = bytes.toString("utf8");
      files.push({
        path: resolved.relative,
        ok: true,
        sizeBytes: stat.size,
        text: text.slice(0, maxChars),
        truncated: text.length > maxChars,
      });
    } catch (error) {
      files.push({
        path: requested,
        ok: false,
        error: safeErrorCode(error),
      });
    }
  }

  return { files, count: files.length };
}

export async function prepareBatchWritePlan(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const rawWrites = args.writes;
  if (!Array.isArray(rawWrites) || rawWrites.length < 1 || rawWrites.length > 25) {
    throw new McpSecurityError("batch_write_plan_invalid");
  }

  let totalBytes = 0;
  const items: Array<Record<string, unknown>> = [];
  for (const raw of rawWrites) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpSecurityError("batch_write_item_invalid");
    const item = raw as Record<string, unknown>;
    if (typeof item.path !== "string" || !item.path.trim() || typeof item.content !== "string") {
      throw new McpSecurityError("batch_write_item_invalid");
    }
    const content = Buffer.from(item.content, "utf8");
    if (content.byteLength > 1_000_000 || content.toString("utf8") !== item.content) {
      content.fill(0);
      throw new McpSecurityError("batch_write_content_invalid");
    }
    totalBytes += content.byteLength;
    if (totalBytes > 2_000_000) {
      content.fill(0);
      throw new McpSecurityError("batch_write_total_too_large");
    }

    try {
      const resolved = await ctx.boundary.resolveWorkspacePath(item.path.trim(), { allowMissing: true });
      ctx.boundary.assertReadable(resolved);
      let beforeSha256: string | null = null;
      let beforeBytes: number | null = null;
      let operation: "CREATE" | "UPDATE" = "CREATE";
      let noOp = false;

      if (resolved.exists) {
        const stat = await fs.stat(resolved.absolute);
        if (!stat.isFile()) throw new McpSecurityError("batch_write_target_not_file");
        if (stat.size > MAX_FILE_BYTES) throw new McpSecurityError("file_too_large");
        const before = await fs.readFile(resolved.absolute);
        try {
          if (isLikelyBinary(resolved.relative, before)) throw new McpSecurityError("binary_file_denied");
          beforeSha256 = sha256(before);
          beforeBytes = before.byteLength;
          operation = "UPDATE";
          noOp = before.equals(content);
        } finally {
          before.fill(0);
        }
      }

      const afterSha256 = sha256(content);
      items.push({
        path: resolved.relative,
        valid: true,
        operation,
        noOp,
        beforeBytes,
        afterBytes: content.byteLength,
        expectedBeforeSha256: beforeSha256,
        proposedAfterSha256: afterSha256,
      });
    } catch (error) {
      items.push({
        path: item.path.trim().slice(0, 32_768),
        valid: false,
        error: safeErrorCode(error),
      });
    } finally {
      content.fill(0);
    }
  }

  const invalidCount = items.filter((item) => item.valid === false).length;
  return {
    mutationPerformed: false,
    itemCount: items.length,
    invalidCount,
    totalProposedBytes: totalBytes,
    allItemsValid: invalidCount === 0,
    approvalProtocolReady: false,
    approvalProtocolReason: "CREATE_ONLY_BRIDGE_NOT_GENERALIZED",
    items,
  };
}

export async function batchFileStatus(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const paths = stringArray(args.paths, 1, MAX_BATCH_STATUS_PATHS, "batch_status_paths_invalid");
  const items: Array<Record<string, unknown>> = [];

  for (const requested of paths) {
    try {
      const resolved = await ctx.boundary.resolveWorkspacePath(requested, { allowMissing: true });
      ctx.boundary.assertReadable(resolved);
      if (!resolved.exists) {
        items.push({ path: resolved.relative, exists: false });
        continue;
      }
      const stat = await fs.stat(resolved.absolute);
      items.push({
        path: resolved.relative,
        exists: true,
        type: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
        sizeBytes: stat.isFile() ? stat.size : null,
        modifiedAt: stat.mtime.toISOString(),
        extension: stat.isFile() ? path.extname(resolved.relative).toLowerCase() : null,
        textCandidate: stat.isFile() ? !isKnownBinaryExtension(resolved.relative) : false,
      });
    } catch (error) {
      items.push({ path: requested, exists: null, error: safeErrorCode(error) });
    }
  }

  return { items, count: items.length };
}

export async function projectSnapshot(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const maxDepth = clampInteger(args.max_depth, 3, 1, 8);
  const maxFiles = clampInteger(args.max_files, 500, 50, MAX_PROJECT_FILES);
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const entries = await walk(root.absolute, root.relative, maxDepth, maxFiles, ctx.boundary);
  const extensionCounts: Record<string, number> = {};
  const tree: string[] = [];
  const importantFiles: Array<{ path: string; sizeBytes: number }> = [];
  const largeFiles: Array<{ path: string; sizeBytes: number }> = [];
  const suspiciousItems: Array<{ path: string; reason: string }> = [];
  let fileCount = 0;
  let directoryCount = 0;

  for (const entry of entries) {
    tree.push(entry.kind === "dir" ? `${entry.relative}/` : entry.relative);
    if (entry.kind === "dir") {
      directoryCount += 1;
      if (archiveLike(entry.relative)) suspiciousItems.push({ path: entry.relative, reason: "archive_or_build_candidate" });
      continue;
    }
    fileCount += 1;
    const ext = path.extname(entry.relative).toLowerCase() || "(none)";
    extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
    if (importantName(path.basename(entry.relative))) {
      importantFiles.push({ path: entry.relative, sizeBytes: entry.size ?? 0 });
    }
    if ((entry.size ?? 0) >= 5_000_000) {
      largeFiles.push({ path: entry.relative, sizeBytes: entry.size ?? 0 });
    }
    if (archiveLike(entry.relative)) suspiciousItems.push({ path: entry.relative, reason: "archive_or_backup_candidate" });
  }

  return {
    root: root.relative,
    maxDepth,
    fileCount,
    directoryCount,
    extensionCounts,
    tree,
    importantFiles: importantFiles.slice(0, 100),
    largeFiles: largeFiles.slice(0, 100),
    suspiciousItems: suspiciousItems.slice(0, 100),
    truncated: fileCount >= maxFiles,
  };
}

export async function batchSearchPatterns(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const patterns = stringArray(args.patterns, 1, MAX_BATCH_PATTERNS, "batch_search_patterns_invalid");
  const mode = args.mode === "regex" ? "regex" : "literal";
  const caseSensitive = args.case_sensitive === true;
  const maxResultsPerPattern = clampInteger(args.max_results_per_pattern, 50, 1, MAX_PATTERN_RESULTS);
  const subpath = optionalString(args.path, ".");
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const rootStat = await fs.stat(root.absolute);
  if (!rootStat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const entries = await walk(root.absolute, root.relative, 8, MAX_PROJECT_FILES, ctx.boundary);
  const files = entries.filter((entry) => entry.kind === "file" && (entry.size ?? 0) <= MAX_SEARCH_FILE_BYTES);
  const matchers = patterns.map((pattern) => ({
    pattern,
    matcher: mode === "regex"
      ? compilePattern(pattern, caseSensitive)
      : null,
  }));
  const groups = matchers.map(({ pattern }) => ({ pattern, matches: [] as Array<{ path: string; line: number; text: string }>, truncated: false }));

  for (const file of files) {
    if (isKnownBinaryExtension(file.relative)) continue;
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file.absolute);
    } catch {
      continue;
    }
    if (isLikelyBinary(file.relative, bytes)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      for (let patternIndex = 0; patternIndex < matchers.length; patternIndex += 1) {
        const group = groups[patternIndex]!;
        if (group.matches.length >= maxResultsPerPattern) {
          group.truncated = true;
          continue;
        }
        const { pattern, matcher } = matchers[patternIndex]!;
        const haystack = caseSensitive ? line : line.toLowerCase();
        const needle = caseSensitive ? pattern : pattern.toLowerCase();
        const matched = matcher ? (matcher.lastIndex = 0, matcher.test(line)) : haystack.includes(needle);
        if (matched) {
          group.matches.push({
            path: file.relative,
            line: lineIndex + 1,
            text: line.slice(0, 1_000),
          });
        }
      }
    }
  }

  return {
    mode,
    caseSensitive,
    groups: groups.map((group) => ({
      pattern: group.pattern,
      matches: group.matches,
      count: group.matches.length,
      truncated: group.truncated,
    })),
  };
}

export async function auditProjectStructure(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const entries = await walk(root.absolute, root.relative, 4, MAX_PROJECT_FILES, ctx.boundary);
  const topLevel = await safeReadDir(root.absolute);
  const topNames = new Set(topLevel.map((entry) => entry.name.toLowerCase()));
  const allPathsLower = entries.map((entry) => entry.relative.toLowerCase());

  const packageMarkers = ["package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml", "build.gradle"]
    .filter((name) => topNames.has(name));
  const hasTests = allPathsLower.some((value) => /(^|\/)(test|tests|__tests__)(\/|$)/.test(value))
    || allPathsLower.some((value) => /\.(test|spec)\.[a-z0-9]+$/.test(value));
  const secretLikeNames = entries
    .filter((entry) => /(^|\/)(\.env(?:\.|$)|credentials?|secrets?|id_rsa|id_ed25519|.*\.(?:pem|pfx|p12|key))$/i.test(entry.relative))
    .map((entry) => entry.relative)
    .slice(0, 50);

  const checks = [
    check("readme", "Has README.md", topNames.has("readme.md")),
    check("project_md", "Has PROJECT.md", topNames.has("project.md")),
    check("llm_md", "Has LLM.md", topNames.has("llm.md")),
    check("status_md", "Has STATUS.md", topNames.has("status.md")),
    check("tests", "Has tests", hasTests),
    check("docs", "Has docs/", topLevel.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === "docs")),
    check("gitignore", "Has .gitignore", topNames.has(".gitignore")),
    check("build_markers", "Has project/package markers", packageMarkers.length > 0, packageMarkers),
    check("no_secret_like_names", "No secret-like file names detected", secretLikeNames.length === 0),
  ];
  const passed = checks.filter((entry) => entry.passed).length;
  const scoreOutOf10 = Math.round((passed / checks.length) * 10);

  return {
    root: root.relative,
    scoreOutOf10,
    checks,
    packageMarkers,
    secretLikeNames,
    note: "Secret-like names are reported only as paths; file contents are never read by this audit.",
  };
}

export async function generateProjectInventory(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const children = await fs.readdir(root.absolute, { withFileTypes: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isSkippableDirectory(entry.name) || ctx.boundary.sensitivePaths.isSensitive(entry.name)) continue;
    const absolute = path.join(root.absolute, entry.name);
    const relative = normalizeSlash(path.join(root.relative === "." ? "" : root.relative, entry.name));
    if (entry.isFile()) {
      const stat = await fs.stat(absolute);
      rows.push({ path: relative, type: "file", sizeBytes: stat.size, marker: importantName(entry.name) });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const names = new Set((await safeReadDir(absolute)).map((item) => item.name.toLowerCase()));
    const markers = ["package.json", "pyproject.toml", "cargo.toml", "go.mod", "tsconfig.json", "readme.md"].filter((name) => names.has(name));
    rows.push({
      path: relative,
      type: "directory",
      likelyProject: markers.length > 0,
      markers,
      archiveCandidate: archiveLike(entry.name),
      suggestedAction: archiveLike(entry.name) ? "REVIEW_ARCHIVE_CANDIDATE" : markers.length > 0 ? "AUDIT_PROJECT" : "INSPECT",
    });
  }

  return { root: root.relative, rows, count: rows.length };
}

export async function shadcnProjectInfo(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const componentsConfig = await readJsonCandidate(root, "components.json", ctx);
  const packageJson = await readJsonCandidate(root, "package.json", ctx);
  const packageRecord = packageJson && typeof packageJson === "object" && !Array.isArray(packageJson)
    ? packageJson as Record<string, unknown>
    : null;
  const dependencies = {
    ...stringRecord(packageRecord?.dependencies),
    ...stringRecord(packageRecord?.devDependencies),
  };
  const relevantDependencies = Object.fromEntries(
    Object.entries(dependencies)
      .filter(([name]) => /^(shadcn|@shadcn\/|@radix-ui\/|lucide-react$|tailwindcss$|class-variance-authority$|clsx$|tailwind-merge$)/.test(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

  return ctx.boundary.redact({
    root: root.relative,
    configured: componentsConfig !== null,
    componentsConfig: componentsConfig ? sanitizeComponentsConfig(componentsConfig) : null,
    relevantDependencies,
    localCliDependencyPresent: Object.keys(dependencies).some((name) => name === "shadcn" || name.startsWith("@shadcn/")),
    executionPolicy: {
      externalCliExecuted: false,
      automaticNpxLatestDownload: false,
      registryMutationPerformed: false,
    },
  });
}

export async function shadcnLocalComponents(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const candidates = [
    "src/components/ui",
    "components/ui",
    "app/components/ui",
  ];
  const componentDirs: Array<{ path: string; files: string[] }> = [];
  for (const relative of candidates) {
    const fullRelative = normalizeSlash(path.join(root.relative === "." ? "" : root.relative, relative));
    let resolved;
    try {
      resolved = await ctx.boundary.resolveWorkspacePath(fullRelative);
      ctx.boundary.assertReadable(resolved);
    } catch {
      continue;
    }
    const dirStat = await fs.stat(resolved.absolute).catch(() => null);
    if (!dirStat?.isDirectory()) continue;
    const files = (await safeReadDir(resolved.absolute))
      .filter((entry) => entry.isFile() && /\.(tsx?|jsx?)$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    componentDirs.push({ path: resolved.relative, files: files.slice(0, 500) });
  }

  return {
    root: root.relative,
    directories: componentDirs,
    componentCount: componentDirs.reduce((sum, item) => sum + item.files.length, 0),
    registrySearchExecuted: false,
    note: "只盘点本地 UI 组件；不会自动下载、安装或修改依赖。",
  };
}

export async function detectArchiveCandidates(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const maxDepth = clampInteger(args.max_depth, 4, 1, 8);
  const maxCandidates = clampInteger(args.limit, 100, 1, 500);
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const entries = await walk(root.absolute, root.relative, maxDepth, MAX_PROJECT_FILES, ctx.boundary);
  const candidates = entries
    .filter((entry) => archiveLike(entry.relative))
    .map((entry) => ({
      path: entry.relative,
      type: entry.kind,
      sizeBytes: entry.kind === "file" ? entry.size ?? null : null,
      modifiedAt: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : null,
      reason: archiveReason(entry.relative),
    }))
    .slice(0, maxCandidates);

  return {
    root: root.relative,
    candidates,
    count: candidates.length,
    truncated: candidates.length >= maxCandidates,
    destructiveActionPerformed: false,
  };
}

export async function listArtifacts(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const maxDepth = clampInteger(args.max_depth, 5, 1, 8);
  const limit = clampInteger(args.limit, 100, 1, 500);
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const entries = await walk(root.absolute, root.relative, maxDepth, MAX_PROJECT_FILES, ctx.boundary);
  const artifacts = entries
    .filter((entry) => entry.kind === "file" && isReportLike(entry.relative))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    .slice(0, limit)
    .map((entry) => ({
      path: entry.relative,
      sizeBytes: entry.size ?? 0,
      modifiedAt: entry.mtimeMs ? new Date(entry.mtimeMs).toISOString() : null,
      kind: artifactKind(entry.relative),
    }));

  return {
    root: root.relative,
    artifacts,
    count: artifacts.length,
    truncated: artifacts.length >= limit,
  };
}

export async function readLatestReport(
  args: Record<string, unknown>,
  ctx: AdvancedToolContext,
): Promise<unknown> {
  const subpath = optionalString(args.path, ".");
  const contains = typeof args.filename_contains === "string" ? args.filename_contains.trim().slice(0, 120) : "";
  const maxChars = clampInteger(args.max_chars, 40_000, 500, 100_000);
  const root = await ctx.boundary.resolveWorkspacePath(subpath);
  ctx.boundary.assertReadable(root);
  const stat = await fs.stat(root.absolute);
  if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");

  const entries = await walk(root.absolute, root.relative, 6, MAX_PROJECT_FILES, ctx.boundary);
  const candidates = entries
    .filter((entry) => entry.kind === "file" && isReportLike(entry.relative))
    .filter((entry) => !contains || path.basename(entry.relative).toLowerCase().includes(contains.toLowerCase()))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

  const latest = candidates[0];
  if (!latest) {
    return { available: false, reasonCode: "REPORT_NOT_FOUND", query: contains || null };
  }
  if ((latest.size ?? 0) > MAX_FILE_BYTES) {
    return {
      available: false,
      reasonCode: "REPORT_TOO_LARGE",
      path: latest.relative,
      sizeBytes: latest.size ?? 0,
    };
  }

  const resolved = await ctx.boundary.resolveWorkspacePath(latest.relative);
  ctx.boundary.assertReadable(resolved);
  const bytes = await fs.readFile(resolved.absolute);
  if (isLikelyBinary(resolved.relative, bytes)) {
    return {
      available: false,
      reasonCode: "REPORT_BINARY_UNSUPPORTED",
      path: resolved.relative,
      sizeBytes: bytes.byteLength,
    };
  }
  const text = bytes.toString("utf8");
  return {
    available: true,
    path: resolved.relative,
    sizeBytes: bytes.byteLength,
    modifiedAt: latest.mtimeMs ? new Date(latest.mtimeMs).toISOString() : null,
    kind: artifactKind(resolved.relative),
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}

async function walk(
  absoluteRoot: string,
  relativeRoot: string,
  maxDepth: number,
  maxFiles: number,
  boundary: McpSecurityBoundary,
): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  let fileCount = 0;

  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    if (depth > maxDepth || fileCount >= maxFiles) return;
    const children = await safeReadDir(absolute);
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (fileCount >= maxFiles) return;
      const childRelative = normalizeSlash(path.join(relative === "." ? "" : relative, child.name));
      if (boundary.sensitivePaths.isSensitive(childRelative)) continue;
      if (child.isDirectory()) {
        if (isSkippableDirectory(child.name)) continue;
        entries.push({ relative: childRelative, absolute: path.join(absolute, child.name), kind: "dir", depth });
        await visit(path.join(absolute, child.name), childRelative, depth + 1);
      } else if (child.isFile()) {
        const stat = await fs.stat(path.join(absolute, child.name)).catch(() => null);
        if (!stat) continue;
        entries.push({
          relative: childRelative,
          absolute: path.join(absolute, child.name),
          kind: "file",
          depth,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        fileCount += 1;
      }
    }
  }

  await visit(absoluteRoot, relativeRoot, 1);
  return entries;
}

async function readJsonCandidate(
  root: { absolute: string; relative: string },
  fileName: string,
  ctx: AdvancedToolContext,
): Promise<unknown | null> {
  const relative = normalizeSlash(path.join(root.relative === "." ? "" : root.relative, fileName));
  let resolved;
  try {
    resolved = await ctx.boundary.resolveWorkspacePath(relative);
    ctx.boundary.assertReadable(resolved);
  } catch {
    return null;
  }
  const stat = await fs.stat(resolved.absolute).catch(() => null);
  if (!stat?.isFile() || stat.size > 256_000) return null;
  try {
    return JSON.parse(await fs.readFile(resolved.absolute, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

function sanitizeComponentsConfig(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const aliases = source.aliases && typeof source.aliases === "object" && !Array.isArray(source.aliases)
    ? Object.fromEntries(
        Object.entries(source.aliases as Record<string, unknown>)
          .filter(([, item]) => typeof item === "string")
          .map(([key, item]) => [key, String(item).slice(0, 300)]),
      )
    : {};
  return {
    style: typeof source.style === "string" ? source.style.slice(0, 80) : null,
    rsc: typeof source.rsc === "boolean" ? source.rsc : null,
    tsx: typeof source.tsx === "boolean" ? source.tsx : null,
    iconLibrary: typeof source.iconLibrary === "string" ? source.iconLibrary.slice(0, 80) : null,
    aliases,
    tailwindConfigured: Boolean(source.tailwind && typeof source.tailwind === "object"),
    registriesConfigured: Boolean(source.registries && typeof source.registries === "object"),
  };
}

async function safeReadDir(absolute: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stringArray(value: unknown, min: number, max: number, code: string): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max
    || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 32_768)) {
    throw new McpSecurityError(code);
  }
  return value.map((entry) => entry.trim());
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function compilePattern(pattern: string, caseSensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i");
  } catch {
    throw new McpSecurityError("invalid_search_regex");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeErrorCode(error: unknown): string {
  if (error instanceof McpSecurityError) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return "unavailable";
}

function normalizeSlash(value: string): string {
  return value.replaceAll("\\", "/") || ".";
}

function importantName(name: string): boolean {
  return /^(readme|project|status|llm)\.md$/i.test(name)
    || /^(package|tsconfig|pyproject|cargo|go\.mod)/i.test(name);
}

function archiveLike(value: string): boolean {
  return /(^|\/)(dist|build|out|coverage|backup|backups|archive|archives|tmp|temp|cache)(\/|$)/i.test(value)
    || /(?:^|[-_.])(backup|bak|copy|old|archive)(?:[-_.]|$)/i.test(value);
}

function archiveReason(value: string): string {
  if (/(^|\/)(dist|build|out|coverage|cache)(\/|$)/i.test(value)) return "generated_or_cache";
  if (/(^|\/)(backup|backups|archive|archives|tmp|temp)(\/|$)/i.test(value)) return "backup_or_archive_directory";
  if (/(?:^|[-_.])(backup|bak|copy|old|archive)(?:[-_.]|$)/i.test(value)) return "backup_like_name";
  return "archive_candidate";
}

function isReportLike(value: string): boolean {
  const base = path.basename(value).toLowerCase();
  if (!/\.(md|txt|json|log|html|csv)$/.test(base)) return false;
  return /(report|result|summary|audit|diagnostic|acceptance|evidence|status|test|build|lint|typecheck|review|handoff|lesson)/i.test(base)
    || /(^|\/)(artifacts?|reports?|evidence|diagnostics?|logs?)(\/|$)/i.test(value);
}

function artifactKind(value: string): string {
  const lower = value.toLowerCase();
  if (/diagnostic/.test(lower)) return "diagnostic";
  if (/audit/.test(lower)) return "audit";
  if (/test|build|lint|typecheck/.test(lower)) return "verification";
  if (/acceptance|evidence/.test(lower)) return "acceptance";
  if (/lesson/.test(lower)) return "lesson";
  if (/handoff/.test(lower)) return "handoff";
  return "report";
}

function isKnownBinaryExtension(name: string): boolean {
  return /\.(7z|avi|bmp|class|dll|doc|docx|exe|gif|ico|jar|jpeg|jpg|mp3|mp4|pdf|png|pyc|so|sqlite|tar|ttf|wasm|webp|woff|woff2|zip)$/i.test(name);
}

function check(id: string, label: string, passed: boolean, detail?: unknown): Record<string, unknown> {
  return { id, label, passed, ...(detail === undefined ? {} : { detail }) };
}
