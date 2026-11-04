import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransactionJournalStore } from "./TransactionJournal.js";
import type { TransactionJournal } from "../../shared/types.js";

let stateRoot: string;
let store: TransactionJournalStore;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-tx-"));
  store = new TransactionJournalStore(stateRoot, "mb_pf_test");
});

describe("TransactionJournalStore", () => {
  it("createPrepare writes a fresh journal in PREPARE phase", async () => {
    const j = await store.createPrepare({
      profileId: "mb_pf_test",
      oldWorkspaceId: "old01",
      oldWorkspaceRoot: "/old",
      newWorkspaceId: "new01",
      newWorkspaceRoot: "/new",
      previousConfigVersion: "abc",
      candidateConfigVersion: "def",
    });
    expect(j.phase).toBe("PREPARE");
    expect(j.stepState).toBe("COMPLETED");
    expect(j.nextAction).toBe("NONE");
    expect(j.lastCompletedStep).toBe("PREPARED");
    expect(j.commitStarted).toBe(false);
  });

  it("markPrepared sets stepState=PREPARED, nextAction=N", () => {
    const j = makeBaseJournal();
    const p = TransactionJournalStore.markPrepared(j, "PROMOTE_PENDING");
    expect(p.stepState).toBe("PREPARED");
    expect(p.nextAction).toBe("PROMOTE_PENDING");
    expect(p.commitStarted).toBe(true);
  });

  it("markCompleted updates stepState=COMPLETED, lastCompletedStep, flags", () => {
    const j = { ...makeBaseJournal(), stepState: "PREPARED" as const, nextAction: "PROMOTE_PENDING" as const, commitStarted: true };
    const c = TransactionJournalStore.markCompleted(j, "PENDING_PROMOTED", { pendingPromoted: true }, "UPDATE_PROFILE");
    expect(c.stepState).toBe("COMPLETED");
    expect(c.nextAction).toBe("UPDATE_PROFILE");
    expect(c.lastCompletedStep).toBe("PENDING_PROMOTED");
    expect(c.pendingPromoted).toBe(true);
    expect(c.profileUpdated).toBe(false);
  });

  it("cannot mark PREPARED while already PREPARED", () => {
    const j = { ...makeBaseJournal(), stepState: "PREPARED" as const, nextAction: "PROMOTE_PENDING" as const };
    expect(() => TransactionJournalStore.markPrepared(j, "UPDATE_PROFILE")).toThrow(/Cannot mark PREPARED/);
  });

  it("cannot mark COMPLETED while IDLE", () => {
    const j = { ...makeBaseJournal(), stepState: "IDLE" as const, nextAction: "NONE" as const };
    expect(() => TransactionJournalStore.markCompleted(j, "PENDING_PROMOTED", {}, "NONE")).toThrow(/Cannot mark COMPLETED/);
  });

  it("cannot mark PREPARED in terminal phase=COMMITTED", () => {
    const j = { ...makeBaseJournal(), phase: "COMMITTED" as const };
    expect(() => TransactionJournalStore.markPrepared(j, "PROMOTE_PENDING")).toThrow(/terminal/);
  });

  it("durability: prepare write survives read-back", async () => {
    const j = await store.createPrepare({
      profileId: "mb_pf_test",
      oldWorkspaceId: "old01",
      oldWorkspaceRoot: "/old",
      newWorkspaceId: "new01",
      newWorkspaceRoot: "/new",
      previousConfigVersion: "abc",
      candidateConfigVersion: "def",
    });
    const raw = await readFile(join(stateRoot, "profiles", "mb_pf_test", "transaction-journal.json"), "utf8");
    const parsed = JSON.parse(raw) as TransactionJournal;
    expect(parsed.transactionId).toBe(j.transactionId);
    expect(parsed.phase).toBe("PREPARE");
  });

  it("clear removes the journal file", async () => {
    await store.createPrepare({
      profileId: "mb_pf_test",
      oldWorkspaceId: null,
      oldWorkspaceRoot: null,
      newWorkspaceId: "new01",
      newWorkspaceRoot: "/new",
      previousConfigVersion: "abc",
      candidateConfigVersion: "def",
    });
    expect(await store.exists()).toBe(true);
    await store.clear();
    expect(await store.exists()).toBe(false);
  });
});

function makeBaseJournal(): TransactionJournal {
  return {
    transactionId: "test-id",
    profileId: "mb_pf_test",
    oldWorkspaceId: "old01",
    newWorkspaceId: "new01",
    oldWorkspaceRoot: "/old",
    newWorkspaceRoot: "/new",
    phase: "PREPARE",
    stepState: "IDLE",
    nextAction: "NONE",
    lastCompletedStep: null,
    commitStarted: false,
    pendingPromoted: false,
    profileUpdated: false,
    oldGrantRevoked: false,
    commitCompleted: false,
    rollbackStarted: false,
    rollbackCompleted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}