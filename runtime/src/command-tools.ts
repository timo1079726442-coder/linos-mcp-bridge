/**
 * command-tools — 受限命令、PowerShell 与 Git 提交（全部走审批 + 授权目录 + 超时/输出上限）。
 *
 * 设计：默认关闭，策略里单独开启；命令不做 shell 解释（spawn shell:false），
 * 只允许固定白名单；PowerShell 是显式的“当前用户权限、无沙箱”，需单独开关。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { McpSecurityBoundary } from "./security-boundary.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 200_000;

export interface CommandResult {
  ok: boolean;
  command: string;
  cwd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
}

export function tokenizeCommand(command: string): string[] {
  return tokenize(command);
}

export function assertAllowedCommand(argv: string[]): void {
  assertAllowed(argv);
}

function tokenize(command: string): string[] {
  if (typeof command !== "string" || !command.trim() || command.length > 4_000 || /[\u0000\r\n]/.test(command)) {
    throw new Error("COMMAND_INVALID");
  }
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const tokens = matches.map((token) => token.replace(/^["']|["']$/g, ""));
  if (tokens.length === 0) throw new Error("COMMAND_INVALID");
  if (tokens.some((token) => /[|&;<>`$(){}\[\]]/.test(token))) throw new Error("COMMAND_METACHAR_DENIED");
  return tokens;
}

function assertAllowed(argv: string[]): void {
  const base = path.basename(argv[0] ?? "").toLowerCase();
  const rest = argv.slice(1);
  if (!base) throw new Error("COMMAND_INVALID");
  if (rest.some((arg) => arg === "-c" || arg === "--exec" || arg === "--exec-path" || arg.includes(".."))) {
    throw new Error("COMMAND_ARGUMENT_DENIED");
  }
  if (base === "git") {
    const sub = rest[0] ?? "";
    // 只读子命令任何时候都允许。
    const READ_ONLY = ["status", "diff", "log", "show", "rev-parse", "branch", "ls-files", "blame", "shortlog", "describe"];
    if (READ_ONLY.includes(sub)) return;
    // 写操作（add/commit/push/pull/fetch/merge/...）交给工具策略决定是否放开：
    // 只要 run_command 在策略里是"已开启"，就允许完整的 git 工作流（像本地 agent 一样）。
    const WRITE = [
      "add", "commit", "push", "pull", "fetch", "merge", "rebase", "cherry-pick", "revert",
      "reset", "restore", "checkout", "switch", "stash", "tag", "remote", "init", "clone", "rm", "mv", "clean", "config", "worktree",
    ];
    if (WRITE.includes(sub)) return;
    throw new Error("COMMAND_NOT_ALLOWED");
  }
  if (base === "npm" || base === "npm.cmd") {
    if (rest[0] === "test") return;
    if (rest[0] === "run" && ["build", "lint", "typecheck", "test"].includes(rest[1] ?? "")) return;
    throw new Error("COMMAND_NOT_ALLOWED");
  }
  if (base === "python" || base === "python3" || base === "py") {
    if (rest[0] === "-m" && rest[1] === "pytest") return;
    if (rest[0] && /\.py$/i.test(rest[0])) return;
    throw new Error("COMMAND_NOT_ALLOWED");
  }
  if (base === "pytest") return;
  if (base === "node") {
    if (rest[0] && /\.(js|mjs|cjs)$/i.test(rest[0])) return;
    throw new Error("COMMAND_NOT_ALLOWED");
  }
  throw new Error("COMMAND_NOT_ALLOWED");
}

function boundedTimeout(value: unknown): number {
  const timeout = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, timeout));
}

export function commandSpawnEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
  };
}

async function runProcess(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  display: string,
): Promise<CommandResult> {
  const started = Date.now();
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      shell: false,
      windowsHide: true,
      env: commandSpawnEnv(),
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const append = (target: "out" | "err", chunk: Buffer): void => {
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const text = chunk.toString("utf8");
      if (target === "out") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        command: display,
        cwd,
        exit_code: code,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        truncated: truncated || stdout.length + stderr.length > MAX_OUTPUT_BYTES,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
      });
    });
  });
}

export async function executeCommand(
  boundary: McpSecurityBoundary,
  args: { command?: unknown; cwd?: unknown; timeout_ms?: unknown },
): Promise<CommandResult> {
  const argv = Array.isArray(args.command)
    ? args.command.map((value) => String(value))
    : tokenize(typeof args.command === "string" ? args.command : "");
  assertAllowed(argv);
  const cwd = await boundary.resolveWritePath(typeof args.cwd === "string" && args.cwd ? args.cwd : ".");
  const stat = await fs.stat(cwd.absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("CWD_NOT_DIRECTORY");
  return await runProcess(argv, cwd.absolute, boundedTimeout(args.timeout_ms), argv.join(" "));
}

export async function resolvePowerShellArgv(
  command: string,
  mode: "user" | "constrained",
): Promise<{ argv: string[]; display: string }> {
  if (!command.trim() || command.length > 4_000 || command.includes("\0")) throw new Error("COMMAND_INVALID");
  const exe = process.env.MCP_BRIDGE_PWSH || await fs.access("C:\\Program Files\\PowerShell\\7\\pwsh.exe").then(() => "C:\\Program Files\\PowerShell\\7\\pwsh.exe").catch(() => "powershell.exe");
  const script = mode === "constrained"
    ? `$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; ${command}`
    : command;
  const argv = mode === "constrained"
    ? [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command", script]
    : [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  return { argv, display: `[${mode}] ${command}` };
}

export async function runPowerShell(
  boundary: McpSecurityBoundary,
  args: { command?: unknown; cwd?: unknown; timeout_ms?: unknown; mode?: unknown },
): Promise<CommandResult> {
  const command = typeof args.command === "string" ? args.command : "";
  const mode = args.mode === "constrained" ? "constrained" : "user";
  const cwd = await boundary.resolveWritePath(typeof args.cwd === "string" && args.cwd ? args.cwd : ".");
  const stat = await fs.stat(cwd.absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("CWD_NOT_DIRECTORY");
  const { argv, display } = await resolvePowerShellArgv(command, mode);
  const result = await runProcess(argv, cwd.absolute, boundedTimeout(args.timeout_ms), display);
  return { ...result, mode } as CommandResult & { mode: string };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

export async function gitCommit(
  boundary: McpSecurityBoundary,
  args: { cwd?: unknown; message?: unknown; allow_empty?: unknown },
): Promise<{ ok: true; commit: string; branch: string; message: string; cwd: string }> {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message || message.length > 500 || /[\u0000\r\n]/.test(message)) throw new Error("COMMIT_MESSAGE_INVALID");
  const cwd = await boundary.resolveWritePath(typeof args.cwd === "string" && args.cwd ? args.cwd : ".");
  const repo = await runProcess(["git", "-C", cwd.absolute, "rev-parse", "--show-toplevel"], cwd.absolute, 30_000, "git rev-parse");
  if (!repo.ok) throw new Error("NOT_A_GIT_REPOSITORY");
  const repoRoot = firstLine(repo.stdout);
  if (!repoRoot) throw new Error("NOT_A_GIT_REPOSITORY");
  await boundary.resolveWritePath(repoRoot);
  const staged = await runProcess(["git", "-C", cwd.absolute, "diff", "--cached", "--name-only"], cwd.absolute, 30_000, "git diff --cached");
  if (!staged.ok) throw new Error("GIT_STATUS_FAILED");
  if (!staged.stdout.trim() && args.allow_empty !== true) throw new Error("NO_STAGED_CHANGES");
  const commit = await runProcess(
    ["git", "-C", cwd.absolute, "commit", "-m", message, ...(args.allow_empty === true ? ["--allow-empty"] : [])],
    cwd.absolute,
    60_000,
    "git commit",
  );
  if (!commit.ok) throw new Error(`GIT_COMMIT_FAILED：${firstLine(commit.stderr) || firstLine(commit.stdout)}`);
  const hash = await runProcess(["git", "-C", cwd.absolute, "rev-parse", "--short", "HEAD"], cwd.absolute, 30_000, "git rev-parse");
  const branch = await runProcess(["git", "-C", cwd.absolute, "rev-parse", "--abbrev-ref", "HEAD"], cwd.absolute, 30_000, "git branch");
  return {
    ok: true,
    commit: firstLine(hash.stdout),
    branch: firstLine(branch.stdout),
    message,
    cwd: cwd.display,
  };
}
