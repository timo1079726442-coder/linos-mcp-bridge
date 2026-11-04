/**
 * WindowsProcessScanner — real Win32 process query via PowerShell.
 *
 * Returns cmdline + ExecutablePath for a given PID. Used by PROVEN_SAME_RUNTIME
 * to verify that an observed Runtime process is actually one that the current
 * Supervisor (or a known prior one) spawned.
 *
 * For non-Windows platforms, falls back to /proc/<pid>/cmdline.
 */
import { execFile } from "node:child_process";

export interface ProcessInfo {
  pid: number;
  cmdline: string;
  executablePath: string;
  startTime: string | null;
}

export async function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    return await getProcessInfoWindows(pid);
  }
  return await getProcessInfoLinux(pid);
}

export const WINDOWS_PROCESS_QUERY_OPTIONS = Object.freeze({ encoding: "utf8" as const, timeout: 5000, windowsHide: true });

async function getProcessInfoWindows(pid: number): Promise<ProcessInfo | null> {
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"
if ($null -eq $p) { exit 1 }
$startTime = $null
try {
  $startTime = (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CreationDate -ErrorAction SilentlyContinue)
  if ($startTime) { $startTime = $startTime.ToString('o') }
} catch {}
[pscustomobject]@{
  pid = ${pid}
  cmdline = [string]$p.CommandLine
  executablePath = [string]$p.ExecutablePath
  startTime = $startTime
} | ConvertTo-Json -Compress
`;
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      WINDOWS_PROCESS_QUERY_OPTIONS,
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as {
            pid: number;
            cmdline: string;
            executablePath: string;
            startTime: string | null;
          };
          resolve({
            pid: parsed.pid,
            cmdline: parsed.cmdline ?? "",
            executablePath: parsed.executablePath ?? "",
            startTime: parsed.startTime,
          });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

async function getProcessInfoLinux(pid: number): Promise<ProcessInfo | null> {
  const { promises: fs } = await import("node:fs");
  try {
    const cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" ");
    const exe = (await fs.readlink(`/proc/${pid}/exe`, "utf8").catch(() => "")).toString();
    const stat = (await fs.stat(`/proc/${pid}`).catch(() => null)) as { mtimeMs?: number } | null;
    return {
      pid,
      cmdline,
      executablePath: exe,
      startTime: stat && stat.mtimeMs ? new Date(stat.mtimeMs).toISOString() : null,
    };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ExpectedIdentity {
  pid: number;
  deviceId: string;
  profileId: string;
  runtimeId: string;
  runtimeInstanceId: string;
  workspaceId: string;
  expectedPort: number;
  commandImage: string;
  startWindow: { earliest: number; latest: number };
  challenge: {
    issuedAt: number;
    nonce: string;
    signatureB64: string;
    expectedSignatureB64: string;
  };
}

export interface ObservedIdentity {
  pid: number;
  port: number;
  identity: {
    deviceId: string;
    profileId: string;
    runtimeId: string;
    runtimeInstanceId: string;
    workspaceId: string;
  };
  processStartTime: string | null;
  commandImage: string;
  challengeVerified: boolean;
}

/**
 * PROVEN_SAME_RUNTIME structural predicate.
 *
 * Caller is expected to have already completed the challenge round-trip and
 * pass `challengeVerified = true`.
 */
export function provenSameRuntime(expected: ExpectedIdentity, observed: ObservedIdentity): boolean {
  if (observed.pid !== expected.pid) return false;
  if (observed.port !== expected.expectedPort) return false;
  if (observed.commandImage !== expected.commandImage) return false;
  if (
    observed.identity.deviceId !== expected.deviceId ||
    observed.identity.profileId !== expected.profileId ||
    observed.identity.runtimeId !== expected.runtimeId ||
    observed.identity.runtimeInstanceId !== expected.runtimeInstanceId ||
    observed.identity.workspaceId !== expected.workspaceId
  ) {
    return false;
  }
  if (!observed.challengeVerified) return false;
  if (observed.processStartTime) {
    const t = Date.parse(observed.processStartTime);
    if (t < expected.startWindow.earliest || t > expected.startWindow.latest) return false;
  }
  return true;
}