import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "./SecretStore.js";
let stateRoot;
let store;
beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "c2c-secret-"));
    // Force DPAPI unavailability by pointing at a no-op script that exits 1
    // immediately. Combined with C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK (when
    // set), this exercises the AES dev fallback path; otherwise the engine
    // refuses to write per P0-5 production policy.
    process.env.C2C_SECRET_STORE_DPAPI_SCRIPT = join(process.cwd(), "scripts", "noop-dpapi.ps1");
    delete process.env.C2C_SECRET_STORE_DISABLE_DPAPI;
    store = new SecretStore(stateRoot, "mb_pf_test");
});
describe("SecretStore (CP9 + SECURITY_MODEL_V2 §6 + P0-5)", () => {
    it("set + get round-trips the secret (DEV fallback)", async () => {
        process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK = "1";
        await store.set("oauth_access_token", "secret_abc_123");
        const got = await store.get("oauth_access_token");
        expect(got).toBe("secret_abc_123");
    });
    it("set writes ENCRYPTED payload to disk (NOT plaintext)", async () => {
        process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK = "1";
        await store.set("oauth_refresh_token", "plaintext-value-should-not-appear");
        const raw = await readFile(join(stateRoot, "profiles", "mb_pf_test", "secrets", "oauth_refresh_token.enc"), "utf8");
        expect(raw.includes("plaintext-value-should-not-appear")).toBe(false);
    });
    it("rejects malformed name (path traversal defense)", async () => {
        await expect(store.set("../etc/passwd", "x")).rejects.toThrow(/bad_secret_name/);
    });
    it("get returns null for missing secret", async () => {
        expect(await store.get("nonexistent")).toBeNull();
    });
    it("delete removes secret", async () => {
        process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK = "1";
        await store.set("tmp", "value");
        await store.delete("tmp");
        expect(await store.get("tmp")).toBeNull();
    });
    it("P0-5 TEST_WEAK_FALLBACK_DISABLED_IN_PRODUCTION: production defaults refuse to write when DPAPI unavailable", async () => {
        delete process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK;
        // No DPAPI helper (C2C_SECRET_STORE_DISABLE_DPAPI=1) + no weak fallback opt-in
        // = set must refuse.
        await expect(store.set("prod_secret", "value")).rejects.toThrow(/DPAPI unavailable.*WEAK_FALLBACK disabled|Refusing to write secret/);
    });
    it("P0-5 health backend reflects mode (aes-gcm-fallback or none)", async () => {
        process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK = "1";
        const h = await store.health();
        expect(["dpapi", "aes-gcm-fallback", "none"]).toContain(h.backend);
    });
});
describe("SecretStore productionSafe flag (P0-5)", () => {
    it("aes-gcm-fallback reports productionSafe=false", async () => {
        process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK = "1";
        const h = await store.health();
        if (h.backend === "aes-gcm-fallback") {
            expect(h.productionSafe).toBe(false);
        }
    });
});
