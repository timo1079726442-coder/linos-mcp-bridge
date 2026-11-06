/**
 * fetch — 受白名单约束的只读网络读取（SSRF 加固版）。
 *
 * 约束：
 * - 只允许 GET；目标域名必须写在 `<profile>/workspaces/<workspaceId>/fetch-allowlist.json`
 *   （兼容旧的 `<profile>/fetch-allowlist.json`），文件不存在或为空 = 完全禁止；
 * - 默认只允许 https；`allow_http` 明确打开才允许 http；**https 不得降级到 http**；
 * - 拒绝 IP 字面量、localhost、URL 内嵌账号密码；端口只允许默认端口或管理员显式授权；
 * - 每一跳都重新"解析 → 全量公网判定 → 固定 IP → 连接 → 核对对端地址"，最多 3 跳；
 * - 全局共享一个截止时间（不按跳重置）；DNS 3s、连接 5s、总预算 20s；
 * - 1MB 响应上限、仅文本类 content-type、拒绝压缩编码、正文截断到 20 万字符。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FetchError } from "./net/fetch-error.js";
import { resolvePinnedTarget, type PinnedTarget, type ResolveOptions } from "./net/resolver.js";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  requestPinned,
  type PinnedRequestOptions,
  type PinnedResponse,
} from "./net/pinned-transport.js";

export { FetchError } from "./net/fetch-error.js";

export interface FetchAllowlist {
  domains: string[];
  allowHttp: boolean;
  /** 管理员显式授权的非默认端口（M4：只来自控制面配置文件）。 */
  allowPorts: number[];
  source: "workspace" | "profile" | "default";
  file: string | null;
}

/** 测试注入点：生产不传，使用真实解析与传输。 */
export interface FetchDeps {
  resolve?: (hostname: string, options?: ResolveOptions) => Promise<PinnedTarget>;
  request?: (options: PinnedRequestOptions) => Promise<PinnedResponse>;
}

const MAX_URL_LENGTH = 2_000;
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_REDIRECTS = 3;
const TOTAL_BUDGET_MS = 20_000;
const DNS_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = DEFAULT_CONNECT_TIMEOUT_MS;
const DEFAULT_PORTS: Record<string, number> = { "https:": 443, "http:": 80 };
const ACCEPT_HEADER = "text/*, application/json;q=0.9, */*;q=0.1";
const DOMAIN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ALLOWED_TYPES = [
  "text/",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/yaml",
  "application/x-yaml",
  "application/rss+xml",
  "application/atom+xml",
];

function allowlistFile(dir: string, workspaceId: string | null): string | null {
  if (workspaceId && /^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
    return path.join(dir, "workspaces", workspaceId, "fetch-allowlist.json");
  }
  return null;
}

function normalizeEntry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const entry = value.trim().toLowerCase();
  if (!entry || entry.length > 253 || !DOMAIN.test(entry)) return null;
  return entry;
}

function normalizePorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ports = new Set<number>();
  for (const item of value) {
    const port = typeof item === "number" ? item : typeof item === "string" ? Number(item) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    ports.add(port);
  }
  return [...ports].slice(0, 20).sort((a, b) => a - b);
}

function parseAllowlist(raw: unknown): { domains: string[]; allowHttp: boolean; allowPorts: number[] } {
  const value = Array.isArray(raw) ? { domains: raw } : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FetchError("FETCH_ALLOWLIST_INVALID");
  }
  const record = value as Record<string, unknown>;
  const domains = Array.isArray(record.domains)
    ? [...new Set(record.domains.map(normalizeEntry).filter((entry): entry is string => entry !== null))]
    : [];
  return {
    domains: domains.slice(0, 100),
    allowHttp: record.allow_http === true,
    allowPorts: normalizePorts(record.allow_ports),
  };
}

export async function loadFetchAllowlist(
  profileDir: string,
  workspaceId: string | null,
): Promise<FetchAllowlist> {
  const workspaceFile = allowlistFile(profileDir, workspaceId);
  const candidates: Array<{ file: string; source: "workspace" | "profile" }> = [];
  if (workspaceFile) candidates.push({ file: workspaceFile, source: "workspace" });
  candidates.push({ file: path.join(profileDir, "fetch-allowlist.json"), source: "profile" });

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate.file, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new FetchError("FETCH_ALLOWLIST_INVALID");
    }
    const { domains, allowHttp, allowPorts } = parseAllowlist(parsed);
    return { domains, allowHttp, allowPorts, source: candidate.source, file: candidate.file };
  }
  return { domains: [], allowHttp: false, allowPorts: [], source: "default", file: null };
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[");
}

export function domainAllowed(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entry of domains) {
    if (entry === host) return true;
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return true;
  }
  return false;
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return DEFAULT_PORTS[url.protocol] ?? 0;
}

/** M4：端口只能取默认端口或管理员在配置文件里授权的端口，MCP 调用者无法指定。 */
function assertPortAllowed(url: URL, allowlist: FetchAllowlist): void {
  const port = effectivePort(url);
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (port === defaultPort) return;
  if (allowlist.allowPorts.includes(port)) return;
  throw new FetchError("FETCH_PORT_NOT_ALLOWED");
}

function validateUrl(input: unknown, allowlist: FetchAllowlist): URL {
  if (typeof input !== "string" || !input.trim() || input.length > MAX_URL_LENGTH) {
    throw new FetchError("FETCH_URL_INVALID");
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new FetchError("FETCH_URL_INVALID");
  }
  if (url.username || url.password) throw new FetchError("FETCH_URL_INVALID");
  if (url.protocol !== "https:" && !(allowlist.allowHttp && url.protocol === "http:")) {
    throw new FetchError("FETCH_SCHEME_NOT_ALLOWED");
  }
  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new FetchError("FETCH_HOST_NOT_ALLOWED");
  }
  if (allowlist.domains.length === 0) throw new FetchError("FETCH_DISABLED");
  if (!domainAllowed(hostname, allowlist.domains)) throw new FetchError("FETCH_DOMAIN_NOT_ALLOWED");
  assertPortAllowed(url, allowlist);
  return url;
}

function isTextContentType(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return ALLOWED_TYPES.some((allowed) => normalized.startsWith(allowed));
}

function headerValue(headers: PinnedResponse["headers"], name: string): string | null {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" ? raw : null;
}

/** 读取响应体：边读边计数（避免大文件占内存），并受全局截止时间约束。 */
async function readBounded(response: PinnedResponse, maxBytes: number, deadlineMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: FetchError, buffer?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(buffer ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      response.destroy();
      finish(new FetchError("FETCH_TIMEOUT"));
    }, Math.max(1, deadlineMs - Date.now()));
    timer.unref?.();
    response.message.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        response.destroy();
        finish(new FetchError("FETCH_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    response.message.on("end", () => finish(undefined, Buffer.concat(chunks)));
    response.message.on("close", () => finish(undefined, Buffer.concat(chunks)));
    response.message.on("error", () => finish(new FetchError("FETCH_FAILED")));
  });
}

export async function fetchUrl(
  profileDir: string,
  workspaceId: string | null,
  args: { url?: unknown; max_bytes?: unknown },
  deps: FetchDeps = {},
): Promise<Record<string, unknown>> {
  const allowlist = await loadFetchAllowlist(profileDir, workspaceId);
  const resolve = deps.resolve ?? resolvePinnedTarget;
  const request = deps.request ?? requestPinned;
  const maxBytes = typeof args.max_bytes === "number" && Number.isInteger(args.max_bytes)
    ? Math.max(1_024, Math.min(MAX_BYTES, args.max_bytes))
    : MAX_BYTES;

  // M3：全局截止时间只在入口计算一次，所有跳共享。
  const deadlineMs = Date.now() + TOTAL_BUDGET_MS;
  const visited = new Set<string>();
  let current = validateUrl(args.url, allowlist);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new FetchError("FETCH_TIMEOUT");
    visited.add(current.toString());

    // 每一跳都重新解析并固定 IP；解析结果直接决定连接目标（I1 / M1）。
    const target = await resolve(current.hostname, {
      timeoutMs: Math.min(DNS_TIMEOUT_MS, remaining),
    });
    const response = await request({
      url: current,
      target,
      headers: { accept: ACCEPT_HEADER, "accept-encoding": "identity" },
      deadlineMs,
      connectTimeoutMs: Math.min(CONNECT_TIMEOUT_MS, remaining),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      response.destroy();
      if (!location) throw new FetchError("FETCH_REDIRECT_INVALID");
      if (redirect === MAX_REDIRECTS) throw new FetchError("FETCH_REDIRECT_LIMIT");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new FetchError("FETCH_REDIRECT_INVALID");
      }
      // Q3：禁止 https → http 降级（即使 allow_http 打开）。
      if (current.protocol === "https:" && next.protocol === "http:") {
        throw new FetchError("FETCH_SCHEME_DOWNGRADE");
      }
      current = validateUrl(next.toString(), allowlist);
      if (visited.has(current.toString())) throw new FetchError("FETCH_REDIRECT_LOOP");
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.destroy();
      throw new FetchError("FETCH_HTTP_ERROR");
    }
    const contentType = headerValue(response.headers, "content-type");
    if (!isTextContentType(contentType)) {
      response.destroy();
      throw new FetchError("FETCH_CONTENT_TYPE_REJECTED");
    }
    // Q6：只接受 identity；不做解压（避免压缩炸弹与额外依赖）。
    const encoding = (headerValue(response.headers, "content-encoding") ?? "identity").trim().toLowerCase();
    if (encoding && encoding !== "identity") {
      response.destroy();
      throw new FetchError("FETCH_CONTENT_ENCODING_REJECTED");
    }
    const declared = Number(headerValue(response.headers, "content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      throw new FetchError("FETCH_TOO_LARGE");
    }

    const buffer = await readBounded(response, maxBytes, deadlineMs);
    const decoded = new TextDecoder("utf-8").decode(buffer);
    const truncated = decoded.length > MAX_TEXT_CHARS;
    return {
      url: args.url,
      final_url: current.toString(),
      status: response.status,
      content_type: contentType,
      bytes: buffer.byteLength,
      chars: Math.min(decoded.length, MAX_TEXT_CHARS),
      truncated,
      text: decoded.slice(0, MAX_TEXT_CHARS),
      allowlist_source: allowlist.source,
      redirects: redirect,
    };
  }
  throw new FetchError("FETCH_REDIRECT_LIMIT");
}

/** 测试用：只导出白名单匹配逻辑。 */
export function __testDomainAllowed(hostname: string, domains: string[]): boolean {
  return domainAllowed(hostname, domains);
}
