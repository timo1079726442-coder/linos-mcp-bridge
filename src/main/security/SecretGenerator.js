import { randomBytes } from "node:crypto";
/**
 * SecretGenerator — runtimeInstanceSecret generation.
 *
 * Per CP1 SECURITY_MODEL_V2 §4, runtimeInstanceSecret is a CSPRNG 32-byte
 * value that lives only in memory. It is delivered to the child Runtime via
 * stdin pipe (preferred) or environment variable (fallback) and is never
 * persisted, logged, included in Diagnostic Bundles, or written to runtime.json.
 */
export class SecretGenerator {
    static generateRuntimeInstanceSecret() {
        return randomBytes(32);
    }
    static encode(secret) {
        return `c2c_ri_secret_${secret.toString("base64url")}`;
    }
    static decode(encoded) {
        const prefix = "c2c_ri_secret_";
        if (!encoded.startsWith(prefix))
            return null;
        try {
            return Buffer.from(encoded.slice(prefix.length), "base64url");
        }
        catch {
            return null;
        }
    }
}
