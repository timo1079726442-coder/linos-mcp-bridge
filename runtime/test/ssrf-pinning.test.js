import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { buildRequestOptions, requestPinned } from "../dist/net/pinned-transport.js";
import { resolvePinnedTarget } from "../dist/net/resolver.js";

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:4700:4700::1111";

// ---------- 解析层：单次解析 + 全量判定 + DNS 顺序 ----------

test("S2：解析只调用一次，且保留 DNS 返回顺序（不做 IPv4 优先）", async () => {
  let calls = 0;
  const target = await resolvePinnedTarget("example.com", {
    lookup: async () => {
      calls += 1;
      // IPv6 在前，IPv4 在后；Q4 定稿要求保留顺序。
      return [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }];
    },
  });
  assert.equal(calls, 1);
  assert.equal(target.family, 6);
  assert.equal(target.address, PUBLIC_V6);
});

test("S2：任一条答案非公网即整体拒绝（M1 / T33）", async () => {
  await assert.rejects(() => resolvePinnedTarget("example.com", {
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }, { address: "127.0.0.1", family: 4 }],
  }), /FETCH_HOST_NOT_ALLOWED/);

  await assert.rejects(() => resolvePinnedTarget("example.com", {
    lookup: async () => [{ address: PUBLIC_V6, family: 6 }, { address: "169.254.169.254", family: 4 }],
  }), /FETCH_HOST_NOT_ALLOWED/);
});

test("S2：空答案拒绝（M1 / T34）", async () => {
  await assert.rejects(() => resolvePinnedTarget("example.com", { lookup: async () => [] }), /FETCH_DNS_EMPTY/);
});

test("S2：非法地址文本、解析失败与超时分别报对应错误码", async () => {
  await assert.rejects(() => resolvePinnedTarget("example.com", {
    lookup: async () => [{ address: "not-an-ip", family: 4 }],
  }), /FETCH_DNS_INVALID_ADDRESS/);

  await assert.rejects(() => resolvePinnedTarget("example.com", {
    lookup: async () => { throw new Error("boom"); },
  }), /FETCH_DNS_FAILED/);

  await assert.rejects(() => resolvePinnedTarget("example.com", {
    timeoutMs: 50,
    lookup: () => new Promise(() => {}), // 永不 resolve
  }), /FETCH_DNS_TIMEOUT/);
});

test("S2：IPv4-mapped 答案归一化为 IPv4 后判定", async () => {
  const allowed = await resolvePinnedTarget("example.com", {
    lookup: async () => [{ address: "::ffff:8.8.8.8", family: 6 }],
  });
  assert.equal(allowed.family, 4);
  assert.equal(allowed.address, "8.8.8.8");

  await assert.rejects(() => resolvePinnedTarget("example.com", {
    lookup: async () => [{ address: "::ffff:127.0.0.1", family: 6 }],
  }), /FETCH_HOST_NOT_ALLOWED/);
});

// ---------- 传输层：TLS/SNI/Host 不被削弱（T10 的静态断言部分） ----------

test("S2：https 请求参数保留域名、SNI、证书校验与独立连接", () => {
  const options = buildRequestOptions({
    url: new URL("https://example.com/path?q=1"),
    target: { hostname: "example.com", address: PUBLIC_V4, family: 4 },
    headers: { accept: "text/*" },
    deadlineMs: Date.now() + 5_000,
  });
  assert.equal(options.host, "example.com", "host 必须是域名，不得改写成 IP");
  assert.equal(options.servername, "example.com", "SNI 必须是域名");
  assert.equal(options.rejectUnauthorized, true, "不得关闭证书校验");
  assert.equal(options.agent, false, "必须禁用连接池复用");
  assert.equal(options.path, "/path?q=1");
  assert.equal(options.headers.host, "example.com");
});

test("S2：lookup 只回放已校验地址，且拒绝其他域名", () => {
  const options = buildRequestOptions({
    url: new URL("https://example.com/"),
    target: { hostname: "example.com", address: PUBLIC_V4, family: 4 },
    deadlineMs: Date.now() + 5_000,
  });
  const lookup = options.lookup;

  const all = [];
  lookup("example.com", { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: PUBLIC_V4, family: 4 }]);
    all.push(addresses);
  });
  assert.equal(all.length, 1, "all:true 时必须回传地址数组");

  const single = [];
  lookup("example.com", {}, (error, address, family) => {
    assert.equal(error, null);
    single.push([address, family]);
  });
  assert.deepEqual(single, [[PUBLIC_V4, 4]]);

  let mismatched = null;
  lookup("other.example.com", { all: true }, (error) => { mismatched = error; });
  assert.ok(mismatched, "非本次已校验域名必须报错");
  assert.match(String(mismatched.code ?? mismatched.message), /FETCH_LOOKUP_HOST_MISMATCH/);
});

// ---------- 真实 socket：证明"校验的 IP == 连接的 IP" ----------

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readAll(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.message.on("data", (chunk) => chunks.push(chunk));
    response.message.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.message.on("error", reject);
  });
}

test("S2：域名在 DNS 中不存在时仍能连接（证明底层没有二次解析）", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"pinned":true}');
  }, async (port) => {
    // `pinned-only.invalid` 按 RFC 6761 保证不可解析；若底层自行解析必定 ENOTFOUND。
    const options = buildRequestOptions({
      url: new URL(`http://pinned-only.invalid:${port}/data.json`),
      target: { hostname: "pinned-only.invalid", address: "127.0.0.1", family: 4 },
      deadlineMs: Date.now() + 5_000,
    });
    assert.equal(options.host, "pinned-only.invalid");
    const response = await requestPinned({
      url: new URL(`http://pinned-only.invalid:${port}/data.json`),
      target: { hostname: "pinned-only.invalid", address: "127.0.0.1", family: 4 },
      deadlineMs: Date.now() + 5_000,
    });
    assert.equal(response.status, 200);
    assert.equal(response.remoteAddress, "127.0.0.1", "实际对端必须等于被校验地址");
    assert.match(await readAll(response), /"pinned":true/);
  });
});

test("S2：连续两次请求不复用连接（agent:false）", async () => {
  const sockets = new Set();
  await withServer((req, res) => {
    sockets.add(req.socket);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  }, async (port) => {
    for (let index = 0; index < 2; index += 1) {
      const response = await requestPinned({
        url: new URL(`http://reuse.test:${port}/`),
        target: { hostname: "reuse.test", address: "127.0.0.1", family: 4 },
        deadlineMs: Date.now() + 5_000,
      });
      await readAll(response);
    }
    assert.equal(sockets.size, 2, "两次请求必须使用不同 socket");
  });
});

test("S2：实际对端与被校验地址不一致时必须失败关闭（T11 / T37）", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("should-not-be-read");
  }, async (port) => {
    await assert.rejects(() => requestPinned({
      url: new URL(`http://mismatch.test:${port}/`),
      // 被校验地址声明为公网地址，但测试钩子实际拨号到 127.0.0.1：
      // remoteAddress 与声明不一致，必须中止而不是返回正文。
      target: { hostname: "mismatch.test", address: PUBLIC_V4, family: 4 },
      __testDialAddress: "127.0.0.1",
      deadlineMs: Date.now() + 5_000,
    }), /FETCH_PEER_MISMATCH/);
  });
});

test("S2：不可达目标与超时返回明确错误码（T6 / T13）", async () => {
  // 端口已关闭
  await assert.rejects(() => requestPinned({
    url: new URL("http://closed.test:1/"),
    target: { hostname: "closed.test", address: "127.0.0.1", family: 4 },
    deadlineMs: Date.now() + 2_000,
  }), /FETCH_FAILED|FETCH_CONNECT_TIMEOUT/);

  // 截止时间已过：不得发起连接
  await assert.rejects(() => requestPinned({
    url: new URL("http://late.test:9/"),
    target: { hostname: "late.test", address: "127.0.0.1", family: 4 },
    deadlineMs: Date.now() - 1,
  }), /FETCH_TIMEOUT/);

  // 服务器不响应，超过全局截止时间
  await withServer(() => { /* 故意不响应 */ }, async (port) => {
    await assert.rejects(() => requestPinned({
      url: new URL(`http://slow.test:${port}/`),
      target: { hostname: "slow.test", address: "127.0.0.1", family: 4 },
      deadlineMs: Date.now() + 150,
    }), /FETCH_TIMEOUT/);
  });
});
