// @vitest-environment node
import { createHash, createHmac } from "node:crypto";
import { Duplex } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { deriveRuntimeSupervisorBridgeKey } from "../security/HKDF.js";
import { RuntimeSupervisorBridgeSession, RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL } from "./RuntimeSupervisorBridge.js";

const runtimeInstanceId = "c2c_ri_test-bridge-instance";
const secret = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");

class PairedDuplex extends Duplex {
  peer: PairedDuplex | null = null;
  _read(): void {}
  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(Buffer.from(chunk));
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.peer && !this.peer.destroyed) this.peer.push(null);
    callback(error);
  }
}

function makePair(): { runtime: PairedDuplex; supervisor: PairedDuplex } {
  const runtime = new PairedDuplex();
  const supervisor = new PairedDuplex();
  runtime.peer = supervisor;
  supervisor.peer = runtime;
  return { runtime, supervisor };
}

function sign(key: Buffer, frame: { protocol: string; runtimeInstanceId: string; sequence: number; timestamp: number; nonce: string; payload: unknown }): string {
  const payloadDigest = createHash("sha256").update(JSON.stringify(frame.payload), "utf8").digest("hex");
  return createHmac("sha256", key)
    .update(`${frame.protocol}\n${frame.runtimeInstanceId}\n${frame.sequence}\n${frame.timestamp}\n${frame.nonce}\n${payloadDigest}`, "utf8")
    .digest("base64url");
}

function signedRequest(payload: unknown, sequence = 1, nonce = "abcdefghijklmnopqrstuvwx") {
  const unsigned = {
    protocol: RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL,
    runtimeInstanceId,
    sequence,
    timestamp: Date.now(),
    nonce,
    payload,
  };
  const key = deriveRuntimeSupervisorBridgeKey(secret);
  return { ...unsigned, mac: sign(key, unsigned) };
}

function readLine(stream: Duplex): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("bridge_response_timeout")), 1_000);
    const onData = (chunk: Buffer | string): void => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      stream.off("data", onData);
      try { resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>); }
      catch (error) { reject(error); }
    };
    stream.on("data", onData);
  });
}

function payload(relativePath = "new.txt", content = "synthetic only") {
  return {
    operation: "MCP_CREATE_INTENT",
    caller: { clientId: "registered-client-1", requestId: "mcp-request-1" },
    intent: { operation: "CREATE", relativePath, content },
  };
}

function waitForEnd(stream: Duplex): Promise<void> {
  stream.on("data", () => {});
  return new Promise((resolve) => stream.once("end", () => resolve()));
}

describe("RuntimeSupervisorBridgeSession", () => {
  it("authenticates Runtime requests and returns a signed, correlated approval result", async () => {
    const { runtime, supervisor } = makePair();
    const onCreateIntent = vi.fn(async () => ({ status: "PENDING" as const, requestId: "approval_12345678" }));
    const session = new RuntimeSupervisorBridgeSession(supervisor, secret, runtimeInstanceId, onCreateIntent);
    const responsePromise = readLine(runtime);
    const requestFrame = signedRequest(payload());
    runtime.write(`${JSON.stringify(requestFrame)}\n`);
    const response = await responsePromise;

    expect(onCreateIntent).toHaveBeenCalledWith({
      runtimeInstanceId,
      correlationId: `${runtimeInstanceId}:1`,
      caller: { clientId: "registered-client-1", requestId: "mcp-request-1" },
      intent: { operation: "CREATE", relativePath: "new.txt", content: "synthetic only" },
    });
    expect(response).toMatchObject({
      protocol: RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL,
      runtimeInstanceId,
      sequence: requestFrame.sequence,
      nonce: requestFrame.nonce,
      payload: { status: "PENDING", requestId: "approval_12345678" },
    });
    const { mac, ...unsignedResponse } = response as typeof response & { mac: string };
    expect(mac).toBe(sign(deriveRuntimeSupervisorBridgeKey(secret), unsignedResponse as Parameters<typeof sign>[1]));
    session.close();
    runtime.destroy();
  });

  it("returns a static rejection code only when isolated diagnostics are enabled", async () => {
    const { runtime, supervisor } = makePair();
    const onCreateIntent = vi.fn(async () => { throw new Error("MCP_WORKSPACE_WRITE_GRANT_REQUIRED"); });
    const session = new RuntimeSupervisorBridgeSession(supervisor, secret, runtimeInstanceId, onCreateIntent, true);
    const responsePromise = readLine(runtime);
    runtime.write(`${JSON.stringify(signedRequest(payload()))}\n`);
    const response = await responsePromise;

    expect(onCreateIntent).toHaveBeenCalledTimes(1);
    expect(response.payload).toEqual({ error: "MCP_WORKSPACE_WRITE_GRANT_REQUIRED" });
    session.close();
    runtime.destroy();
  });

  it("keeps Supervisor errors generic when isolated diagnostics are disabled", async () => {
    const { runtime, supervisor } = makePair();
    const onCreateIntent = vi.fn(async () => { throw new Error("MCP_WORKSPACE_WRITE_GRANT_REQUIRED"); });
    const session = new RuntimeSupervisorBridgeSession(supervisor, secret, runtimeInstanceId, onCreateIntent);
    const responsePromise = readLine(runtime);
    runtime.write(`${JSON.stringify(signedRequest(payload()))}\n`);
    const response = await responsePromise;

    expect(response.payload).toEqual({ error: "SUPERVISOR_CREATE_INTENT_UNAVAILABLE" });
    session.close();
    runtime.destroy();
  });

  it("rejects invalid MACs before reaching the approval handler", async () => {
    const { runtime, supervisor } = makePair();
    const onCreateIntent = vi.fn(async () => ({ status: "REJECTED" as const }));
    const session = new RuntimeSupervisorBridgeSession(supervisor, secret, runtimeInstanceId, onCreateIntent);
    const closed = waitForEnd(runtime);
    const forged = { ...signedRequest(payload()), mac: "A".repeat(43) };
    runtime.write(`${JSON.stringify(forged)}\n`);
    await closed;
    expect(onCreateIntent).not.toHaveBeenCalled();
    session.close();
  });

  it("rejects unsafe relative paths before reaching the approval handler", async () => {
    const { runtime, supervisor } = makePair();
    const onCreateIntent = vi.fn(async () => ({ status: "REJECTED" as const }));
    const session = new RuntimeSupervisorBridgeSession(supervisor, secret, runtimeInstanceId, onCreateIntent);
    const closed = waitForEnd(runtime);
    runtime.write(`${JSON.stringify(signedRequest(payload("../outside.txt")))}\n`);
    await closed;
    expect(onCreateIntent).not.toHaveBeenCalled();
    session.close();
  });

  it("rejects replayed sequences and Runtime identity mismatches", async () => {
    const { runtime, supervisor } = makePair();
    const onCreateIntent = vi.fn(async () => ({ status: "REJECTED" as const }));
    const session = new RuntimeSupervisorBridgeSession(supervisor, secret, runtimeInstanceId, onCreateIntent);
    const firstResponse = readLine(runtime);
    const frame = signedRequest(payload());
    runtime.write(`${JSON.stringify(frame)}\n`);
    await firstResponse;
    const closed = waitForEnd(runtime);
    runtime.write(`${JSON.stringify(frame)}\n`);
    await closed;
    expect(onCreateIntent).toHaveBeenCalledTimes(1);
    session.close();
  });
});
