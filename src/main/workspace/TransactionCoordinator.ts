import * as path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import type { AuditChain } from "../audit/AuditChain.js";
import type { HealthProbe } from "../health/HealthProbe.js";
import type { ReadinessEngine } from "../health/ReadinessEngine.js";
import { TransactionJournalStore } from "./TransactionJournal.js";
import { WorkspaceGrantStore } from "../oauth/WorkspaceGrantStore.js";
import { ProfileStore } from "../profile/ProfileStore.js";
import { WorkspaceManager } from "./WorkspaceManager.js";
import type { TransactionJournal, TxNextAction, TxStep } from "../../shared/types.js";

/**
 * Workspace Change transaction coordinator.
 *
 * Every commit sub-step follows the durable protocol:
 *   write PREPARED + fsync → idempotent mutation → read-back verification
 *   → write COMPLETED + fsync.
 * The journal is therefore sufficient to reconcile a crash without guessing
 * whether a side effect happened.
 */
export interface TransactionContext {
  profileStore: ProfileStore;
  audit: AuditChain;
  journalStore: TransactionJournalStore;
  probe: HealthProbe;
  readiness: ReadinessEngine;
  grantStore: WorkspaceGrantStore;
}

export interface PrepareResult {
  transactionId: string;
}

export class WorkspaceTransactionCoordinator {
  private readonly workspace = new WorkspaceManager();

  constructor(private readonly ctx: TransactionContext) {}

  async prepare(opts: { profileId: string; newWorkspaceRoot: string }): Promise<PrepareResult> {
    const active = await this.ctx.profileStore.readConfig(opts.profileId);
    const newInfo = await this.workspace.validate(opts.newWorkspaceRoot);
    if (!newInfo.exists) throw new Error("new_workspace_does_not_exist");
    if (active.currentWorkspace.workspaceId === newInfo.workspaceId) {
      throw new Error("new_workspace_identical_to_current");
    }
    const journalStore = this.journalStoreFor(opts.profileId);
    const journal = await journalStore.createPrepare({
      profileId: opts.profileId,
      oldWorkspaceId: active.currentWorkspace.workspaceId,
      oldWorkspaceRoot: active.currentWorkspace.root,
      newWorkspaceId: newInfo.workspaceId,
      newWorkspaceRoot: newInfo.root,
      previousConfigVersion: sha256(JSON.stringify(active)),
      candidateConfigVersion: sha256(JSON.stringify({
        ...active,
        currentWorkspace: { root: newInfo.root, workspaceId: newInfo.workspaceId },
      })),
    });
    await this.ctx.audit.append({
      event: "WORKSPACE_CHANGE_PREPARED",
      transactionId: journal.transactionId,
      oldWorkspaceId: active.currentWorkspace.workspaceId,
      newWorkspaceId: newInfo.workspaceId,
    });
    return { transactionId: journal.transactionId };
  }

  /** Commit the prepared transaction. Safe to call again after a crash. */
  async commit(opts: { profileId: string }): Promise<{ action: "commit" | "noop" }> {
    const journal = await this.journalStoreFor(opts.profileId).read();
    if (!journal) throw new Error("transaction_not_found");
    return this.idempotentCommit(journal);
  }

  async resumeAfterCrash(opts: { profileId: string }): Promise<{ action: "rollback" | "commit" | "noop" }> {
    const journalStore = this.journalStoreFor(opts.profileId);
    const journal = await journalStore.read();
    if (!journal) return { action: "noop" };
    switch (journal.phase) {
      case "PREPARE":
      case "CANDIDATE":
      case "ROLLING_BACK":
        await this.rollback(journal);
        return { action: "rollback" };
      case "COMMITTING":
        return await this.idempotentCommit(journal);
      case "COMMITTED":
      case "ROLLED_BACK":
        return { action: "noop" };
      default:
        return { action: "noop" };
    }
  }

  /** PHASE D — ROLLBACK. Safe before COMMIT only. */
  async rollback(journal: TransactionJournal): Promise<void> {
    if (journal.phase === "COMMITTED" || journal.phase === "COMMITTING") {
      throw new Error(`cannot_rollback_in_phase_${journal.phase}`);
    }
    await this.ctx.audit.append({ event: "WORKSPACE_CHANGE_ROLLBACK_STARTED", transactionId: journal.transactionId });
    const journalStore = this.journalStoreFor(journal.profileId);
    const rolling = { ...journal, phase: "ROLLING_BACK" as const, rollbackStarted: true, updatedAt: new Date().toISOString() };
    await journalStore.write(rolling);
    await journalStore.fsyncFile();
    const completed = { ...rolling, phase: "ROLLED_BACK" as const, rollbackCompleted: true, updatedAt: new Date().toISOString() };
    await journalStore.write(completed);
    await journalStore.fsyncFile();
    await this.ctx.audit.append({ event: "WORKSPACE_CHANGE_ROLLED_BACK", transactionId: journal.transactionId });
  }

  /** PHASE C — Write-Ahead + Complete Marker, with read-back reconciliation. */
  private async idempotentCommit(initial: TransactionJournal): Promise<{ action: "commit" | "noop" }> {
    const journalStore = this.journalStoreFor(initial.profileId);
    let journal = initial;
    if (journal.commitCompleted && journal.phase === "COMMITTED") return { action: "noop" };

    // Enter COMMITTING durably before the first irreversible mutation.
    if (journal.phase !== "COMMITTING") {
      journal = {
        ...journal,
        phase: "COMMITTING",
        commitStarted: true,
        nextAction: journal.nextAction === "NONE" ? "PROMOTE_PENDING" : journal.nextAction,
        updatedAt: new Date().toISOString(),
      };
      await journalStore.write(journal);
      await journalStore.fsyncFile();
    }

    journal = await this.runStep(journal, "PROMOTE_PENDING", "PENDING_PROMOTED", {
      pendingPromoted: true,
    }, async () => {
      await this.updateWorkspace(journal, journal.profileId);
      const current = await this.ctx.profileStore.readConfig(journal.profileId);
      return current.currentWorkspace.workspaceId === journal.newWorkspaceId && current.currentWorkspace.root === journal.newWorkspaceRoot;
    }, "UPDATE_PROFILE");

    journal = await this.runStep(journal, "UPDATE_PROFILE", "PROFILE_UPDATED", {
      profileUpdated: true,
    }, async () => {
      await this.updateWorkspace(journal, journal.profileId);
      const current = await this.ctx.profileStore.readConfig(journal.profileId);
      return current.currentWorkspace.workspaceId === journal.newWorkspaceId && current.currentWorkspace.root === journal.newWorkspaceRoot;
    }, "REVOKE_OLD_GRANT");

    journal = await this.runStep(journal, "REVOKE_OLD_GRANT", "OLD_GRANT_REVOKED", {
      oldGrantRevoked: true,
    }, async () => {
      if (!journal.oldWorkspaceId) return true;
      const before = await this.ctx.grantStore.list();
      await this.ctx.grantStore.revoke(journal.oldWorkspaceId);
      const after = await this.ctx.grantStore.list();
      const oldGrant = after.find(({ workspaceId }) => workspaceId === journal.oldWorkspaceId)?.grant;
      const unrelatedUnchanged = before
        .filter(({ workspaceId }) => workspaceId !== journal.oldWorkspaceId)
        .every((entry) => {
          const current = after.find(({ workspaceId }) => workspaceId === entry.workspaceId)?.grant;
          return JSON.stringify(current) === JSON.stringify(entry.grant);
        });
      return (!oldGrant || oldGrant.revoked === true) && unrelatedUnchanged;
    }, "FINALIZE");

    // C4 FINALIZE has the same WAL shape: PREPARED marker, then the terminal
    // phase mutation, then a durable COMPLETED marker.
    if (!journal.commitCompleted) {
      journal = await this.markPrepared(journal, "FINALIZE");
      const committed = {
        ...journal,
        phase: "COMMITTED" as const,
        stepState: "PREPARED" as const,
        updatedAt: new Date().toISOString(),
      };
      await journalStore.write(committed);
      await journalStore.fsyncFile();
      const verify = await journalStore.read();
      if (!verify || verify.phase !== "COMMITTED") throw new Error("transaction_finalize_verify_failed");
      journal = TransactionJournalStore.markCompleted(
        verify,
        "COMMITTED",
        { commitCompleted: true },
        "NONE",
        "COMMITTED",
      );
      await journalStore.write(journal);
      await journalStore.fsyncFile();
      await this.ctx.audit.append({ event: "WORKSPACE_CHANGE_COMMITTED", transactionId: journal.transactionId });
    }
    return { action: "commit" };
  }

  private async runStep(
    journal: TransactionJournal,
    action: Exclude<TxNextAction, "NONE" | "FINALIZE">,
    completedStep: Exclude<TxStep, "PREPARED" | "CANDIDATE_VERIFIED" | "COMMITTED" | "ROLLBACK_STARTED" | "ROLLED_BACK">,
    flags: { pendingPromoted?: boolean; profileUpdated?: boolean; oldGrantRevoked?: boolean },
    mutateAndVerify: () => Promise<boolean>,
    nextAction: TxNextAction,
  ): Promise<TransactionJournal> {
    if (journal.lastCompletedStep === completedStep && journal.stepState === "COMPLETED") return journal;
    let current = journal;
    if (current.stepState === "COMPLETED") current = await this.markPrepared(current, action);
    const verified = await mutateAndVerify();
    if (!verified) throw new Error(`transaction_verify_failed:${action}`);
    const completed = TransactionJournalStore.markCompleted(current, completedStep, flags, nextAction, "COMMITTING");
    const store = this.journalStoreFor(completed.profileId);
    await store.write(completed);
    await store.fsyncFile();
    return completed;
  }

  private async markPrepared(journal: TransactionJournal, action: TxNextAction): Promise<TransactionJournal> {
    const store = this.journalStoreFor(journal.profileId);
    const prepared = TransactionJournalStore.markPrepared(journal, action);
    await store.write(prepared);
    await store.fsyncFile();
    return prepared;
  }

  private async updateWorkspace(journal: TransactionJournal, profileId: string): Promise<void> {
    const profile = await this.ctx.profileStore.readConfig(profileId);
    profile.currentWorkspace = { root: journal.newWorkspaceRoot, workspaceId: journal.newWorkspaceId };
    await this.ctx.profileStore.writeConfig(profile);
  }

  private journalStoreFor(profileId: string): TransactionJournalStore {
    const stateRoot = (this.ctx.profileStore as unknown as { stateRoot?: string }).stateRoot
      ?? process.env.LOCALAPPDATA
      ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "/", ".local", "share");
    return new TransactionJournalStore(stateRoot, profileId);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
