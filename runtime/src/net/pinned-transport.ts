/**
 * 把已校验的 IP 固定到实际 TCP 连接上（SSRF 修复的核心）。
 *
 * 关键点（对应方案 I1 / I2 / I3 / I4 / I7）：
 * - `lookup` 只回放 `PinnedTarget.address`，底层不存在第二次解析；
 * - `host` / `servername` 保持原始域名，因此 Host 头、SNI、证书校验都不降级；
 * - `agent: false`，每次请求独立连接，避免连接池跨目标复用；
 * - 响应到达后比较 `socket.remoteAddress` 与被校验地址（规范化比较），不一致立即中止。
 */
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { Socket } from "node:net";
import { sameAddress } from "./address-policy.js";
import { FetchError } from "./fetch-error.js";
import type { PinnedTarget } from "./resolver.js";

export interface PinnedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  message: IncomingMessage;
  socket: Socket;
  remoteAddress: string;
  destroy: () => void;
}

export interface PinnedRequestOptions {
  url: URL;
  target: PinnedTarget;
  headers?: Record<string, string>;
  /** 绝对截止时间（epoch ms）：到点立即中止并返回 FETCH_TIMEOUT。 */
  deadlineMs: number;
  connectTimeoutMs?: number;
  /**
   * 仅供测试：实际拨号地址（默认等于 `target.address`）。
   * 生产调用路径永不传入；用于验证"对端与被校验地址不一致"时必须失败关闭。
   */
  __testDialAddress?: string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/** 纯函数：构造请求参数，便于对 TLS/SNI/agent/lookup 做单元断言。 */
export function buildRequestOptions(input: PinnedRequestOptions): RequestOptions {
  const isHttps = input.url.protocol === "https:";
  const hostname = input.target.hostname;
  const dialAddress = input.__testDialAddress ?? input.target.address;
  const port = input.url.port ? Number(input.url.port) : (isHttps ? 443 : 80);
  const options: RequestOptions = {
    protocol: input.url.protocol,
    // host 决定 Host 头与证书校验基准，必须保持域名（不得改写成 IP）。
    host: hostname,
    port,
    path: `${input.url.pathname}${input.url.search}`,
    method: "GET",
    // 禁用连接池：任何跨跳/跨目标复用都会让"固定 IP"失去意义。
    agent: false,
    headers: { ...(input.headers ?? {}), host: hostname },
  };
  // Node 在 family autoselection 下会以 all:true 调用 lookup；两种形态都要支持。
  const lookup = (
    lookupHostname: string,
    lookupOptions: { all?: boolean },
    callback: (error: NodeJS.ErrnoException | null, addressOrAddresses: unknown, family?: number) => void,
  ): void => {
    if (String(lookupHostname).toLowerCase() !== hostname.toLowerCase()) {
      // 底层只应针对本次已校验的域名取址；其他情况视为实现被破坏。
      callback(new FetchError("FETCH_LOOKUP_HOST_MISMATCH") as unknown as NodeJS.ErrnoException, "");
      return;
    }
    if (lookupOptions?.all) {
      callback(null, [{ address: dialAddress, family: input.target.family }]);
    } else {
      callback(null, dialAddress, input.target.family);
    }
  };
  (options as { lookup?: unknown }).lookup = lookup;
  if (isHttps) {
    // SNI 与证书校验都使用原始域名；绝不关闭校验。
    options.servername = hostname;
    options.rejectUnauthorized = true;
  }
  return options;
}

function mapTransportError(error: unknown): FetchError {
  if (error instanceof FetchError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")
    || ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) {
    return new FetchError("FETCH_TLS_FAILED");
  }
  if (code === "ETIMEDOUT") return new FetchError("FETCH_CONNECT_TIMEOUT");
  return new FetchError("FETCH_FAILED");
}

/**
 * 发起一次固定 IP 的请求。响应体为流，调用方负责消费或 destroy。
 * 任何异常都以 `FetchError` 拒绝，调用方必须失败关闭。
 */
export function requestPinned(input: PinnedRequestOptions): Promise<PinnedResponse> {
  const remaining = input.deadlineMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return Promise.reject(new FetchError("FETCH_TIMEOUT"));
  }
  const options = buildRequestOptions(input);
  const transport = input.url.protocol === "https:" ? https : http;

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false;
    const settleError = (error: FetchError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const deadlineTimer = setTimeout(() => {
      settleError(new FetchError("FETCH_TIMEOUT"));
      request.destroy(new FetchError("FETCH_TIMEOUT"));
    }, remaining);
    deadlineTimer.unref?.();

    const request = transport.request(options, (message) => {
      const remote = message.socket?.remoteAddress ?? "";
      // I2 / M2：证明"校验的 IP == 连接的 IP"；不等则失败关闭，不读取正文。
      if (!sameAddress(remote, input.target.address)) {
        message.destroy();
        settleError(new FetchError("FETCH_PEER_MISMATCH"));
        return;
      }
      if (settled) {
        message.destroy();
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
      resolve({
        status: message.statusCode ?? 0,
        headers: message.headers,
        message,
        socket: message.socket as Socket,
        remoteAddress: remote,
        destroy: () => message.destroy(),
      });
    });

    request.setTimeout(input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, () => {
      request.destroy(new FetchError("FETCH_CONNECT_TIMEOUT"));
    });
    request.on("error", (error: unknown) => settleError(mapTransportError(error)));
    request.end();
  });
}
