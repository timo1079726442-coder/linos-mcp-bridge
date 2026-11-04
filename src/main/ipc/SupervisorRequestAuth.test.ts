import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createSupervisorRequestAuthorization,
  createSupervisorRpcAuthOkProof,
  createSupervisorRpcChallenge,
  createSupervisorRpcNonce,
  createSupervisorRpcProof,
  createSupervisorRpcResponseFrame,
  deriveSupervisorRpcSessionKey,
  SupervisorRequestVerifier,
  supervisorMethodRequiresAuthorization,
  verifySupervisorRpcAuthOkProof,
  verifySupervisorRpcProof,
  verifySupervisorRpcResponseFrame,
} from "./SupervisorRequestAuth.js";

describe("Supervisor session authentication", () => {
  const key = Buffer.from("session key for tests only");
  const request = {
    id: "7",
    method: "diagnostics.repair.run",
    params: {
      request: { signature: "fault:v1:opaque", expectedProfileId: "profile-test", expectedWorkspaceId: "workspace-test", suggestionId: "RESTART_PROFILE_TUNNEL" },
      nativeConfirmation: "LOCAL_CONFIRMED",
    },
  };

  it("requires a signed session by default and exempts only explicit read-only methods", () => {
    expect(supervisorMethodRequiresAuthorization("diagnostics.run")).toBe(true);
    expect(supervisorMethodRequiresAuthorization("diagnostics.repair-options.match")).toBe(true);
    expect(supervisorMethodRequiresAuthorization("security.folder-acl.add")).toBe(true);
    expect(supervisorMethodRequiresAuthorization("security.approvals.execute")).toBe(true);
    for (const taskMethod of [
      "agent-task.availability",
      "agent-task.submit",
      "agent-task.status",
      "agent-task.cancel",
      "agent-task.result",
      "agent-task.evidence",
    ]) {
      expect(supervisorMethodRequiresAuthorization(taskMethod)).toBe(true);
    }
    expect(supervisorMethodRequiresAuthorization("ping")).toBe(false);
    expect(supervisorMethodRequiresAuthorization("diagnostics.fault-cases.list")).toBe(false);
  });
  it("accepts one correctly signed request and rejects its replay", () => {
    const verifier = new SupervisorRequestVerifier(key);
    const authorization = createSupervisorRequestAuthorization(key, request, 1);
    expect(verifier.available).toBe(true);
    expect(verifier.verify(request, authorization)).toBe(true);
    expect(verifier.verify(request, authorization)).toBe(false);
  });

  it("rejects absent sessions and unsigned LOCAL_CONFIRMED values", () => {
    expect(new SupervisorRequestVerifier(null).verify(request, undefined)).toBe(false);
    expect(new SupervisorRequestVerifier(null).verify(request, { nonce: 1, signature: "LOCAL_CONFIRMED" })).toBe(false);
  });

  it("rejects changed method, Profile, Workspace, action, or confirmation after signing", () => {
    const authorization = createSupervisorRequestAuthorization(key, request, 1);
    for (const changed of [
      { ...request, method: "diagnostics.run" },
      { ...request, params: { ...request.params, nativeConfirmation: "NOT_REQUIRED" } },
      { ...request, params: { ...request.params, request: { ...request.params.request, expectedProfileId: "profile-other" } } },
      { ...request, params: { ...request.params, request: { ...request.params.request, expectedWorkspaceId: "workspace-other" } } },
      { ...request, params: { ...request.params, request: { ...request.params.request, suggestionId: "START_PROFILE_RUNTIME" } } },
    ]) {
      expect(new SupervisorRequestVerifier(key).verify(changed, authorization)).toBe(false);
    }
  });

  it("rejects invalid and out-of-order nonces without consuming a later valid nonce", () => {
    const verifier = new SupervisorRequestVerifier(key);
    const valid = createSupervisorRequestAuthorization(key, request, 2);
    expect(verifier.verify(request, { nonce: 0, signature: valid.signature })).toBe(false);
    expect(verifier.verify(request, { ...valid, signature: "0".repeat(64) })).toBe(false);
    expect(verifier.verify(request, valid)).toBe(true);
    expect(verifier.verify(request, createSupervisorRequestAuthorization(key, request, 1))).toBe(false);
  });

  it("authenticates both RPC peers and binds a fresh session to both nonces", () => {
    const rootKey = randomBytes(32);
    const challenge = createSupervisorRpcChallenge();
    const clientNonce = createSupervisorRpcNonce();
    const proof = createSupervisorRpcProof(rootKey, challenge, clientNonce);
    expect(verifySupervisorRpcProof(rootKey, challenge, clientNonce, proof)).toBe(true);
    expect(verifySupervisorRpcProof(rootKey, challenge, createSupervisorRpcNonce(), proof)).toBe(false);

    const sessionKey = deriveSupervisorRpcSessionKey(rootKey, challenge, clientNonce);
    const serverProof = createSupervisorRpcAuthOkProof(sessionKey, challenge, clientNonce);
    expect(verifySupervisorRpcAuthOkProof(sessionKey, challenge, clientNonce, serverProof)).toBe(true);
    expect(verifySupervisorRpcAuthOkProof(sessionKey, challenge, createSupervisorRpcNonce(), serverProof)).toBe(false);
    expect(deriveSupervisorRpcSessionKey(rootKey, challenge, createSupervisorRpcNonce()).equals(sessionKey)).toBe(false);
  });

  it("signs every RPC response and rejects missing, changed, or replay-shifted frames", () => {
    const sessionKey = randomBytes(32);
    const frame = createSupervisorRpcResponseFrame(sessionKey, {
      id: "11",
      sequence: 4,
      ok: true,
      data: { health: "ok" },
    });
    expect(verifySupervisorRpcResponseFrame(sessionKey, frame)).toBe(true);
    expect(verifySupervisorRpcResponseFrame(sessionKey, { ...frame, payload: frame.payload.replace("health", "spoofed") })).toBe(false);
    expect(verifySupervisorRpcResponseFrame(sessionKey, { ...frame, sequence: 3 })).toBe(false);
    const { mac: _mac, ...missingMac } = frame;
    expect(verifySupervisorRpcResponseFrame(sessionKey, missingMac)).toBe(false);
  });
});
