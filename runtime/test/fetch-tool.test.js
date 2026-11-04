import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { domainAllowed, fetchUrl, loadFetchAllowlist } from "../dist/fetch-tool.js";

const WORKSPACE_ID = "0123456789ab";

async function setup(domains, options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-fetch-"));
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(profile, { recursive: true });
  await mkdir(path.join(profile, "workspaces", WORKSPACE_ID), { recursive: true });
  await writeFile(path.join(profile, "workspaces", WORKSPACE_ID, "fetch-allowlist.json"),
    JSON.stringify({ domains, allow_http: options.allowHttp === true }), "utf8");
  return { parent, profile };
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "application/json" },
  });
}

test("白名单：精确匹配与 *. 子域名匹配", () => {
  assert.equal(domainAllowed("example.com", ["example.com"]), true);
  assert.equal(domainAllowed("sub.example.com", ["example.com"]), false);
  assert.equal(domainAllowed("sub.example.com", ["*.example.com"]), true);
  assert.equal(domainAllowed("example.com", ["*.example.com"]), false);
  assert.equal(domainAllowed("evil-example.com", ["*.example.com"]), false);
});

test("白名单文件按工作区优先，缺失时回退 Profile 级", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    const loaded = await loadFetchAllowlist(profile, WORKSPACE_ID);
    assert.equal(loaded.source, "workspace");
    assert.deepEqual(loaded.domains, ["example.com"]);

    await writeFile(path.join(profile, "fetch-allowlist.json"), JSON.stringify({ domains: ["fallback.test"] }), "utf8");
    const fallback = await loadFetchAllowlist(profile, "aabbccddeeff");
    assert.equal(fallback.source, "profile");
    assert.deepEqual(fallback.domains, ["fallback.test"]);

    const empty = await loadFetchAllowlist(profile, "not-set");
    assert.equal(empty.source, "profile");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("fetch 成功读取文本并报告大小/截断", async () => {
  const { parent, profile } = await setup(["example.com", "*.example.com"]);
  try {
    const request = async (url) => {
      assert.equal(url, "https://example.com/data.json");
      return jsonResponse({ ok: true });
    };
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/data.json" }, request);
    assert.equal(result.status, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.match(String(result.text), /"ok":true/);
    assert.equal(result.allowlist_source, "workspace");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("fetch 拒绝未授权域名、http、IP、localhost 与带凭据 URL", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    const noop = async () => jsonResponse({});
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://evil.test/x" }, noop), /FETCH_DOMAIN_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "http://example.com/x" }, noop), /FETCH_SCHEME_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://127.0.0.1/x" }, noop), /FETCH_HOST_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://localhost/x" }, noop), /FETCH_HOST_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://user:pass@example.com/x" }, noop), /FETCH_URL_INVALID/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  const empty = await setup([]);
  try {
    const noop = async () => jsonResponse({});
    await assert.rejects(() => fetchUrl(empty.profile, WORKSPACE_ID, { url: "https://example.com/x" }, noop), /FETCH_DISABLED/);
  } finally {
    await rm(empty.parent, { recursive: true, force: true });
  }
});

test("fetch 逐跳校验重定向，拒绝跳到白名单外", async () => {
  const { parent, profile } = await setup(["example.com", "*.example.com"]);
  try {
    const redirect = async () => new Response(null, { status: 302, headers: { location: "https://sub.example.com/final" } });
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/start" }, async (url) => {
      if (url === "https://example.com/start") return redirect();
      return jsonResponse({ done: true });
    });
    assert.equal(result.final_url, "https://sub.example.com/final");
    assert.equal(result.redirects, 1);

    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/start" }, async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.test/final" } })),
      /FETCH_DOMAIN_NOT_ALLOWED/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("fetch 拒绝非文本类型与超大响应", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/a.bin" },
        async () => new Response("binary", { status: 200, headers: { "content-type": "application/octet-stream" } })),
      /FETCH_CONTENT_TYPE_REJECTED/,
    );
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/big", max_bytes: 1024 },
        async () => new Response("x", { status: 200, headers: { "content-type": "text/plain", "content-length": "2048" } })),
      /FETCH_TOO_LARGE/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
