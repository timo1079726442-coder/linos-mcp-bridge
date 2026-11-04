import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExecutionRecordStore } from "../dist/execution-store.js";
import {
  ExecutionStoreProducer,
  RUNTIME_READY_RECORD_ID,
  RUNTIME_READY_TASK_ID,
} from "../dist/execution-producer.js";

/**
 * Fail-closed verification of the startup-readiness predicate.
 *
 * A startup readiness record must NEVER be written unless the Runtime is
 * actually serving on a valid, expected port AND the workspace is real.
 * This guards the consumer side: if a stale `exec_runtime_ready` survives
 * a crash, the next session can read it via /admin/execution/list. The list
 * projection still carries timestamp + runtimeInstanceId so UI can refuse
 * stale records, but the writer-side predicate must never write junk.
 */
test("publishRuntimeReady: 0/0 is rejected (boundPort=0 means nothing is bound)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-00-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 0, boundPort: 0,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.equal(rec, null, "0/0 must fail closed; ephemeral mode needs a real bound port");
    assert.equal((await readdir(root)).filter((n) => n.endsWith(".json")).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: 0/valid-port is accepted (ephemeral mode)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-eph-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 0, boundPort: 14556,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.ok(rec, "ephemeral bind to a real port must be accepted");
    assert.equal(rec?.id, RUNTIME_READY_RECORD_ID);
    assert.equal(rec?.taskId, RUNTIME_READY_TASK_ID);
    const files = (await readdir(root)).filter((n) => n.endsWith(".json"));
    assert.equal(files.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: 0/boundPort=65535 is accepted (ephemeral boundary)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-eph-max-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 0, boundPort: 65535,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.ok(rec, "upper port boundary must be accepted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: 0/boundPort=65536 is rejected (out of range)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-eph-oor-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 0, boundPort: 65536,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.equal(rec, null, "ports must be 1..65535; 65536 is not a valid TCP port");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: fixed port 48766/48766 is accepted (production shape)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-fix-ok-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 48766, boundPort: 48766,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.ok(rec, "exact fixed-port match must be accepted");
    assert.equal(rec?.id, RUNTIME_READY_RECORD_ID);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: fixed port 48766/0 is rejected (EADDRINUSE-style drift)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-fix-0-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 48766, boundPort: 0,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.equal(rec, null, "fixed-port mode with boundPort=0 must fail closed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: fixed port mismatch 48766/48767 is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-fix-mm-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 48766, boundPort: 48767,
      workspaceExists: true, workspaceId: "ws",
    });
    assert.equal(rec, null, "fixed-port mode must reject any drift; port drift was the original S02 root cause");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: workspaceExists=false is rejected regardless of ports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-noexist-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const recFixed = await producer.publishRuntimeReady({
      expectedPort: 48766, boundPort: 48766,
      workspaceExists: false, workspaceId: "ws",
    });
    assert.equal(recFixed, null, "fixed-port must require existing workspace");
    const recEphemeral = await producer.publishRuntimeReady({
      expectedPort: 0, boundPort: 14556,
      workspaceExists: false, workspaceId: "ws",
    });
    assert.equal(recEphemeral, null, "ephemeral must also require existing workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishRuntimeReady: empty workspaceId is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-rready-empty-"));
  try {
    const producer = new ExecutionStoreProducer(new ExecutionRecordStore(root));
    const rec = await producer.publishRuntimeReady({
      expectedPort: 48766, boundPort: 48766,
      workspaceExists: true, workspaceId: "",
    });
    assert.equal(rec, null, "empty workspaceId must fail closed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
