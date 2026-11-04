import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SecretStore } from "../security/SecretStore.js";

const CONTROL_SCOPE = "c2c_v2_control";
const SECRET_NAME = "supervisor_rpc_root_key";
const KEY_BYTES = 32;

type ProtectedSecretStore = Pick<SecretStore, "get" | "set" | "health">;

/**
 * Loads one V2-only Supervisor RPC root key from the existing DPAPI-backed
 * SecretStore. The raw key exists only in Main/Supervisor memory and is sent
 * to a newly spawned Supervisor over inherited stdin.
 */
export class SupervisorRpcKeyStore {
  private pending: Promise<Buffer> | null = null;

  constructor(
    private readonly stateRoot: string,
    private readonly secrets: ProtectedSecretStore,
  ) {}

  getOrCreate(): Promise<Buffer> {
    if (!this.pending) this.pending = this.loadOrCreate();
    return this.pending.then((key) => Buffer.from(key));
  }

  private async loadOrCreate(): Promise<Buffer> {
    const health = await this.secrets.health();
    if (health.backend !== "dpapi" || health.productionSafe !== true) {
      throw new Error("SUPERVISOR_RPC_DPAPI_REQUIRED");
    }

    const filePath = path.join(this.stateRoot, "profiles", CONTROL_SCOPE, "secrets", SECRET_NAME + ".enc");
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("SUPERVISOR_RPC_KEY_STORAGE_UNAVAILABLE");
      }
    }

    if (exists) {
      const key = decodeKey(await this.secrets.get(SECRET_NAME));
      if (!key) throw new Error("SUPERVISOR_RPC_KEY_UNAVAILABLE");
      return key;
    }

    const key = randomBytes(KEY_BYTES);
    await this.secrets.set(SECRET_NAME, key.toString("base64url"));
    const persisted = decodeKey(await this.secrets.get(SECRET_NAME));
    if (!persisted || !timingSafeEqual(key, persisted)) {
      throw new Error("SUPERVISOR_RPC_KEY_PERSISTENCE_FAILED");
    }
    return key;
  }
}

function decodeKey(value: string | null): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const key = Buffer.from(value, "base64url");
  return key.length === KEY_BYTES ? key : null;
}
