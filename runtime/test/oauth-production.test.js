import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../dist/server.js";
import { detectWorkspace } from "../dist/workspace.js";

const secret = Buffer.alloc(32, 19);
const workspace = await detectWorkspace(process.cwd());
const workspaceId = workspace.workspaceId;
const redirectUri = "http://127.0.0.1:43125/oauth/callback";

function identity(runtimeInstanceId) {
  return {
    deviceId: "c2c_dev_oauth_production",
    profileId: "mb_pf_oauth_production",
    runtimeId: "c2c_rt_oauth_production",
    runtimeInstanceId,
    workspaceRoot: process.cwd(),
    workspaceId,
    expectedPort: 0,
    publicMcpUrl: null,
    hostname: null,
  };
}

function persistence(stateRoot) {
  return {
    clientRegistryPath: path.join(stateRoot, "profiles", "mb_pf_oauth_production", "client-registry.json"),
    grantPath: path.join(stateRoot, "profiles", "mb_pf_oauth_production", "grants", `${workspaceId}.json`),
    intentDirectory: path.join(stateRoot, "profiles", "mb_pf_oauth_production", "intents"),
  };
}

function validIntent(runtimeInstanceId, intentId = "c2c_intent_production_1234567890") {
  return {
    intentId,
    deviceId: "c2c_dev_oauth_production",
    profileId: "mb_pf_oauth_production",
    runtimeId: "c2c_rt_oauth_production",
    runtimeInstanceId,
    workspaceId,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    candidateClientId: null,
  };
}

async function register(base, extra = {}) {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Production OAuth Test Client",
      redirect_uris: [redirectUri],
      scope: "workspace.read git.read offline_access",
      ...extra,
    }),
  });
  return { response, body: await response.json() };
}

async function authorize(base, clientId, intentId, scope = "workspace.read git.read offline_access") {
  const verifier = `v${randomBytes(32).toString("base64url")}`.slice(0, 64);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", "production-state");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("intent_id", intentId);
  const consent = await fetch(url);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(consentId);
  const decision = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ consent_id: consentId, decision: "allow" }),
  });
  assert.equal(decision.status, 302);
  const callback = new URL(decision.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "production-state");
  return { code: callback.searchParams.get("code"), verifier };
}

async function exchange(base, clientId, code, verifier) {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  return { response, body: await response.json() };
}

async function refresh(base, clientId, refreshToken) {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
  });
  return { response, body: await response.json() };
}

test("production OAuth wiring is intent-bound, durable, and fail-closed", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "c2c-oauth-production-"));
  const store = persistence(stateRoot);
  let first;
  let second;
  try {
    first = await startServer({
      identity: identity("c2c_ri_oauth_production_1"),
      secret,
      oauth: { requireIntent: true, persistence: store },
    });
    const base = `http://127.0.0.1:${first.port}`;

    const noIntent = await register(base);
    assert.equal(noIntent.response.status, 503);
    assert.equal(noIntent.body.error, "connection_intent_required");

    const intent = validIntent("c2c_ri_oauth_production_1");
    await fetch(`${base}/admin/oauth/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intent),
    }).then((r) => assert.equal(r.status, 401));

    // The production server is only bound by the Supervisor Capability-MAC;
    // this test installs the binding through the public server handle to keep
    // the protocol test independent from process orchestration.
    first.setOAuthIntent(intent);
    const unknownRedirect = await register(base, { redirect_uris: ["https://unknown.example.invalid/cb"] });
    assert.equal(unknownRedirect.response.status, 400);

    const registered = await register(base);
    assert.equal(registered.response.status, 201);
    const clientId = registered.body.client_id;
    assert.match(clientId, /^c2c_client_/);

    const clientMetadataChanged = await register(base, {
      client_id: clientId,
      client_name: "Changed Metadata Must Fail",
    });
    assert.equal(clientMetadataChanged.response.status, 409);
    assert.equal(clientMetadataChanged.body.error, "client_metadata_changed");

    const upgraded = await register(base, {
      client_id: clientId,
      scope: "workspace.read workspace.search git.read execution.read offline_access",
    });
    assert.equal(upgraded.response.status, 200);
    assert.equal(upgraded.body.scope, "workspace.read workspace.search git.read execution.read offline_access");

    const narrowed = await register(base, {
      client_id: clientId,
      scope: "workspace.read git.read offline_access",
    });
    assert.equal(narrowed.response.status, 409);
    assert.equal(narrowed.body.error, "client_metadata_changed");

    const missingPkce = new URL(`${base}/oauth/authorize`);
    missingPkce.searchParams.set("response_type", "code");
    missingPkce.searchParams.set("client_id", clientId);
    missingPkce.searchParams.set("redirect_uri", redirectUri);
    missingPkce.searchParams.set("state", "missing-pkce");
    assert.equal((await fetch(missingPkce)).status, 400);

    const authorization = await authorize(
      base,
      clientId,
      intent.intentId,
      "workspace.read workspace.search git.read execution.read offline_access",
    );
    assert.ok(authorization.code);
    const tokens = await exchange(base, clientId, authorization.code, authorization.verifier);
    assert.equal(tokens.response.status, 200);
    assert.match(tokens.body.access_token, /^c2c_at_/);
    assert.match(tokens.body.refresh_token, /^c2c_rt_/);

    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.body.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "git_status", arguments: {} } }),
    });
    assert.equal(mcp.status, 200);
    const mcpBody = await mcp.json();
    assert.equal(mcpBody.jsonrpc, "2.0");
    assert.equal(mcpBody.result.isError, false);
    assert.equal(mcpBody.result.structuredContent.isRepo, true);
    assert.equal(mcpBody.result.content[0].type, "text");
    assert.deepEqual(JSON.parse(mcpBody.result.content[0].text), mcpBody.result.structuredContent);

    const replay = await exchange(base, clientId, authorization.code, authorization.verifier);
    assert.equal(replay.response.status, 400);
    assert.equal(replay.body.error, "invalid_grant");

    const rotated = await refresh(base, clientId, tokens.body.refresh_token);
    assert.equal(rotated.response.status, 200);
    assert.notEqual(rotated.body.access_token, tokens.body.access_token);
    const oldRefresh = await refresh(base, clientId, tokens.body.refresh_token);
    assert.equal(oldRefresh.response.status, 400);

    const clientFile = await readFile(store.clientRegistryPath, "utf8");
    const grantFile = await readFile(store.grantPath, "utf8");
    assert.match(clientFile, new RegExp(clientId));
    assert.doesNotMatch(grantFile, new RegExp(tokens.body.access_token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(grantFile, new RegExp(rotated.body.refresh_token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await first.close();
    first = null;

    second = await startServer({
      identity: identity("c2c_ri_oauth_production_2"),
      secret,
      oauth: { requireIntent: true, persistence: store },
    });
    const secondBase = `http://127.0.0.1:${second.port}`;
    const restartNoIntent = await register(secondBase, { client_id: clientId });
    assert.equal(restartNoIntent.response.status, 503);

    const nextIntent = validIntent("c2c_ri_oauth_production_2", "c2c_intent_production_restart_1234567890");
    second.setOAuthIntent(nextIntent);
    const pinned = await register(secondBase, {
      client_id: clientId,
      scope: "workspace.read workspace.search git.read execution.read offline_access",
    });
    assert.equal(pinned.response.status, 200);

    const rotatedAfterRestart = await refresh(secondBase, clientId, rotated.body.refresh_token);
    assert.equal(rotatedAfterRestart.response.status, 200);
    const revoke = await fetch(`${secondBase}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: rotatedAfterRestart.body.access_token, client_id: clientId }),
    });
    assert.equal(revoke.status, 200);
    const revokedMcp = await fetch(`${secondBase}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${rotatedAfterRestart.body.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(revokedMcp.status, 401);
  } finally {
    if (first) await first.close().catch(() => undefined);
    if (second) await second.close().catch(() => undefined);
    await rm(stateRoot, { recursive: true, force: true });
  }
});
