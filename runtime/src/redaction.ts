const REDACTION_RULES: Array<{ re: RegExp; replacement: string }> = [
  { re: /c2c_ri_secret_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:runtimeInstanceSecret]" },
  { re: /c2c_admin_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:adminToken]" },
  { re: /c2c_at_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:accessToken]" },
  { re: /c2c_rt_[A-Za-z0-9_-]+/g, replacement: "[REDACTED:refreshToken]" },
  { re: /(authorization\s*[:=]\s*['"]?bearer\s+)[^\s"']+/gi, replacement: "$1[REDACTED:bearer]" },
  { re: /\bbearer\s+([A-Za-z0-9._~+/=-]{16,})/gi, replacement: "Bearer [REDACTED:bearer]" },
  { re: /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|tunnel[_-]?credential|password|passwd|cookie)\s*[:=]\s*['"]?)[^\s"']+/gi, replacement: "$1[REDACTED:secret]" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED:privateKey]" },
  { re: /\b[a-fA-F0-9]{64,}\b/g, replacement: "[REDACTED:hexBlob]" },
  { re: /\b[A-Za-z0-9_-]{48,}\b/g, replacement: "[REDACTED:longToken]" },
];

export function redactString(input: string): string {
  return REDACTION_RULES.reduce((value, rule) => value.replace(rule.re, rule.replacement), input);
}

export function redactObject<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item)) as unknown as T;
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) output[key] = redactObject(child);
    return output as T;
  }
  return value;
}
