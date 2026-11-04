import { promises as fs } from "node:fs";
import * as path from "node:path";

export type PathContainmentFailure = "INVALID_PATH" | "WORKSPACE_UNAVAILABLE" | "OUTSIDE_WORKSPACE" | "PATH_UNRESOLVABLE";

export type ContainedPathResult =
  | { ok: true; workspaceRoot: string; targetPath: string }
  | { ok: false; reason: PathContainmentFailure };

export function normalizePathForComparison(value: string): string {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const remainder = absolute.slice(root.length).replace(/[\\/]+$/, "");
  const normalized = remainder ? path.join(root, remainder) : root;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePathForComparison(root);
  const normalizedCandidate = normalizePathForComparison(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Resolve existing path components through realpath before making a scope
 * decision. Missing final components are appended only to a resolved existing
 * ancestor; this supports safe checks for not-yet-created files.
 */
export async function resolvePathWithinWorkspace(workspaceRoot: string | null, candidate: string): Promise<ContainedPathResult> {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || !path.isAbsolute(candidate)) {
    return { ok: false, reason: "INVALID_PATH" };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(path.resolve(workspaceRoot));
    const rootStats = await fs.stat(canonicalRoot);
    if (!rootStats.isDirectory()) return { ok: false, reason: "WORKSPACE_UNAVAILABLE" };
  } catch {
    return { ok: false, reason: "WORKSPACE_UNAVAILABLE" };
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpathWithMissingTail(path.resolve(candidate));
  } catch {
    return { ok: false, reason: "PATH_UNRESOLVABLE" };
  }

  if (!isPathWithin(canonicalRoot, canonicalTarget)) return { ok: false, reason: "OUTSIDE_WORKSPACE" };
  return { ok: true, workspaceRoot: canonicalRoot, targetPath: canonicalTarget };
}

async function realpathWithMissingTail(absolutePath: string): Promise<string> {
  let cursor = absolutePath;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const resolvedAncestor = await fs.realpath(cursor);
      return path.resolve(resolvedAncestor, ...missingSegments);
    } catch (error: unknown) {
      if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
