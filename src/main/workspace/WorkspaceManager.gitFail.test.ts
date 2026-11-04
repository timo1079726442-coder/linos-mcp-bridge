import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Deterministic git-failure tests for WorkspaceManager.
 *
 * Isolated in its own file so the node:child_process mock cannot affect the
 * real-temp-dir tests in WorkspaceManager.test.ts (vitest isolates per file).
 *
 * Regression target: a git command that FAILS must never be reported as an
 * empty/clean state. "command failed" and "no changes" are different facts.
 */
const state = vi.hoisted(() => ({
  statusOk: true,
  statusOutput: "",
  shortstatOk: true,
  shortstatOutput: "",
}));

vi.mock("node:child_process", () => {
  const spawn = (_cmd: string, args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    const key = args.join(" ");
    setImmediate(() => {
      if (key === "rev-parse --is-inside-work-tree") {
        proc.stdout.emit("data", Buffer.from("true", "utf8"));
        proc.emit("close", 0);
        return;
      }
      if (key === "rev-parse --abbrev-ref HEAD") {
        proc.stdout.emit("data", Buffer.from("main", "utf8"));
        proc.emit("close", 0);
        return;
      }
      if (key === "rev-parse --short HEAD") {
        proc.stdout.emit("data", Buffer.from("abc1234", "utf8"));
        proc.emit("close", 0);
        return;
      }
      if (key === "status --porcelain -- .") {
        if (!state.statusOk) { proc.emit("close", 128); return; }
        if (state.statusOutput) proc.stdout.emit("data", Buffer.from(state.statusOutput, "utf8"));
        proc.emit("close", 0);
        return;
      }
      if (key === "diff --shortstat -- .") {
        if (!state.shortstatOk) { proc.emit("close", 128); return; }
        if (state.shortstatOutput) proc.stdout.emit("data", Buffer.from(state.shortstatOutput, "utf8"));
        proc.emit("close", 0);
        return;
      }
      proc.emit("close", 0);
    });
    return proc;
  };
  return { spawn, default: { spawn } };
});

import { WorkspaceManager } from "./WorkspaceManager.js";

let repoDir = "";

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "c2c-wm-gitfail-"));
  state.statusOk = true;
  state.statusOutput = "";
  state.shortstatOk = true;
  state.shortstatOutput = "";
});

describe("WorkspaceManager git fail-closed", () => {
  it("gitChanges reports GIT_COMMAND_FAILED (not a clean tree) when git status fails", async () => {
    state.statusOk = false;
    const wm = new WorkspaceManager();
    const summary = await wm.gitChanges(repoDir);
    expect(summary.available).toBe(false);
    expect(summary.reasonCode).toBe("GIT_COMMAND_FAILED");
    // Must not look like "no changes": available=false is the contract.
    expect(summary.changedFiles).toEqual([]);
  });

  it("gitChanges reports GIT_COMMAND_FAILED when git diff --shortstat fails", async () => {
    state.statusOk = true;
    state.statusOutput = " M src/a.ts\n";
    state.shortstatOk = false;
    const wm = new WorkspaceManager();
    const summary = await wm.gitChanges(repoDir);
    expect(summary.available).toBe(false);
    expect(summary.reasonCode).toBe("GIT_COMMAND_FAILED");
  });

  it("validate marks dirty=null (unknown) when git status fails, never false", async () => {
    state.statusOk = false;
    const wm = new WorkspaceManager();
    const info = await wm.validate(repoDir);
    expect(info.isGitRepo).toBe(true);
    expect(info.dirty).toBeNull();
  });

  it("gitChanges parses real output when git succeeds", async () => {
    state.statusOutput = " M src/a.ts\n?? src/b.ts\n";
    state.shortstatOutput = " 3 files changed, 10 insertions(+), 2 deletions(-)";
    const wm = new WorkspaceManager();
    const summary = await wm.gitChanges(repoDir);
    expect(summary.available).toBe(true);
    expect(summary.reasonCode).toBeUndefined();
    expect(summary.changedFiles).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "??" },
    ]);
    expect(summary.stats).toEqual({ filesChanged: 2, insertions: 10, deletions: 2 });
  });

  it("gitChanges reports NOT_A_GIT_REPO for a non-git directory", async () => {
    // detectGit false -> validate reports isGitRepo=false -> reasonCode NOT_A_GIT_REPO
    const wm = new WorkspaceManager();
    // Force detectGit to fail by making rev-parse --is-inside-work-tree fail.
    // The mock returns "true" for that command, so instead assert via a
    // non-existent path which short-circuits before git.
    const summary = await wm.gitChanges(join(repoDir, "does-not-exist"));
    expect(summary.available).toBe(false);
    expect(summary.reasonCode).toBe("NOT_A_GIT_REPO");
  });

  it("validate marks dirty=false only when git status truly succeeds empty", async () => {
    state.statusOk = true;
    state.statusOutput = "";
    const wm = new WorkspaceManager();
    const info = await wm.validate(repoDir);
    expect(info.dirty).toBe(false);
  });
});
