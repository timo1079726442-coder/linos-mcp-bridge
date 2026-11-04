import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorRpcKeyStore } from "./SupervisorRpcKeyStore.js";
import type { SecretHealth } from "../security/SecretStore.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function fakeSecretStore(stateRoot: string, options: { backend?: SecretHealth["backend"]; productionSafe?: boolean; missingRead?: boolean } = {}) {
  const values = new Map<string, string>();
  const filePath = join(stateRoot, "profiles", "c2c_v2_control", "secrets", "supervisor_rpc_root_key.enc");
  return {
    values,
    filePath,
    health: async (): Promise<SecretHealth> => ({ dpapiOk: true, backend: options.backend ?? "dpapi", productionSafe: options.productionSafe ?? true }),
    get: async (name: string) => options.missingRead ? null : values.get(name) ?? null,
    set: async (name: string, value: string) => {
      values.set(name, value);
      await fs.mkdir(join(stateRoot, "profiles", "c2c_v2_control", "secrets"), { recursive: true });
      await fs.writeFile(filePath, "protected:" + Buffer.from(value).toString("hex"), "utf8");
    },
  };
}

describe("SupervisorRpcKeyStore", () => {
  it("creates and reuses a 32-byte key through the DPAPI-only storage contract", async () => {
    const stateRoot = await fs.mkdtemp(join(tmpdir(), "c2c-rpc-key-"));
    roots.push(stateRoot);
    const secrets = fakeSecretStore(stateRoot);
    const store = new SupervisorRpcKeyStore(stateRoot, secrets);
    const first = await store.getOrCreate();
    const second = await store.getOrCreate();
    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    const storedBytes = await fs.readFile(secrets.filePath, "utf8");
    expect(storedBytes).not.toContain(first.toString("base64url"));
    expect(storedBytes).not.toContain(first.toString("hex"));
  });

  it("fails closed when DPAPI is unavailable or an existing protected key cannot be read", async () => {
    const stateRoot = await fs.mkdtemp(join(tmpdir(), "c2c-rpc-key-"));
    roots.push(stateRoot);
    const insecure = new SupervisorRpcKeyStore(stateRoot, fakeSecretStore(stateRoot, { backend: "aes-gcm-fallback", productionSafe: false }));
    await expect(insecure.getOrCreate()).rejects.toThrow("SUPERVISOR_RPC_DPAPI_REQUIRED");

    const missing = new SupervisorRpcKeyStore(stateRoot, fakeSecretStore(stateRoot, { missingRead: true }));
    await expect(missing.getOrCreate()).rejects.toThrow("SUPERVISOR_RPC_KEY_PERSISTENCE_FAILED");
  });

  it("does not replace an existing unreadable protected key", async () => {
    const stateRoot = await fs.mkdtemp(join(tmpdir(), "c2c-rpc-key-"));
    roots.push(stateRoot);
    const secrets = fakeSecretStore(stateRoot);
    await secrets.set("supervisor_rpc_root_key", "invalid");
    secrets.values.clear();
    const store = new SupervisorRpcKeyStore(stateRoot, secrets);
    await expect(store.getOrCreate()).rejects.toThrow("SUPERVISOR_RPC_KEY_UNAVAILABLE");
  });
});
