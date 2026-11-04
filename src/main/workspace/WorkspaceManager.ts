import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { WorkspaceInfo, WorkspaceId, WorkspaceCandidate, GitChangeSummary } from "../../shared/types.js";

/**
 * WorkspaceManager — validates, detects, and inspects workspace directories.
 *
 * Identity: workspaceId = sha256(lowercase(realpath))[:12]
 * Per CP1 IDENTITY_MODEL_V2 §2, workspaceId NEVER participates in
 * Transport Identity or Runtime Identity calculation.
 */
export class WorkspaceManager {
  async validate(root: string): Promise<WorkspaceInfo> {
    const exists = await this.exists(root);
    if (!exists) {
      return {
        root,
        workspaceId: await this.computeWorkspaceId(root),
        exists: false,
        isGitRepo: false,
        branch: null,
        commit: null,
        dirty: null,
      };
    }
    const isGitRepo = await this.detectGit(root);
    let branch: string | null = null;
    let commit: string | null = null;
    let dirty: boolean | null = null;
    if (isGitRepo) {
      try {
        branch = (await this.runGitResult(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || null;
        commit = (await this.runGitResult(root, ["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
        // Fail closed: a failed status command means "unknown", NOT "clean".
        const status = await this.runGitResult(root, ["status", "--porcelain", "--", "."]);
        dirty = status.ok ? status.stdout.trim().length > 0 : null;
      } catch {
        // Git operations failed; treat as unknown rather than claiming clean.
        branch = null;
        commit = null;
        dirty = null;
      }
    }
    return {
      root: await this.realpath(root),
      workspaceId: await this.computeWorkspaceId(root),
      exists: true,
      isGitRepo,
      branch,
      commit,
      dirty,
    };
  }

  async detect(root: string): Promise<WorkspaceCandidate> {
    const info = await this.validate(root);
    const project = await this.detectProject(root);
    return {
      root: info.root,
      workspaceId: info.workspaceId,
      isGitRepo: info.isGitRepo,
      projectType: project.projectType,
      languages: project.languages,
      frameworks: project.frameworks,
    };
  }

  /**
   * Bounded Git change summary: file paths + line-count stats only. Never
   * returns diff bodies or file contents, so no source material can leak.
   *
   * Fail-closed: a git command that fails yields `available: false` with
   * `reasonCode: "GIT_COMMAND_FAILED"`. It must never be reported as an empty
   * (i.e. clean) change list, because "command failed" and "no changes" are
   * different facts and conflating them hides real failures.
   */
  async gitChanges(root: string): Promise<GitChangeSummary> {
    const info = await this.validate(root);
    if (!info.isGitRepo || !info.exists) {
      return {
        available: false,
        isGitRepo: info.isGitRepo,
        branch: info.branch,
        changedFiles: [],
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
        truncated: false,
        reasonCode: "NOT_A_GIT_REPO",
      };
    }

    // Primary source: porcelain status. A failure here means we cannot claim
    // anything about the tree, so fail closed.
    const statusResult = await this.runGitResult(root, ["status", "--porcelain", "--", "."]);
    if (!statusResult.ok) {
      return {
        available: false,
        isGitRepo: true,
        branch: info.branch,
        changedFiles: [],
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
        truncated: false,
        reasonCode: "GIT_COMMAND_FAILED",
      };
    }

    // Secondary source: line-count stats. A failure would otherwise surface as
    // "+0/-0", which reads as "no line changes"; fail closed instead.
    const shortstatResult = await this.runGitResult(root, ["diff", "--shortstat", "--", "."]);
    if (!shortstatResult.ok) {
      return {
        available: false,
        isGitRepo: true,
        branch: info.branch,
        changedFiles: [],
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
        truncated: false,
        reasonCode: "GIT_COMMAND_FAILED",
      };
    }

    const changedFiles: Array<{ path: string; status: string }> = [];
    const MAX_FILES = 500;
    const lines = statusResult.stdout.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines.slice(0, MAX_FILES)) {
      const trimmed = line.trimEnd();
      if (trimmed.length < 4) continue;
      const statusCode = trimmed.slice(0, 2).trim();
      const filePath = trimmed.slice(3).trim().replace(/^["']|["']$/g, "");
      if (!filePath) continue;
      changedFiles.push({ path: filePath.slice(0, 500), status: statusCode || "?" });
    }

    let filesChanged = changedFiles.length;
    let insertions = 0;
    let deletions = 0;
    const insMatch = /(\d+) insertions?\(\+\)/.exec(shortstatResult.stdout);
    const delMatch = /(\d+) deletions?\(-\)/.exec(shortstatResult.stdout);
    insertions = insMatch ? Number(insMatch[1]) : 0;
    deletions = delMatch ? Number(delMatch[1]) : 0;
    if (filesChanged === 0) {
      const filesMatch = /(\d+) files? changed/.exec(shortstatResult.stdout);
      filesChanged = filesMatch ? Number(filesMatch[1]) : 0;
    }

    return {
      available: true,
      isGitRepo: true,
      branch: info.branch,
      changedFiles,
      stats: { filesChanged, insertions, deletions },
      truncated: lines.length > MAX_FILES,
    };
  }

  /** Compute workspaceId from realpath. Pure (best-effort). */
  async computeWorkspaceId(root: string): Promise<WorkspaceId> {
    let real = root;
    try {
      real = await fs.realpath(root);
    } catch {
      // not exist yet; use lowercased as-given
    }
    const normalized = process.platform === "win32" || process.platform === "darwin"
      ? real.toLowerCase()
      : real;
    return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  /** Detect basic project metadata. Best-effort; never throws. */
  async detectProject(root: string): Promise<{
    projectType: string;
    languages: string[];
    frameworks: string[];
  }> {
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let projectType = "unknown";

    if (await this.exists(path.join(root, "package.json"))) {
      projectType = projectType === "unknown" ? "node" : projectType;
      languages.add("JavaScript");
      try {
        const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as Record<string, unknown>;
        const deps: Record<string, string> = {};
        for (const k of ["dependencies", "devDependencies"]) {
          const v = pkg[k];
          if (v && typeof v === "object") Object.assign(deps, v as Record<string, string>);
        }
        const known: Record<string, string> = {
          next: "Next.js",
          react: "React",
          vue: "Vue",
          svelte: "Svelte",
          express: "Express",
          fastify: "Fastify",
          "@nestjs/core": "NestJS",
          electron: "Electron",
        };
        for (const [dep, label] of Object.entries(known)) {
          if (deps[dep]) frameworks.add(label);
        }
      } catch {
        // ignore malformed package.json
      }
    }
    if (await this.exists(path.join(root, "tsconfig.json"))) languages.add("TypeScript");
    if (await this.exists(path.join(root, "pyproject.toml")) || await this.exists(path.join(root, "requirements.txt"))) {
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (await this.exists(path.join(root, "Cargo.toml"))) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (await this.exists(path.join(root, "go.mod"))) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }

    return { projectType, languages: [...languages], frameworks: [...frameworks] };
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  private async realpath(p: string): Promise<string> {
    try {
      return await fs.realpath(p);
    } catch {
      return p;
    }
  }

  private async detectGit(root: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => {
        resolve(code === 0 && stdout.trim() === "true");
      });
    });
  }

  /**
   * Run a git command and report whether it actually succeeded.
   *
   * Returns RAW stdout (not trimmed): `git status --porcelain` uses a fixed
   * leading status column, so trimming the whole output would swallow the first
   * line's leading space and corrupt the first path. Callers trim as needed.
   *
   * The previous fire-and-forget helper resolved an empty string on failure,
   * which made "git failed" indistinguishable from "git returned nothing" and
   * produced false-clean states (dirty=false, 0 changed files).
   */
  private runGitResult(root: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
    return new Promise((resolve) => {
      const proc = spawn("git", args, { cwd: root });
      let stdout = "";
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve({ ok, stdout });
      };
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      proc.on("error", () => finish(false));
      proc.on("close", (code) => finish(code === 0));
    });
  }
}