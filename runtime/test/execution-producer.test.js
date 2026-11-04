import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../dist/server.js";
import { ExecutionRecordStore } from "../dist/execution-store.js";
import { dispatchMcp } from "../dist/mcp-tools.js";
import {
  ExecutionStoreProducer,
  RUNTIME_READY_PUBLIC_OUTPUT,
  RUNTIME_READY_RECORD_ID,
} from "../dist/execution-producer.js";

test("ExecutionStoreProducer publishes only verified, bounded readiness evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-producer-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    assert.equal(await producer.publishRuntimeReady({
      expectedPort: 48766,
      boundPort: 0,
      workspaceExists: true,
      workspaceId: "producer-test",
    }), null);

    const first = await producer.publishRuntimeReady({
      expectedPort: 48766,
      boundPort: 48766,
      workspaceExists: true,
      workspaceId: "producer-test",
    });
    assert.equal(first?.id, RUNTIME_READY_RECORD_ID);
    assert.equal(first?.publicOutput, true);
    assert.equal(first?.allowedOutput, RUNTIME_READY_PUBLIC_OUTPUT);

    const second = await producer.publishRuntimeReady({
      expectedPort: 48766,
      boundPort: 48766,
      workspaceExists: true,
      workspaceId: "producer-test",
    });
    assert.equal(second?.id, RUNTIME_READY_RECORD_ID);
    assert.deepEqual(await readdir(root), [`${RUNTIME_READY_RECORD_ID}.json`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime startup lifecycle produces the readiness record after the port is bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-producer-server-"));
  const executionStorePath = path.join(root, "executions");
  let handle;
  try {
    // expectedPort: 0 = ephemeral, lets the OS pick. The DSH sandbox blocks
    // binding to fixed numeric ports but allows ephemeral binding, so tests
    // remain runnable in restricted environments without forcing the user
    // to provide a free port per run.
    handle = await startServer({
      identity: {
        deviceId: "producer-server-device",
        profileId: "producer-server-profile",
        runtimeId: "producer-server-runtime",
        runtimeInstanceId: "producer-server-instance",
        workspaceRoot: root,
        workspaceId: "producer-server-workspace",
        expectedPort: 0,
        publicMcpUrl: null,
        hostname: null,
      },
      secret: Buffer.alloc(32, 13),
      executionStorePath,
      oauth: { requireIntent: false },
    });

    assert.ok(handle.port > 0, `expected ephemeral port > 0, got ${handle.port}`);
    const stored = JSON.parse(await readFile(
      path.join(executionStorePath, `${RUNTIME_READY_RECORD_ID}.json`),
      "utf8",
    ));
    assert.equal(stored.id, RUNTIME_READY_RECORD_ID);
    assert.equal(stored.status, "PASS");
    assert.equal(stored.publicOutput, true);
    assert.equal(stored.allowedOutput, RUNTIME_READY_PUBLIC_OUTPUT);

    await handle.close();
    handle = await startServer({
      identity: {
        deviceId: "producer-server-device",
        profileId: "producer-server-profile",
        runtimeId: "producer-server-runtime",
        runtimeInstanceId: "producer-server-instance-restart",
        workspaceRoot: root,
        workspaceId: "producer-server-workspace",
        expectedPort: 0,
        publicMcpUrl: null,
        hostname: null,
      },
      secret: Buffer.alloc(32, 13),
      executionStorePath,
      oauth: { requireIntent: false },
    });
    assert.ok(handle.port > 0);
    assert.deepEqual(await readdir(executionStorePath), [`${RUNTIME_READY_RECORD_ID}.json`]);
    const exposed = await dispatchMcp(
      { method: "tools/call", params: { name: "execution_output", arguments: { id: RUNTIME_READY_RECORD_ID } } },
      "producer-server-workspace",
      root,
      executionStorePath,
    );
    assert.equal(exposed.output, RUNTIME_READY_PUBLIC_OUTPUT);
  } finally {
    if (handle) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex completion events become stable, bounded public execution records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-codex-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const first = await producer.publishCodexTaskCompleted({
      taskId: "codex-task-2026-09-29",
      iteration: 1,
      status: "PASS",
      changedFiles: ["src/example.ts"],
      tests: [{ category: "unit", command: "npm test", passed: true, testCount: 4, failedCount: 0 }],
      summary: "Codex task completed; safe acceptance summary recorded.",
      publicOutput: true,
      allowedOutput: "Task completed and acceptance checks passed.",
    });
    const second = await producer.publishCodexTaskCompleted({
      taskId: "codex-task-2026-09-29",
      iteration: 1,
      status: "PASS",
      changedFiles: ["src/example.ts"],
      tests: [{ category: "unit", passed: true, testCount: 4, failedCount: 0 }],
      summary: "same deterministic event",
      publicOutput: true,
      allowedOutput: "updated safe output",
    });
    assert.equal(first.id, second.id);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".json")), [`${first.id}.json`]);
    const store = new ExecutionRecordStore(root);
    const exposed = await store.publicOutput(first.id);
    assert.equal(exposed?.output, "updated safe output");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime completion admin endpoint requires the Supervisor Capability-MAC", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-admin-"));
  const executionStorePath = path.join(root, "executions");
  const secret = Buffer.alloc(32, 17);
  let handle;
  try {
    handle = await startServer({
      identity: {
        deviceId: "admin-device",
        profileId: "admin-profile",
        runtimeId: "admin-runtime",
        runtimeInstanceId: "admin-instance",
        workspaceRoot: root,
        workspaceId: "admin-workspace",
        expectedPort: 0,
        publicMcpUrl: null,
        hostname: null,
      },
      secret,
      executionStorePath,
      oauth: { requireIntent: false },
    });
    const base = `http://127.0.0.1:${handle.port}`;

    const denied = await fetch(`${base}/admin/execution/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "denied", iteration: 1 }),
    });
    assert.equal(denied.status, 401);

    const body = JSON.stringify({
      taskId: "codex-admin-test",
      iteration: 2,
      status: "PASS",
      changedFiles: [],
      tests: [{ category: "smoke", passed: true, testCount: 1, failedCount: 0 }],
      summary: "admin completion accepted",
      publicOutput: true,
      allowedOutput: "safe completion output",
    });
    const { createHmac, randomBytes } = await import("node:crypto");
    const { deriveAdminControlKey } = await import("../dist/capability.js");
    const ts = new Date().toISOString();
    const nonce = `test_${randomBytes(8).toString("hex")}`;
    const bodyHash = createHmac("sha256", Buffer.alloc(32)).update(body).digest("hex");
    const sig = createHmac("sha256", deriveAdminControlKey(secret))
      .update(`${ts}\n${nonce}\nPOST\n/admin/execution/complete\n${bodyHash}`)
      .digest("base64url");
    const accepted = await fetch(`${base}/admin/execution/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}`,
      },
      body,
    });
    assert.equal(accepted.status, 201);
    const response = await accepted.json();
    assert.equal(response.taskId, "codex-admin-test");
    assert.equal((await readdir(executionStorePath)).filter((name) => name.includes("codex")).length, 1);
  } finally {
    if (handle) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /admin/execution/list requires Capability-MAC and returns bounded records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-list-"));
  const executionStorePath = path.join(root, "executions");
  const secret = Buffer.alloc(32, 19);
  let handle;
  try {
    handle = await startServer({
      identity: {
        deviceId: "list-device",
        profileId: "list-profile",
        runtimeId: "list-runtime",
        runtimeInstanceId: "list-instance",
        workspaceRoot: root,
        workspaceId: "list-workspace",
        expectedPort: 0,
        publicMcpUrl: null,
        hostname: null,
      },
      secret,
      executionStorePath,
      oauth: { requireIntent: false },
    });
    const base = `http://127.0.0.1:${handle.port}`;

    // No signature -> 401
    const denied = await fetch(`${base}/admin/execution/list`);
    assert.equal(denied.status, 401);

    // Signed GET -> 200 with the startup readiness record.
    const { createHmac, randomBytes } = await import("node:crypto");
    const { deriveAdminControlKey } = await import("../dist/capability.js");
    const ts = new Date().toISOString();
    const nonce = `test_${randomBytes(8).toString("hex")}`;
    const bodyHash = createHmac("sha256", Buffer.alloc(32)).update("").digest("hex");
    const sig = createHmac("sha256", deriveAdminControlKey(secret))
      .update(`${ts}\n${nonce}\nGET\n/admin/execution/list\n${bodyHash}`)
      .digest("base64url");
    const accepted = await fetch(`${base}/admin/execution/list?limit=50`, {
      method: "GET",
      headers: { authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}` },
    });
    assert.equal(accepted.status, 200);
    const payload = await accepted.json();
    assert.equal(payload.available, true);
    assert.equal(payload.source, "execution-store");
    assert.equal(payload.records.length, 1);
    assert.equal(payload.records[0].id, RUNTIME_READY_RECORD_ID);
    // The read projection must never leak allowedOutput.
    assert.equal(payload.records[0].allowedOutput, undefined);
  } finally {
    if (handle) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GET /admin/execution/output requires Capability-MAC and returns only whitelisted public output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-execution-output-"));
  const executionStorePath = path.join(root, "executions");
  const secret = Buffer.alloc(32, 23);
  let handle;
  try {
    handle = await startServer({
      identity: {
        deviceId: "output-device",
        profileId: "output-profile",
        runtimeId: "output-runtime",
        runtimeInstanceId: "output-instance",
        workspaceRoot: root,
        workspaceId: "output-workspace",
        expectedPort: 0,
        publicMcpUrl: null,
        hostname: null,
      },
      secret,
      executionStorePath,
      oauth: { requireIntent: false },
    });
    const base = `http://127.0.0.1:${handle.port}`;

    const { createHmac, randomBytes } = await import("node:crypto");
    const { deriveAdminControlKey } = await import("../dist/capability.js");

    async function signedGet(pathname, query) {
      const ts = new Date().toISOString();
      const nonce = `test_${randomBytes(8).toString("hex")}`;
      const bodyHash = createHmac("sha256", Buffer.alloc(32)).update("").digest("hex");
      const sig = createHmac("sha256", deriveAdminControlKey(secret))
        .update(`${ts}\n${nonce}\nGET\n${pathname}\n${bodyHash}`)
        .digest("base64url");
      return fetch(`${base}${pathname}${query ? `?${query}` : ""}`, {
        method: "GET",
        headers: { authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}` },
      });
    }

    // No signature -> 401
    const denied = await fetch(`${base}/admin/execution/output?id=anything`);
    assert.equal(denied.status, 401);

    // Startup readiness record is publicOutput=true with a whitelisted body.
    const ok = await signedGet("/admin/execution/output", `id=${encodeURIComponent(RUNTIME_READY_RECORD_ID)}`);
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.available, true);
    assert.equal(payload.id, RUNTIME_READY_RECORD_ID);
    assert.equal(payload.output, RUNTIME_READY_PUBLIC_OUTPUT);

    // Unregistered id -> 404.
    const missing = await signedGet("/admin/execution/output", "id=exec_does_not_exist");
    assert.equal(missing.status, 404);
  } finally {
    if (handle) await handle.close();
    await rm(root, { recursive: true, force: true });
  }
});
