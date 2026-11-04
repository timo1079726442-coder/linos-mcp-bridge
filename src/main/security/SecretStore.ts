import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * SecretStore — encryption-at-rest for OAuth tokens, Transport Credentials,
 * and other long-lived secrets.
 *
 * Per CP1 SECURITY_MODEL_V2 §6 + CP9 + FOUNDER security audit (P0-4, P0-5):
 *   - runtimeInstanceSecret is NOT persisted here (only in memory)
 *   - deviceId is NOT a secret (identifier only)
 *   - Windows Production: DPAPI ONLY. Secret NEVER appears in argv or env.
 *     The DPAPI helper script reads plaintext from STDIN.
 *   - AES fallback: DEV/TEST ONLY, controlled by C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK=1.
 *     Production (default) without DPAPI → FAIL CLOSED, not AES fallback.
 *
 * Per-block format (AES mode): v1 | aes | SALT(16) | IV(12) | TAG(16) | CIPHERTEXT
 * Storage extension: `.enc`
 *
 * Honest health: `backend: "dpapi" | "aes-gcm-fallback" | "none"`. Reports
 * `productionSafe: boolean` indicating whether secrets are safe to store.
 */
export interface SecretHealth {
  dpapiOk: boolean;
  backend: "dpapi" | "aes-gcm-fallback" | "none";
  productionSafe: boolean;
  error?: string;
}

export class SecretStore {
  constructor(
    private readonly stateRoot: string,
    private readonly profileId: string,
  ) {}

  private dir(): string {
    return path.join(this.stateRoot, "profiles", this.profileId, "secrets");
  }

  private pathFor(name: string): string {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
      throw new Error(`bad_secret_name: ${name}`);
    }
    return path.join(this.dir(), `${name}.enc`);
  }

  async set(name: string, plaintext: string): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    const backend = await this.detectBackend();
    const payload = await this.encrypt(plaintext, backend);
    const tmp = `${this.pathFor(name)}.tmp`;
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.pathFor(name));
  }

  async get(name: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.pathFor(name), "utf8");
      const backend = await this.detectBackend();
      const decrypted = await this.decrypt(raw, backend);
      return decrypted.replace(/\r?\n$/, "").trimEnd();
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(name));
    } catch {
      // ignore missing
    }
  }

  async rotate(name: string, newPlaintext: string): Promise<void> {
    await this.set(name, newPlaintext);
  }

  async health(): Promise<SecretHealth> {
    if (process.platform !== "win32") {
      return {
        dpapiOk: false,
        backend: "none",
        productionSafe: false,
        error: "secret_store_unsupported_on_this_platform",
      };
    }
    const allowWeak = process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK === "1";
    if (await this.tryDpapi()) {
      return { dpapiOk: true, backend: "dpapi", productionSafe: true };
    }
    if (allowWeak) {
      return { dpapiOk: false, backend: "aes-gcm-fallback", productionSafe: false };
    }
    return {
      dpapiOk: false,
      backend: "none",
      productionSafe: false,
      error: "dpapi_unavailable_and_weak_fallback_disabled_in_production",
    };
  }

  private async detectBackend(): Promise<"dpapi" | "aes-gcm-fallback"> {
    if (process.platform !== "win32") {
      throw new Error("SecretStore Windows-only in production");
    }
    if (await this.tryDpapi()) return "dpapi";
    if (process.env.C2C_SECRET_STORE_ALLOW_WEAK_FALLBACK === "1") return "aes-gcm-fallback";
    throw new Error(
      "SecretStore Production: DPAPI unavailable + WEAK_FALLBACK disabled. " +
        "Refusing to write secret in plaintext.",
    );
  }

  private async tryDpapi(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      const r = await this.dpapiHelperRoundtrip("");
      return r !== null;
    } catch {
      return false;
    }
  }

  /**
   * DPAPI round-trip via PowerShell. Secret is written to STDIN by Node, the
   * PS1 script reads from stdin and emits base64 on stdout. NO secret on argv.
   *
   * C2C_SECRET_STORE_DPAPI_SCRIPT may override the script path (used in tests).
   */
  private async dpapiHelperRoundtrip(plaintext: string): Promise<string | null> {
    const scriptPath =
      process.env.C2C_SECRET_STORE_DPAPI_SCRIPT ??
      path.join(process.cwd(), "scripts", "dpapi-helper.ps1");
    return new Promise<string | null>((resolve, reject) => {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.stdin.write(plaintext);
      proc.stdin.end();
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("dpapi_helper_timeout"));
      }, 5000);
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve(null);
          return;
        }
        const out = stdout.trim();
        resolve(out.length > 0 ? out : null);
      });
      proc.on("error", () => resolve(null));
    });
  }

  private async encrypt(plaintext: string, backend: "dpapi" | "aes-gcm-fallback"): Promise<string> {
    if (backend === "dpapi") {
      return await this.dpapiEncrypt(plaintext);
    }
    return this.aesEncrypt(plaintext);
  }

  private async decrypt(payload: string, backend: "dpapi" | "aes-gcm-fallback"): Promise<string> {
    if (backend === "dpapi") {
      return await this.dpapiDecrypt(payload);
    }
    return this.aesDecrypt(payload);
  }

  private async dpapiEncrypt(plaintext: string): Promise<string> {
    const cipherB64 = await this.dpapiHelperRoundtrip(plaintext);
    if (!cipherB64) throw new Error("dpapi_encrypt_failed");
    return `v1:dpapi:${cipherB64}`;
  }

  private async dpapiDecrypt(payload: string): Promise<string> {
    const m = /^v1:dpapi:(.+)$/.exec(payload);
    if (!m) throw new Error("bad_dpapi_payload");
    const decrypted = await this.dpapiHelperRoundtrip(`!DECRYPT:${m[1]}`);
    if (!decrypted) throw new Error("dpapi_decrypt_failed");
    return decrypted;
  }

  // ===== AES-256-GCM DEV-ONLY fallback (NEVER for production secrets) =====
  private machineKey(): Buffer {
    const material = `${osHostname()}|${osUsername()}|c2c-v2-dev-only`;
    return createHash("sha256").update(material).digest();
  }

  private aesEncrypt(plaintext: string): string {
    const key = this.machineKey();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:aes-dev:${salt.toString("base64")}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  private aesDecrypt(payload: string): string {
    const m = /^v1:aes-dev:([^:]+):([^:]+):([^:]+):(.+)$/.exec(payload);
    if (!m) throw new Error("bad_aes_payload");
    const [, saltB64, ivB64, tagB64, ctB64] = m;
    const key = this.machineKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64!, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64!, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  }
}

function osHostname(): string {
  try {
    return require("node:os").hostname();
  } catch {
    return "unknown";
  }
}

function osUsername(): string {
  try {
    return require("node:os").userInfo().username;
  } catch {
    return "unknown";
  }
}