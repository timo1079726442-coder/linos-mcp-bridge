import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { startServer } from "../dist/server.js";
import { deriveAdminControlKey, deriveChallengeKey, computeHealthFingerprint, signChallenge, } from "../dist/capability.js";
let handle = null;
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
const identity = {
    deviceId: "c2c_dev_test",
    profileId: "mb_pf_test",
    runtimeId: "c2c_rt_test",
    runtimeInstanceId: "c2c_ri_test",
    workspaceRoot: process.cwd(),
    workspaceId: "test-ws-id",
    expectedPort: 0,
    publicMcpUrl: null,
    hostname: null,
};
before(async () => {
    handle = await startServer({ identity, secret, oauth: { requireIntent: false } });
});
after(async () => {
    if (handle)
        await handle.close();
});
nodeTest("GET /health returns minimal identity", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.service, "c2c-bridge");
    assert.equal(body.status, "ok");
    assert.equal(body.healthFingerprint, computeHealthFingerprint(secret));
    assert.equal(body.deviceId, undefined);
    assert.equal(body.workspaceId, undefined);
    assert.equal(body.runtimeId, undefined);
});
nodeTest("OAuth discovery returns valid metadata", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.ok(body.grant_types_supported.includes("authorization_code"));
});
nodeTest("/admin/info rejects without Capability MAC", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/admin/info`);
    assert.equal(res.status, 401);
});
nodeTest("/admin/info accepts valid Capability MAC", async () => {
    const adminKey = deriveAdminControlKey(secret);
    const ts = new Date().toISOString();
    const nonce = `nonce_${Math.random().toString(36).slice(2)}`;
    const bodyHash = createHmac("sha256", Buffer.alloc(32))
        .update(Buffer.alloc(0))
        .digest("hex");
    const sig = createHmac("sha256", adminKey)
        .update(`${ts}\n${nonce}\nGET\n/admin/info\n${bodyHash}`)
        .digest("base64url");
    const auth = `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}`;
    const res = await fetch(`http://127.0.0.1:${handle.port}/admin/info`, {
        headers: { Authorization: auth },
    });
    assert.equal(res.status, 200);
    const body = (await res.json());
    assert.equal(body.runtimeInstanceId, "c2c_ri_test");
    assert.equal(body.deviceId, "c2c_dev_test");
});
nodeTest("/admin/challenge returns HMAC over identity", async () => {
    const adminKey = deriveAdminControlKey(secret);
    const ts = new Date().toISOString();
    const nonce = `nonce_c_${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ nonce: "x", issuedAt: new Date().toISOString() });
    const bodyHash = createHmac("sha256", Buffer.alloc(32))
        .update(body)
        .digest("hex");
    const sig = createHmac("sha256", adminKey)
        .update(`${ts}\n${nonce}\nPOST\n/admin/challenge\n${bodyHash}`)
        .digest("base64url");
    const auth = `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}`;
    const res = await fetch(`http://127.0.0.1:${handle.port}/admin/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: auth },
        body,
    });
    assert.equal(res.status, 200);
    const out = (await res.json());
    assert.ok(typeof out.signature === "string");
    const ck = deriveChallengeKey(secret);
    const re = signChallenge("x", out.issuedAt, {
        deviceId: "c2c_dev_test",
        profileId: "mb_pf_test",
        runtimeId: "c2c_rt_test",
        runtimeInstanceId: "c2c_ri_test",
        workspaceId: out.workspaceId,
    }, ck);
    assert.equal(out.signature, re);
});
nodeTest("/mcp rejects anonymous before any tool execution", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
  assert.equal(res.status, 401);
});
