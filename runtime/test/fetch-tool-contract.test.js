import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { fetchUrl } from "../dist/fetch-tool.js";

const WORKSPACE_ID = "0123456789ab";
const PUBLIC_ADDRESS = "93.184.216.34";

async function setup(options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-fetch-contract-"));
  const profile = path.join(parent, "profiles", "mb_pf_test");
  const root = path.join(parent, "workspace");
  await mkdir(root, { recursive: true });
  await mkdir(path.join(profile, "workspaces", WORKSPACE_ID), { recursive: true });
  const payload = { domains: ["example.com"], allow_http: options.allowHttp === true };
  if (options.allowPorts) payload.allow_ports = options.allowPorts;
  await writeFile(path.join(profile, "workspaces", WORKSPACE_ID, "fetch-allowlist.json"),
    JSON.stringify(payload), "utf8");
  await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: {} }), "utf8");
  return { parent, profile, root };
}

function fakeResponse(headers = {}, body = "{}") {
  const message = Readable.from([Buffer.from(body, "utf8")]);
  const socket = { remoteAddress: PUBLIC_ADDRESS };
  return {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
    message,
    socket,
    remoteAddress: PUBLIC_ADDRESS,
    destroy: () => message.destroy(),
  };
}

/** M4：端口授权只来自管理员配置，工具参数里不存在端口入口。 */
test("S4：fetch 工具 schema 只接受 url / max_bytes，且禁止额外参数", async () => {
  const { parent, profile, root } = await setup();
  try {
    const listed = await dispatchMcp({ method: "tools/list" }, WORKSPACE_ID, root, null, {
      toolPolicyDir: profile,
      caller: { clientId: "fetch-contract-client", requestId: "fetch-contract-1" },
    });
    const fetchTool = listed.tools.find((tool) => tool.name === "fetch");
    assert.ok(fetchTool, "fetch 工具必须注册");
    assert.deepEqual(Object.keys(fetchTool.inputSchema.properties).sort(), ["max_bytes", "url"]);
    assert.equal(fetchTool.inputSchema.additionalProperties, false);
    assert.deepEqual(fetchTool.inputSchema.required, ["url"]);
    for (const forbidden of ["port", "allow_ports", "method", "headers", "host"]) {
      assert.equal(forbidden in fetchTool.inputSchema.properties, false, `schema 不得暴露 ${forbidden}`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S4：调用方传入 port 参数不会改变实际端口（M4 / T32）", async () => {
  const strict = await setup();
  try {
    // 带 port 参数 + URL 使用非默认端口：仍然被拒绝，说明参数不生效。
    await assert.rejects(() => fetchUrl(strict.profile, WORKSPACE_ID, {
      url: "https://example.com:8443/x", port: 8443, allow_ports: [8443],
    }, {
      resolve: async (hostname) => ({ hostname, address: PUBLIC_ADDRESS, family: 4 }),
      request: async () => fakeResponse(),
    }), /FETCH_PORT_NOT_ALLOWED/);

    // 默认端口请求：参数里的 port 不得覆盖 URL 计算出的端口。
    const requested = [];
    await fetchUrl(strict.profile, WORKSPACE_ID, {
      url: "https://example.com/x", port: 9443,
    }, {
      resolve: async (hostname) => ({ hostname, address: PUBLIC_ADDRESS, family: 4 }),
      request: async (options) => { requested.push(options); return fakeResponse(); },
    });
    assert.equal(requested[0].url.port, "", "URL 端口不得被参数改写");
    assert.equal(requested[0].url.hostname, "example.com");
  } finally {
    await rm(strict.parent, { recursive: true, force: true });
  }
});
