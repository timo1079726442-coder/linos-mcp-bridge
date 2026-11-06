import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  computeHealthFingerprint,
  deriveAdminControlKey,
  deriveChallengeKey,
  derivePublicHealthChallengeKey,
  signChallenge,
  verifyAdminAuth,
} from "./capability.js";
import { detectWorkspace, type WorkspaceInfo } from "./workspace.js";
import { dispatchMcp, TOOL_INVENTORY, type McpCallerContext, type McpCreateIntentBridge } from "./mcp-tools.js";
import { ExecutionRecordStore } from "./execution-store.js";
import { JobStore } from "./job-store.js";
import { recoverInterruptedJobs } from "./job-runner.js";
import { ExecutionStoreProducer, type CodexTaskCompletionEvent } from "./execution-producer.js";
import {
  authCodes,
  clientRegistry,
  findTokenByAccess,
  findTokenByRefresh,
  hashSecret,
  loadPersistentOAuthState,
  patchPersistedIntent,
  persistClientRecord,
  persistGrantRecord,
  revokeToken,
  tokenStore,
  type OAuthPersistenceOptions,
  type AuthorizationCode,
  type RegisteredClient,
  type TokenSet,
} from "./oauth-store.js";

/**
 * V2 Runtime HTTP surface.
 *
 * The OAuth implementation is deliberately fail-closed: redirect URIs are
 * exact-client bindings, unknown origins are rejected, PKCE S256 is required,
 * authorization codes are single-use, and the MCP endpoint requires a bearer
 * access token. Runtime OAuth state is process-local and is invalidated on a
 * Runtime restart; durable profile/grant records remain Supervisor-owned.
 */

export interface RuntimeIdentity {
  deviceId: string;
  profileId: string;
  runtimeId: string;
  runtimeInstanceId: string;
  workspaceRoot: string;
  workspaceId: string;
  expectedPort: number;
  publicMcpUrl: string | null;
  hostname: string | null;
}

export type OAuthIntentStatus =
  | "PENDING"
  | "CLIENT_BOUND"
  | "CONSENT_PENDING"
  | "CONSUMED"
  | "EXPIRED"
  | "REVOKED"
  | "REVOKED_RUNTIME_RESTART";

export interface OAuthIntentBinding {
  intentId: string;
  deviceId: string;
  profileId: string;
  runtimeId: string;
  runtimeInstanceId: string;
  workspaceId: string;
  status: OAuthIntentStatus;
  expiresAt: string;
  candidateClientId?: string | null;
  /**
   * 本机为本次连接允许的 scope 上限（控制中心"全权模式"）。
   * 为空/缺省时严格按客户端申请授予，保持最小权限。
   */
  grantedScopes?: string[];
}

export interface OAuthServerOptions {
  /** Exact trusted origins. Wildcards are always rejected. */
  trustedRedirectOrigins?: string[];
  /** Profile-approved scopes. Unknown scopes fail closed. */
  allowedScopes?: string[];
  /** Production defaults to true; tests may explicitly disable intent gating. */
  requireIntent?: boolean;
  initialIntent?: OAuthIntentBinding | null;
  persistence?: OAuthPersistenceOptions;
  /** Safe, metadata-only diagnostics for DCR failures; never stores secrets. */
  safeDiagnosticsPath?: string;
}

export interface ServerOptions {
  identity: RuntimeIdentity;
  secret: Buffer;
  executionStorePath?: string | null;
  /** 本机状态根：用于读取长期 API 令牌（给非 OAuth 客户端，如 Claude / Cursor）。 */
  stateRoot?: string | null;
  oauth?: OAuthServerOptions;
  /** Trusted Supervisor bridge; omitted means CREATE requests remain unavailable. */
  createIntentBridge?: McpCreateIntentBridge;
  /** Exposes only allowlisted bridge failure codes in isolated CREATE tests. */
  bridgeFailureDiagnostics?: boolean;
}

export interface RuntimeServerHandle {
  port: number;
  close(): Promise<void>;
  workspace(): Promise<WorkspaceInfo>;
  setOAuthIntent(binding: OAuthIntentBinding | null): void;
}

const DEFAULT_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "workspace.write",
  "workspace.shell",
  "offline_access",
];
const AUTH_CODE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const READ_ONLY_BUNDLE_SCOPES = new Set(["workspace.search", "git.read", "execution.read"]);

export async function startServer(opts: ServerOptions): Promise<RuntimeServerHandle> {
  // Single source of truth for "valid port number" across the runtime.
  // Two valid shapes:
  //   - expectedPort === 0: ephemeral (dev/test launcher) — OS picks a free port
  //   - 1 <= expectedPort <= 65535 integer: fixed port (production shape)
  // Anything else (negative, fractional, > 65535, NaN) is a programming error
  // and must fail closed at startup, before any HTTP listener is bound.
  if (!Number.isInteger(opts.identity.expectedPort)
      || opts.identity.expectedPort < 0
      || opts.identity.expectedPort > 65535) {
    throw new Error(
      `RUNTIME_EXPECTED_PORT_INVALID: ${String(opts.identity.expectedPort)} ` +
      "(expected integer 0..65535, where 0 means ephemeral)",
    );
  }
  const adminKey = deriveAdminControlKey(opts.secret);
  const challengeKey = deriveChallengeKey(opts.secret);
  const healthFp = computeHealthFingerprint(opts.secret);
  const ws = await detectWorkspace(opts.identity.workspaceRoot);
  const expectedPort = opts.identity.expectedPort;
  const startedAt = new Date().toISOString();
  const oauthOptions = opts.oauth ?? {};
  const allowedScopes = new Set(oauthOptions.allowedScopes ?? DEFAULT_SCOPES);
  const trustedRedirectOrigins = new Set(oauthOptions.trustedRedirectOrigins ?? []);
  const requireIntent = oauthOptions.requireIntent ?? true;
  let intentBinding = oauthOptions.initialIntent ?? null;
  // 必须在任何 await 之前声明：否则授权请求先到达会触发 TDZ。
  const reconnectCacheRef: { value: { allow: boolean; at: number } | null } = { value: null };
  const pendingConsent = new Map<string, AuthorizationCode>();

  // 短配对码：只在 127.0.0.1 上生成，只存哈希，一次性使用。
  const pairingCodes = new Map<string, { expiresAt: number }>();
  const PAIRING_TTL_MS = 60 * 60 * 1000;
  // 静态 API 令牌缓存（必须在任何 await 之前声明，否则事件循环先处理请求会 TDZ）。
  const apiTokenCacheRef: { value: { hash: string; scopes: string[]; at: number } | null } = { value: null };
  const isLoopback = (ip: string | undefined): boolean =>
    ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  /**
   * 真正的本机请求：TCP 来源是回环，且不带任何代理转发头。
   * 只看 req.ip 不够——cloudflared 从 127.0.0.1 连进来，公网请求看起来也是"本机"，
   * 那样 /oauth/pairing 就能被公网签发配对码。
   */
  const isDirectLoopback = (req: { ip?: string; headers: Record<string, unknown> }): boolean => {
    const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"];
    if (typeof forwarded === "string" && forwarded.trim().length > 0) return false;
    return isLoopback(req.ip);
  };
  const executionProducer = opts.executionStorePath
    ? new ExecutionStoreProducer(new ExecutionRecordStore(opts.executionStorePath))
    : null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  // ----- Health (public; minimal identity) -----
  app.get("/health", (_req, res) => {
    res.json({
      service: "c2c-bridge",
      version: "2.0.0",
      status: "ok",
      healthFingerprint: healthFp,
    });
  });

  // ----- 工具清单（公开只读；控制中心用它对账，避免界面显示"未核实"）-----
  app.get("/tools", async (_req, res) => {
    const { loadToolPolicyWithSource, riskOf } = await import("./tool-policy.js");
    const policyDir = opts.executionStorePath ? path.dirname(opts.executionStorePath) : null;
    const loaded = policyDir ? await loadToolPolicyWithSource(policyDir, ws.workspaceId) : null;
    const policy = loaded?.policy ?? null;
    res.json({
      ok: true,
      service: "c2c-bridge",
      name: "LinOS C2C Runtime",
      version: "2.0.0",
      mcp_path: "/mcp",
      auth_mode: "oauth",
      workspace_id: ws.workspaceId,
      tool_policy: {
        source: loaded?.source ?? "none",
        workspace_id: ws.workspaceId,
      },
      tools: TOOL_INVENTORY.map((t) => ({
        name: t.name,
        conditional: t.conditional,
        group: t.group,
        description: t.description,
        risk: riskOf(t.group),
        enabled: policy ? policy.tools[t.name]?.enabled === true : true,
        approval: policy ? (policy.tools[t.name]?.approval ?? "manual") : "manual",
      })),
      tool_count: TOOL_INVENTORY.length,
    });
  });

  // ----- 短配对码（仅本机可生成；一次性；只存哈希）-----
  app.post("/oauth/pairing", express.json({ limit: "1kb" }), (req, res) => {
    if (!isDirectLoopback(req)) {
      res.status(403).json({ error: "loopback_only" });
      return;
    }
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    let code = "";
    for (let i = 0; i < 8; i += 1) code += alphabet[bytes[i] % alphabet.length];
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    pairingCodes.set(hashSecret(code), { expiresAt });
    res.json({ ok: true, code, expiresAt });
  });

  app.delete("/oauth/pairing", (req, res) => {
    if (!isDirectLoopback(req)) {
      res.status(403).json({ error: "loopback_only" });
      return;
    }
    pairingCodes.clear();
    res.json({ ok: true, cleared: true });
  });

  // ----- Public health challenge -----
  app.post("/health/challenge", express.json({ limit: "1kb" }), (req, res) => {
    const { nonce, ts } = req.body ?? {};
    if (typeof nonce !== "string" || typeof ts !== "string") {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    if (Math.abs(Date.now() - Date.parse(ts)) > 30_000) {
      res.status(400).json({ error: "ts_expired" });
      return;
    }
    const key = derivePublicHealthChallengeKey(opts.secret);
    const mac = createHmac("sha256", key)
      .update(`${nonce}|${ts}|public-health-challenge-v1`)
      .digest("base64url");
    res.json({ sig: mac });
  });

  // ----- OAuth AS + Protected Resource Metadata -----
  let issuer = opts.identity.publicMcpUrl
    ? new URL(opts.identity.publicMcpUrl).origin
    : `http://127.0.0.1:${expectedPort}`;
  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...allowedScopes],
  };
  const prMetadata = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: [...allowedScopes],
    bearer_methods_supported: ["header"],
    resource_name: "LinOS C2C Control Center",
  };
  await loadPersistentOAuthState(oauthOptions.persistence, ws.workspaceId, `${issuer}/mcp`);
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(asMetadata));
  app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => res.json(asMetadata));
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(prMetadata));
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(prMetadata));

  // ----- Capability guard for loopback Supervisor administration -----
  const nonceCache = new Set<string>();
  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    if (!isLoopback || viaProxy) {
      res.status(404).end();
      return;
    }
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith("c2cadmin ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let parsed: { ts: string; nonce: string; sig: string };
    try {
      parsed = JSON.parse(auth.slice("c2cadmin ".length)) as typeof parsed;
    } catch {
      res.status(400).json({ error: "bad_authorization_format" });
      return;
    }
    if (nonceCache.has(parsed.nonce)) {
      res.status(401).json({ error: "nonce_replay" });
      return;
    }
    const bodyBytes = req.method === "GET" || req.method === "DELETE"
      ? Buffer.alloc(0)
      : Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    const verdict = verifyAdminAuth(parsed, req.method, req.path, bodyBytes, adminKey);
    if (!verdict.ok) {
      res.status(401).json({ error: "unauthorized", reason: verdict.reason });
      return;
    }
    nonceCache.add(parsed.nonce);
    setTimeout(() => nonceCache.delete(parsed.nonce), 5 * 60_000).unref();
    next();
  };

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: "c2c-bridge",
      version: "2.0.0",
      deviceId: opts.identity.deviceId,
      profileId: opts.identity.profileId,
      runtimeId: opts.identity.runtimeId,
      runtimeInstanceId: opts.identity.runtimeInstanceId,
      workspaceId: ws.workspaceId,
      workspaceName: pathBasename(opts.identity.workspaceRoot),
      workspaceRoot: ws.root,
      port: expectedPort,
      publicUrl: opts.identity.publicMcpUrl,
      healthFingerprint: healthFp,
      tunnel: { provider: null, url: opts.identity.publicMcpUrl },
      tokenCount: [...tokenStore.values()].filter((t) => !t.revoked).length,
      pairingActive: pairingCodes.size > 0,
      pid: process.pid,
      startedAt,
    });
  });

  app.get("/admin/tool-audit", adminGuard, async (_req, res) => {
    const dir = opts.executionStorePath ? path.dirname(opts.executionStorePath) : null;
    if (!dir) {
      res.status(503).json({ ok: false, error: "AUDIT_DIR_UNAVAILABLE" });
      return;
    }
    const { verifyToolAudit } = await import("./tool-audit.js");
    res.json(await verifyToolAudit(dir));
  });

  app.post("/admin/challenge", express.json({ limit: "1kb" }), adminGuard, (req, res) => {
    const { nonce, issuedAt } = req.body ?? {};
    if (typeof nonce !== "string" || typeof issuedAt !== "string") {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const signature = signChallenge(
      nonce,
      issuedAt,
      {
        deviceId: opts.identity.deviceId,
        profileId: opts.identity.profileId,
        runtimeId: opts.identity.runtimeId,
        runtimeInstanceId: opts.identity.runtimeInstanceId,
        workspaceId: ws.workspaceId,
      },
      challengeKey,
    );
    res.json({ ...opts.identity, workspaceId: ws.workspaceId, issuedAt, signature });
  });

  // Supervisor-only binding prevents a stale/foreign Intent from entering OAuth.
  app.post("/admin/oauth/intent", express.json({ limit: "4kb" }), adminGuard, (req, res) => {
    const next = req.body as Partial<OAuthIntentBinding>;
    if (
      typeof next.intentId !== "string" ||
      typeof next.deviceId !== "string" ||
      typeof next.profileId !== "string" ||
      typeof next.runtimeId !== "string" ||
      typeof next.runtimeInstanceId !== "string" ||
      typeof next.workspaceId !== "string" ||
      typeof next.expiresAt !== "string" ||
      typeof next.status !== "string"
    ) {
      res.status(400).json({ error: "bad_intent_binding" });
      return;
    }
    if (
      next.deviceId !== opts.identity.deviceId ||
      next.profileId !== opts.identity.profileId ||
      next.runtimeId !== opts.identity.runtimeId ||
      next.runtimeInstanceId !== opts.identity.runtimeInstanceId ||
      next.workspaceId !== ws.workspaceId
    ) {
      res.status(409).json({ error: "intent_identity_mismatch" });
      return;
    }
    if (Date.parse(next.expiresAt) <= Date.now()) {
      res.status(409).json({ error: "intent_expired" });
      return;
    }
    // 只接受本机允许集内的 scope，防止 Supervisor 侧笔误扩权。
    const grantedScopes = Array.isArray(next.grantedScopes)
      ? next.grantedScopes.filter((s): s is string => typeof s === "string" && allowedScopes.has(s))
      : [];
    intentBinding = { ...(next as OAuthIntentBinding), grantedScopes };
    res.status(204).end();
  });

  // Supervisor-bound Codex/Harness completion ingress. The Runtime is the
  // only writer of the Execution Store; the loopback Capability-MAC prevents
  // the public MCP surface from becoming an execution-record producer.
  app.post("/admin/execution/complete", express.json({ limit: "64kb" }), adminGuard, async (req, res) => {
    if (!executionProducer) {
      res.status(503).json({ error: "execution_store_unavailable" });
      return;
    }
    const event = req.body as Partial<CodexTaskCompletionEvent>;
    if (!isCodexTaskCompletionEvent(event)) {
      res.status(400).json({ error: "invalid_execution_completion" });
      return;
    }
    try {
      const record = await executionProducer.publishCodexTaskCompleted(event);
      res.status(201).json({
        id: record.id,
        taskId: record.taskId,
        iteration: record.iteration,
        status: record.status,
        timestamp: record.timestamp,
      });
    } catch (error) {
      const code = error instanceof Error && /^execution_[a-z0-9_]+$/.test(error.message)
        ? error.message
        : "invalid_execution_completion";
      res.status(400).json({ error: code });
    }
  });

  // Supervisor-only read projection. The Runtime is the only writer of the
  // Execution Store; this admin endpoint lets the Supervisor surface a bounded,
  // already-redacted read-only view to the Renderer without exposing the MCP
  // surface or raw files. No allowedOutput payload is returned here.
  app.get("/admin/execution/list", adminGuard, async (_req, res) => {
    if (!executionProducer) {
      res.status(503).json({ error: "execution_store_unavailable" });
      return;
    }
    const limit = Math.max(1, Math.min(50, Number.parseInt(String(_req.query.limit ?? "20"), 10) || 20));
    try {
      const records = await executionProducer.recent(limit);
      res.json({
        available: true,
        source: "execution-store",
        // Both the top-level envelope and each record carry the current
        // runtimeInstanceId. Consumers MUST compare it against the current
        // Supervisor session id before trusting a record as evidence of
        // current health: a stale `exec_runtime_ready` left by a prior
        // crashed session will not match and must be rejected.
        runtimeInstanceId: opts.identity.runtimeInstanceId,
        records: records.map((record) => ({
          id: record.id,
          taskId: record.taskId,
          iteration: record.iteration,
          timestamp: record.timestamp,
          changedFiles: record.changedFiles,
          tests: record.tests,
          status: record.status,
          summary: record.summary,
          publicOutput: record.publicOutput && Boolean(record.allowedOutput),
          runtimeInstanceId: opts.identity.runtimeInstanceId,
        })),
      });
    } catch {
      res.status(503).json({ available: false, source: "execution-store", error: "execution_store_unavailable" });
    }
  });

  // Supervisor-only public-output read. Only records explicitly flagged
  // publicOutput=true AND carrying an allowedOutput body are returned; this is
  // the bounded, whitelisted public output, never raw stdout/stderr or diffs.
  app.get("/admin/execution/output", adminGuard, async (req, res) => {
    if (!executionProducer) {
      res.status(503).json({ error: "execution_store_unavailable" });
      return;
    }
    const id = String(req.query.id ?? "");
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      res.status(400).json({ error: "execution_id_invalid" });
      return;
    }
    try {
      const publicRecord = await executionProducer.publicOutput(id);
      if (!publicRecord) {
        res.status(404).json({ error: "execution_output_not_registered" });
        return;
      }
      res.json({
        available: true,
        source: "execution-store",
        id,
        output: publicRecord.output,
        // Top-level runtimeInstanceId so consumers can correlate this public
        // output with the current live Runtime session and refuse stale reads.
        runtimeInstanceId: opts.identity.runtimeInstanceId,
      });
    } catch {
      res.status(503).json({ available: false, source: "execution-store", error: "execution_store_unavailable" });
    }
  });

  // ----- MCP: bearer token required -----
  app.post(
    "/mcp",
    express.json({ limit: "8mb" }),
    async (req, res) => {
      const token = await bearerToken(req);
      if (!token) {
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      const method = String((req.body as { method?: unknown })?.method ?? "");
      const tool = String(((req.body as { params?: { name?: unknown } })?.params?.name) ?? "");
      const required = requiredScopeForMcp(method, tool);
      if (required && !scopeAllowsMcpMethod(token.scopes, required)) {
        res.status(403).json({ error: "insufficient_scope", scope: required });
        return;
      }
      const requestIdValue = (req.body as { id?: unknown })?.id;
      const caller: McpCallerContext = Object.freeze({
        clientId: token.clientId,
        requestId: typeof requestIdValue === "string" || typeof requestIdValue === "number" ? requestIdValue : null,
      });
      const isToolCall = method === "tools/call";
      void dispatchMcp(
        req.body,
        ws.workspaceId,
        opts.identity.workspaceRoot,
        opts.executionStorePath ?? null,
        {
          caller,
          writeScopeGranted: token.scopes.includes("workspace.write"),
          shellScopeGranted: token.scopes.includes("workspace.shell"),
          createIntentBridge: opts.createIntentBridge,
          bridgeFailureDiagnostics: opts.bridgeFailureDiagnostics === true,
          // 工具策略与人工审批门：profile 目录下的 tool-policy.json。
          toolPolicyDir: opts.executionStorePath ? path.dirname(opts.executionStorePath) : undefined,
          // 连接器配置展示（get_mcp_app_settings）需要实际端口/公网地址。
          localPort: boundPort,
          publicMcpUrl: opts.identity.publicMcpUrl ?? null,
        },
      )
        .then((result) => {
          const payload = {
            jsonrpc: "2.0",
            id: (req.body as { id?: unknown })?.id ?? null,
            result: isToolCall ? mcpToolCallResult(result) : result,
          };
          // 兼容只接受 SSE 的客户端（Cursor / Claude Code 等）：
          // 客户端显式要 text/event-stream 时，用单事件流回同样内容。
          if (String(req.headers.accept ?? "").includes("text/event-stream")) {
            res.status(200);
            res.setHeader("content-type", "text/event-stream; charset=utf-8");
            res.setHeader("cache-control", "no-cache");
            res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            return;
          }
          res.json(payload);
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          // 只要请求带了工具名，就一律按工具调用错误返回（result.isError），
          // 不要退化成 JSON-RPC -32603：客户端会把它显示成"服务内部错误"，
          // 掩盖真实原因（实测读不存在的文件报 -32603，用户以为服务坏了）。
          const toolish = isToolCall || Boolean(tool);
          res.json(toolish
            ? {
              jsonrpc: "2.0",
              id: (req.body as { id?: unknown })?.id ?? null,
              result: mcpToolCallError(e),
            }
            : {
              jsonrpc: "2.0",
              id: (req.body as { id?: unknown })?.id ?? null,
              error: { code: -32603, message },
            });
        });
    },
  );

  // ----- OAuth Dynamic Client Registration -----
  app.post("/oauth/register", express.json({ limit: "8kb" }), async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const clientName = typeof body.client_name === "string" ? body.client_name.trim() : "";
    const redirects = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((v): v is string => typeof v === "string")
      : [];
    if (!clientName || clientName.length > 200 || redirects.length === 0 || redirects.length > 10 || redirects.length !== (body.redirect_uris as unknown[] | undefined)?.length) {
      res.status(400).json({ error: "invalid_client_metadata" });
      return;
    }
    const redirectCheck = redirects.map((uri) => validateRedirectUri(uri, trustedRedirectOrigins));
    if (redirectCheck.some((v) => !v.ok)) {
      await appendSafeOAuthDiagnostic(oauthOptions.safeDiagnosticsPath, {
        event: "DCR_REJECTED_REDIRECT",
        redirects: redirects.map(safeRedirectDescriptor),
        reasons: redirectCheck.map((v) => v.ok ? "ok" : v.reason),
      });
      res.status(400).json({ error: "redirect_uri_unknown" });
      return;
    }
    const requestedScopes = parseScopes(body.scope, allowedScopes);
    if (!requestedScopes) {
      res.status(400).json({ error: "invalid_scope" });
      return;
    }
    if (!(await intentIsUsable())) {
      await appendSafeOAuthDiagnostic(oauthOptions.safeDiagnosticsPath, {
        event: "DCR_REJECTED_INTENT",
        redirects: redirects.map(safeRedirectDescriptor),
      });
      res.status(503).json({ error: "connection_intent_required" });
      return;
    }
    const suppliedClientId = typeof body.client_id === "string" ? body.client_id : null;
    if (intentBinding?.candidateClientId && intentBinding.candidateClientId !== suppliedClientId) {
      res.status(409).json({ error: "dcr_race_client_already_bound" });
      return;
    }
    const clientId = suppliedClientId ?? `c2c_client_${randomBytes(18).toString("base64url")}`;
    const existing = clientRegistry.get(clientId);
    const identityMatches = existing &&
      existing.clientName === clientName &&
      sameStringSet(existing.redirectUris, redirects) &&
      !existing.revoked;
    const scopeUpgrade = Boolean(
      identityMatches &&
      intentBinding?.candidateClientId === clientId &&
      (await intentIsUsable()) &&
      isStrictScopeUpgrade(existing!.scopes, requestedScopes),
    );
    if (existing && (!identityMatches || (!sameStringSet(existing.scopes, requestedScopes) && !scopeUpgrade))) {
      res.status(409).json({ error: "client_metadata_changed" });
      return;
    }
    const client: RegisteredClient = existing
      ? (scopeUpgrade ? { ...existing, scopes: requestedScopes } : existing)
      : {
      clientId,
      clientName,
      redirectUris: redirects,
      scopes: requestedScopes,
      registeredAt: new Date().toISOString(),
      revoked: false,
    };
    try {
      await persistClientRecord(oauthOptions.persistence, client);
    } catch {
      res.status(503).json({ error: "oauth_persistence_unavailable" });
      return;
    }
    clientRegistry.set(clientId, client);
    if (intentBinding && !intentBinding.candidateClientId) {
      intentBinding = { ...intentBinding, candidateClientId: clientId, status: "CLIENT_BOUND" };
      void patchPersistedIntent(oauthOptions.persistence, intentBinding.intentId, {
        candidateClientId: clientId,
        candidateClientName: client.clientName,
        candidateRedirectUris: [...client.redirectUris],
        requestedScopes: [...client.scopes],
        status: "CLIENT_BOUND",
      });
    }
    res.status(existing ? 200 : 201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      scope: client.scopes.join(" "),
      token_endpoint_auth_method: "none",
    });
    await appendSafeOAuthDiagnostic(oauthOptions.safeDiagnosticsPath, {
      event: scopeUpgrade ? "DCR_SCOPE_UPGRADED" : (existing ? "DCR_REUSED" : "DCR_ACCEPTED"),
      redirects: redirects.map(safeRedirectDescriptor),
      scopeCount: requestedScopes.length,
    });
  });

  // ----- OAuth Authorization + consent -----
  app.get("/oauth/authorize", async (req, res) => {
    const parsed = buildAuthorizationRequest(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      respondOAuthError(res, parsed.error, null, parsed.state);
      return;
    }
    const check = await validateAuthorizationRequest(parsed.request);
    if (!check.ok) {
      const safe = safeRegisteredRedirect(parsed.request, trustedRedirectOrigins);
      respondOAuthError(res, check.error, safe, parsed.request.state);
      return;
    }
    // 走"已授权重连"路径（无新意图）时沿用旧授权 scope，避免重连后权限缩水。
    if (!intentBinding && (await allowReconnectWithoutIntent())) {
      const previousScopes = await scopesFromExistingGrant();
      if (previousScopes.length > 0) {
        parsed.request.scopes = [...new Set([...parsed.request.scopes, ...previousScopes])];
      }
    }
    const consentId = `c2c_consent_${randomBytes(18).toString("base64url")}`;
    pendingConsent.set(consentId, parsed.request);
    setTimeout(() => pendingConsent.delete(consentId), AUTH_CODE_TTL_MS).unref();
    res.type("html").send(renderConsentPage(consentId, parsed.request, ws));
  });

  app.post(
    "/oauth/authorize",
    express.urlencoded({ extended: false, limit: "8kb" }),
    express.json({ limit: "8kb" }),
    async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const consentId = typeof body.consent_id === "string" ? body.consent_id : "";
      const pending = pendingConsent.get(consentId);
      if (!pending || pending.expiresAt <= Date.now()) {
        res.status(400).send("Invalid or expired consent request");
        return;
      }
      pendingConsent.delete(consentId);

      // 配对码：控制中心本机生成，用户在授权页输入即可代替手动点"允许"。
      const submitted = typeof body.pairing_code === "string" ? body.pairing_code.trim().toUpperCase() : "";
      let pairingOk = false;
      if (submitted) {
        const record = pairingCodes.get(hashSecret(submitted));
        if (record && record.expiresAt > Date.now()) {
          pairingOk = true;
          pairingCodes.delete(hashSecret(submitted));
        }
      }

      const decision = body.decision === "allow" || pairingOk ? "allow" : "deny";
      const client = clientRegistry.get(pending.clientId);
      if (!client || client.revoked) {
        res.status(400).send("Unknown client");
        return;
      }
      if (decision === "deny") {
        if (intentBinding) intentBinding = { ...intentBinding, status: "REVOKED" };
        if (pending.intentId) void patchPersistedIntent(oauthOptions.persistence, pending.intentId, { status: "REVOKED" });
        redirectWithParams(res, pending.redirectUri, { error: "access_denied", state: pending.state });
        return;
      }
      const code = randomBytes(32).toString("base64url");
      const codeRecord: AuthorizationCode = {
        ...pending,
        authorizationCodeHash: hashSecret(code),
        consumed: false,
      };
      authCodes.set(codeRecord.authorizationCodeHash, codeRecord);
      if (intentBinding) intentBinding = { ...intentBinding, status: "CONSUMED" };
      if (pending.intentId) void patchPersistedIntent(oauthOptions.persistence, pending.intentId, { status: "CONSUMED" });
      redirectWithParams(res, pending.redirectUri, { code, state: pending.state });
    },
  );

  // ----- OAuth token endpoint -----
  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "8kb" }),
    express.json({ limit: "8kb" }),
    async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
      if (grantType === "authorization_code") {
        const code = typeof body.code === "string" ? body.code : "";
        const clientId = typeof body.client_id === "string" ? body.client_id : "";
        const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
        const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
        const record = authCodes.get(hashSecret(code));
        if (!record || record.consumed || record.expiresAt <= Date.now() || record.clientId !== clientId || record.redirectUri !== redirectUri) {
          oauthTokenError(res, "invalid_grant");
          return;
        }
        if (!verifyPkce(verifier, record.codeChallenge)) {
          oauthTokenError(res, "invalid_grant");
          return;
        }
        record.consumed = true;
        try {
          await issueTokenResponse(res, record.clientId, record.scopes, record.resource);
        } catch {
          oauthTokenError(res, "temporarily_unavailable");
        }
        return;
      }
      if (grantType === "refresh_token") {
        const refresh = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const clientId = typeof body.client_id === "string" ? body.client_id : "";
        const previous = findTokenByRefresh(refresh);
        if (!previous || previous.clientId !== clientId || previous.revoked) {
          oauthTokenError(res, "invalid_grant");
          return;
        }
        previous.revoked = true;
        try {
          await persistGrantRecord(oauthOptions.persistence, ws.workspaceId, previous);
          await issueTokenResponse(res, previous.clientId, previous.scopes, previous.audience);
        } catch {
          oauthTokenError(res, "temporarily_unavailable");
        }
        return;
      }
      oauthTokenError(res, "unsupported_grant_type");
    },
  );

  app.post(
    "/oauth/revoke",
    express.urlencoded({ extended: false, limit: "8kb" }),
    express.json({ limit: "8kb" }),
    async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const token = typeof body.token === "string" ? body.token : "";
      const clientId = typeof body.client_id === "string" ? body.client_id : null;
      const found = tokenStore.get(hashSecret(token)) ?? findTokenByRefresh(token);
      if (found && (!clientId || found.clientId === clientId)) {
        revokeToken(token);
        try {
          await persistGrantRecord(oauthOptions.persistence, ws.workspaceId, found);
        } catch {
          // Revocation remains in-memory; future restart will fail closed if
          // the durable revocation marker cannot be written.
        }
      }
      res.status(200).end();
    },
  );

  // ----- Bind to preferred port; no ephemeral fallback in production -----
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(expectedPort, "127.0.0.1");
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : 0;
  if (expectedPort > 0 && boundPort !== expectedPort) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`STRICT_FAIL_CLOSED: bound to ${boundPort} instead of preferred ${expectedPort}`);
  }
  if (!opts.identity.publicMcpUrl && expectedPort === 0) {
    issuer = `http://127.0.0.1:${boundPort}`;
    asMetadata.issuer = issuer;
    asMetadata.authorization_endpoint = `${issuer}/oauth/authorize`;
    asMetadata.token_endpoint = `${issuer}/oauth/token`;
    asMetadata.registration_endpoint = `${issuer}/oauth/register`;
    asMetadata.revocation_endpoint = `${issuer}/oauth/revoke`;
    prMetadata.resource = `${issuer}/mcp`;
    prMetadata.authorization_servers = [issuer];
  }

  // The Runtime owns the product's startup evidence. This is intentionally
  // best-effort for test/smoke launches without a state root, while a normal
  // Supervisor launch receives a durable, safe record before it reports ready.
  if (executionProducer) {
    try {
      await executionProducer.publishRuntimeReady({
        expectedPort,
        boundPort,
        workspaceExists: ws.exists,
        workspaceId: ws.workspaceId,
      });
    } catch {
      // Evidence production must never take the bridge offline. The MCP
      // execution tools remain fail-closed when no record was persisted.
    }
  }

  // A restart must never leave a job looking RUNNING when no worker is alive to
  // finish it. Heartbeat timestamps distinguish a live worker from an orphan.
  const jobsRoot = opts.executionStorePath ? path.dirname(opts.executionStorePath) : null;
  if (jobsRoot) {
    try {
      const workspaces = await fs.readdir(path.join(jobsRoot, "jobs"));
      for (const workspaceId of workspaces) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) continue;
        await recoverInterruptedJobs(new JobStore(jobsRoot, workspaceId)).catch(() => undefined);
      }
    } catch {
      // Job recovery is best effort; it must not block the MCP endpoint.
    }
  }

  return {
    port: boundPort,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    workspace: async () => ws,
    setOAuthIntent: (binding) => { intentBinding = binding; },
  };

  /**
   * 「重连免配对」开关（默认关）：主进程写入 <stateRoot>/oauth-settings.json。
   * 开启后，只要本机仍有未撤销、未过期的授权，已授权客户端重连就不再要求新的配对码。
   */
  let reconnectCache: { allow: boolean; at: number } | null = null;
  async function allowReconnectWithoutIntent(): Promise<boolean> {
    if (reconnectCacheRef.value && Date.now() - reconnectCacheRef.value.at < 5_000) return reconnectCacheRef.value.allow;    let allow = false;
    const stateRoot = (opts as { stateRoot?: string | null }).stateRoot;
    if (stateRoot) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(stateRoot, "oauth-settings.json"), "utf8")) as { allowReconnectWithoutIntent?: unknown };
        allow = raw.allowReconnectWithoutIntent === true;
      } catch {
        allow = false;
      }
    }
    reconnectCacheRef.value = { allow, at: Date.now() };
    return allow;
  }

  /** 该工作区是否已有可用授权（未撤销、未过期）。 */
  async function hasUsableGrant(): Promise<boolean> {
    try {
      const grantPath = oauthOptions.persistence?.grantPath;
      if (!grantPath) return false;
      const raw = await fs.readFile(grantPath, "utf8");
      const record = JSON.parse(raw) as { revoked?: unknown; expiresAt?: unknown; audience?: unknown };
      const expiresAt = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : Number.NaN;
      return record.revoked !== true && Number.isFinite(expiresAt) && expiresAt > Date.now() && record.audience === ws.workspaceId;
    } catch {
      return false;
    }
  }

  /** 重连场景沿用旧授权的 scope，避免重连后权限缩水成只读。 */
  async function scopesFromExistingGrant(): Promise<string[]> {
    try {
      const grantPath = oauthOptions.persistence?.grantPath;
      if (!grantPath) return [];
      const raw = await fs.readFile(grantPath, "utf8");
      const record = JSON.parse(raw) as { scopes?: unknown };
      if (!Array.isArray(record.scopes)) return [];
      return record.scopes.filter((scope): scope is string => typeof scope === "string" && allowedScopes.has(scope));
    } catch {
      return [];
    }
  }

  async function intentIsUsable(): Promise<boolean> {
    if (!requireIntent) return true;
    const reconnectOk = async (): Promise<boolean> =>
      (await allowReconnectWithoutIntent()) && (await hasUsableGrant());

    if (!intentBinding) return await reconnectOk();
    const identityOk =
      intentBinding.deviceId === opts.identity.deviceId &&
      intentBinding.profileId === opts.identity.profileId &&
      intentBinding.runtimeId === opts.identity.runtimeId &&
      intentBinding.runtimeInstanceId === opts.identity.runtimeInstanceId &&
      intentBinding.workspaceId === ws.workspaceId;
    if (!identityOk) return await reconnectOk();
    if (Date.parse(intentBinding.expiresAt) <= Date.now()) {
      intentBinding = { ...intentBinding, status: "EXPIRED" };
      void patchPersistedIntent(oauthOptions.persistence, intentBinding.intentId, { status: "EXPIRED" });
      return await reconnectOk();
    }
    const statusOk = intentBinding.status === "PENDING" || intentBinding.status === "CLIENT_BOUND" || intentBinding.status === "CONSENT_PENDING";
    return statusOk ? true : await reconnectOk();
  }

  async function validateAuthorizationRequest(request: AuthorizationCode): Promise<{ ok: true } | { ok: false; error: string }> {
    const client = clientRegistry.get(request.clientId);
    if (!client || client.revoked) return { ok: false, error: "unauthorized_client" };
    if (!client.redirectUris.includes(request.redirectUri)) return { ok: false, error: "invalid_request" };
    const redirectCheck = validateRedirectUri(request.redirectUri, trustedRedirectOrigins);
    if (!redirectCheck.ok) return { ok: false, error: "redirect_uri_unknown" };
    if (!(await intentIsUsable())) return { ok: false, error: "connection_intent_required" };
    if (intentBinding?.candidateClientId && intentBinding.candidateClientId !== request.clientId) return { ok: false, error: "client_not_bound_to_intent" };
    if (request.intentId && intentBinding?.intentId !== request.intentId) return { ok: false, error: "intent_mismatch" };
    // 放行集 = 客户端在 DCR 时登记的 scope ∪ 本机全权意图授予的 scope。
    // 只看 client.scopes 会死锁：ChatGPT 的 DCR 不带 scope，默认只登记 workspace.read，
    // 而全权模式在授权时请求 7 个 scope —— 合并逻辑在 buildAuthorizationRequest 里，
    // 但校验发生在这之后，用合并结果去比登记集必然 invalid_scope。
    const intentGranted = (intentBinding?.grantedScopes ?? []).filter((scope) => allowedScopes.has(scope));
    const allowedForClient = [...new Set([...client.scopes, ...intentGranted])];
    if (request.scopes.some((scope) => !allowedForClient.includes(scope))) return { ok: false, error: "invalid_scope" };
    if (!request.codeChallenge || request.codeChallengeMethod !== "S256") return { ok: false, error: "invalid_request" };
    return { ok: true };
  }

  function buildAuthorizationRequest(query: Record<string, unknown>): { ok: true; request: AuthorizationCode } | { ok: false; error: string; redirectUri: null; state: string | null } {
    const stringValue = (key: string): string => typeof query[key] === "string" ? query[key] as string : "";
    const clientId = stringValue("client_id");
    const redirectUri = stringValue("redirect_uri");
    const state = stringValue("state");
    const responseType = stringValue("response_type");
    const codeChallenge = stringValue("code_challenge");
    const method = stringValue("code_challenge_method");
    if (!clientId || !redirectUri || !state || responseType !== "code" || !codeChallenge || method !== "S256") {
      return { ok: false, error: "invalid_request", redirectUri: null, state: state || null };
    }
    if (!isValidPkceChallenge(codeChallenge) || state.length > 1024) {
      return { ok: false, error: "invalid_request", redirectUri: null, state };
    }
    const requestedScopes = parseScopes(query.scope, allowedScopes);
    if (!requestedScopes) return { ok: false, error: "invalid_scope", redirectUri: null, state };
    // 全权模式：本机 Intent 显式给出的 scope 上限并入本次授权。
    // ChatGPT 只会申请 workspace.read，若不并入，命令/写入类工具永远不可用。
    const intentGrant = (intentBinding?.grantedScopes ?? []).filter((s) => allowedScopes.has(s));
    const scopes = intentGrant.length
      ? [...new Set([...requestedScopes, ...intentGrant])]
      : requestedScopes;
    const resource = stringValue("resource") || `${issuer}/mcp`;
    const intentId = stringValue("intent_id") || null;
    return {
      ok: true,
      request: {
        clientId,
        redirectUri,
        scopes,
        codeChallenge,
        codeChallengeMethod: "S256",
        state,
        resource,
        createdAt: Date.now(),
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        intentId,
        authorizationCodeHash: "",
        consumed: false,
      },
    };
  }

  async function issueTokenResponse(res: Response, clientId: string, scopes: string[], audience: string): Promise<void> {
    const accessToken = `c2c_at_${randomBytes(32).toString("base64url")}`;
    const refreshToken = `c2c_rt_${randomBytes(32).toString("base64url")}`;
    const token: TokenSet = {
      clientId,
      accessTokenHash: hashSecret(accessToken),
      refreshTokenHash: hashSecret(refreshToken),
      scopes: [...scopes],
      audience,
      accessTokenExpiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      refreshTokenExpiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    };
    tokenStore.set(token.accessTokenHash, token);
    try {
      await persistGrantRecord(oauthOptions.persistence, ws.workspaceId, token);
    } catch (error) {
      tokenStore.delete(token.accessTokenHash);
      throw error;
    }
    res.status(200).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(" "),
      resource: audience,
    });
  }

  /**
   * 本机签发的长期 API 令牌（给 Claude / Cursor / Codex 等不实现动态注册的客户端用）。
   * 文件：<stateRoot>/profiles/<profileId>/mcp-token.json，只存 sha256，明文只在生成时展示一次。
   */
  // 用容器而不是 let：函数在 app.listen 之后才执行到声明处，直接 let 会触发 TDZ。
  async function loadApiToken(): Promise<{ hash: string; scopes: string[] } | null> {
    if (apiTokenCacheRef.value && Date.now() - apiTokenCacheRef.value.at < 5_000) return apiTokenCacheRef.value;
    const stateRoot = (opts as { stateRoot?: string }).stateRoot;
    if (!stateRoot) return null;
    const file = path.join(stateRoot, "profiles", opts.identity.profileId, "mcp-token.json");
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as { hash?: unknown; scopes?: unknown };
      if (typeof raw.hash !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(raw.hash)) return null;
      const scopes = Array.isArray(raw.scopes)
        ? raw.scopes.filter((s): s is string => typeof s === "string" && allowedScopes.has(s))
        : [];
      apiTokenCacheRef.value = { hash: raw.hash, scopes: scopes.length > 0 ? scopes : [...allowedScopes], at: Date.now() };
      return apiTokenCacheRef.value;
    } catch {
      return null;
    }
  }

  async function bearerToken(req: Request): Promise<TokenSet | null> {
    const value = req.headers.authorization;
    if (!value || !/^Bearer\s+/i.test(value)) return null;
    const raw = value.replace(/^Bearer\s+/i, "").trim();
    if (!raw || raw.length > 512) return null;
    const staticToken = await loadApiToken();
    if (staticToken && hashSecret(raw) === staticToken.hash) {
      // 静态令牌不是 OAuth 签发，用固定 clientId 标记，审计里可区分来源。
      return {
        clientId: "c2c_api_token",
        accessTokenHash: staticToken.hash,
        refreshTokenHash: "",
        scopes: [...staticToken.scopes],
        audience: `${issuer}/mcp`,
        accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
        refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
        revoked: false,
      } as unknown as TokenSet;
    }
    const token = findTokenByAccess(raw);
    if (!token || token.audience !== `${issuer}/mcp`) return null;
    return token;
  }
}

function safeRedirectDescriptor(uri: string): string {
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<malformed>";
  }
}

async function appendSafeOAuthDiagnostic(
  target: string | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  if (!target) return;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
  } catch {
    // The following append may still succeed when the parent already exists.
  }
  try {
    await fs.appendFile(target, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch {
    // Diagnostics must never change OAuth behavior.
  }
}

function parseScopes(value: unknown, allowed: Set<string>): string[] | null {
  const scopes = typeof value === "string" && value.trim()
    ? value.trim().split(/\s+/)
    : ["workspace.read"];
  if (scopes.length > 20 || scopes.some((scope) => !/^[A-Za-z0-9._:-]{1,64}$/.test(scope) || !allowed.has(scope))) return null;
  return [...new Set(scopes)];
}

function validateRedirectUri(uri: string, trustedOrigins: Set<string>): { ok: true } | { ok: false; reason: string } {
  if (!uri || uri.length > 2048 || uri.includes("*") || uri.includes("#")) return { ok: false, reason: "invalid_redirect_uri" };
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return { ok: false, reason: "malformed_redirect_uri" }; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "non_http_scheme" };
  if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return { ok: false, reason: "insecure_http_non_localhost" };
  if (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) return { ok: true };
  const origin = normalizeOrigin(parsed);
  for (const candidate of trustedOrigins) {
    try {
      if (normalizeOrigin(new URL(candidate)) === origin) return { ok: true };
    } catch {
      // Invalid policy entries are ignored; they never broaden trust.
    }
  }
  return { ok: false, reason: "redirect_uri_unknown" };
}

function normalizeOrigin(url: URL): string {
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`.toLowerCase();
}

function safeRegisteredRedirect(request: { clientId: string; redirectUri: string }, trustedOrigins: Set<string>): string | null {
  const client = clientRegistry.get(request.clientId);
  if (!client || client.revoked || !client.redirectUris.includes(request.redirectUri)) return null;
  return validateRedirectUri(request.redirectUri, trustedOrigins).ok ? request.redirectUri : null;
}

function isCodexTaskCompletionEvent(value: Partial<CodexTaskCompletionEvent>): value is CodexTaskCompletionEvent {
  return typeof value.taskId === "string"
    && Number.isInteger(value.iteration)
    && (value.status === "PASS" || value.status === "FAIL" || value.status === "UNKNOWN")
    && Array.isArray(value.changedFiles)
    && Array.isArray(value.tests)
    && typeof value.summary === "string"
    && typeof value.publicOutput === "boolean"
    && (value.allowedOutput === undefined || typeof value.allowedOutput === "string");
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function isStrictScopeUpgrade(previous: string[], requested: string[]): boolean {
  return previous.every((scope) => requested.includes(scope)) && requested.length > previous.length;
}

function isValidPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function verifyPkce(verifier: string, expectedChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const a = Buffer.from(actual);
  const b = Buffer.from(expectedChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

const WRITE_SCOPE_TOOLS = new Set([
  "write_file",
  "create_file",
  "update_file",
  "prepare_write",
  "batch_prepare_write",
  "batch_replace_text",
  "prepare_project_scaffold",
  "cancel_pending_operation",
  "commit_operation",
  "commit_operations",
]);

function requiredScopeForMcp(method: string, tool: string): string | null {
  if (method === "tools/list" || method === "initialize" || method === "ping") return "workspace.read";
  if (method !== "tools/call") return "workspace.read";
  if (tool === "search_workspace") return "workspace.search";
  if (WRITE_SCOPE_TOOLS.has(tool)) return "workspace.write";
  if (tool === "git_status" || tool === "git_diff") return "git.read";
  if (tool === "test_status" || tool === "execution_summary" || tool === "execution_output") return "execution.read";
  return "workspace.read";
}

/**
 * ChatGPT's current connector DCR requests workspace.read for the complete
 * read-only MCP surface, even when the connector UI is set to allow all
 * tools. Keep the narrower scopes available for clients that request them,
 * while treating workspace.read as the explicit read-only bundle rather than
 * denying the remaining read-only tools after user consent.
 */
function scopeAllowsMcpMethod(granted: string[], required: string): boolean {
  return granted.includes(required) || (granted.includes("workspace.read") && READ_ONLY_BUNDLE_SCOPES.has(required));
}

/**
 * MCP tools/call responses must use the standard tool-result envelope. The
 * internal dispatcher intentionally returns the redacted structured payload;
 * the HTTP boundary exposes that payload both as structuredContent and as a
 * JSON text content block so ChatGPT and other MCP clients can consume it.
 */
function mcpToolCallResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
  isError: false;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) ?? String(value) }],
    structuredContent: value,
    isError: false,
  };
}

function mcpToolCallError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ code: classifyToolError(message), error: message }) }],
    isError: true,
  };
}

/** 把常见失败归类成稳定错误码，客户端不必解析英文文案。 */
function classifyToolError(message: string): string {
  if (/INSUFFICIENT_SCOPE/i.test(message)) return "INSUFFICIENT_SCOPE";
  if (/ENOENT|no such file or directory/i.test(message)) return "FILE_NOT_FOUND";
  if (/EACCES|EPERM|access is denied/i.test(message)) return "ACCESS_DENIED";
  if (/EISDIR|is a directory/i.test(message)) return "PATH_IS_DIRECTORY";
  if (/JOB_NOT_FOUND/i.test(message)) return "JOB_NOT_FOUND";
  if (/TOOL_DISABLED/i.test(message)) return "TOOL_DISABLED";
  return "TOOL_ERROR";
}

function respondOAuthError(res: Response, error: string, redirectUri: string | null, state: string | null): void {
  if (redirectUri && state) {
    redirectWithParams(res, redirectUri, { error, state });
    return;
  }
  res.status(400).json({ error });
}

function redirectWithParams(res: Response, redirectUri: string, values: Record<string, string>): void {
  try {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
    res.redirect(302, target.toString());
  } catch {
    res.status(400).json({ error: "invalid_redirect_uri" });
  }
}

function oauthTokenError(res: Response, error: string): void {
  res.status(400).json({ error });
}

function renderConsentPage(consentId: string, request: AuthorizationCode, workspace: WorkspaceInfo): string {
  const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const scopeText = request.scopes.map(esc).join(", ");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LinOS C2C 授权</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1115;color:#e6ebf2;display:flex;justify-content:center;padding:48px}
main{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px 32px;max-width:560px;width:100%}
h1{font-size:20px;margin:0 0 16px}p{color:#8b98ab;font-size:13px;line-height:1.9;margin:6px 0}
code{color:#e6ebf2}input{width:100%;padding:10px 12px;margin:12px 0;border-radius:8px;border:1px solid #333a48;background:#0f1115;color:#e6ebf2;font-size:18px;letter-spacing:4px;text-align:center;text-transform:uppercase}
button{padding:9px 18px;border-radius:8px;border:1px solid #333a48;background:#1d2430;color:#e6ebf2;font-size:14px;cursor:pointer;margin-right:8px}
button.primary{background:#2563eb;border-color:#2563eb}</style></head>
<body><main><h1>允许访问这个工作区？</h1>
<p>客户端：<strong>${esc(request.clientId)}</strong></p>
<p>工作区：<strong>${esc(workspace.root)}</strong>（${esc(workspace.workspaceId)}）</p>
<p>权限范围：${scopeText}</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="consent_id" value="${esc(consentId)}">
<p style="margin-top:16px">如果你在控制中心生成了配对码，输入它即可直接授权：</p>
<input name="pairing_code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="配对码">
<button class="primary" type="submit" name="decision" value="allow">允许</button>
<button type="submit" name="decision" value="deny">拒绝</button>
</form></main></body></html>`;
}

function pathBasename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
