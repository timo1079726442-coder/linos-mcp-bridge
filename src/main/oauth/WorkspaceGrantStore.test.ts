import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceGrantStore } from "./WorkspaceGrantStore.js";
import { createHash } from "node:crypto";

let stateRoot: string;
let store: WorkspaceGrantStore;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-grant-store-"));
  store = new WorkspaceGrantStore(stateRoot, "mb_pf_test");
});

function makeGrant(ws: string) {
  return {
    clientId: `c2c_client_${ws}`,
    accessTokenHash: createHash("sha256").update("access-token").digest("hex"),
    refreshTokenHash: createHash("sha256").update("refresh-token").digest("hex"),
    scopes: ["workspace.read"],
    audience: ws,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    revoked: false,
  };
}

describe("WorkspaceGrantStore (CP7 OAuth Storage Split)", () => {
  it("set + get round-trips per workspace", async () => {
    const ws = "ws-alpha";
    await store.set(ws, makeGrant(ws));
    const got = await store.get(ws);
    expect(got?.clientId).toBe(`c2c_client_${ws}`);
    expect(got?.audience).toBe(ws);
  });

  it("plaintext access/refresh tokens NEVER on disk", async () => {
    const ws = "ws-secret-leak";
    await store.set(ws, makeGrant(ws));
    const raw = await readFile(join(stateRoot, "profiles", "mb_pf_test", "grants", `${ws}.json`), "utf8");
    expect(raw.includes("access-token")).toBe(false);
    expect(raw.includes("refresh-token")).toBe(false);
    expect(raw.includes("accessTokenHash")).toBe(true);
    expect(raw.includes("refreshTokenHash")).toBe(true);
  });

  it("revokeAll marks every workspace grant revoked (commit semantics)", async () => {
    await store.set("ws-a", makeGrant("ws-a"));
    await store.set("ws-b", makeGrant("ws-b"));
    await store.set("ws-c", makeGrant("ws-c"));
    const n = await store.revokeAll();
    expect(n).toBe(3);
    const all = await store.list();
    expect(all.every((g) => g.grant.revoked === true)).toBe(true);
    expect(all.every((g) => !!g.grant.revokedAt)).toBe(true);
  });

  it("rejects malformed workspace id (path traversal)", async () => {
    await expect(store.set("../etc/passwd", makeGrant("ws"))).rejects.toThrow(/bad_workspace_id/);
  });
});