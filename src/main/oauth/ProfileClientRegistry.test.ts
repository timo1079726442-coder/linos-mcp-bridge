import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileClientRegistry, generateClientId } from "./ProfileClientRegistry.js";

let stateRoot: string;
let reg: ProfileClientRegistry;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-client-reg-"));
  reg = new ProfileClientRegistry(stateRoot, "mb_pf_test");
});

describe("ProfileClientRegistry (CP7 OAuth Storage Split)", () => {
  it("P0-A upsert + list round-trips", async () => {
    const clientId = generateClientId();
    const rec = await reg.upsert({
      clientId,
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/oauth/callback"],
      scopes: ["workspace.read"],
    });
    expect(rec.pinStatus).toBe("active");
    expect(rec.lastSeenAt).toBeTruthy();
    const list = await reg.list();
    expect(list.length).toBe(1);
    expect(list[0]?.clientId).toBe(clientId);
  });

  it("upsert updates existing clientId (idempotent)", async () => {
    const clientId = generateClientId();
    await reg.upsert({ clientId, clientName: "v1", redirectUris: ["https://a.com/cb"], scopes: ["workspace.read"] });
    await reg.upsert({ clientId, clientName: "v2", redirectUris: ["https://b.com/cb"], scopes: ["workspace.read"] });
    const list = await reg.list();
    expect(list.length).toBe(1);
    expect(list[0]?.clientName).toBe("v2");
    expect(list[0]?.redirectUris[0]).toBe("https://b.com/cb");
  });

  it("revoke flips pinStatus", async () => {
    const clientId = generateClientId();
    await reg.upsert({ clientId, clientName: "x", redirectUris: ["https://x.com/cb"], scopes: [] });
    await reg.revoke(clientId);
    const after = await reg.findByClientId(clientId);
    expect(after?.pinStatus).toBe("revoked");
    expect(after?.revokedAt ?? after?.lastSeenAt).toBeTruthy();
  });

  it("generateClientId produces unique c2c_client_* IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(generateClientId());
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^c2c_client_[A-Za-z0-9_-]+$/);
  });
});