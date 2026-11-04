import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { startServer } from "../dist/server.js";
import { detectWorkspace } from "../dist/workspace.js";

/**
 * 全权模式回归：ChatGPT 的 DCR 不带 scope（服务端默认只登记 workspace.read），
 * 但控制中心批准的全权 Intent 给出了 7 项 scope。授权必须放行并写进 token，
 * 否则写入/命令类工具永远 INSUFFICIENT_SCOPE（线上真实故障）。
 */

const secret = Buffer.alloc(32, 23);
const workspaceRoot = path.resolve("..", "dist");
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const ALL_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "workspace.write",
  "workspace.shell",
  "offline_access",
];

test("全权 Intent 能让只登记 read 的客户端拿到 write/shell", async () => {
  const ws = await detectWorkspace(workspaceRoot);
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-allpower-"));
  const runtimeInstanceId = "c2c_ri_allpower_1";
  const persistence = {
    clientRegistryPath: path.join(stateRoot, "profiles", "mb_pf_allpower", "client-registry.json"),
    grantPath: path.join(stateRoot, "profiles", "mb_pf_allpower", "grants", `${ws.workspaceId}.json`),
    intentDirectory: path.join(stateRoot, "profiles", "mb_pf_allpower", "intents"),
  };

  const server = await startServer({
    identity: {
      deviceId: "c2c_dev_allpower",
      profileId: "mb_pf_allpower",
      runtimeId: "c2c_rt_allpower",
      runtimeInstanceId,
      workspaceRoot,
      workspaceId: ws.workspaceId,
      expectedPort: 0,
      publicMcpUrl: null,
      hostname: null,
    },
    secret,
    oauth: { requireIntent: true, persistence, trustedRedirectOrigins: ["https://chatgpt.com"] },
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    // 全权 intent 必须先于 DCR 绑定（控制中心「获取配对码」的顺序）。
    const intent = {
      intentId: "c2c_intent_allpower_1234567890",
      deviceId: "c2c_dev_allpower",
      profileId: "mb_pf_allpower",
      runtimeId: "c2c_rt_allpower",
      runtimeInstanceId,
      workspaceId: ws.workspaceId,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      candidateClientId: null,
      grantedScopes: ALL_SCOPES,
    };
    server.setOAuthIntent(intent);

    // 模拟 ChatGPT：DCR 不送 scope。
    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT AllPower", redirect_uris: [redirectUri] }),
    });
    assert.equal(reg.status, 201);
    const registered = await reg.json();
    assert.deepEqual(registered.scope.split(" "), ["workspace.read"], "DCR 只应登记 read");

    // 授权：请求 7 个 scope（面板全权模式），门必须按并集放行。
    const verifier = `v${randomBytes(32).toString("base64url")}`.slice(0, 64);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const url = new URL(`${base}/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", registered.client_id);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", ALL_SCOPES.join(" "));
    url.searchParams.set("state", "allpower-state");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("intent_id", intent.intentId);

    const consent = await fetch(url);
    assert.equal(consent.status, 200);
    const consentId = /name="consent_id" value="([^"]+)"/.exec(await consent.text())?.[1];
    assert.ok(consentId, "应返回含 consent_id 的同意页");

    const decision = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_id: consentId, decision: "allow" }),
    });
    assert.equal(decision.status, 302);
    const location = decision.headers.get("location") ?? "";
    const code = new URL(location).searchParams.get("code");
    assert.ok(code, "重定向应带授权码");

    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = await tokenRes.json();
    const granted = tokens.scope.split(" ");
    assert.ok(granted.includes("workspace.write"), `token 应含 write，实际 ${tokens.scope}`);
    assert.ok(granted.includes("workspace.shell"), `token 应含 shell，实际 ${tokens.scope}`);
  } finally {
    await server.close().catch(() => undefined);
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
