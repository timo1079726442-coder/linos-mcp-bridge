import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../dist/server.js";

const secret = Buffer.alloc(32, 7);
const identity = {
  deviceId: "c2c_dev_oauth",
  profileId: "mb_pf_oauth",
  runtimeId: "c2c_rt_oauth",
  runtimeInstanceId: "c2c_ri_oauth",
  workspaceRoot: process.cwd(),
  workspaceId: "oauth-workspace",
  expectedPort: 0,
  publicMcpUrl: null,
  hostname: null,
};
let handle;
let base;

before(async () => {
  handle = await startServer({ identity, secret, oauth: { requireIntent: false } });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  if (handle) await handle.close();
});

test("OAuth DCR → consent → PKCE token → bearer MCP → refresh → revoke", async () => {
  const redirectUri = "http://127.0.0.1:43123/oauth/callback";
  const dcr = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Local OAuth Test Client",
      redirect_uris: [redirectUri],
      scope: "workspace.read offline_access",
    }),
  });
  assert.equal(dcr.status, 201);
  const client = await dcr.json();
  assert.match(client.client_id, /^c2c_client_/);

  const verifier = `v${randomBytes(32).toString("base64url")}`.slice(0, 64);
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const state = "state-oauth-test";
  const authUrl = new URL(`${base}/oauth/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "workspace.read offline_access");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const consent = await fetch(authUrl);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const consentId = /name="consent_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(consentId);
  assert.match(html, /允许访问这个工作区/);

  const decision = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ consent_id: consentId, decision: "allow" }),
  });
  assert.equal(decision.status, 302);
  const callback = new URL(decision.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, new URL(redirectUri).origin + new URL(redirectUri).pathname);
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.match(tokens.access_token, /^c2c_at_/);
  assert.match(tokens.refresh_token, /^c2c_rt_/);

  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(mcp.status, 200);
  const mcpBody = await mcp.json();
  assert.ok(Array.isArray(mcpBody.result.tools));

  for (const [name, args] of [
    ["search_workspace", { query: "oauth", mode: "literal", limit: 1 }],
    ["git_status", {}],
  ]) {
    const toolCall = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
    });
    assert.equal(toolCall.status, 200);
    const toolBody = await toolCall.json();
    assert.equal(toolBody.result.isError, false, `tool failed: ${name}`);
  }

  const refresh = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token }),
  });
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.notEqual(refreshed.access_token, tokens.access_token);

  const revoke = await fetch(`${base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshed.access_token, client_id: client.client_id }),
  });
  assert.equal(revoke.status, 200);
  const afterRevoke = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${refreshed.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(afterRevoke.status, 401);
});

test("OAuth rejects unknown redirect origins and missing PKCE", async () => {
  const dcr = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Unknown Origin", redirect_uris: ["https://unknown.example.invalid/cb"] }),
  });
  assert.equal(dcr.status, 400);

  const local = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "PKCE Required", redirect_uris: ["http://localhost:43124/cb"] }),
  });
  assert.equal(local.status, 201);
  const client = await local.json();
  const url = new URL(`${base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", "http://localhost:43124/cb");
  url.searchParams.set("state", "state");
  const response = await fetch(url);
  assert.equal(response.status, 400);
});
