import { createHmac } from "node:crypto";
/**
 * HKDF-SHA256 wrapper. Per CP1 ARCHITECTURE_V2 §3 + SECURITY_MODEL_V2 §3,
 * runtimeInstanceSecret is the single shared secret; adminControlKey /
 * challengeKey / healthFingerprintKey / publicHealthChallengeKey are derived
 * via HKDF with domain-separated info strings. Domain separation is mandatory
 * so a leak in one domain never crosses to another.
 */
export function hkdfSha256(ikm, info, length = 32) {
    // Simplified HKDF-SHA256: extract = HMAC(salt=zeros, ikm); expand = HMAC chaining.
    // For our purposes (fixed-length symmetric keys) this is sufficient and
    // does not depend on node:crypto's hkdfSync (which is available in Node 22+).
    const salt = Buffer.alloc(32);
    const prk = createHmac("sha256", salt).update(ikm).digest();
    let t = Buffer.alloc(0);
    let out = Buffer.alloc(0);
    let counter = 1;
    while (out.length < length) {
        t = createHmac("sha256", prk).update(Buffer.concat([t, Buffer.from(info, "utf8"), Buffer.from([counter])])).digest();
        out = Buffer.concat([out, t]);
        counter++;
    }
    return out.subarray(0, length);
}
export function deriveAdminControlKey(secret) {
    return hkdfSha256(secret, "c2c-v2-admin-control-v1", 32);
}
export function deriveChallengeKey(secret) {
    return hkdfSha256(secret, "c2c-v2-challenge-v1", 32);
}
export function deriveHealthFingerprintKey(secret) {
    return hkdfSha256(secret, "c2c-v2-public-health-fingerprint-v1", 32);
}
export function derivePublicHealthChallengeKey(secret) {
    return hkdfSha256(secret, "c2c-v2-public-health-challenge-v1", 32);
}
