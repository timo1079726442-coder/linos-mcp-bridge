/**
 * fetch — 受白名单约束的只读网络读取。
 *
 * 约束：
 * - 只允许 GET；目标域名必须写在 `<profile>/workspaces/<workspaceId>/fetch-allowlist.json`
 *   （兼容旧的 `<profile>/fetch-allowlist.json`），文件不存在或为空 = 完全禁止；
 * - 默认只允许 https；`allow_http` 明确打开才允许 http；
 * - 拒绝 IP 字面量、localhost、URL 内嵌账号密码；
 * - 手动处理重定向，每一跳都重新校验白名单（最多 3 跳）；
 * - 10s 超时、1MB 响应上限、仅文本类 content-type、正文截断到 20 万字符。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface FetchAllowlist {
  domains: string[];
  allowHttp: boolean;
  source: "workspace" | "profile" | "default";
  file: string | null;
}

export class FetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FetchError";
  }
}

const MAX_URL_LENGTH = 2_000;
const MAX_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
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

function parseAllowlist(raw: unknown): { domains: string[]; allowHttp: boolean } {
  const value = Array.isArray(raw) ? { domains: raw } : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FetchError("FETCH_ALLOWLIST_INVALID");
  }
  const record = value as Record<string, unknown>;
  const domains = Array.isArray(record.domains)
    ? [...new Set(record.domains.map(normalizeEntry).filter((entry): entry is string => entry !== null))]
    : [];
  return { domains: domains.slice(0, 100), allowHttp: record.allow_http === true };
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
    const { domains, allowHttp } = parseAllowlist(parsed);
    return { domains, allowHttp, source: candidate.source, file: candidate.file };
  }
  return { domains: [], allowHttp: false, source: "default", file: null };
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
  return url;
}

function isTextContentType(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return ALLOWED_TYPES.some((allowed) => normalized.startsWith(allowed));
}

export async function fetchUrl(
  profileDir: string,
  workspaceId: string | null,
  args: { url?: unknown; max_bytes?: unknown },
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const allowlist = await loadFetchAllowlist(profileDir, workspaceId);
  let current = validateUrl(args.url, allowlist);
  const maxBytes = typeof args.max_bytes === "number" && Number.isInteger(args.max_bytes)
    ? Math.max(1_024, Math.min(MAX_BYTES, args.max_bytes))
    : MAX_BYTES;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await request(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/*, application/json;q=0.9, */*;q=0.1" },
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) throw new FetchError("FETCH_TIMEOUT");
      throw new FetchError("FETCH_FAILED");
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new FetchError("FETCH_REDIRECT_INVALID");
      if (redirect === MAX_REDIRECTS) throw new FetchError("FETCH_REDIRECT_LIMIT");
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new FetchError("FETCH_REDIRECT_INVALID");
      }
      current = validateUrl(next.toString(), allowlist);
      continue;
    }

    if (!response.ok) throw new FetchError("FETCH_HTTP_ERROR");
    const contentType = response.headers.get("content-type");
    if (!isTextContentType(contentType)) throw new FetchError("FETCH_CONTENT_TYPE_REJECTED");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new FetchError("FETCH_TOO_LARGE");
    if (!response.body) throw new FetchError("FETCH_FAILED");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new FetchError("FETCH_TOO_LARGE");
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
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
