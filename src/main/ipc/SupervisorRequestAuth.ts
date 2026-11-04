import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export interface SupervisorAuthenticatedRequest {
  id: string;
  method: string;
  params?: unknown;
}

export const SUPERVISOR_RPC_CHALLENGE_KIND = "C2C_SUPERVISOR_CHALLENGE_V1" as const;
export const SUPERVISOR_RPC_AUTH_KIND = "C2C_SUPERVISOR_AUTH_V1" as const;
export const SUPERVISOR_RPC_AUTH_OK_KIND = "C2C_SUPERVISOR_AUTH_OK_V1" as const;
export const SUPERVISOR_RPC_RESPONSE_KIND = "C2C_SUPERVISOR_RESPONSE_V1" as const;

const unauthenticatedReadMethods = new Set([
  "ping",
  "readiness.get",
  "diagnostics.fault-cases.list",
  "diagnostics.repair-history.list",
  "profile.list",
  "profile.get-active",
  "workspace.validate",
  "workspace.detect",
  "intent.list",
]);

/** Default-deny Supervisor RPC authorization; only explicit read-only methods are unsigned. */
export function supervisorMethodRequiresAuthorization(method: string): boolean {
  return !unauthenticatedReadMethods.has(method);
}

export interface SupervisorRequestAuthorization {
  nonce: number;
  signature: string;
}

export interface SupervisorRpcChallengeFrame {
  kind: typeof SUPERVISOR_RPC_CHALLENGE_KIND;
  challenge: string;
}

export interface SupervisorRpcAuthFrame {
  kind: typeof SUPERVISOR_RPC_AUTH_KIND;
  clientNonce: string;
  proof: string;
}

export interface SupervisorRpcAuthOkFrame {
  kind: typeof SUPERVISOR_RPC_AUTH_OK_KIND;
  proof: string;
}

export interface SupervisorRpcResponsePayload {
  id: string;
  sequence: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface SupervisorRpcResponseFrame {
  kind: typeof SUPERVISOR_RPC_RESPONSE_KIND;
  sequence: number;
  payload: string;
  mac: string;
}

function messageFor(request: SupervisorAuthenticatedRequest, nonce: number): string {
  return JSON.stringify(["c2c-supervisor-rpc-v1", request.id, nonce, request.method, request.params ?? {}]);
}

export function createSupervisorRequestAuthorization(
  key: Uint8Array,
  request: SupervisorAuthenticatedRequest,
  nonce: number,
): SupervisorRequestAuthorization {
  if (!Number.isSafeInteger(nonce) || nonce < 1) throw new Error("supervisor_auth_nonce_invalid");
  const signature = createHmac("sha256", key).update(messageFor(request, nonce), "utf8").digest("hex");
  return { nonce, signature };
}

/** A fresh random challenge makes each pipe reconnect derive a distinct request key. */
export function createSupervisorRpcChallenge(): string {
  return createSupervisorRpcNonce();
}

export function createSupervisorRpcNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function createSupervisorRpcProof(rootKey: Uint8Array, challenge: string, clientNonce: string): string {
  const challengeBytes = decodeChallenge(challenge);
  const clientNonceBytes = decodeChallenge(clientNonce);
  if (!challengeBytes || !clientNonceBytes || rootKey.byteLength !== 32) throw new Error("supervisor_auth_challenge_invalid");
  return createHmac("sha256", rootKey)
    .update("c2c-supervisor-rpc-client-auth-v2\0", "utf8")
    .update(challengeBytes)
    .update(clientNonceBytes)
    .digest("hex");
}

export function verifySupervisorRpcProof(rootKey: Uint8Array | null, challenge: string, clientNonce: string, proof: string): boolean {
  if (!rootKey || rootKey.byteLength !== 32 || !/^[a-f0-9]{64}$/i.test(proof)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(createSupervisorRpcProof(rootKey, challenge, clientNonce), "hex");
  } catch {
    return false;
  }
  const received = Buffer.from(proof, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createSupervisorRpcAuthOkProof(sessionKey: Uint8Array, challenge: string, clientNonce: string): string {
  const challengeBytes = decodeChallenge(challenge);
  const clientNonceBytes = decodeChallenge(clientNonce);
  if (!challengeBytes || !clientNonceBytes || sessionKey.byteLength !== 32) throw new Error("supervisor_auth_challenge_invalid");
  return createHmac("sha256", sessionKey)
    .update("c2c-supervisor-rpc-server-auth-v2\0", "utf8")
    .update(challengeBytes)
    .update(clientNonceBytes)
    .digest("hex");
}

export function verifySupervisorRpcAuthOkProof(sessionKey: Uint8Array, challenge: string, clientNonce: string, proof: string): boolean {
  if (sessionKey.byteLength !== 32 || !/^[a-f0-9]{64}$/i.test(proof)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(createSupervisorRpcAuthOkProof(sessionKey, challenge, clientNonce), "hex");
  } catch {
    return false;
  }
  const received = Buffer.from(proof, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function deriveSupervisorRpcSessionKey(rootKey: Uint8Array, challenge: string, clientNonce: string): Buffer {
  const challengeBytes = decodeChallenge(challenge);
  const clientNonceBytes = decodeChallenge(clientNonce);
  if (!challengeBytes || !clientNonceBytes || rootKey.byteLength !== 32) throw new Error("supervisor_auth_challenge_invalid");
  return Buffer.from(hkdfSync("sha256", rootKey, Buffer.concat([challengeBytes, clientNonceBytes]), "c2c-supervisor-rpc-session-v2", 32));
}

export function createSupervisorRpcResponseFrame(
  sessionKey: Uint8Array,
  response: SupervisorRpcResponsePayload,
): SupervisorRpcResponseFrame {
  if (sessionKey.byteLength !== 32 || !Number.isSafeInteger(response.sequence) || response.sequence < 1) {
    throw new Error("supervisor_response_sequence_invalid");
  }
  const payload = JSON.stringify(response);
  return {
    kind: SUPERVISOR_RPC_RESPONSE_KIND,
    sequence: response.sequence,
    payload,
    mac: responseMac(sessionKey, response.sequence, payload),
  };
}

export function verifySupervisorRpcResponseFrame(sessionKey: Uint8Array | null, value: unknown): value is SupervisorRpcResponseFrame {
  if (!sessionKey || sessionKey.byteLength !== 32 || !value || typeof value !== "object") return false;
  const frame = value as Partial<SupervisorRpcResponseFrame>;
  if (frame.kind !== SUPERVISOR_RPC_RESPONSE_KIND || !Number.isSafeInteger(frame.sequence) || (frame.sequence ?? 0) < 1 ||
      typeof frame.payload !== "string" || typeof frame.mac !== "string" || !/^[a-f0-9]{64}$/i.test(frame.mac)) return false;
  const expected = Buffer.from(responseMac(sessionKey, frame.sequence!, frame.payload), "hex");
  const received = Buffer.from(frame.mac, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function responseMac(sessionKey: Uint8Array, sequence: number, payload: string): string {
  return createHmac("sha256", sessionKey)
    .update(JSON.stringify(["c2c-supervisor-rpc-response-v1", "SUPERVISOR_TO_MAIN", sequence, payload]), "utf8")
    .digest("hex");
}

function decodeChallenge(challenge: string): Buffer | null {
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  const bytes = Buffer.from(challenge, "base64url");
  return bytes.length === 32 ? bytes : null;
}

/** A per-connection verifier. Nonces restart safely because each challenge derives a new key. */
export class SupervisorRequestVerifier {
  private readonly key: Buffer | null;
  private lastNonce = 0;

  constructor(key: Uint8Array | null) {
    this.key = key ? Buffer.from(key) : null;
  }

  get available(): boolean {
    return this.key !== null;
  }

  verify(request: SupervisorAuthenticatedRequest, authorization: SupervisorRequestAuthorization | undefined): boolean {
    if (!this.key || !authorization || !Number.isSafeInteger(authorization.nonce) || authorization.nonce <= this.lastNonce) return false;
    if (typeof authorization.signature !== "string" || !/^[a-f0-9]{64}$/i.test(authorization.signature)) return false;
    const expected = createHmac("sha256", this.key).update(messageFor(request, authorization.nonce), "utf8").digest();
    const received = Buffer.from(authorization.signature, "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
    this.lastNonce = authorization.nonce;
    return true;
  }
}
