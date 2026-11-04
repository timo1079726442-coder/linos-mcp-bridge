import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  hkdfSha256,
  deriveAdminControlKey,
  deriveChallengeKey,
  deriveHealthFingerprintKey,
  derivePublicHealthChallengeKey,
} from "./HKDF.js";

describe("HKDF-SHA256", () => {
  it("produces deterministic output for fixed input", () => {
    const ikm = Buffer.from("fixed-ikm-for-test-only", "utf8");
    const a = hkdfSha256(ikm, "test-info", 32);
    const b = hkdfSha256(ikm, "test-info", 32);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it("different info produces different keys (domain separation)", () => {
    const ikm = randomBytes(32);
    const a = hkdfSha256(ikm, "domain-a", 32);
    const b = hkdfSha256(ikm, "domain-b", 32);
    expect(a.equals(b)).toBe(false);
  });

  it("different ikm produces different keys", () => {
    const info = "domain";
    const a = hkdfSha256(randomBytes(32), info, 32);
    const b = hkdfSha256(randomBytes(32), info, 32);
    expect(a.equals(b)).toBe(false);
  });

  it("length respected", () => {
    const ikm = randomBytes(32);
    expect(hkdfSha256(ikm, "x", 16).length).toBe(16);
    expect(hkdfSha256(ikm, "x", 64).length).toBe(64);
  });
});

describe("Domain-separated key derivation", () => {
  it("adminControlKey != challengeKey for same secret", () => {
    const secret = randomBytes(32);
    expect(deriveAdminControlKey(secret).equals(deriveChallengeKey(secret))).toBe(false);
  });

  it("healthFingerprintKey != publicHealthChallengeKey for same secret", () => {
    const secret = randomBytes(32);
    expect(
      deriveHealthFingerprintKey(secret).equals(derivePublicHealthChallengeKey(secret)),
    ).toBe(false);
  });

  it("all four domains produce distinct keys", () => {
    const secret = randomBytes(32);
    const keys = new Set([
      deriveAdminControlKey(secret).toString("hex"),
      deriveChallengeKey(secret).toString("hex"),
      deriveHealthFingerprintKey(secret).toString("hex"),
      derivePublicHealthChallengeKey(secret).toString("hex"),
    ]);
    expect(keys.size).toBe(4);
  });
});