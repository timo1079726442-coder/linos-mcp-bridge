import express from "express";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { computeHealthFingerprint, deriveAdminControlKey, deriveChallengeKey, derivePublicHealthChallengeKey, signChallenge, verifyAdminAuth, } from "./capability.js";
import { detectWorkspace } from "./workspace.js";
export async function startServer(opts) {
    const adminKey = deriveAdminControlKey(opts.secret);
    const challengeKey = deriveChallengeKey(opts.secret);
    const healthFp = computeHealthFingerprint(opts.secret);
    const ws = await detectWorkspace(opts.identity.workspaceRoot);
    const expectedPort = opts.identity.expectedPort;
    const startedAt = new Date().toISOString();
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
    // ----- Public health challenge (optional cryptographic verification) -----
    app.post("/health/challenge", express.json({ limit: "1kb" }), (req, res) => {
        (async () => {
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
        })().catch((e) => {
            res.status(500).json({ error: "internal", message: e.message });
        });
    });
    // ----- OAuth AS + Protected Resource Metadata (RFC 8414 + 9728) -----
    const issuer = opts.identity.publicMcpUrl
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
        scopes_supported: ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"],
    };
    const prMetadata = {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: asMetadata.scopes_supported,
        bearer_methods_supported: ["header"],
        resource_name: "LinOS C2C Control Center",
    };
    app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(asMetadata));
    app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => res.json(asMetadata));
    app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(prMetadata));
    app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(prMetadata));
    // ----- Workspace tools (read-only MCP) -----
    const adminGuard = (req, res, next) => {
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
        const rest = auth.slice("c2cadmin ".length);
        let parsed;
        try {
            parsed = JSON.parse(rest);
        }
        catch {
            res.status(400).json({ error: "bad_authorization_format" });
            return;
        }
        const nonceCache = nonceCacheRef.value;
        if (nonceCache.has(parsed.nonce)) {
            res.status(401).json({ error: "nonce_replay" });
            return;
        }
        let bodyBytes = Buffer.alloc(0);
        if (req.method !== "GET" && req.method !== "DELETE") {
            // body is read separately by express.json; we need raw bytes here.
            bodyBytes = Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
        }
        const verdict = verifyAdminAuth(parsed, req.method, req.path, bodyBytes, adminKey);
        if (verdict.ok !== true) {
            res.status(401).json({ error: "unauthorized", reason: verdict.reason });
            return;
        }
        nonceCache.add(parsed.nonce);
        setTimeout(() => nonceCache.delete(parsed.nonce), 5 * 60_000);
        next();
    };
    // Mutable nonce cache (closure-held).
    const nonceCacheRef = { value: null };
    nonceCacheRef.value = new Set();
    // ----- /admin/info (loopback + Capability MAC) -----
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
            tokenCount: 0,
            pairingActive: false,
            pid: process.pid,
            startedAt,
        });
    });
    // ----- /admin/challenge (loopback + Capability MAC) -----
    app.post("/admin/challenge", express.json({ limit: "1kb" }), adminGuard, (req, res) => {
        const { nonce, issuedAt } = req.body ?? {};
        if (typeof nonce !== "string" || typeof issuedAt !== "string") {
            res.status(400).json({ error: "bad_request" });
            return;
        }
        const signature = signChallenge(nonce, issuedAt, {
            deviceId: opts.identity.deviceId,
            profileId: opts.identity.profileId,
            runtimeId: opts.identity.runtimeId,
            runtimeInstanceId: opts.identity.runtimeInstanceId,
            workspaceId: ws.workspaceId,
        }, challengeKey);
        res.json({
            deviceId: opts.identity.deviceId,
            profileId: opts.identity.profileId,
            runtimeId: opts.identity.runtimeId,
            runtimeInstanceId: opts.identity.runtimeInstanceId,
            workspaceId: ws.workspaceId,
            signature,
        });
    });
    // ----- /mcp (stateless Streamable HTTP; minimal stub for now) -----
    app.post("/mcp", express.json({ limit: "8mb" }), (_req, res) => {
        // Minimal stub: actual MCP tool dispatch will be wired in CP7.
        res.status(503).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "MCP tools dispatch not yet wired in CP7" },
            id: null,
        });
    });
    // ----- OAuth endpoints (stub for CP7; DCR / authorize / token present but no registration storage in this runtime) -----
    app.post("/oauth/register", express.json({ limit: "8kb" }), (_req, res) => {
        res.status(501).json({ error: "not_implemented", message: "OAuth registration delegated to CP7 OAuthManager" });
    });
    app.get("/oauth/authorize", (_req, res) => {
        res.status(501).send("OAuth authorize delegated to CP7 (will render Consent Page from OAuthManager state)");
    });
    app.post("/oauth/token", express.json({ limit: "8kb" }), (_req, res) => {
        res.status(501).json({ error: "not_implemented", message: "Token endpoint delegated to CP7 OAuthManager" });
    });
    // ----- Bind to preferred port. STRICT FAIL CLOSED if occupied. -----
    const server = createServer(app);
    await new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(expectedPort, "127.0.0.1");
    });
    const boundPort = server.address().port;
    if (expectedPort > 0 && boundPort !== expectedPort) {
        // STRICT FAIL CLOSED: never accept ephemeral port in production
        server.close();
        throw new Error(`STRICT_FAIL_CLOSED: bound to ${boundPort} instead of preferred ${expectedPort}; refusing to fall back`);
    }
    // expectedPort === 0 means dev/test mode; OS-assigned port is allowed.
    return {
        port: boundPort,
        close: () => new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        }),
        workspace: async () => ws,
    };
}
function pathBasename(p) {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx >= 0 ? p.slice(idx + 1) : p;
}
