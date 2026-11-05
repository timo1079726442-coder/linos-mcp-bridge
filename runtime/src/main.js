#!/usr/bin/env node
/**
 * V2 Runtime entry point.
 *
 * Reads --device-id, --profile-id, --runtime-id, --runtime-instance-id,
 * --workspace, --port, --public-mcp-url from argv.
 *
 * Secret intake order (Production):
 *   1. stdin pipe (preferred; mandatory in production)
 *   2. env (only if MCP_BRIDGE_ALLOW_ENV_SECRET=1; for tests)
 *
 * Fails closed if no secret is provided.
 */
import { startServer } from "./server.js";
import { readSecretFromStdin, tryReadSecretFromEnv, clearSecret, setSecret } from "./secret.js";
function parseArgs() {
    const out = new Map();
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i]?.startsWith("--")) {
            const key = argv[i].slice(2);
            const val = argv[i + 1] ?? "";
            if (!val.startsWith("--")) {
                out.set(key, val);
                i++;
            }
            else {
                out.set(key, "true");
            }
        }
    }
    return out;
}
async function main() {
    const args = parseArgs();
    const workspaceRoot = args.get("workspace") ?? "";
    const port = parseInt(args.get("port") ?? "48765", 10);
    const deviceId = args.get("device-id");
    const profileId = args.get("profile-id");
    const runtimeId = args.get("runtime-id");
    const runtimeInstanceId = args.get("runtime-instance-id");
    const publicMcpUrl = args.get("public-mcp-url") ?? null;
    const hostname = publicMcpUrl ? new URL(publicMcpUrl).host : null;
    if (!workspaceRoot || !deviceId || !profileId || !runtimeId || !runtimeInstanceId) {
        console.error("FATAL: missing required --workspace/--device-id/--profile-id/--runtime-id/--runtime-instance-id");
        process.exit(2);
    }
    // Secret intake
    let secret = await readSecretFromStdin();
    if (!secret) {
        secret = tryReadSecretFromEnv();
    }
    if (!secret) {
        console.error("FATAL: no runtimeInstanceSecret on stdin and MCP_BRIDGE_ALLOW_ENV_SECRET != 1");
        process.exit(3);
    }
    setSecret(secret);
    // Compute workspaceId before constructing identity.
    const { detectWorkspace } = await import("./workspace.js");
    const ws = await detectWorkspace(workspaceRoot);
    let handle;
    try {
        handle = await startServer({
            identity: {
                deviceId,
                profileId,
                runtimeId,
                runtimeInstanceId,
                workspaceRoot,
                workspaceId: ws.workspaceId,
                expectedPort: port,
                publicMcpUrl,
                hostname,
            },
            secret,
        });
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
            status: "ready",
            port: handle.port,
            workspaceId: ws.workspaceId,
            runtimeInstanceId,
            deviceId,
            profileId,
            runtimeId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
        }));
    }
    catch (e) {
        clearSecret();
        console.error("FATAL: server failed:", e.message);
        process.exit(4);
    }
    const shutdown = async (signal) => {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ event: "shutdown", signal }));
        clearSecret();
        await handle.close();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
});
