/**
 * Secret intake for V2 Runtime.
 *
 * Per CP1 SECURITY_MODEL_V2 §4 + the P0 production rule (SECRET_INJECTION
 * = STDIN_PIPE_ONLY), the runtimeInstanceSecret MUST arrive via stdin pipe.
 * The env-var fallback is DISABLED by default in production builds; tests
 * may opt in via MCP_BRIDGE_ALLOW_ENV_SECRET=1.
 *
 * The secret is read once, immediately stripped from process.env if present,
 * and held only in process memory for the lifetime of the process.
 */

export const STDIN_SECRET_PREFIX = "c2c_ri_secret_";
const ALLOW_ENV_SECRET = "MCP_BRIDGE_ALLOW_ENV_SECRET";

let cachedSecret: Buffer | null = null;

export async function readSecretFromStdin(): Promise<Buffer | null> {
  if (cachedSecret) return cachedSecret;
  if (process.stdin.isTTY) {
    // No stdin pipe attached. Either explicit test mode or broken Supervisor.
    return null;
  }
  // Attach data listener SYNCHRONOUSLY before returning the promise to avoid
  // race: if Supervisor writes the secret before the listener attaches, the
  // data event would be lost.
  let buf = "";
  let settled = false;
  return new Promise<Buffer | null>((resolve) => {
    const finish = (val: Buffer | null): void => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      resolve(val);
    };
    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buf.indexOf("\n");
      if (newline >= 0) {
        const line = buf.slice(0, newline).trim();
        finish(decodeSecret(line));
      }
    };
    const onEnd = (): void => {
      finish(decodeSecret(buf.trim()));
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    // Resume stdin to ensure data flows.
    if (typeof process.stdin.resume === "function") process.stdin.resume();
    // Hard timeout: do not block forever if Supervisor forgets to send.
    setTimeout(() => finish(cachedSecret), 5000);
  });
}

export function tryReadSecretFromEnv(): Buffer | null {
  if (process.env[ALLOW_ENV_SECRET] !== "1") return null;
  const raw = process.env.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET;
  if (!raw) return null;
  const decoded = decodeSecret(raw);
  if (decoded) {
    // Immediately strip from env so it never propagates.
    delete process.env.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET;
  }
  return decoded;
}

function decodeSecret(line: string): Buffer | null {
  if (!line.startsWith(STDIN_SECRET_PREFIX)) return null;
  try {
    const b64 = line.slice(STDIN_SECRET_PREFIX.length);
    return Buffer.from(b64, "base64url");
  } catch {
    return null;
  }
}

export function setSecret(secret: Buffer): void {
  cachedSecret = secret;
}

export function clearSecret(): void {
  cachedSecret = null;
}