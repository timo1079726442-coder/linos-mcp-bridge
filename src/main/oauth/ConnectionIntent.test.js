import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionIntentStore, INTENT_TTL_MS } from "./ConnectionIntent.js";
let stateRoot;
let store;
beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "c2c-intent-"));
    store = new ConnectionIntentStore(stateRoot, "mb_pf_test");
});
describe("ConnectionIntentStore (P0 §9)", () => {
    it("create() generates CSPRNG intent ID", async () => {
        const ids = new Set();
        for (let i = 0; i < 50; i++) {
            const intent = await store.create({
                deviceId: "c2c_dev_test",
                runtimeId: "c2c_rt_test",
                runtimeInstanceId: `c2c_ri_${i}`,
                workspaceId: "ws-id",
            });
            expect(intent.intentId).toMatch(/^c2c_intent_[A-Za-z0-9_-]{22}$/);
            ids.add(intent.intentId);
        }
        expect(ids.size).toBe(50); // All unique
    });
    it("create() persists durably to disk", async () => {
        const intent = await store.create({
            deviceId: "c2c_dev_test",
            runtimeId: "c2c_rt_test",
            runtimeInstanceId: "c2c_ri_a",
            workspaceId: "ws-id",
        });
        // Re-read via a new store to confirm disk persistence.
        const fresh = new ConnectionIntentStore(stateRoot, "mb_pf_test");
        const read = await fresh.read(intent.intentId);
        expect(read).not.toBeNull();
        expect(read?.status).toBe("PENDING");
    });
    it("TTL = 5 minutes per CP0-R3 spec", async () => {
        const intent = await store.create({
            deviceId: "c2c_dev_test",
            runtimeId: "c2c_rt_test",
            runtimeInstanceId: "c2c_ri_a",
            workspaceId: "ws-id",
        });
        const diffMs = new Date(intent.expiresAt).getTime() - new Date(intent.createdAt).getTime();
        expect(diffMs).toBe(INTENT_TTL_MS);
    });
    it("invalidateForOldRuntime transitions all mismatched to REVOKED_RUNTIME_RESTART", async () => {
        const old1 = await store.create({
            deviceId: "d", runtimeId: "r", runtimeInstanceId: "ri-old-1", workspaceId: "w",
        });
        const old2 = await store.create({
            deviceId: "d", runtimeId: "r", runtimeInstanceId: "ri-old-2", workspaceId: "w",
        });
        const fresh = await store.create({
            deviceId: "d", runtimeId: "r", runtimeInstanceId: "ri-new", workspaceId: "w",
        });
        await store.transition(old1.intentId, "CLIENT_BOUND");
        await store.transition(old2.intentId, "CONSENT_PENDING");
        const count = await store.invalidateForOldRuntime("ri-new");
        expect(count).toBe(2);
        const r1 = await store.read(old1.intentId);
        const r2 = await store.read(old2.intentId);
        const fr = await store.read(fresh.intentId);
        expect(r1?.status).toBe("REVOKED_RUNTIME_RESTART");
        expect(r2?.status).toBe("REVOKED_RUNTIME_RESTART");
        expect(fr?.status).toBe("PENDING"); // fresh one untouched
    });
    it("rejects malformed intentId (path traversal defense)", async () => {
        await expect(store.read("../etc/passwd")).rejects.toThrow(/bad_intent_id/);
    });
});
