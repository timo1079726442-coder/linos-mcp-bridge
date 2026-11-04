import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
import { ProfileStore } from "../profile/ProfileStore.js";
import { AuditChain } from "../audit/AuditChain.js";
import { HealthProbe } from "../health/HealthProbe.js";
import { ReadinessEngine } from "../health/ReadinessEngine.js";
import { TransactionJournalStore } from "./TransactionJournal.js";
import { WorkspaceTransactionCoordinator } from "./TransactionCoordinator.js";
import { WorkspaceGrantStore } from "../oauth/WorkspaceGrantStore.js";

let stateRoot: string;
let oldWorkspace: string;
let newWorkspace: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? ".", "c2c-tx-"));
  oldWorkspace = join(stateRoot, "old-workspace");
  newWorkspace = join(stateRoot, "new-workspace");
  await mkdir(oldWorkspace, { recursive: true });
  await mkdir(newWorkspace, { recursive: true });
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

async function setup() {
  const device = new DeviceIdentity(stateRoot);
  const profiles = new ProfileStore(stateRoot, device);
  const profile = await profiles.create({ profileName: "transaction-test", profileType: "custom", initialWorkspaceRoot: oldWorkspace });
  const audit = new AuditChain(stateRoot, profile.profileId);
  await audit.open();
  const grants = new WorkspaceGrantStore(stateRoot, profile.profileId);
  await grants.set(profile.currentWorkspace.workspaceId!, {
    clientId: "c2c_client_test",
    accessTokenHash: "access-hash",
    refreshTokenHash: "refresh-hash",
    scopes: ["workspace.read"],
    audience: profile.currentWorkspace.workspaceId!,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
  });
  await grants.set("other-workspace", {
    clientId: "c2c_client_other",
    accessTokenHash: "other-access-hash",
    refreshTokenHash: "other-refresh-hash",
    scopes: ["workspace.read"],
    audience: "other-workspace",
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revoked: false,
  });
  const coordinator = new WorkspaceTransactionCoordinator({
    profileStore: profiles,
    audit,
    journalStore: new TransactionJournalStore(stateRoot, profile.profileId),
    probe: new HealthProbe(),
    readiness: new ReadinessEngine(),
    grantStore: grants,
  });
  return { profiles, profile, grants, coordinator, journal: new TransactionJournalStore(stateRoot, profile.profileId) };
}

describe("WorkspaceTransactionCoordinator (WAL + Complete Marker)", () => {
  it("commits workspace and revokes old grants only during COMMIT", async () => {
    const { profiles, profile, grants, coordinator, journal } = await setup();
    const prepared = await coordinator.prepare({ profileId: profile.profileId, newWorkspaceRoot: newWorkspace });
    expect(prepared.transactionId).toMatch(/^[a-f0-9]{32}$/);

    const beforeCommit = await profiles.readConfig(profile.profileId);
    expect(beforeCommit.currentWorkspace.root).toBe(oldWorkspace);
    expect((await grants.get(profile.currentWorkspace.workspaceId!))?.revoked).toBe(false);

    const result = await coordinator.commit({ profileId: profile.profileId });
    expect(result.action).toBe("commit");
    const after = await profiles.readConfig(profile.profileId);
    expect(after.currentWorkspace.root?.toLowerCase().endsWith("\\new-workspace")).toBe(true);
    expect((await grants.get(profile.currentWorkspace.workspaceId!))?.revoked).toBe(true);
    expect((await grants.get("other-workspace"))?.revoked).toBe(false);
    expect((await journal.read())?.phase).toBe("COMMITTED");
    expect((await journal.read())?.commitCompleted).toBe(true);

    expect((await coordinator.commit({ profileId: profile.profileId })).action).toBe("noop");
  });

  it("reconciles a crash after PREPARED but before mutation completion", async () => {
    const { profiles, profile, coordinator, journal } = await setup();
    await coordinator.prepare({ profileId: profile.profileId, newWorkspaceRoot: newWorkspace });
    const prepared = await journal.read();
    expect(prepared).not.toBeNull();
    await journal.write({
      ...prepared!,
      phase: "COMMITTING",
      commitStarted: true,
      stepState: "PREPARED",
      nextAction: "PROMOTE_PENDING",
    });
    await journal.fsyncFile();

    const result = await coordinator.resumeAfterCrash({ profileId: profile.profileId });
    expect(result.action).toBe("commit");
    expect((await profiles.readConfig(profile.profileId)).currentWorkspace.root?.toLowerCase().endsWith("\\new-workspace")).toBe(true);
    expect((await journal.read())?.phase).toBe("COMMITTED");
  });

  it("rolls back a prepared transaction without revoking grants", async () => {
    const { profiles, profile, grants, coordinator, journal } = await setup();
    await coordinator.prepare({ profileId: profile.profileId, newWorkspaceRoot: newWorkspace });
    const pending = await journal.read();
    await coordinator.rollback(pending!);
    expect((await journal.read())?.phase).toBe("ROLLED_BACK");
    expect((await profiles.readConfig(profile.profileId)).currentWorkspace.root).toBe(oldWorkspace);
    expect((await grants.get(profile.currentWorkspace.workspaceId!))?.revoked).toBe(false);
  });
});
