/**
 * 单次 DNS 解析 + 全量判定 + 固定目标地址。
 *
 * 这是 SSRF 防护链路的入口：整个 fetch 过程中，域名解析**只在这里发生一次**，
 * 其返回值随后被 `pinned-transport` 直接作为 socket 的目标地址（不允许底层再解析）。
 *
 * 规则（对应方案 I6 / I9 / M1）：
 * - 空答案 → `FETCH_DNS_EMPTY`（旧实现会放行，属缺陷）；
 * - 任意一条答案不是公网单播 → 整体拒绝（不挑选、"取一条安全的"）；
 * - 全部通过后，按 **DNS 返回顺序**取第一条（Q4 定稿，不做 IPv4 优先）。
 */
import dns from "node:dns/promises";
import { classifyAddress, formatAddress, parseAddress, type AddressFamily } from "./address-policy.js";
import { FetchError } from "./fetch-error.js";

export interface PinnedTarget {
  hostname: string;
  /** 规范化文本，供 pinned-transport 的 lookup 回放。 */
  address: string;
  family: AddressFamily;
}

export interface DnsAnswer {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string, options: { all: true; verbatim: boolean }) => Promise<DnsAnswer[]>;

export interface ResolveOptions {
  timeoutMs?: number;
  /** 测试注入点：生产不传，使用真实的 dns.lookup。 */
  lookup?: LookupFn;
}

export const DEFAULT_DNS_TIMEOUT_MS = 3_000;

const defaultLookup: LookupFn = (hostname, options) => dns.lookup(hostname, options) as Promise<DnsAnswer[]>;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new FetchError("FETCH_DNS_TIMEOUT"));
  }
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new FetchError("FETCH_DNS_TIMEOUT")), timeoutMs);
    promise.then(
      (value) => { if (timer) clearTimeout(timer); resolve(value); },
      (error) => { if (timer) clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * 解析并固定一个域名。任一步失败都抛 `FetchError`，调用方必须失败关闭。
 */
export async function resolvePinnedTarget(hostname: string, options: ResolveOptions = {}): Promise<PinnedTarget> {
  const lookup = options.lookup ?? defaultLookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;

  let answers: DnsAnswer[];
  try {
    answers = await withTimeout(lookup(hostname, { all: true, verbatim: true }), timeoutMs);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError("FETCH_DNS_FAILED");
  }

  // M1：空答案必须拒绝，不能"无地址视为通过"。
  if (!Array.isArray(answers) || answers.length === 0) throw new FetchError("FETCH_DNS_EMPTY");

  const verified: PinnedTarget[] = [];
  for (const answer of answers) {
    const parsed = typeof answer?.address === "string" ? parseAddress(answer.address) : null;
    if (!parsed) throw new FetchError("FETCH_DNS_INVALID_ADDRESS");
    // M1：任意一条不合规 → 整体拒绝（不允许忽略危险答案）。
    if (!classifyAddress(parsed).allowed) throw new FetchError("FETCH_HOST_NOT_ALLOWED");
    verified.push({ hostname, address: formatAddress(parsed), family: parsed.family });
  }

  // Q4：保留 DNS 顺序；此处取第一条是安全的，因为上面已保证全部答案合规。
  return verified[0]!;
}
