import { randomBytes } from "node:crypto";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSupervisorRpcAuthOkProof,
  createSupervisorRpcChallenge,
  createSupervisorRpcResponseFrame,
  deriveSupervisorRpcSessionKey,
  SUPERVISOR_RPC_AUTH_KIND,
  SUPERVISOR_RPC_AUTH_OK_KIND,
  SUPERVISOR_RPC_CHALLENGE_KIND,
  SupervisorRequestVerifier,
  supervisorMethodRequiresAuthorization,
  verifySupervisorRpcProof,
} from "./SupervisorRequestAuth.js";
import { SupervisorClient } from "./SupervisorClient.js";

const openServers: net.Server[] = [];
const openClients: SupervisorClient[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }).catch(() => undefined)));
});

function startFakeSupervisor(options: { omitServerProof?: boolean; tamperResponse?: boolean } = {}): Promise<{
  pipeName: string;
  challenges: string[];
  rootKey: Buffer;
  /** One entry per accepted request, in wire order, across all connections. */
  sequences: () => number[];
  /** One entry per pipe connection the fake Supervisor accepted. */
  connections: () => string[];
}> {
  if (process.platform !== "win32") throw new Error("named pipe protocol test requires Windows");
  const pipeName = `\\\\.\\pipe\\C2C_RPC_TEST_${randomBytes(8).toString("hex")}`;
  const rootKey = randomBytes(32);
  const challenges: string[] = [];
  // Mirrors supervisorMain.ts: the server requires sequence === lastSequence + 1
  // on the same connection and destroys the pipe otherwise.
  const connectionIds: string[] = [];
  const accepted: number[] = [];
  const server = net.createServer((socket) => {
    connectionIds.push(randomBytes(6).toString("hex"));
    socket.once("close", () => undefined);
    const challenge = createSupervisorRpcChallenge();
    challenges.push(challenge);
    let sessionKey: Buffer | null = null;
    let verifier: SupervisorRequestVerifier | null = null;
    let lastSequence = 0;
    let buffer = "";
    socket.write(JSON.stringify({ kind: SUPERVISOR_RPC_CHALLENGE_KIND, challenge }) + "\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(line) as Record<string, unknown>; }
        catch { socket.destroy(); return; }
        if (!sessionKey) {
          if (frame.kind !== SUPERVISOR_RPC_AUTH_KIND || typeof frame.clientNonce !== "string" || typeof frame.proof !== "string" ||
              !verifySupervisorRpcProof(rootKey, challenge, frame.clientNonce, frame.proof)) {
            socket.destroy();
            return;
          }
          sessionKey = deriveSupervisorRpcSessionKey(rootKey, challenge, frame.clientNonce);
          verifier = new SupervisorRequestVerifier(sessionKey);
          socket.write(JSON.stringify({
            kind: SUPERVISOR_RPC_AUTH_OK_KIND,
            ...(options.omitServerProof ? {} : { proof: createSupervisorRpcAuthOkProof(sessionKey, challenge, frame.clientNonce) }),
          }) + "\n");
          continue;
        }

        const request = frame as { id?: unknown; sequence?: unknown; method?: unknown; params?: unknown; authorization?: { nonce: number; signature: string } };
        if (typeof request.id !== "string" || !Number.isSafeInteger(request.sequence) || request.sequence !== lastSequence + 1 || typeof request.method !== "string") {
          socket.destroy();
          return;
        }
        lastSequence = request.sequence as number;
        accepted.push(lastSequence);
        if (supervisorMethodRequiresAuthorization(request.method) && !verifier?.verify({
          id: request.id,
          method: request.method,
          params: request.params,
        }, request.authorization)) {
          socket.destroy();
          return;
        }
        const response = { id: request.id, sequence: lastSequence, ok: true, data: { diagnostics: "verified" } };
        const signed = createSupervisorRpcResponseFrame(sessionKey, response);
        if (options.tamperResponse) signed.payload = signed.payload.replace("verified", "spoofed");
        socket.write(JSON.stringify(signed) + "\n");
      }
    });
  });
  openServers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, () => {
      server.off("error", reject);
      resolve({
        pipeName,
        challenges,
        rootKey,
        sequences: () => [...accepted],
        connections: () => [...connectionIds],
      });
    });
  });
}

function createClient(pipeName: string, rootKey: Buffer): SupervisorClient {
  const client = new SupervisorClient({
    stateRoot: "unused-test-root",
    supervisorEntry: "unused-test-entry",
    pipeName,
    sessionRootKeyProvider: async () => Buffer.from(rootKey),
  });
  openClients.push(client);
  return client;
}

describe("SupervisorClient authenticated named-pipe protocol", () => {
  it("verifies server proof, signs protected calls, and creates a fresh session on reconnect", async () => {
    if (process.platform !== "win32") return;
    const { pipeName, challenges, rootKey } = await startFakeSupervisor();
    const client = createClient(pipeName, rootKey);
    await expect(client.call({ method: "diagnostics.run" })).resolves.toEqual({ diagnostics: "verified" });
    await client.close();
    await expect(client.call({ method: "diagnostics.run" })).resolves.toEqual({ diagnostics: "verified" });
    expect(challenges).toHaveLength(2);
    expect(challenges[0]).not.toBe(challenges[1]);
  });

  it("rejects an AUTH_OK without a valid server proof and never treats the fake server as alive", async () => {
    if (process.platform !== "win32") return;
    const { pipeName, rootKey } = await startFakeSupervisor({ omitServerProof: true });
    const client = createClient(pipeName, rootKey);
    await expect(client.call({ method: "ping" })).rejects.toThrow("supervisor_auth_server_proof_invalid");
    expect(client.isAlive()).toBe(false);
  });

  it("rejects a tampered signed response before resolving a call", async () => {
    if (process.platform !== "win32") return;
    const { pipeName, rootKey } = await startFakeSupervisor({ tamperResponse: true });
    const client = createClient(pipeName, rootKey);
    await expect(client.call({ method: "diagnostics.run" })).rejects.toThrow("supervisor_auth_response_invalid");
    expect(client.isAlive()).toBe(false);
  });

  it("keeps one pipe connection and strictly consecutive sequences under concurrent first calls", async () => {
    if (process.platform !== "win32") return;
    const { pipeName, rootKey, connections, sequences } = await startFakeSupervisor();
    const client = createClient(pipeName, rootKey);
    // Reproduces the renderer mount burst: Electron main pre-warms the client
    // with `void client.ensureConnected()` and does not await it, so the first
    // renderer RPCs arrive concurrently while `alive` is still false.
    const methods = ["readiness.get", "profile.get-active", "ping", "profile.list", "intent.list", "workspace.detect"];
    const results = await Promise.all(methods.map((method) => client.call({ method })));

    expect(results).toHaveLength(methods.length);
    // Before the fix each concurrent caller ran its own handshake, so several
    // connections opened and every one of them restarted its sequence at 1.
    expect(connections().length).toBe(1);
    expect(sequences()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(client.isAlive()).toBe(true);
  });
});
