import { describe, expect, it } from "vitest";
import { guardReadOnlySql, SqlGuardError } from "./sql-guard.js";

function codeOf(run: () => unknown): string {
  try {
    run();
    return "NO_ERROR";
  } catch (error: unknown) {
    return error instanceof SqlGuardError ? error.code : "OTHER";
  }
}

describe("sql-guard", () => {
  it("允许只读语句并自动补 LIMIT（多取一行判断截断）", () => {
    expect(guardReadOnlySql("SELECT * FROM orders", { maxRows: 100 })).toMatchObject({
      operation: "SELECT",
      tables: ["orders"],
      sql: "SELECT * FROM orders LIMIT 101",
    });
    expect(guardReadOnlySql("SHOW TABLES", { maxRows: 10 }).operation).toBe("SHOW");
    expect(guardReadOnlySql("DESCRIBE orders", { maxRows: 10 }).operation).toBe("DESCRIBE");
    expect(guardReadOnlySql("EXPLAIN SELECT * FROM orders", { maxRows: 10 }).operation).toBe("EXPLAIN");
    expect(guardReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x", { maxRows: 5 }).operation).toBe("SELECT");
  });

  it("收紧已有 LIMIT，保留 OFFSET", () => {
    expect(guardReadOnlySql("SELECT * FROM t LIMIT 1000", { maxRows: 100 }).sql).toBe("SELECT * FROM t LIMIT 101");
    expect(guardReadOnlySql("SELECT * FROM t LIMIT 10, 1000", { maxRows: 100 }).sql).toBe("SELECT * FROM t LIMIT 10, 101");
    expect(guardReadOnlySql("SELECT * FROM t LIMIT 1000 OFFSET 20", { maxRows: 100 }).sql)
      .toBe("SELECT * FROM t LIMIT 101 OFFSET 20");
    expect(guardReadOnlySql("SELECT * FROM t LIMIT 5", { maxRows: 100 }).sql).toBe("SELECT * FROM t LIMIT 5");
  });

  it("拒绝写/DDL/管理语句与多语句", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a=1",
      "DELETE FROM t",
      "DROP TABLE t",
      "CREATE TABLE t (a int)",
      "TRUNCATE t",
      "GRANT SELECT ON *.* TO x",
      "CALL p()",
      "SET @x=1",
      "SELECT * FROM t; DELETE FROM t",
      "SELECT * FROM t INTO OUTFILE '/tmp/x'",
      "SELECT SLEEP(10)",
      "SELECT * FROM t FOR UPDATE",
      "SELECT * FROM mysql.user",
      "LOAD_FILE('/etc/passwd')",
    ]) {
      expect(codeOf(() => guardReadOnlySql(sql, { maxRows: 100 })), sql).not.toBe("NO_ERROR");
    }
  });

  it("拒绝注释、控制字符、超长与非只读首关键字", () => {
    expect(codeOf(() => guardReadOnlySql("SELECT 1 -- comment", { maxRows: 10 }))).toBe("SQL_COMMENT_REJECTED");
    expect(codeOf(() => guardReadOnlySql("SELECT 1 /* x */", { maxRows: 10 }))).toBe("SQL_COMMENT_REJECTED");
    expect(codeOf(() => guardReadOnlySql("SELECT 1 # x", { maxRows: 10 }))).toBe("SQL_COMMENT_REJECTED");
    expect(codeOf(() => guardReadOnlySql("SELECT\u0001 1", { maxRows: 10 }))).toBe("SQL_CONTROL_CHARACTER");
    expect(codeOf(() => guardReadOnlySql("x".repeat(4001), { maxRows: 10 }))).toBe("SQL_LENGTH_INVALID");
    expect(codeOf(() => guardReadOnlySql("EXPLAIN UPDATE t SET a=1", { maxRows: 10 }))).toBe("SQL_NOT_READ_ONLY");
    expect(codeOf(() => guardReadOnlySql("WITH x AS (SELECT 1) UPDATE t SET a=1", { maxRows: 10 }))).not.toBe("NO_ERROR");
  });

  it("表白名单与不可验证的子查询按失败关闭处理", () => {
    expect(codeOf(() => guardReadOnlySql("SELECT * FROM secrets", { maxRows: 10, allowedTables: ["orders"] })))
      .toBe("SQL_TABLE_NOT_ALLOWED");
    expect(codeOf(() => guardReadOnlySql("SELECT * FROM (SELECT 1) x", { maxRows: 10, allowedTables: ["orders"] })))
      .toBe("SQL_TABLE_UNVERIFIABLE");
    const allowed = guardReadOnlySql("SELECT * FROM orders JOIN users ON 1=1", { maxRows: 10, allowedTables: ["orders", "users"] });
    expect(allowed.tables).toEqual(["orders", "users"]);
  });
});
