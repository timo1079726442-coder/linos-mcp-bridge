import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { domainAllowed, fetchUrl, loadFetchAllowlist } from "../dist/fetch-tool.js";
import { resolvePinnedTarget } from "../dist/net/resolver.js";

const WORKSPACE_ID = "0123456789ab";
const PUBLIC_ADDRESS = "93.184.216.34";

async function setup(domains, options = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-fetch-"));
  const profile = path.join(parent, "profiles", "mb_pf_test");
  await mkdir(profile, { recursive: true });
  await mkdir(path.join(profile, "workspaces", WORKSPACE_ID), { recursive: true });
  const payload = { domains, allow_http: options.allowHttp === true };
  if (options.allowPorts) payload.allow_ports = options.allowPorts;
  await writeFile(path.join(profile, "workspaces", WORKSPACE_ID, "fetch-allowlist.json"),
    JSON.stringify(payload), "utf8");
  return { parent, profile };
}

/** 与 PinnedResponse 同形状的假响应：正文用真实可读流，便于验证读取期限制。 */
function fakeResponse({ status = 200, headers = {}, body = "" } = {}) {
  const message = Readable.from([Buffer.from(body, "utf8")]);
  const socket = { remoteAddress: PUBLIC_ADDRESS };
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    message,
    socket,
    remoteAddress: PUBLIC_ADDRESS,
    destroy: () => message.destroy(),
  };
}

/** 记录每次解析与请求，用于断言"每跳重新解析 + 固定 IP"。 */
function recordingDeps(handler) {
  const resolved = [];
  const requested = [];
  return {
    resolved,
    requested,
    deps: {
      resolve: async (hostname) => {
        resolved.push(hostname);
        return { hostname, address: PUBLIC_ADDRESS, family: 4 };
      },
      request: async (options) => {
        requested.push(options);
        return handler(options, requested.length);
      },
    },
  };
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
    assert.deepEqual(loaded.allowPorts, []);

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

test("fetch 成功读取文本并报告大小/截断（请求头为 identity 编码）", async () => {
  const { parent, profile } = await setup(["example.com", "*.example.com"]);
  try {
    const recorder = recordingDeps(() => fakeResponse({ body: JSON.stringify({ ok: true }) }));
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/data.json" }, recorder.deps);
    assert.equal(result.status, 200);
    assert.equal(result.content_type, "application/json");
    assert.equal(result.truncated, false);
    assert.match(String(result.text), /"ok":true/);
    assert.equal(result.allowlist_source, "workspace");
    // 只解析一次；请求头固定 identity，且 Host 保持域名
    assert.deepEqual(recorder.resolved, ["example.com"]);
    assert.equal(recorder.requested[0].url.hostname, "example.com");
    assert.equal(recorder.requested[0].headers["accept-encoding"], "identity");
    assert.equal(recorder.requested[0].target.address, PUBLIC_ADDRESS);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("fetch 拒绝未授权域名、http、IP、localhost 与带凭据 URL", async () => {
  const { parent, profile } = await setup(["example.com"]);
  const recorder = recordingDeps(() => fakeResponse({}));
  try {
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://evil.test/x" }, recorder.deps), /FETCH_DOMAIN_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "http://example.com/x" }, recorder.deps), /FETCH_SCHEME_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://127.0.0.1/x" }, recorder.deps), /FETCH_HOST_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://localhost/x" }, recorder.deps), /FETCH_HOST_NOT_ALLOWED/);
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://user:pass@example.com/x" }, recorder.deps), /FETCH_URL_INVALID/);
    assert.equal(recorder.requested.length, 0, "被拒绝的 URL 不得发起任何请求");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  const empty = await setup([]);
  try {
    await assert.rejects(() => fetchUrl(empty.profile, WORKSPACE_ID, { url: "https://example.com/x" }, recorder.deps), /FETCH_DISABLED/);
  } finally {
    await rm(empty.parent, { recursive: true, force: true });
  }
});

test("fetch 逐跳重新解析并校验重定向，拒绝跳到白名单外", async () => {
  const { parent, profile } = await setup(["example.com", "*.example.com"]);
  try {
    const recorder = recordingDeps((options, call) => {
      if (call === 1) return fakeResponse({ status: 302, headers: { location: "https://sub.example.com/final" } });
      return fakeResponse({ body: JSON.stringify({ done: true }) });
    });
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/start" }, recorder.deps);
    assert.equal(result.final_url, "https://sub.example.com/final");
    assert.equal(result.redirects, 1);
    assert.deepEqual(recorder.resolved, ["example.com", "sub.example.com"], "每一跳都必须重新解析");

    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/start" }, recordingDeps(() =>
        fakeResponse({ status: 302, headers: { location: "https://evil.test/final" } })).deps),
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
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/a.bin" }, recordingDeps(() =>
        fakeResponse({ headers: { "content-type": "application/octet-stream" }, body: "binary" })).deps),
      /FETCH_CONTENT_TYPE_REJECTED/,
    );
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/big", max_bytes: 1024 }, recordingDeps(() =>
        fakeResponse({ headers: { "content-type": "text/plain", "content-length": "2048" }, body: "x" })).deps),
      /FETCH_TOO_LARGE/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------- S3：新增的收紧策略 ----------

test("S3：https 不得降级到 http（T21）", async () => {
  const { parent, profile } = await setup(["example.com"], { allowHttp: true });
  try {
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/start" }, recordingDeps(() =>
        fakeResponse({ status: 302, headers: { location: "http://example.com/plain" } })).deps),
      /FETCH_SCHEME_DOWNGRADE/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S3：非默认端口默认拒绝，管理员授权后放行（T22 / T39 / M4）", async () => {
  const strict = await setup(["example.com"]);
  try {
    await assert.rejects(
      () => fetchUrl(strict.profile, WORKSPACE_ID, { url: "https://example.com:8443/x" }, recordingDeps(() => fakeResponse({})).deps),
      /FETCH_PORT_NOT_ALLOWED/,
    );
    // 默认端口始终允许
    const ok = recordingDeps(() => fakeResponse({ body: "{}" }));
    await fetchUrl(strict.profile, WORKSPACE_ID, { url: "https://example.com/x" }, ok.deps);
    assert.equal(ok.requested.length, 1);
  } finally {
    await rm(strict.parent, { recursive: true, force: true });
  }

  const relaxed = await setup(["example.com"], { allowPorts: [8443] });
  try {
    const recorder = recordingDeps(() => fakeResponse({ body: "{}" }));
    await fetchUrl(relaxed.profile, WORKSPACE_ID, { url: "https://example.com:8443/x" }, recorder.deps);
    assert.equal(recorder.requested[0].url.port, "8443");
  } finally {
    await rm(relaxed.parent, { recursive: true, force: true });
  }
});

test("S3：重定向环与重定向次数上限（T19 / T20）", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    let hop = 0;
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/loop" }, {
        resolve: async (hostname) => ({ hostname, address: PUBLIC_ADDRESS, family: 4 }),
        request: async () => {
          hop += 1;
          return fakeResponse({ status: 302, headers: { location: "https://example.com/loop" } });
        },
      }),
      /FETCH_REDIRECT_LOOP/,
    );
    assert.equal(hop, 1, "检测到环后不得继续请求");

    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/0" }, {
        resolve: async (hostname) => ({ hostname, address: PUBLIC_ADDRESS, family: 4 }),
        request: async (options) => fakeResponse({
          status: 302,
          headers: { location: `https://example.com/${Number(options.url.pathname.slice(1)) + 1}` },
        }),
      }),
      /FETCH_REDIRECT_LIMIT/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S3：拒绝压缩响应（T27 / Q6）", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/gz" }, recordingDeps(() =>
        fakeResponse({ headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: "x" })).deps),
      /FETCH_CONTENT_ENCODING_REJECTED/,
    );
    // identity 可以接受
    const recorder = recordingDeps(() => fakeResponse({ headers: { "content-type": "text/plain", "content-encoding": "identity" }, body: "ok" }));
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/plain" }, recorder.deps);
    assert.equal(result.text, "ok");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S3：无 content-length 但流式超限与正文截断（T26 / T28 / T38）", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/stream", max_bytes: 1024 }, recordingDeps(() =>
        fakeResponse({ headers: { "content-type": "text/plain" }, body: "x".repeat(4096) })).deps),
      /FETCH_TOO_LARGE/,
    );

    const recorder = recordingDeps(() => fakeResponse({
      headers: { "content-type": "text/plain" },
      body: "y".repeat(210_000),
    }));
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/long" }, recorder.deps);
    assert.equal(result.truncated, true);
    assert.equal(result.chars, 200_000);
    assert.equal(String(result.text).length, 200_000);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S3：混合 DNS 答案经真实解析器整体拒绝（T33 / M1）", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    const mixedDeps = {
      resolve: (hostname) => resolvePinnedTarget(hostname, {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
      }),
      request: async () => fakeResponse({}),
    };
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/x" }, mixedDeps), /FETCH_HOST_NOT_ALLOWED/);

    const emptyDeps = {
      resolve: (hostname) => resolvePinnedTarget(hostname, { lookup: async () => [] }),
      request: async () => fakeResponse({}),
    };
    await assert.rejects(() => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/x" }, emptyDeps), /FETCH_DNS_EMPTY/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S3：全局预算耗尽后不再发起新请求（T29 / T30 / M3）", async () => {
  const { parent, profile } = await setup(["example.com"]);
  try {
    const requested = [];
    let clock = Date.now();
    const deps = {
      resolve: async (hostname) => ({ hostname, address: PUBLIC_ADDRESS, family: 4 }),
      request: async () => {
        requested.push(Date.now());
        // 模拟第一跳耗时超过总预算
        clock += 25_000;
        return fakeResponse({ status: 302, headers: { location: "https://example.com/next" }, body: "" });
      },
    };
    const originalNow = Date.now;
    Date.now = () => clock;
    try {
      await assert.rejects(
        () => fetchUrl(profile, WORKSPACE_ID, { url: "https://example.com/first" }, deps),
        /FETCH_TIMEOUT/,
      );
    } finally {
      Date.now = originalNow;
    }
    assert.equal(requested.length, 1, "预算耗尽后不得发起第 2 次请求");
    assert.ok(clock >= originalNow(), "时间戳应已推进");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("S3：允许 http 时仍需通过白名单与公网判定", async () => {
  const { parent, profile } = await setup(["example.com"], { allowHttp: true });
  try {
    const recorder = recordingDeps(() => fakeResponse({ headers: { "content-type": "text/plain" }, body: "plain" }));
    const result = await fetchUrl(profile, WORKSPACE_ID, { url: "http://example.com/plain" }, recorder.deps);
    assert.equal(result.text, "plain");
    await assert.rejects(
      () => fetchUrl(profile, WORKSPACE_ID, { url: "http://127.0.0.1/plain" }, recorder.deps),
      /FETCH_HOST_NOT_ALLOWED/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
