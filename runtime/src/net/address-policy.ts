/**
 * 地址策略：把 IP 文本规范化为可比对的数值，并判定是否属于"全局可路由单播"。
 *
 * 安全目标（对应 SSRF 方案 I2 / I5 / I6 / M1 / M2）：
 * - 严格解析，不猜测：无法确定格式的一律视为无效（调用方必须失败关闭）；
 * - 只允许公网单播，其余（回环、私网、链路本地、CGNAT、文档段、多播、保留段、
 *   云元数据、IPv4-mapped/NAT64/6to4/Teredo 等）全部拒绝；
 * - 比较用 {family, value} 而不是字符串，避免 `::ffff:127.0.0.1`、`2001:0db8::1`
 *   之类写法绕过或误判。
 *
 * 本模块是纯函数，无 I/O，便于穷举地址矩阵做单元测试。
 */

export type AddressFamily = 4 | 6;

export interface ParsedAddress {
  family: AddressFamily;
  /** IPv4 为 32 位，IPv6 为 128 位。 */
  value: bigint;
}

export interface AddressVerdict {
  allowed: boolean;
  /** 拒绝原因（CIDR 或分类名），仅用于内部诊断，不应原样暴露给调用方。 */
  reason?: string;
}

const V4_TOTAL_BITS = 32;
const V6_TOTAL_BITS = 128;

/** 全局可路由单播的允许区间（IPv4）：1.0.0.0 – 223.255.255.255。 */
const V4_GLOBAL_MIN = 0x01000000n;
const V4_GLOBAL_MAX = 0xdfffffffn;

/** IPv6 只允许 2000::/3 之内（再减去下表拒绝段）。 */
const V6_GLOBAL_PREFIX = 0x20000000000000000000000000000000n;
const V6_GLOBAL_BITS = 3;

/**
 * IPv4 拒绝段（默认拒绝的补充枚举；区间之外的地址本来就不允许）。
 * 云元数据 169.254.169.254 落在 169.254.0.0/16，被此表覆盖。
 */
const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT（含 100.100.100.200 云元数据）
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // 链路本地 + 169.254.169.254 / 169.254.170.2
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // 多播
  ["240.0.0.0", 4], // 保留（含 255.255.255.255）
];

/**
 * IPv6 拒绝段：
 * - ::/96 覆盖 ::、::1 与已废弃的 IPv4-compatible 形式；
 * - ::ffff:0:0/96 在解析阶段已降级为 IPv4，由 IPv4 规则判定；
 * - 64:ff9b::/96、64:ff9b:1::/48 为 NAT64；2001::/23 含 Teredo/ORCHID/文档；
 *   2002::/16 为 6to4；3fff::/20 为文档段；
 * - fc00::/7 ULA（含 fd00:ec2::254）、fe80::/10 链路本地、ff00::/8 多播。
 */
const V6_DENY: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32], // 文档段：不在 2001::/23 内，必须单独拒绝
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

function parseIpv4(input: string): bigint | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(input);
  if (!match) return null;
  const parts: number[] = [];
  for (let index = 1; index <= 4; index += 1) {
    const text = match[index] ?? "";
    // 拒绝前导零（`010` 的八进制语义在不同解析器下不一致，不能猜）。
    if (text.length > 1 && text.startsWith("0")) return null;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    parts.push(value);
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  return (BigInt(a) << 24n) | (BigInt(b) << 16n) | (BigInt(c) << 8n) | BigInt(d);
}

function parseHexGroups(text: string): number[] | null {
  if (text === "") return [];
  const groups: number[] = [];
  for (const group of text.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

function parseIpv6(input: string): bigint | null {
  // zone id（`fe80::1%eth0`）只对链路本地有意义，后者本就被拒；直接视为无效。
  if (input.includes("%")) return null;
  if ((input.match(/::/g) ?? []).length > 1) return null;

  let body = input;
  let embeddedV4: bigint | null = null;
  const lastColon = body.lastIndexOf(":");
  if (lastColon !== -1 && body.slice(lastColon + 1).includes(".")) {
    embeddedV4 = parseIpv4(body.slice(lastColon + 1));
    if (embeddedV4 === null) return null;
    // 用两个占位 hextet 保留位置，最后再覆盖低 32 位。
    body = `${body.slice(0, lastColon + 1)}0:0`;
  }

  const halves = body.split("::");
  const left = parseHexGroups(halves[0] ?? "");
  if (left === null) return null;

  let groups: number[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const right = parseHexGroups(halves[1] ?? "");
    if (right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  if (embeddedV4 !== null) {
    const lowMask = 0xffffffffn;
    value = (value & ~lowMask) | embeddedV4;
  }
  return value;
}

/**
 * 严格解析。IPv4-mapped（`::ffff:a.b.c.d`）会归一化为 family=4：
 * 它的实际连接目标就是内嵌的 IPv4，按同一套规则判定才不会漏。
 */
export function parseAddress(input: string): ParsedAddress | null {
  if (typeof input !== "string") return null;
  const text = input.trim();
  if (!text || text.length > 64) return null;

  if (text.includes(":")) {
    const value = parseIpv6(text);
    if (value === null) return null;
    // ::ffff:0:0/96 → 高 96 位为 0 且第 80–95 位为 0xffff
    const high96 = value >> 32n;
    if (high96 === 0xffffn) {
      return { family: 4, value: value & 0xffffffffn };
    }
    return { family: 6, value };
  }

  const v4 = parseIpv4(text);
  return v4 === null ? null : { family: 4, value: v4 };
}

/** 规范化输出（用于把地址回填给 lookup / 日志）。 */
export function formatAddress(address: ParsedAddress): string {
  if (address.family === 4) {
    const value = Number(address.value & 0xffffffffn);
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
  }
  const groups: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    groups.push(Number((address.value >> shift) & 0xffffn));
  }
  // RFC 5952：压缩最长的一段连续 0（长度 >= 2），其余小写无前导零。
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** 规范化比较：family 与数值都要相等；无法解析时一律返回 false（失败关闭）。 */
export function sameAddress(left: string, right: string): boolean {
  const a = parseAddress(left);
  const b = parseAddress(right);
  if (!a || !b) return false;
  return a.family === b.family && a.value === b.value;
}

function cidrPrefix(cidr: string): bigint {
  const parsed = parseAddress(cidr);
  if (!parsed) throw new Error(`invalid cidr: ${cidr}`);
  return parsed.value;
}

const V4_DENY_RESOLVED = V4_DENY.map(([cidr, bits]) => ({ prefix: cidrPrefix(cidr), bits, label: `${cidr}/${bits}` }));
const V6_DENY_RESOLVED = V6_DENY.map(([cidr, bits]) => ({ prefix: cidrPrefix(cidr), bits, label: `${cidr}/${bits}` }));

function inCidr(value: bigint, prefix: bigint, bits: number, totalBits: number): boolean {
  if (bits <= 0) return true;
  const shift = BigInt(totalBits - bits);
  return (value >> shift) === (prefix >> shift);
}

function classifyV4(value: bigint): AddressVerdict {
  if (value < V4_GLOBAL_MIN || value > V4_GLOBAL_MAX) {
    return { allowed: false, reason: "not-global-unicast" };
  }
  for (const deny of V4_DENY_RESOLVED) {
    if (inCidr(value, deny.prefix, deny.bits, V4_TOTAL_BITS)) return { allowed: false, reason: deny.label };
  }
  return { allowed: true };
}

function classifyV6(value: bigint): AddressVerdict {
  if (!inCidr(value, V6_GLOBAL_PREFIX, V6_GLOBAL_BITS, V6_TOTAL_BITS)) {
    return { allowed: false, reason: "not-global-unicast" };
  }
  for (const deny of V6_DENY_RESOLVED) {
    if (inCidr(value, deny.prefix, deny.bits, V6_TOTAL_BITS)) return { allowed: false, reason: deny.label };
  }
  return { allowed: true };
}

/** 判定一个已解析地址是否允许作为抓取目标。 */
export function classifyAddress(address: ParsedAddress): AddressVerdict {
  return address.family === 4 ? classifyV4(address.value) : classifyV6(address.value);
}

/** 便捷版：文本无法解析的地址同样视为不允许（失败关闭）。 */
export function classifyAddressText(input: string): AddressVerdict {
  const parsed = parseAddress(input);
  if (!parsed) return { allowed: false, reason: "invalid-address" };
  return classifyAddress(parsed);
}
