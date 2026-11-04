import { promises as fs, existsSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

interface LockRecord {
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * One control-plane Supervisor per state root.
 *
 * The lock is intentionally independent from the AuditChain. A second
 * Supervisor must be rejected before it can open or append to the chain.
 * Stale locks are moved aside, never blindly deleted, and release checks the
 * ownership token so a late process cannot remove a newer lock.
 */
export class SupervisorInstanceLock {
  private constructor(
    private readonly lockPath: string,
    private readonly record: LockRecord,
  ) {}

  static async acquire(stateRoot: string): Promise<SupervisorInstanceLock> {
    const lockPath = path.join(stateRoot, "supervisor.lock.json");
    await fs.mkdir(stateRoot, { recursive: true });

    for (let attempt = 0; attempt < 8; attempt++) {
      const record: LockRecord = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token: randomBytes(16).toString("hex"),
      };
      try {
        const handle = await fs.open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
        } finally {
          await handle.close();
        }
        return new SupervisorInstanceLock(lockPath, record);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const current = await readLock(lockPath);
        if (!current) {
          // Never treat a partially written/unknown lock as stale: doing so
          // could let two Supervisors race while the first owner is writing.
          throw new Error("supervisor_instance_lock_unreadable");
        }
        if (current && isPidAlive(current.pid)) {
          throw new Error("supervisor_instance_already_running");
        }
        const stalePath = `${lockPath}.stale-${Date.now()}-${randomBytes(4).toString("hex")}`;
        try {
          await fs.rename(lockPath, stalePath);
        } catch (renameError) {
          // Another contender may have reconciled the stale lock. Retry the
          // exclusive create rather than deleting an unknown file.
          if (!isAlreadyExists(renameError) && !isMissing(renameError)) throw renameError;
        }
      }
    }
    throw new Error("supervisor_instance_lock_contended");
  }

  async release(): Promise<void> {
    const current = await readLock(this.lockPath);
    if (!sameOwner(current, this.record)) return;
    try {
      await fs.unlink(this.lockPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /** Best-effort crash/exit cleanup; ownership is checked before unlinking. */
  releaseSync(): void {
    if (!existsSync(this.lockPath)) return;
    try {
      const current = JSON.parse(readFileSync(this.lockPath, "utf8")) as LockRecord;
      if (!sameOwner(current, this.record)) return;
      unlinkSync(this.lockPath);
    } catch {
      // A stale lock is safe to reconcile on the next Supervisor start.
    }
  }
}

async function readLock(lockPath: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return parsed as LockRecord;
  } catch {
    return null;
  }
}

function sameOwner(a: LockRecord | null, b: LockRecord): boolean {
  return Boolean(a && a.pid === b.pid && a.token === b.token);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EPERM");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
