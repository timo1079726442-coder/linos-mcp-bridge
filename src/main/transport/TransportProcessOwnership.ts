import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getProcessInfo, isProcessAlive } from "../process/ProcessScanner.js";

export interface TransportIdentity {
  provider: string;
  tunnelId: string;
  tunnelName: string;
  hostname: string;
  credentialPath: string;
}

export interface TransportProcessOwnershipRecord extends TransportIdentity {
  pid: number;
  startedAt: string;
  credentialPathHash: string;
  active: boolean;
}

export type OwnershipVerdict = "NONE" | "OWNED_PROCESS" | "STALE" | "FOREIGN_PROCESS" | "UNKNOWN";

/**
 * V2-only process ownership proof for cloudflared.
 *
 * A PID or a process name is never enough. The command line must carry the
 * V2 tunnel id, tunnel name, and explicit V2 credential path, and the
 * executable must match the configured binary. Legacy/foreign processes are
 * therefore fail-closed and are never terminated by this class.
 */
export class TransportProcessOwnership {
  constructor(private readonly statePath: string) {}

  async read(): Promise<TransportProcessOwnershipRecord | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8")) as TransportProcessOwnershipRecord;
      if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || !parsed.tunnelId || !parsed.tunnelName || !parsed.credentialPathHash) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async record(identity: TransportIdentity, pid: number, startedAt: string): Promise<TransportProcessOwnershipRecord> {
    const value: TransportProcessOwnershipRecord = {
      ...identity,
      pid,
      startedAt,
      credentialPathHash: hashPath(identity.credentialPath),
      active: true,
    };
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temp, this.statePath);
    return value;
  }

  async clear(): Promise<void> {
    await fs.rm(this.statePath, { force: true }).catch(() => undefined);
  }

  async inspect(identity: TransportIdentity, binaryPath: string | null): Promise<OwnershipVerdict> {
    const record = await this.read();
    if (!record) return "NONE";
    if (!sameIdentity(record, identity)) return "FOREIGN_PROCESS";
    if (!isProcessAlive(record.pid)) return "STALE";
    const info = await getProcessInfo(record.pid);
    if (!info) return "UNKNOWN";
    const cmdline = normalize(info.cmdline);
    const expectedCredential = normalize(identity.credentialPath);
    const expectedBinary = binaryPath ? normalize(binaryPath) : null;
    const executableMatches = expectedBinary === null || normalize(info.executablePath) === expectedBinary;
    const commandMatches =
      cmdline.includes(normalize(identity.tunnelId)) &&
      cmdline.includes(normalize(identity.tunnelName)) &&
      cmdline.includes(expectedCredential);
    return executableMatches && commandMatches ? "OWNED_PROCESS" : "FOREIGN_PROCESS";
  }

  async terminateIfOwned(identity: TransportIdentity, binaryPath: string | null): Promise<OwnershipVerdict> {
    const verdict = await this.inspect(identity, binaryPath);
    if (verdict !== "OWNED_PROCESS") return verdict;
    const record = await this.read();
    if (!record) return "UNKNOWN";
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/PID", String(record.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      });
    } else {
      try { process.kill(record.pid, "SIGTERM"); } catch { /* already stopped */ }
    }
    await this.clear();
    return "OWNED_PROCESS";
  }
}

export function hashPath(value: string): string {
  return createHash("sha256").update(normalize(value), "utf8").digest("hex");
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(/^"|"$/g, "").toLowerCase();
}

function sameIdentity(left: TransportProcessOwnershipRecord, right: TransportIdentity): boolean {
  return left.provider === right.provider &&
    left.tunnelId === right.tunnelId &&
    left.tunnelName === right.tunnelName &&
    left.hostname === right.hostname &&
    left.credentialPathHash === hashPath(right.credentialPath);
}
