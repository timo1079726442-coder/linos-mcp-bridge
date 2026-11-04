import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
import { ProfileStore } from "../profile/ProfileStore.js";
import { AuditChain } from "../audit/AuditChain.js";
import { TransactionJournalStore } from "./TransactionJournal.js";
import { WorkspaceTransactionCoordinator } from "./TransactionCoordinator.js";
import { HealthProbe } from "../health/HealthProbe.js";
import { ReadinessEngine } from "../health/ReadinessEngine.js";
let stateRoot;
let profiles;
let audit;
let journal;
let coord;
const probe = new HealthProbe();
const readiness = new ReadinessEngine();
beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "c2c-coord-"));
    const device = new DeviceIdentity(stateRoot);
    await device.getDeviceId();
    profiles = new ProfileStore(stateRoot, device);
    audit = new AuditChain(stateRoot, "mb_pf_test");
    await audit.open();
    journal = new TransactionJournalStore(stateRoot, "mb_pf_test");
    coord = new WorkspaceTransactionCoordinator(profiles, audit, journal, probe, readiness);
});
describe("WorkspaceTransactionCoordinator (P0 §5)", () => {
    it("prepare() creates journal and audits", async () => {
        const profile = await profiles.create({ profileName: "T", profileType: "custom", initialWorkspaceRoot: process.cwd() });
        const target = await mkdtemp(join(tmpdir(), "c2c-ws-"));
        const { transactionId } = await coord.prepare({ profileId: profile.profileId, newWorkspaceRoot: target });
        expect(transactionId).toMatch(/^[a-f0-9]{32}$/);
        const j = await journal.read();
        expect(j?.phase).toBe("PREPARE");
        expect(j?.stepState).toBe("COMPLETED");
        await rm(target, { recursive: true, force: true });
    });
    it("resume() in PREPARE returns rollback (and clears journal)", async () => {
        const profile = await profiles.create({ profileName: "T", profileType: "custom", initialWorkspaceRoot: process.cwd() });
        const target = await mkdtemp(join(tmpdir(), "c2c-ws-"));
        await coord.prepare({ profileId: profile.profileId, newWorkspaceRoot: target });
        const r = await coord.resume("placeholder");
        expect(r.action).toBe("rollback");
        expect(await journal.read()).toBeNull();
        await rm(target, { recursive: true, force: true });
    });
    it("resume() with no journal returns noop", async () => {
        const r = await coord.resume("x");
        expect(r.action).toBe("noop");
    });
    it("prepare() rejects non-existent workspace", async () => {
        const profile = await profiles.create({ profileName: "T", profileType: "custom", initialWorkspaceRoot: process.cwd() });
        await expect(coord.prepare({ profileId: profile.profileId, newWorkspaceRoot: "Z:\\does-not-exist-xyz" })).rejects.toThrow(/new_workspace_does_not_exist/);
    });
    it("prepare() rejects identical workspace", async () => {
        const cwd = process.cwd();
        const profile = await profiles.create({ profileName: "T", profileType: "custom", initialWorkspaceRoot: cwd });
        await expect(coord.prepare({ profileId: profile.profileId, newWorkspaceRoot: cwd })).rejects.toThrow(/identical_to_current/);
    });
    it("prepare() produces correct workspaceId from realpath", async () => {
        const dir = await mkdtemp(join(tmpdir(), "c2c-ws-"));
        const profile = await profiles.create({ profileName: "T", profileType: "custom", initialWorkspaceRoot: dir });
        const target = await mkdtemp(join(tmpdir(), "c2c-ws2-"));
        const { transactionId } = await coord.prepare({ profileId: profile.profileId, newWorkspaceRoot: target });
        const j = await journal.read();
        expect(j?.newWorkspaceRoot).toBeTruthy();
        expect(j?.newWorkspaceId).toMatch(/^[0-9a-f]{12}$/);
        await rm(target, { recursive: true, force: true });
        await rm(dir, { recursive: true, force: true });
    });
});
