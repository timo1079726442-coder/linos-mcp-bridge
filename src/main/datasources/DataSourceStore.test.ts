import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DataSourceStore, type DataSourceSecretStore } from "./DataSourceStore.js";

class FakeSecrets implements DataSourceSecretStore {
  readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

let stateRoot: string;
let secrets: FakeSecrets;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-ds-"));
  secrets = new FakeSecrets();
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

function store(workspaceId: string | null = "0123456789ab"): DataSourceStore {
  return new DataSourceStore(stateRoot, "mb_pf_test", workspaceId, secrets);
}

const validInput = {
  name: "本地 MySQL（只读）",
  kind: "mysql",
  host: "127.0.0.1",
  port: 3306,
  database: "shop",
  user: "linos_ro",
  password: "a-strong-password",
  options: { maxRows: 100, timeoutMs: 10_000 },
};

describe("DataSourceStore", () => {
  it("保存新数据源：密码只进 SecretStore，JSON 不回显", async () => {
    const meta = await store().save(validInput);
    expect(meta.id).toMatch(/^mysql_[a-f0-9]{12}$/);
    expect(meta.hasSecret).toBe(true);
    expect(secrets.values.get(`ds_${meta.id}`)).toBe("a-strong-password");

    const file = path.join(stateRoot, "profiles", "mb_pf_test", "workspaces", "0123456789ab", "datasources.json");
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("a-strong-password");
    expect(JSON.parse(raw).datasources[0].host).toBe("127.0.0.1");

    const list = await store().list();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("a-strong-password");
  });

  it("更新已有数据源时留空密码会保留原密码", async () => {
    const created = await store().save(validInput);
    const updated = await store().save({
      ...validInput,
      id: created.id,
      name: "改名后的库",
      password: "",
      options: { maxRows: 50, timeoutMs: 5_000, allowedTables: ["orders", "users"] },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe("改名后的库");
    expect(updated.hasSecret).toBe(true);
    expect(secrets.values.get(`ds_${created.id}`)).toBe("a-strong-password");
    expect(updated.options.allowedTables).toEqual(["orders", "users"]);
  });

  it("校验主机/端口/库名/用户/行数/超时/白名单", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...validInput, host: "http://127.0.0.1" }, "DATASOURCE_HOST_INVALID"],
      [{ ...validInput, port: 0 }, "DATASOURCE_PORT_INVALID"],
      [{ ...validInput, port: 70000 }, "DATASOURCE_PORT_INVALID"],
      [{ ...validInput, database: "../x" }, "DATASOURCE_DATABASE_INVALID"],
      [{ ...validInput, user: "bad user" }, "DATASOURCE_USER_INVALID"],
      [{ ...validInput, password: "" }, "DATASOURCE_PASSWORD_REQUIRED"],
      [{ ...validInput, password: "short" }, "DATASOURCE_PASSWORD_INVALID"],
      [{ ...validInput, options: { maxRows: 0, timeoutMs: 10_000 } }, "DATASOURCE_MAX_ROWS_INVALID"],
      [{ ...validInput, options: { maxRows: 10, timeoutMs: 500 } }, "DATASOURCE_TIMEOUT_INVALID"],
      [{ ...validInput, options: { maxRows: 10, timeoutMs: 10_000, allowedTables: ["bad table"] } }, "DATASOURCE_ALLOWED_TABLES_INVALID"],
      [{ ...validInput, id: "mysql_000000000000" }, "DATASOURCE_NOT_FOUND"],
    ];
    for (const [input, code] of cases) {
      await expect(store().save(input)).rejects.toThrow(code);
    }
  });

  it("按工作区隔离，删除时同时清理密码", async () => {
    const a = await store("0123456789ab").save(validInput);
    const b = await store("aabbccddeeff").list();
    expect(b).toHaveLength(0);

    await store("0123456789ab").remove(a.id);
    expect(await store("0123456789ab").list()).toHaveLength(0);
    expect(secrets.values.has(`ds_${a.id}`)).toBe(false);
  });

  it("没有工作区时写入 Profile 级文件（兼容旧结构）", async () => {
    const meta = await store(null).save(validInput);
    const profileFile = path.join(stateRoot, "profiles", "mb_pf_test", "datasources.json");
    expect(await readFile(profileFile, "utf8")).toContain(meta.id);
  });
});
