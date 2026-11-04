import { promises as fs, existsSync, readFileSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
export class SupervisorInstanceLock {
    lockPath;
    record;
    constructor(lockPath, record) {
        this.lockPath = lockPath;
        this.record = record;
    }
    static async acquire(stateRoot) {
        const lockPath = path.join(stateRoot, "supervisor.lock.json");
        await fs.mkdir(stateRoot, { recursive: true });
        for (let attempt = 0; attempt < 8; attempt++) {
            const record = { pid: process.pid, startedAt: new Date().toISOString(), token: randomBytes(16).toString("hex") };
            try {
                const handle = await fs.open(lockPath, "wx");
                try {
                    await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
                }
                finally {
                    await handle.close();
                }
                return new SupervisorInstanceLock(lockPath, record);
            }
            catch (error) {
                if (!isAlreadyExists(error))
                    throw error;
                const current = await readLock(lockPath);
                if (!current)
                    throw new Error("supervisor_instance_lock_unreadable");
                if (isPidAlive(current.pid))
                    throw new Error("supervisor_instance_already_running");
                const stalePath = `${lockPath}.stale-${Date.now()}-${randomBytes(4).toString("hex")}`;
                try {
                    await fs.rename(lockPath, stalePath);
                }
                catch (renameError) {
                    if (!isAlreadyExists(renameError) && !isMissing(renameError))
                        throw renameError;
                }
            }
        }
        throw new Error("supervisor_instance_lock_contended");
    }
    async release() {
        const current = await readLock(this.lockPath);
        if (!sameOwner(current, this.record))
            return;
        try {
            await fs.unlink(this.lockPath);
        }
        catch (error) {
            if (!isMissing(error))
                throw error;
        }
    }
    releaseSync() {
        if (!existsSync(this.lockPath))
            return;
        try {
            const current = JSON.parse(readFileSync(this.lockPath, "utf8"));
            if (!sameOwner(current, this.record))
                return;
            unlinkSync(this.lockPath);
        }
        catch {
            // Reconcile stale state on the next start.
        }
    }
}
async function readLock(lockPath) {
    try {
        const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (typeof parsed.pid !== "number" || typeof parsed.token !== "string")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function sameOwner(a, b) {
    return Boolean(a && a.pid === b.pid && a.token === b.token);
}
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
    }
}
function isAlreadyExists(error) { return errorCode(error) === "EEXIST"; }
function isMissing(error) { return errorCode(error) === "ENOENT"; }
function errorCode(error) {
    if (!error || typeof error !== "object" || !("code" in error))
        return null;
    const code = error.code;
    return typeof code === "string" ? code : null;
}
