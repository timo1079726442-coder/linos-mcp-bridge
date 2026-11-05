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
import { createRuntimeSupervisorBridge, openRuntimeSupervisorBridgeStream } from "./supervisor-bridge.js";
import { appendFile, mkdir, stat } from "node:fs/promises";
import type { Duplex } from "node:stream";
import * as path from "node:path";

function parseArgs(): Map<string, string> {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] ?? "";
      if (!val.startsWith("--")) {
        out.set(key, val);
        i++;
      } else {
        out.set(key, "true");
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const workspaceRoot = args.get("workspace") ?? "";
  const port = parseInt(args.get("port") ?? "48766", 10);
  const deviceId = args.get("device-id");
  const profileId = args.get("profile-id");
  const runtimeId = args.get("runtime-id");
  const runtimeInstanceId = args.get("runtime-instance-id");
  const stateRoot = args.get("state-root") ?? null;
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
  const bridgeDiagnostics = process.env.MCP_BRIDGE_SUPERVISOR_BRIDGE_DIAGNOSTICS === "1";
  const bridgeDiagnosticSink = bridgeDiagnostics && stateRoot
    ? createBridgeDiagnosticSink(path.join(stateRoot, "profiles", profileId!, "runtime-supervisor-bridge-runtime.jsonl"))
    : undefined;
  const supervisorBridge = createRuntimeSupervisorBridge(
    secret,
    runtimeInstanceId!,
    getSupervisorBridgeStream(bridgeDiagnosticSink),
    undefined,
    bridgeDiagnostics,
    bridgeDiagnosticSink,
  );

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
      executionStorePath: stateRoot ? path.join(stateRoot, "profiles", profileId!, "executions") : null,
      stateRoot: stateRoot ?? null,
      secret,
      createIntentBridge: supervisorBridge,
      bridgeFailureDiagnostics: bridgeDiagnostics,
      oauth: {
        // Production Runtime only accepts a Supervisor-bound Intent. No
        // wildcard is trusted here. The exact https://chatgpt.com origin was
        // captured from a real ChatGPT DCR request and is the V2 built-in
        // known-good origin; redirect paths remain client-pinned at DCR.
        requireIntent: true,
        trustedRedirectOrigins: ["https://chatgpt.com"],
        persistence: stateRoot
          ? {
              clientRegistryPath: path.join(stateRoot, "profiles", profileId, "client-registry.json"),
              grantPath: path.join(stateRoot, "profiles", profileId, "grants", `${ws.workspaceId}.json`),
              intentDirectory: path.join(stateRoot, "profiles", profileId, "intents"),
            }
          : undefined,
        safeDiagnosticsPath: stateRoot
          ? path.join(stateRoot, "profiles", profileId, "oauth-safe-diagnostics.jsonl")
          : undefined,
      },
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        status: "ready",
        port: handle.port,
        workspaceId: ws.workspaceId,
        runtimeInstanceId,
        deviceId,
        profileId,
        runtimeId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
  } catch (e) {
    supervisorBridge?.close();
    clearSecret();
    console.error("FATAL: server failed:", (e as Error).message);
    process.exit(4);
  }

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: "shutdown", signal }));
    supervisorBridge?.close();
    clearSecret();
    await handle!.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function createBridgeDiagnosticSink(filePath: string): (event: {
  stage: string;
  correlationId: string;
  elapsedMs: number;
  errorCode?: string;
}) => void {
  let writes = Promise.resolve();
  return (event) => {
    if (!/^[a-z0-9_]{1,80}$/.test(event.stage)
      || typeof event.correlationId !== "string" || event.correlationId.length > 160
      || !Number.isFinite(event.elapsedMs) || (event.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(event.errorCode))) return;
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      process: "runtime",
      stage: event.stage,
      correlationId: event.correlationId,
      elapsedMs: Math.max(0, Math.round(event.elapsedMs)),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    })}\n`;
    writes = writes.then(async () => {
      const current = await stat(filePath).catch(() => null);
      if (current && current.size + Buffer.byteLength(line, "utf8") > 512 * 1024) return;
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, line, "utf8");
    }).catch(() => { /* diagnostics must not affect Runtime requests */ });
  };
}

function getSupervisorBridgeStream(diagnosticSink?: Parameters<typeof openRuntimeSupervisorBridgeStream>[0]): Duplex | undefined {
  return openRuntimeSupervisorBridgeStream(diagnosticSink);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
