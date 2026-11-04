/**
 * Redactor — central redaction pipeline for console, audit, and diagnostic
 * bundle output. Per CP1 SECURITY_MODEL_V2 §7.
 *
 * Strategy: identify and mask secret-shaped tokens (c2c_ri_secret_*, c2c_at_*,
 * c2c_rt_*, base64url 22+ chars, Authorization header values, long hex blobs,
 * known credential field names). Replace with `[REDACTED:<kind>]` so the
 * shape of the log entry is preserved without leaking the value.
 */
const REDACTION_RULES = [
    // SPECIFIC c2c_* prefixes first (don't get eaten by generic password/secret rule)
    { name: "runtimeInstanceSecret", re: /c2c_ri_secret_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:runtimeInstanceSecret]" },
    { name: "adminToken", re: /c2c_admin_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:adminToken]" },
    { name: "accessToken", re: /c2c_at_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:accessToken]" },
    { name: "refreshToken", re: /c2c_rt_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:refreshToken]" },
    // Already-redacted placeholders must not be re-categorized
    { name: "alreadyRedacted", re: /\[REDACTED:[a-zA-Z]+\]/g, replacement: "$&" },
    // Now the generic field-value rules
    { name: "authHeader", re: /(authorization"?\s*[:=]\s*"?bearer\s+)[^\s"']+/gi, replacement: "$1[REDACTED:bearer]" },
    { name: "bearerToken", re: /bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, replacement: "Bearer [REDACTED:bearer]" },
    { name: "tunnelCredential", re: /(tunnel[_-]?credential"?\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:tunnelCredential]" },
    { name: "clientSecret", re: /((?:client_secret|client-secret)\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:clientSecret]" },
    // password/secret must come AFTER c2c_* (which contain "secret" prefix)
    { name: "password", re: /((?:password|passwd)\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:password]" },
    { name: "longHexBlob", re: /\b[a-fA-F0-9]{48,}\b/g, replacement: "[REDACTED:hexBlob]" },
    { name: "longBase64Url", re: /\b[A-Za-z0-9_-]{40,}\b/g, replacement: "[REDACTED:longToken]" },
];
export function redactString(input) {
    let out = input;
    for (const rule of REDACTION_RULES) {
        out = out.replace(rule.re, rule.replacement);
    }
    return out;
}
export function redactObject(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return redactString(value);
    if (Array.isArray(value))
        return value.map((v) => redactObject(v));
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactObject(v);
        }
        return out;
    }
    return value;
}
export function redactJson(obj) {
    return JSON.stringify(redactObject(obj), null, 2);
}
