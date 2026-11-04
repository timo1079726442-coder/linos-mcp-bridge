import { beforeEach, describe, expect, it } from "vitest";
import { DataSourceStore, type DataSourceMeta } from "./DataSourceStore.js";
import { MysqlBridge, type MysqlAuditEvent } from "./MysqlBridge.js";

const META: DataSourceMeta = {
  id: "mysql_0123456789ab",
  kind: "mysql",
  name: "本地只读",
  host: "127.0.0.1",
  port: 3306,
  database: "shop",
  user: "linos_ro",
  options: { maxRows: 2, timeoutMs: 1_000 },
  hasSecret: true,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

let calls: string[];
let rows: unknown[];
let grants: string[];
let throwOnQuery: { code: string } | null;

function bridge(audits: MysqlAuditEvent[] = []): MysqlBridge {
  const store = {
    get: async (): Promise<DataSourceMeta> => META,
    getSecret: async (): Promise<string> => "pw",
  } as unknown as DataSourceStore;
  const fakeMysql = {
    createConnection: async () => ({
      query: async (query: { sql: string } | string) => {
        const sql = typeof query === "string" ? query : query.sql;
        calls.push(sql);
        if (throwOnQuery) throw throwOnQuery;
        if (sql.startsWith("SELECT VERSION()")) {
          return [[{ version: "8.0.36", current_user: "linos_ro@localhost" }], []];
        }
        if (sql.startsWith("SHOW GRANTS")) {
          return [grants.map((grant) => ({ Grants: grant })), []];
        }
        return [rows, []];
      },
      end: async () => undefined,
    }),
  };
  return new MysqlBridge({
    store,
    audit: async (event) => {
      audits.push(event);
    },
    loadMysql: async () => fakeMysql,
    now: () => Date.parse("2026-10-20T00:00:00.000Z"),
  });
}

beforeEach(() => {
  calls = [];
  rows = [];
  grants = ["GRANT SELECT, SHOW VIEW ON `shop`.* TO `linos_ro`@`localhost`"];
  throwOnQuery = null;
});

describe("MysqlBridge", () => {
  it("只读查询：补 LIMIT、截断行数、审计不含 SQL 正文", async () => {
    rows = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, name: `row-${index}` }));
    const audits: MysqlAuditEvent[] = [];
    const result = await bridge(audits).query(META.id, "SELECT * FROM orders", 10);
    expect(calls).toEqual(["SELECT * FROM orders LIMIT 3"]);
    expect(result.row_count).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.read_only).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("SELECT * FROM");
    expect(audits[0]!.operation).toBe("SELECT");
    expect(audits[0]!.row_count).toBe(2);
  });

  it("写 SQL 在连库前就被拒绝", async () => {
    const audits: MysqlAuditEvent[] = [];
    await expect(bridge(audits).query(META.id, "DELETE FROM orders"))
      .rejects.toThrow(/SQL_STATEMENT_NOT_ALLOWED|SQL_KEYWORD_REJECTED/);
    expect(calls).toHaveLength(0);
  });

  it("数据库拒绝时映射为稳定错误码并留审计", async () => {
    throwOnQuery = { code: "ER_ACCESS_DENIED_ERROR" };
    const audits: MysqlAuditEvent[] = [];
    await expect(bridge(audits).query(META.id, "SELECT * FROM orders")).rejects.toThrow(/MYSQL_ACCESS_DENIED/);
    expect(audits[0]!.outcome).toBe("MYSQL_ACCESS_DENIED");
  });

  it("测试连接会核对写权限，只读账号返回 read_only_account=true", async () => {
    const result = await bridge().test(META.id);
    expect(result.server_version).toBe("8.0.36");
    expect(result.current_user).toBe("linos_ro@localhost");
    expect(result.read_only_account).toBe(true);
    expect(result.write_privileges).toEqual([]);

    grants = ["GRANT ALL PRIVILEGES ON `shop`.* TO `linos_ro`@`localhost`"];
    const unsafe = await bridge().test(META.id);
    expect(unsafe.read_only_account).toBe(false);
    expect((unsafe.write_privileges as string[]).length).toBe(1);
  });

  it("列出数据库时排除系统库", async () => {
    rows = [{ Database: "shop" }, { Database: "mysql" }, { Database: "information_schema" }, { Database: "analytics" }];
    const result = await bridge().listSchemas(META.id);
    expect(result.schemas).toEqual(["shop", "analytics"]);
    expect(result.count).toBe(2);
  });

  it("表结构只允许合法标识符并返回列信息", async () => {
    rows = [{ Field: "id", Type: "int", Null: "NO", Key: "PRI", Default: null, Extra: "auto_increment" }];
    const result = await bridge().describeTable(META.id, "orders");
    expect(calls[0]).toBe("SHOW FULL COLUMNS FROM `orders` FROM `shop`");
    expect(result.columns).toEqual([
      { field: "id", type: "int", nullable: false, key: "PRI", default: null, extra: "auto_increment" },
    ]);
    await expect(bridge().describeTable(META.id, "orders; DROP TABLE x")).rejects.toThrow(/MYSQL_IDENTIFIER_INVALID/);
  });
});
