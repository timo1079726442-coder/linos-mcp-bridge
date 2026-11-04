/**
 * HKDF-SHA256 + Capability MAC for V2 Runtime.
 *
 * runtimeInstanceSecret is read once from stdin at process start and held
 * only in process memory. adminControlKey / challengeKey /
 * healthFingerprintKey / publicHealthChallengeKey are derived via HKDF
 * with domain-separated info strings.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function hkdfSha256(ikm: Buffer, info: string, length = 32): Buffer {
  const salt = Buffer.alloc(32);
  const prk = createHmac("sha256", salt).update(ikm).digest();
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  let counter = 1;
  while (out.length < length) {
    t = createHmac("sha256", prk)
      .update(Buffer.concat([t, Buffer.from(info, "utf8"), Buffer.from([counter])]))
      .digest();
    out = Buffer.concat([out, t]);
    counter++;
  }
  return out.subarray(0, length);
}

export function deriveAdminControlKey(secret: Buffer): Buffer {
  return hkdfSha256(secret, "c2c-v2-admin-control-v1", 32);
}

export function deriveRuntimeSupervisorBridgeKey(secret: Buffer): Buffer {
  return hkdfSha256(secret, "c2c-v2-runtime-supervisor-bridge-v1", 32);
}

export function deriveChallengeKey(secret: Buffer): Buffer {
  return hkdfSha256(secret, "c2c-v2-challenge-v1", 32);
}

export function deriveHealthFingerprintKey(secret: Buffer): Buffer {
  return hkdfSha256(secret, "c2c-v2-public-health-fingerprint-v1", 32);
}

export function derivePublicHealthChallengeKey(secret: Buffer): Buffer {
  return hkdfSha256(secret, "c2c-v2-public-health-challenge-v1", 32);
}

/** Compute the truncated health fingerprint for /health public endpoint. */
export function computeHealthFingerprint(secret: Buffer): string {
  const key = deriveHealthFingerprintKey(secret);
  const full = createHmac("sha256", key)
    .update("c2c-v2-public-health-fingerprint-v1")
    .digest();
  return full.subarray(0, 16).toString("base64url");
}

export interface AdminAuth {
  ts: string;
  nonce: string;
  sig: string;
}

export function verifyAdminAuth(
  auth: AdminAuth,
  method: string,
  path: string,
  bodyBytes: Buffer,
  adminKey: Buffer,
): { ok: true } | { ok: false; reason: string } {
  const tsMs = Date.parse(auth.ts);
  if (!Number.isFinite(tsMs)) return { ok: false, reason: "bad_ts" };
  if (Math.abs(Date.now() - tsMs) > 30_000) return { ok: false, reason: "ts_expired" };
  if (auth.nonce.length < 8 || auth.nonce.length > 128) return { ok: false, reason: "bad_nonce" };
  const bodyHash = createHmac("sha256", Buffer.alloc(32)).update(bodyBytes).digest("hex");
  const expected = createHmac("sha256", adminKey)
    .update(`${auth.ts}\n${auth.nonce}\n${method}\n${path}\n${bodyHash}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(auth.sig, "base64url");
  } catch {
    return { ok: false, reason: "bad_sig_encoding" };
  }
  if (provided.length !== expected.length) return { ok: false, reason: "sig_length_mismatch" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "sig_mismatch" };
  return { ok: true };
}

export function verifyChallengeSignature(
  signatureB64: string,
  nonce: string,
  issuedAt: string,
  identity: {
    deviceId: string;
    profileId: string;
    runtimeId: string;
    runtimeInstanceId: string;
    workspaceId: string;
  },
  challengeKey: Buffer,
): boolean {
  if (Math.abs(Date.now() - Date.parse(issuedAt)) > 30_000) return false;
  const expected = createHmac("sha256", challengeKey)
    .update(`v2|${nonce}|${issuedAt}|${identity.deviceId}|${identity.profileId}|${identity.runtimeId}|${identity.runtimeInstanceId}|${identity.workspaceId}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureB64, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export function signChallenge(
  nonce: string,
  issuedAt: string,
  identity: {
    deviceId: string;
    profileId: string;
    runtimeId: string;
    runtimeInstanceId: string;
    workspaceId: string;
  },
  challengeKey: Buffer,
): string {
  return createHmac("sha256", challengeKey)
    .update(`v2|${nonce}|${issuedAt}|${identity.deviceId}|${identity.profileId}|${identity.runtimeId}|${identity.runtimeInstanceId}|${identity.workspaceId}`)
    .digest("base64url");
}