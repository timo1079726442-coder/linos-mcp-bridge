import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp, TOOL_INVENTORY } from "../dist/mcp-tools.js";

const CALLER = Object.freeze({ clientId: "c2c_client_SETTINGS_TEST", requestId: 31 });

async function setup() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-settings-"));
  const root = path.join(parent, "workspace");
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(root);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {} }), "utf8");
  await writeFile(path.join(root, "note.md"), "needle in a haystack\n", "utf8");
  return { parent, root, profile };
}

function call(ctx, name, args = {}, extra = {}) {
  return dispatchMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    "0123456789ab",
    ctx.root,
    path.join(ctx.profile, "executions"),
    { caller: CALLER, toolPolicyDir: ctx.profile, localPort: 48767, ...extra },
  );
}

test("search 是 search_workspace 的兼容别名", async () => {
  const ctx = await setup();
  try {
    const result = await call(ctx, "search", { query: "needle", limit: 5 });
    assert.ok(Array.isArray(result.matches));
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].path, "note.md");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("get_mcp_app_settings 返回连接器配置", async () => {
  const ctx = await setup();
  try {
    const settings = await call(ctx, "get_mcp_app_settings");
    assert.equal(settings.name, "LinOS C2C Runtime");
    assert.equal(settings.auth_mode, "oauth");
    assert.equal(settings.mcp_url, "http://127.0.0.1:48767/mcp");
    assert.equal(settings.tool_count, TOOL_INVENTORY.length);
    assert.equal(settings.security.writes_require_local_approval, true);
    assert.ok(settings.scopes.includes("workspace.write"));

    const publicUrl = await call(ctx, "get_mcp_app_settings", {}, { publicMcpUrl: "https://example.test/mcp" });
    assert.equal(publicUrl.mcp_url, "https://example.test/mcp");
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("verify_tool_registered 能区分已注册/未注册与当前策略", async () => {
  const ctx = await setup();
  try {
    const registered = await call(ctx, "verify_tool_registered", { name: "search" });
    assert.equal(registered.registered, true);
    assert.equal(registered.group, "搜索");
    assert.equal(registered.conditional, false);
    assert.equal(registered.enabled, true);

    const missing = await call(ctx, "verify_tool_registered", { name: "not_a_tool" });
    assert.deepEqual(missing, { name: "not_a_tool", registered: false });
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});

test("已认证客户端的 tools/list 包含兼容工具，共 58 个", async () => {
  const ctx = await setup();
  try {
    const listed = await dispatchMcp(
      { method: "tools/list", params: {} },
      "0123456789ab",
      ctx.root,
      path.join(ctx.profile, "executions"),
      { caller: CALLER, toolPolicyDir: ctx.profile },
    );
    const names = listed.tools.map((tool) => tool.name);
    for (const name of ["search", "get_mcp_app_settings", "verify_tool_registered"]) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(listed.tools.length, 74);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});





