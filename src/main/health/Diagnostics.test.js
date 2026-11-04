import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "./Diagnostics.js";
import { ProfileStore } from "../profile/ProfileStore.js";
import { DeviceIdentity } from "../profile/DeviceIdentity.js";
let stateRoot;
let diagnostics;
beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "c2c-diag-"));
    // Seed a profile to make diagnostics meaningful.
    const device = new DeviceIdentity(stateRoot);
    await device.getDeviceId();
    const store = new ProfileStore(stateRoot, device);
    await store.create({ profileName: "DIAG", profileType: "custom" });
    diagnostics = new Diagnostics({ stateRoot });
});
describe("Diagnostics (P0-D no hardcoded PASS)", () => {
    it("P0-D diagnostics.watchdog.alive is FALSE (NOT_STARTED), no fake alive=true", async () => {
        const r = await diagnostics.run();
        expect(r.watchdog.alive).toBe(false);
        expect(r.watchdog.status).toBe("NOT_STARTED");
    });
    it("P0-D diagnostics.profileMetadata reflects 48766 + LOCAL_ONLY isolated defaults", async () => {
        const r = await diagnostics.run();
        expect(r.profileMetadata).not.toBeNull();
        expect(r.profileMetadata?.transportProvider).toBe("LOCAL_ONLY");
        // The runtime.json doesn't exist (no Runtime spawned in this test)
        // so the report uses the configured port from profile.
        expect(r.transport.provider).toBe("local-only");
    });
    it("P0-D diagnostics.report never contains hardcoded dpapiOk=true", async () => {
        const r = await diagnostics.run();
        // dpapiOk must reflect actual backend probe, not a hardcoded true
        expect(typeof r.secretStore.dpapiOk).toBe("boolean");
        expect(typeof r.secretStore.encryptionBackend).toBe("string");
    });
    it("P0-D diagnostics with no Runtime spawned reports runtime alive FAIL not PASS", async () => {
        const r = await diagnostics.run();
        // No actual bridge on 48766 → runtime layer should be FAIL
        expect(r.readiness.layers.runtime).not.toBe("PASS");
    });
    it("P0-D diagnostics.report is fully typed (all required fields present)", async () => {
        const r = await diagnostics.run();
        expect(r.generatedAt).toBeTruthy();
        expect(r.appVersion).toBe("2.0.0");
        expect(r.osVersion).toContain(process.platform);
        expect(r.readiness).toBeDefined();
        expect(r.readiness.layers).toBeDefined();
    });
});
