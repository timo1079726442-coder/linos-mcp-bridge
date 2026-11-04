import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../dist/server.js";
import { detectWorkspace } from "../dist/workspace.js";
import { hashSecret, tokenStore } from "../dist/oauth-store.js";

test("/mcp 的 create_file 是真实工具，受 workspace.write 约束", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "c2c-mcp-create-scope-"));
  const workspaceRoot = path.join(temp, "workspace");
  await mkdir(workspaceRoot);
  const workspace = await detectWorkspace(workspaceRoot);
  const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
  const identity = {
    deviceId: "c2c_dev_scope_test",
    profileId: "profile_scope_test",
    runtimeId: "runtime_scope_test",
    runtimeInstanceId: "c2c_ri_scope-test-instance-12345678",
    workspaceRoot,
    workspaceId: workspace.workspaceId,
    expectedPort: 0,
    publicMcpUrl: null,
    hostname: null,
  };
  const bridgeCalls = [];
  let resourceAudience = "";
  const addToken = (accessToken, scopes) => {
    const accessTokenHash = hashSecret(accessToken);
    tokenStore.set(accessTokenHash, {
      clientId: "registered-client-1",
      accessTokenHash,
      refreshTokenHash: hashSecret(`${accessToken}-refresh`),
      scopes,
      audience: resourceAudience,
      accessTokenExpiresAt: Date.now() + 60_000,
      refreshTokenExpiresAt: Date.now() + 120_000,
      revoked: false,
    });
  };
  const readToken = "synthetic-read-token-not-a-credential";
  const writeToken = "synthetic-write-token-not-a-credential";

  let handle;
  try {
    handle = await startServer({
      identity,
      secret,
      oauth: { requireIntent: false },
      createIntentBridge: {
        async requestCreateIntent(request) {
          bridgeCalls.push(request);
          return { status: "PENDING", requestId: "apr_scope_test_12345678" };
        },
      },
    });
    resourceAudience = `http://127.0.0.1:${handle.port}/mcp`;
    addToken(readToken, ["workspace.read"]);
    addToken(writeToken, ["workspace.read", "workspace.write"]);
    const baseUrl = `http://127.0.0.1:${handle.port}/mcp`;
    const post = (accessToken, body) => fetch(baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const readList = await post(readToken, { jsonrpc: "2.0", id: "list-read", method: "tools/list" });
    assert.equal(readList.status, 200);
    const readListBody = await readList.json();
    assert.equal(readListBody.result.tools.some((tool) => tool.name === "create_file"), true);

    const writeList = await post(writeToken, { jsonrpc: "2.0", id: "list-write", method: "tools/list" });
    assert.equal(writeList.status, 200);
    const writeListBody = await writeList.json();
    assert.equal(writeListBody.result.tools.some((tool) => tool.name === "create_file"), true);

    const readCall = await post(readToken, {
      jsonrpc: "2.0", id: "call-read", method: "tools/call",
      params: { name: "create_file", arguments: { path: "new.txt", content: "synthetic content" } },
    });
    assert.equal(readCall.status, 403);
    assert.deepEqual(await readCall.json(), { error: "insufficient_scope", scope: "workspace.write" });
    assert.equal(bridgeCalls.length, 0);

    const writeCall = await post(writeToken, {
      jsonrpc: "2.0", id: "call-write-42", method: "tools/call",
      params: { name: "create_file", arguments: { path: "new.txt", content: "synthetic content" } },
    });
    assert.equal(writeCall.status, 200);
    assert.equal(bridgeCalls.length, 0, "create_file no longer uses the legacy approval bridge");
    assert.equal(await readFile(path.join(workspaceRoot, "new.txt"), "utf8"), "synthetic content");
  } finally {
    await handle?.close();
    tokenStore.clear();
    await rm(temp, { recursive: true, force: true });
  }
});


