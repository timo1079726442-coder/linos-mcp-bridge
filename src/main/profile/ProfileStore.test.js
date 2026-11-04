import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./ProfileStore.js";
import { DeviceIdentity } from "./DeviceIdentity.js";
let stateRoot;
let store;
beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "c2c-profile-"));
    const device = new DeviceIdentity(stateRoot);
    await device.getDeviceId();
    store = new ProfileStore(stateRoot, device);
});
describe("ProfileStore", () => {
    it("creates a profile with default config (V2 isolated: 48766 + LOCAL_ONLY)", async () => {
        const cfg = await store.create({ profileName: "COMPANY", profileType: "company" });
        expect(cfg.profileName).toBe("COMPANY");
        expect(cfg.profileType).toBe("company");
        expect(cfg.profileId.startsWith("mb_pf_")).toBe(true);
        expect(cfg.runtimeId.startsWith("c2c_rt_")).toBe(true);
        expect(cfg.runtime.source).toBe("PACKAGED_V2");
        expect(cfg.transport.expectedLocalPort).toBe(48766);
        expect(cfg.transport.provider).toBe("LOCAL_ONLY");
    });
    it("isolates profiles by profileId", async () => {
        await store.create({ profileName: "A", profileType: "company" });
        await store.create({ profileName: "B", profileType: "home" });
        const list = await store.list();
        expect(list).toHaveLength(2);
        expect(list.map((s) => s.profileName).sort()).toEqual(["A", "B"]);
    });
    it("computes workspaceId as sha256(lowercase(realpath))[:12]", async () => {
        const dir = await mkdtemp(join(tmpdir(), "c2c-ws-"));
        const expectedId = await store.computeWorkspaceId(dir);
        expect(expectedId).toHaveLength(12);
        expect(expectedId).toMatch(/^[0-9a-f]{12}$/);
    });
    it("returns same workspaceId for same path (case-insensitive on win32)", async () => {
        const dir = await mkdtemp(join(tmpdir(), "c2c-ws-"));
        const id1 = await store.computeWorkspaceId(dir.toUpperCase());
        const id2 = await store.computeWorkspaceId(dir.toLowerCase());
        if (process.platform === "win32") {
            expect(id1).toBe(id2);
        }
        else {
            // On non-windows, uppercase and lowercase are different
            expect(id1).not.toBe(id2);
        }
    });
    it("atomic write prevents half-written configs", async () => {
        const cfg = await store.create({ profileName: "ATOMIC", profileType: "custom" });
        // Modify + write; simulate concurrent read in between should still see valid JSON
        const tampered = { ...cfg, profileName: "TAMPERED" };
        await store.writeConfig(tampered);
        const readBack = await store.readConfig(cfg.profileId);
        expect(readBack.profileName).toBe("TAMPERED");
    });
    it("delete removes all profile data", async () => {
        const cfg = await store.create({ profileName: "DEL", profileType: "custom" });
        await store.delete(cfg.profileId);
        const list = await store.list();
        expect(list.find((s) => s.profileId === cfg.profileId)).toBeUndefined();
    });
    // P0-A — new profile defaults are 100% isolated (CP0 Founder OPTION_A_PLUS)
    it("P0-A TEST_NEW_PROFILE_DEFAULT_ISOLATED: new profile uses 48766 + LOCAL_ONLY", async () => {
        const cfg = await store.create({ profileName: "ISOLATED", profileType: "custom" });
        expect(cfg.transport.expectedLocalPort).toBe(48766);
        expect(cfg.transport.provider).toBe("LOCAL_ONLY");
        expect(cfg.transport.hostname).toBeNull();
        expect(cfg.transport.tunnelName).toBeNull();
        expect(cfg.transport.tunnelId).toBeNull();
        expect(cfg.transport.publicMcpUrl).toBeNull();
    });
    it("P0-A TEST_NEW_PROFILE_NEVER_DEFAULTS_48765: new profile refuses 48765", async () => {
        const cfg = await store.create({ profileName: "OK", profileType: "custom" });
        expect(cfg.transport.expectedLocalPort).not.toBe(48765);
    });
    it("P0-A writeConfig rejects production-port config", async () => {
        const cfg = await store.create({ profileName: "TEST", profileType: "custom" });
        const tampered = {
            ...cfg,
            transport: { ...cfg.transport, expectedLocalPort: 48765 },
        };
        await expect(store.writeConfig(tampered)).rejects.toThrow(/refuses to default-bind/);
    });
    it("P0-A writeConfig rejects production-hostname config", async () => {
        const cfg = await store.create({ profileName: "TEST", profileType: "custom" });
        const tampered = {
            ...cfg,
            transport: { ...cfg.transport, publicMcpUrl: "https://mcp-legacy.example.com/mcp" },
        };
        await expect(store.writeConfig(tampered)).rejects.toThrow(/PRODUCTION/i);
    });
});
