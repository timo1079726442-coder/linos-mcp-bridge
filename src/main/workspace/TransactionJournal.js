import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
/**
 * TransactionJournal — durable Write-Ahead + Complete Marker journal for
 * Workspace Change Transactions. Per CP1-R3 §2.
 *
 * Each sub-step is a 3-phase write:
 *   PREPARED → mutation (idempotent) → verify → COMPLETED
 *
 * Crash recovery uses IDEMPOTENT_COMMIT_RECOVERY semantics.
 */
export class TransactionJournalStore {
    journalPath;
    constructor(stateRoot, profileId) {
        this.journalPath = path.join(stateRoot, "profiles", profileId, "transaction-journal.json");
    }
    async exists() {
        try {
            await fs.stat(this.journalPath);
            return true;
        }
        catch {
            return false;
        }
    }
    async read() {
        try {
            const raw = await fs.readFile(this.journalPath, "utf8");
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async clear() {
        try {
            await fs.unlink(this.journalPath);
        }
        catch {
            // ignore missing
        }
    }
    /**
     * Write a journal snapshot. Atomic: tmp + rename.
     * Each write MUST be paired with fsync at the call site.
     */
    async write(journal) {
        await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
        const tmp = `${this.journalPath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(journal, null, 2), "utf8");
        await fs.rename(tmp, this.journalPath);
        // Caller is responsible for fsync via fsyncFile() below.
    }
    /** fsync a single file (best-effort). */
    async fsyncFile() {
        try {
            const fh = await fs.open(this.journalPath, "r+");
            try {
                await fh.sync();
            }
            finally {
                await fh.close();
            }
        }
        catch {
            // Windows fs.open mode 'r+' may behave differently; ignore errors.
        }
    }
    /** Create a fresh journal at PREPARE phase. */
    async createPrepare(opts) {
        const now = new Date().toISOString();
        const journal = {
            transactionId: randomBytes(16).toString("hex"),
            profileId: opts.profileId,
            oldWorkspaceId: opts.oldWorkspaceId,
            newWorkspaceId: opts.newWorkspaceId,
            oldWorkspaceRoot: opts.oldWorkspaceRoot,
            newWorkspaceRoot: opts.newWorkspaceRoot,
            phase: "PREPARE",
            stepState: "COMPLETED",
            nextAction: "NONE",
            lastCompletedStep: "PREPARED",
            commitStarted: false,
            pendingPromoted: false,
            profileUpdated: false,
            oldGrantRevoked: false,
            commitCompleted: false,
            rollbackStarted: false,
            rollbackCompleted: false,
            createdAt: now,
            updatedAt: now,
        };
        await this.write(journal);
        await this.fsyncFile();
        return journal;
    }
    /**
     * Mark PREPARED for a sub-step. Sets stepState=PREPARED, nextAction=<action>.
     * Caller MUST fsync after this returns.
     */
    static markPrepared(journal, action) {
        if (journal.stepState !== "COMPLETED" && journal.stepState !== "IDLE") {
            throw new Error(`Cannot mark PREPARED while stepState=${journal.stepState}`);
        }
        if (journal.phase === "COMMITTED" || journal.phase === "ROLLED_BACK") {
            throw new Error(`Cannot mark PREPARED in terminal phase=${journal.phase}`);
        }
        return {
            ...journal,
            stepState: "PREPARED",
            nextAction: action,
            commitStarted: journal.commitStarted || action !== "NONE",
            updatedAt: new Date().toISOString(),
        };
    }
    /**
     * Mark COMPLETED for a sub-step. Caller MUST verify mutation actual state first.
     * Only call after read-back verify confirms mutation actually applied.
     */
    static markCompleted(journal, completedStep, flags, nextAction, nextPhase) {
        if (journal.stepState !== "PREPARED") {
            throw new Error(`Cannot mark COMPLETED while stepState=${journal.stepState}`);
        }
        const phase = nextPhase ?? journal.phase;
        return {
            ...journal,
            phase,
            stepState: "COMPLETED",
            nextAction,
            lastCompletedStep: completedStep,
            pendingPromoted: flags.pendingPromoted ?? journal.pendingPromoted,
            profileUpdated: flags.profileUpdated ?? journal.profileUpdated,
            oldGrantRevoked: flags.oldGrantRevoked ?? journal.oldGrantRevoked,
            commitCompleted: flags.commitCompleted ?? journal.commitCompleted,
            updatedAt: new Date().toISOString(),
        };
    }
}
