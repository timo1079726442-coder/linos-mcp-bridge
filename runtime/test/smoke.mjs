// Manual smoke test of the runtime server.
import { startServer } from "../dist/server.js";

const secret = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);
const wsRoot = process.cwd();
const { detectWorkspace } = await import("../dist/workspace.js");
const ws = await detectWorkspace(wsRoot);

const handle = await startServer({
  identity: {
    deviceId: "c2c_dev_smoke",
    profileId: "mb_pf_smoke",
    runtimeId: "c2c_rt_smoke",
    runtimeInstanceId: "c2c_ri_smoke",
    workspaceRoot: wsRoot,
    workspaceId: ws.workspaceId,
    expectedPort: 0,
    publicMcpUrl: null,
    hostname: null,
  },
  secret,
});

const base = `http://127.0.0.1:${handle.port}`;
console.log("bound", handle.port);

// 1) /health
const h = await fetch(`${base}/health`);
console.log("health", h.status, await h.text());

// 2) oauth discovery
const o = await fetch(`${base}/.well-known/oauth-authorization-server`);
console.log("oauth", o.status, await o.text());

// 3) /admin/info without auth (should be 401)
const ai = await fetch(`${base}/admin/info`);
console.log("admin no-auth", ai.status);

await handle.close();
console.log("closed");

// Force exit because there may be lingering handles from express
process.exit(0);