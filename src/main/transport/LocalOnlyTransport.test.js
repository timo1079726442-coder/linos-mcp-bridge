import { describe, it, expect } from "vitest";
import { LocalOnlyTransport } from "./LocalOnlyTransport.js";
describe("LocalOnlyTransport (ADR-0002 §2)", () => {
    it("id is local-only", () => {
        const t = new LocalOnlyTransport();
        expect(t.id).toBe("local-only");
    });
    it("start sets local:// URL on the bound port", async () => {
        const t = new LocalOnlyTransport();
        const h = await t.start(48766);
        expect(h.url).toBe("local://127.0.0.1:48766");
        expect(t.getStatus().running).toBe(true);
        expect(t.getStatus().provider).toBe("local-only");
    });
    it("health() never reports public surface", async () => {
        const t = new LocalOnlyTransport();
        await t.start(48766);
        const h = await t.health();
        expect(h.edge.connected).toBe(false);
        expect(h.public.healthStatus).toBeNull();
        expect(h.public.mcpAnonymous).toBeNull();
        expect(h.public.oauthDiscoveryOk).toBe(false);
        expect(h.process.pid).toBeNull();
    });
    it("stop clears running state", async () => {
        const t = new LocalOnlyTransport();
        await t.start(48766);
        await t.stop();
        expect(t.getStatus().running).toBe(false);
    });
    it("restart returns a fresh handle", async () => {
        const t = new LocalOnlyTransport();
        await t.start(48766);
        const h = await t.restart(48766);
        expect(h.url).toBe("local://127.0.0.1:48766");
    });
});
