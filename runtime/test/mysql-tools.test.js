import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";

const CALLER = Object.freeze({ clientId: "c2c_client_MYSQL_TEST", requestId: 21 });

async function setup(policy = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-mysql-"));
  const root = path.join(parent, "workspace");
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(root);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: policy }), "utf8");
  return { parent, root, profile };
}

function call(ctx, name, args) {
  return dispatchMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    "0123456789ab",
    ctx.root,
    path.join(ctx.profile, "executions"),
    { caller: CALLER, toolPolicyDir: ctx.profile },
  );
}

test("MySQL 工具默认关闭，开启后无控制通道时失败关闭", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () => call(ctx, "mysql_list_schemas", { datasource_id: "mysql_0123456789ab" }),
      /TOOL_DISABLED/,
    );
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }

  const enabled = await setup({
    mysql_list_schemas: { enabled: true, approval: "auto" },
    mysql_query: { enabled: true, approval: "auto" },
  });
  try {
    await assert.rejects(
      () => call(enabled, "mysql_list_schemas", { datasource_id: "mysql_0123456789ab" }),
      /CONTROL_BRIDGE_UNAVAILABLE/,
    );
    await assert.rejects(
      () => call(enabled, "mysql_query", { datasource_id: "bad", sql: "SELECT 1" }),
      /DATASOURCE_ID_INVALID/,
    );
  } finally {
    await rm(enabled.parent, { recursive: true, force: true });
  }
});

test("已认证客户端的 tools/list 包含 3 个 MySQL 工具，且默认值来自 inventory", async () => {
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
    for (const name of ["mysql_list_schemas", "mysql_describe_table", "mysql_query"]) {
      assert.ok(names.includes(name), name);
    }
    assert.equal(listed.tools.length, 75);
  } finally {
    await rm(ctx.parent, { recursive: true, force: true });
  }
});







