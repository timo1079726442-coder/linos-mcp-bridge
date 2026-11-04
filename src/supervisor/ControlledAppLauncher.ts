/**
 * Controlled native launcher. This is an internal execution primitive, NOT a
 * remotely registered MCP tool. A trusted Supervisor handler must verify
 * OAuth caller identity, user approval, and policy before invoking it.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface LaunchAppRequest {
  programPath: string;
  allowedRoots: readonly string[];
  /** Exact approved executable digest, captured as part of approval. */
  expectedSha256: string;
  /** Only exact approved executables may launch (not merely any EXE in a root). */
  approvedPrograms: readonly string[];
  args?: readonly string[];
}

export interface LaunchAppResult {
  status: "STARTED" | "FAILED" | "REJECTED";
  pid: number | null;
  code: string;
}

export interface LaunchAppAudit {
  (event: { action: "launch_app"; status: LaunchAppResult["status"]; code: string; pid: number | null; pathHash: string }): Promise<void>;
}
export interface LaunchAppApproval {
  (request: { programPath: string; sha256: string; args: readonly string[] }): Promise<boolean>;
}

export async function launchApprovedApp(
  request: LaunchAppRequest,
  approve: LaunchAppApproval,
  audit: LaunchAppAudit,
  spawnProgram: typeof spawn = spawn,
): Promise<LaunchAppResult> {
  let canonical = "";
  let pid: number | null = null;
  const conclude = async (status: LaunchAppResult["status"], code: string): Promise<LaunchAppResult> => {
    await audit({
      action: "launch_app",
      status,
      code,
      pid,
      pathHash: createHash("sha256").update(canonical.toLowerCase()).digest("hex"),
    });
    return { status, pid, code };
  };
  try {
    if (process.platform !== "win32") return await conclude("REJECTED", "WINDOWS_ONLY");
    if (typeof request.programPath !== "string" || !path.win32.isAbsolute(request.programPath)
      || !/\.exe$/i.test(request.programPath)
      || !/^[a-f0-9]{64}$/.test(request.expectedSha256)) {
      return await conclude("REJECTED", "PROGRAM_INVALID");
    }
    if (!Array.isArray(request.args) && request.args !== undefined) return await conclude("REJECTED", "ARGS_INVALID");
    const args = [...(request.args ?? [])];
    if (args.length > 12 || args.some((arg) => typeof arg !== "string" || arg.length > 512 || /[\u0000-\u001f]/.test(arg))) {
      return await conclude("REJECTED", "ARGS_INVALID");
    }
    canonical = await fs.realpath(request.programPath);
    const program = path.win32.normalize(canonical).toLowerCase();
    const permittedRoots = await Promise.all(request.allowedRoots.map((root) => fs.realpath(root).catch(() => "")));
    const inside = permittedRoots.some((root) => {
      if (!root) return false;
      const relative = path.win32.relative(root, canonical);
      return relative !== "" && relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative);
    });
    if (!inside || !request.approvedPrograms.some((candidate) => path.win32.normalize(candidate).toLowerCase() === program)) {
      return await conclude("REJECTED", "PROGRAM_NOT_ALLOWLISTED");
    }
    const info = await fs.lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 200 * 1024 * 1024) {
      return await conclude("REJECTED", "PROGRAM_UNSAFE");
    }
    const bytes = await fs.readFile(canonical);
    const digest = createHash("sha256").update(bytes).digest("hex");
    bytes.fill(0);
    if (digest !== request.expectedSha256) return await conclude("REJECTED", "PROGRAM_CHANGED");
    if (!await approve({ programPath: canonical, sha256: digest, args })) {
      return await conclude("REJECTED", "OWNER_REJECTED");
    }
    // Recheck after approval. If the file changed during the prompt, fail closed.
    const recheck = await fs.readFile(canonical);
    const currentDigest = createHash("sha256").update(recheck).digest("hex");
    recheck.fill(0);
    if (currentDigest !== digest) return await conclude("REJECTED", "PROGRAM_CHANGED");

    const child: ChildProcess = spawnProgram(canonical, args, {
      cwd: path.dirname(canonical),
      shell: false,
      windowsHide: false,
      stdio: "ignore",
      detached: false,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
    });
    const spawned = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      child.once("spawn", () => { clearTimeout(timeout); resolve(true); });
      child.once("error", () => { clearTimeout(timeout); resolve(false); });
    });
    if (!spawned || !Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      if (spawned) child.kill();
      return await conclude("FAILED", "SPAWN_FAILED_OR_NO_PID");
    }
    pid = child.pid ?? null;
    child.unref();
    return await conclude("STARTED", "PROCESS_CREATED_NOT_HEALTH_VERIFIED");
  } catch {
    return await conclude("FAILED", "LAUNCH_FAILED");
  }
}
