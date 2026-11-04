import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveAdminControlKey } from "../dist/capability.js";
import { startServer } from "../dist/server.js";

test("GET /admin/execution/list reports unavailable when the store disappears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-list-unavailable-"));
  const executionStorePath = path.join(root, "executions");
  const secret = Buffer.alloc(32, 31);
  let handle;
  try {
    handle = await startServer({
      identity: {
        deviceId: "list-unavailable-device",
        profileId: "list-unavailable-profile",
        runtimeId: "list-unavailable-runtime",
        runtimeInstanceId: "list-unavailable-instance",
        workspaceRoot: root,
        workspaceId: "list-unavailable-workspace",
        expectedPort: 0,
        publicMcpUrl: null,
        hostname: null,
      },
      secret,
      executionStorePath,
      oauth: { requireIntent: false },
    });

    // Runtime startup creates the store; remove only this test-owned temp path
    // to exercise a lost/unavailable store without touching host state.
    await rm(executionStorePath, { recursive: true, force: true });

    const ts = new Date().toISOString();
    const nonce = `test_${randomBytes(8).toString("hex")}`;
    const bodyHash = createHmac("sha256", Buffer.alloc(32)).update("").digest("hex");
    const sig = createHmac("sha256", deriveAdminControlKey(secret))
      .update(`${ts}\n${nonce}\nGET\n/admin/execution/list\n${bodyHash}`)
      .digest("base64url");
    const response = await fetch(`http://127.0.0.1:${handle.port}/admin/execution/list`, {
      headers: { authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}` },
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      available: false,
      source: "execution-store",
      error: "execution_store_unavailable",
    });
  } finally {
    if (handle) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
