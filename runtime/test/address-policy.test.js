import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAddressText,
  formatAddress,
  parseAddress,
  sameAddress,
} from "../dist/net/address-policy.js";

function assertDenied(address) {
  const verdict = classifyAddressText(address);
  assert.equal(verdict.allowed, false, `${address} 必须被拒绝，实际允许（reason=${verdict.reason}）`);
}

function assertAllowed(address) {
  const verdict = classifyAddressText(address);
  assert.equal(verdict.allowed, true, `${address} 必须放行，实际拒绝（reason=${verdict.reason}）`);
}

// §8.2 地址矩阵：IPv4 特殊段全部拒绝
test("S1：IPv4 特殊用途地址全部拒绝", () => {
  for (const address of [
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200", // 云元数据（Alibaba）
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // 云元数据（AWS/GCP/Azure）
    "169.254.170.2",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.5",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ]) {
    assertDenied(address);
  }
});

test("S1：IPv4 公网地址放行", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "202.106.0.20", "223.255.255.254"]) {
    assertAllowed(address);
  }
});

// §8.2 IPv6 特殊段：ULA / 链路本地 / 多播 / 文档 / 转换型地址
test("S1：IPv6 特殊用途地址全部拒绝", () => {
  for (const address of [
    "::",
    "::1",
    "::ffff:127.0.0.1", // IPv4-mapped → 降级为 v4 判定
    "::ffff:7f00:1", // 同上，十六进制写法
    "::ffff:8.8.8.8", // mapped 公网：归一后放行见正例；此处单独断言见下
    "::127.0.0.1", // IPv4-compatible（已废弃）
    "64:ff9b::7f00:1", // NAT64
    "64:ff9b:1::1", // 本地 NAT64
    "100::1", // discard-only
    "2001::1", // Teredo
    "2001:db8::1", // 文档段
    "2002:7f00:1::1", // 6to4
    "3fff::1", // 文档段（RFC 9637）
    "fc00::1", // ULA
    "fd00:ec2::254", // 云元数据（AWS IPv6）
    "fd12:3456::1",
    "fe80::1", // 链路本地
    "fe80::1%eth0", // 带 zone id
    "ff02::1", // 多播
  ]) {
    if (address === "::ffff:8.8.8.8") continue; // 该地址归一后是公网，见下一个测试
    assertDenied(address);
  }
});

test("S1：IPv6 公网地址放行", () => {
  for (const address of [
    "2606:4700:4700::1111",
    "2a00:1450:4001::1",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8", // IPv4-mapped 公网：归一化为 8.8.8.8 后允许
  ]) {
    assertAllowed(address);
  }
});

// M2：规范化比较
test("S1：mapped 形式与不同文本表示归一化后相等", () => {
  assert.equal(sameAddress("::ffff:127.0.0.1", "127.0.0.1"), true);
  assert.equal(sameAddress("::ffff:8.8.8.8", "8.8.8.8"), true);
  assert.equal(sameAddress("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"), true);
  assert.equal(sameAddress("2001:db8::1", "2001:0DB8::0001"), true);
  assert.equal(sameAddress("::", "0:0:0:0:0:0:0:0"), true);
  assert.equal(sameAddress("127.0.0.1", "127.0.0.2"), false);
  assert.equal(sameAddress("2001:db8::1", "2001:db8::2"), false);
  assert.equal(sameAddress("127.0.0.1", "::1"), false);
  assert.equal(sameAddress("not-an-ip", "not-an-ip"), false, "解析失败必须返回 false");
  assert.equal(sameAddress("127.0.0.1", ""), false);
});

// M2：严格解析，非法写法不被猜测
test("S1：非法或歧义地址文本一律无效", () => {
  for (const address of [
    "",
    "  ",
    "1.2.3",
    "1.2.3.4.5",
    "256.1.1.1",
    "010.1.1.1", // 前导零（八进制歧义）
    "1.2.3.0004",
    "localhost",
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "2001:db8::1::2",
    "gggg::1",
    "1111:2222:3333:4444:5555:6666:7777:8888:9999",
    ":",
    "::ffff:1.2.3.999",
  ]) {
    assert.equal(parseAddress(address), null, `${address} 应解析失败`);
    assert.equal(classifyAddressText(address).allowed, false, `${address} 必须视为不允许`);
  }
});

test("S1：formatAddress 生成可再解析的规范文本", () => {
  const cases = [
    ["127.0.0.1", "127.0.0.1"],
    ["8.8.8.8", "8.8.8.8"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["2606:4700:4700::1111", "2606:4700:4700::1111"],
    ["::ffff:8.8.8.8", "8.8.8.8"],
    ["::", "::"],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseAddress(input);
    assert.ok(parsed, `${input} 应可解析`);
    assert.equal(formatAddress(parsed), expected);
    assert.equal(sameAddress(formatAddress(parsed), input), true, "规范文本必须与原文等价");
  }
});
