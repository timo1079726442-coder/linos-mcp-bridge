import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../dist/server.js";

/**
 * Runtime startup port validation + read-projection stale guard.
 *
 * Two contracts:
 *  1) startServer rejects expectedPort that is not 0 (ephemeral) or an integer
 *     in 1..65535. Anything else is fail-closed at startup, before any
 *     HTTP listener is bound.
 *  2) /admin/execution/list and /admin/execution/output carry the current
 *     runtimeInstanceId so the Supervisor (or any future consumer) can
 *     refuse records left by a prior crashed session. A stale
 *     `exec_runtime_ready` from an old session will not match the live
 *     runtimeInstanceId and must be rejected by the consumer.
 *
 * Uses ephemeral (expectedPort: 0) so this suite is runnable in restricted
 * sandboxes that block binding to fixed numeric ports.
 */

const fixedSecret = Buffer.alloc(32, 29);

function makeIdentity(overrides) {
  return {
    deviceId: "device-identity-test",
    profileId: "profile-identity-test",
    runtimeId: "runtime-identity-test",
    runtimeInstanceId: "instance-identity-live",
    workspaceRoot: "/path/not/exist",
    workspaceId: "ws-identity-test",
    expectedPort: 0,
    publicMcpUrl: null,
    hostname: null,
    ...overrides,
  };
}

async function ephemeralHandle() {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-id-"));
  const executionStorePath = path.join(root, "executions");
  const handle = await startServer({
    identity: makeIdentity({ workspaceRoot: root, workspaceId: "ws-id-eph" }),
    secret: fixedSecret,
    executionStorePath,
    oauth: { requireIntent: false },
  });
  return { handle, root };
}

test("startServer rejects non-integer expectedPort (fail closed)", async () => {
  await assert.rejects(
    () => startServer({
      identity: makeIdentity({ expectedPort: 48766.5 }),
      secret: fixedSecret,
      oauth: { requireIntent: false },
    }),
    /RUNTIME_EXPECTED_PORT_INVALID/,
    "fractional ports must be rejected at startup",
  );
});

test("startServer rejects negative expectedPort", async () => {
  await assert.rejects(
    () => startServer({
      identity: makeIdentity({ expectedPort: -1 }),
      secret: fixedSecret,
      oauth: { requireIntent: false },
    }),
    /RUNTIME_EXPECTED_PORT_INVALID/,
  );
});

test("startServer rejects NaN expectedPort", async () => {
  await assert.rejects(
    () => startServer({
      identity: makeIdentity({ expectedPort: NaN }),
      secret: fixedSecret,
      oauth: { requireIntent: false },
    }),
    /RUNTIME_EXPECTED_PORT_INVALID/,
  );
});

test("startServer rejects expectedPort > 65535", async () => {
  await assert.rejects(
    () => startServer({
      identity: makeIdentity({ expectedPort: 65536 }),
      secret: fixedSecret,
      oauth: { requireIntent: false },
    }),
    /RUNTIME_EXPECTED_PORT_INVALID/,
  );
});

test("startServer accepts fixed expectedPort 48766 (production shape)", async () => {
  // The OS may refuse to bind 48766 in this sandbox; we only need to
  // confirm startServer's port-validity check is satisfied, so catch the
  // EADDRINUSE-style failure and require the error to be the port-in-use
  // failure, not the startup port-invalidator.
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "c2c-id-fix-"));
    const handle = await startServer({
      identity: makeIdentity({ expectedPort: 48766, workspaceRoot: root, workspaceId: "ws-id-fix" }),
      secret: fixedSecret,
      oauth: { requireIntent: false },
    });
    await handle.close();
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    const msg = String(error?.message ?? "");
    assert.ok(
      !/RUNTIME_EXPECTED_PORT_INVALID/.test(msg),
      `48766 is a valid fixed port; must not be rejected by validator: ${msg}`,
    );
  }
});

test("/admin/execution/list and /output carry runtimeInstanceId (stale guard)", async () => {
  const { handle, root } = await ephemeralHandle();
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { createHmac, randomBytes } = await import("node:crypto");
    const { deriveAdminControlKey } = await import("../dist/capability.js");

    async function signedGet(pathname, query) {
      const ts = new Date().toISOString();
      const nonce = `test_${randomBytes(8).toString("hex")}`;
      const bodyHash = createHmac("sha256", Buffer.alloc(32)).update("").digest("hex");
      const sig = createHmac("sha256", deriveAdminControlKey(fixedSecret))
        .update(`${ts}\n${nonce}\nGET\n${pathname}\n${bodyHash}`)
        .digest("base64url");
      return fetch(`${base}${pathname}${query ? `?${query}` : ""}`, {
        method: "GET",
        headers: { authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}` },
      });
    }

    const listRes = await signedGet("/admin/execution/list", "limit=5");
    assert.equal(listRes.status, 200);
    const listPayload = await listRes.json();
    assert.equal(listPayload.runtimeInstanceId, "instance-identity-live",
      "list envelope must carry current runtimeInstanceId for the stale guard");
    assert.ok(Array.isArray(listPayload.records));
    for (const rec of listPayload.records) {
      assert.equal(rec.runtimeInstanceId, "instance-identity-live",
        `each record must carry current runtimeInstanceId; offender: ${JSON.stringify(rec.id)}`);
    }

    const outRes = await signedGet(
      "/admin/execution/output",
      `id=${encodeURIComponent("exec_runtime_ready")}`,
    );
    assert.equal(outRes.status, 200);
    const outPayload = await outRes.json();
    assert.equal(outPayload.runtimeInstanceId, "instance-identity-live",
      "output envelope must carry current runtimeInstanceId for the stale guard");
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("/admin/execution/list clamps to 1..50 even if a higher limit is requested", async () => {
  const { handle, root } = await ephemeralHandle();
  try {
    const base = `http://127.0.0.1:${handle.port}`;
    const { createHmac, randomBytes } = await import("node:crypto");
    const { deriveAdminControlKey } = await import("../dist/capability.js");

    async function signedGet(pathname, query) {
      const ts = new Date().toISOString();
      const nonce = `test_${randomBytes(8).toString("hex")}`;
      const bodyHash = createHmac("sha256", Buffer.alloc(32)).update("").digest("hex");
      const sig = createHmac("sha256", deriveAdminControlKey(fixedSecret))
        .update(`${ts}\n${nonce}\nGET\n${pathname}\n${bodyHash}`)
        .digest("base64url");
      return fetch(`${base}${pathname}${query ? `?${query}` : ""}`, {
        method: "GET",
        headers: { authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}` },
      });
    }

    const res = await signedGet("/admin/execution/list", "limit=99999");
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.ok(payload.records.length <= 50, `records must be clamped to 50; got ${payload.records.length}`);
  } finally {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
