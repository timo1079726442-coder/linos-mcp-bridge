/**
 * Redactor — central redaction pipeline for console, audit, and diagnostic
 * bundle output. Per CP1 SECURITY_MODEL_V2 §7.
 *
 * Strategy: identify and mask secret-shaped tokens (c2c_ri_secret_*, c2c_at_*,
 * c2c_rt_*, base64url 22+ chars, Authorization header values, long hex blobs,
 * known credential field names). Replace with `[REDACTED:<kind>]` so the
 * shape of the log entry is preserved without leaking the value.
 */
const REDACTION_RULES: Array<{ name: string; re: RegExp; replacement: string }> = [
  // SPECIFIC c2c_* prefixes first (don't get eaten by generic password/secret rule)
  { name: "runtimeInstanceSecret", re: /c2c_ri_secret_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:runtimeInstanceSecret]" },
  { name: "adminToken", re: /c2c_admin_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:adminToken]" },
  { name: "accessToken", re: /c2c_at_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:accessToken]" },
  { name: "refreshToken", re: /c2c_rt_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:refreshToken]" },
  // Already-redacted placeholders must not be re-categorized
  { name: "alreadyRedacted", re: /\[REDACTED:[a-zA-Z]+\]/g, replacement: "$&" },
  // Now the generic field-value rules
  { name: "authHeader", re: /(authorization"?\s*[:=]\s*"?bearer\s+)[^\s"']+/gi, replacement: "$1[REDACTED:bearer]" },
  { name: "urlUserInfo", re: /(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, replacement: "$1[REDACTED:userinfo]@" },
  { name: "credentialQuery", re: /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|secret|password|passwd|cookie|oauth[_-]?state|authorization[_-]?code|code[_-]?verifier|signature|h5st|sdtoken)=)[^&#\s]*/gi, replacement: "$1[REDACTED:credential]" },
  { name: "credentialArgument", re: /((?:^|\s)--?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|client[_-]?secret|secret|password|passwd|cookie|oauth[_-]?state|authorization[_-]?code|code[_-]?verifier|h5st|sdtoken)(?:=|\s+))[^\s"']+/gi, replacement: "$1[REDACTED:credential]" },
  { name: "bearerToken", re: /bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, replacement: "Bearer [REDACTED:bearer]" },
  { name: "tunnelCredential", re: /(tunnel[_-]?credential"?\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:tunnelCredential]" },
  { name: "clientSecret", re: /((?:client_secret|client-secret)\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:clientSecret]" },
  { name: "accessOrRefreshField", re: /((?:access[_-]?token|refresh[_-]?token)\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:token]" },
  { name: "cookie", re: /((?:cookie|set-cookie)\s*[:=]\s*"?)([^\r\n"']+)/gi, replacement: "$1[REDACTED:cookie]" },
  { name: "privateKey", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED:privateKey]" },
  // password/secret must come AFTER c2c_* (which contain "secret" prefix)
  { name: "password", re: /((?:password|passwd)\s*[:=]\s*"?)([^&\s"']+)/gi, replacement: "$1[REDACTED:password]" },
  { name: "credentialField", re: /((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|accessToken|refreshToken|idToken|token|api[_-]?key|apiKey|client[_-]?secret|clientSecret|secret|password|passwd|cookie|oauth[_-]?state|oauthState|authorization[_-]?code|authorizationCode|code[_-]?verifier|codeVerifier|h5st|sdtoken)["']?\s*[:=]\s*["']?)(?!\[REDACTED:)[^"'&,\s}\]]+/gi, replacement: "$1[REDACTED:credential]" },
  { name: "longHexBlob", re: /\b[a-fA-F0-9]{48,}\b/g, replacement: "[REDACTED:hexBlob]" },
  { name: "longBase64Url", re: /\b[A-Za-z0-9_-]{40,}\b/g, replacement: "[REDACTED:longToken]" },
];

export function redactString(input: string): string {
  let out = input;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.re, rule.replacement);
  }
  return out;
}

export function redactObject<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const marker = sensitiveFieldMarker(k);
      if (!marker || v === null || v === undefined) {
        out[k] = redactObject(v);
      } else if (typeof v === "string") {
        const redacted = redactString(v);
        out[k] = redacted === v ? marker : redacted;
      } else {
        out[k] = marker;
      }
    }
    return out as unknown as T;
  }
  return value;
}

function sensitiveFieldMarker(key: string): string | null {
  const normalized = key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (normalized.endsWith("accesstoken")) return "[REDACTED:accessToken]";
  if (normalized.endsWith("refreshtoken")) return "[REDACTED:refreshToken]";
  if (normalized.endsWith("clientsecret")) return "[REDACTED:clientSecret]";
  if (normalized.endsWith("password") || normalized.endsWith("passwd")) return "[REDACTED:password]";
  if (normalized.endsWith("cookie")) return "[REDACTED:cookie]";
  if (normalized.endsWith("apikey")) return "[REDACTED:apiKey]";
  if (normalized.endsWith("privatekey")) return "[REDACTED:privateKey]";
  if (normalized.endsWith("h5st")) return "[REDACTED:h5st]";
  if (normalized.endsWith("sdtoken")) return "[REDACTED:sdtoken]";
  if (["oauthstate", "stateparameter", "authorizationcode", "oauthcode", "codeverifier"].includes(normalized)) {
    return "[REDACTED:oauthCredential]";
  }
  if (normalized === "authorization" || normalized.endsWith("authorizationheader")) return "[REDACTED:authorization]";
  if (normalized === "token" || normalized.endsWith("token")) return "[REDACTED:token]";
  if (normalized === "secret" || normalized.endsWith("secret")) return "[REDACTED:secret]";
  if (normalized === "credential" || normalized.endsWith("credentials")) return "[REDACTED:credential]";
  return null;
}

export function redactJson(obj: unknown): string {
  return JSON.stringify(redactObject(obj), null, 2);
}
