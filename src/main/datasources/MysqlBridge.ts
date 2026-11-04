/**
 * MysqlBridge — 主进程内的只读 MySQL 访问。
 *
 * 为什么放在主进程：密码由 SecretStore（DPAPI）保管，runtime 永远拿不到；
 * runtime 只说"用哪个数据源、执行哪条只读 SQL"，主进程负责连接、守卫、限额、审计。
 *
 * 安全叠加：数据库侧只读账号（最终防线）+ SQL 守卫 + 行数/超时/字节上限 +
 * 每次本机审批（runtime 工具策略）+ 不含正文的审计。
 */
import { createHash } from "node:crypto";
import { DataSourceError, type DataSourceMeta, type DataSourceStore } from "./DataSourceStore.js";
import { guardReadOnlySql, SqlGuardError } from "./sql-guard.js";

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CELL_CHARS = 2_000;

export type MysqlAuditEvent = {
  timestamp: string;
  datasource_id: string;
  operation: string;
  sql_sha256: string | null;
  tables: string[];
  row_count: number;
  elapsed_ms: number;
  outcome: string;
};

export interface MysqlBridgeOptions {
  store: DataSourceStore;
  audit: (event: MysqlAuditEvent) => Promise<void>;
  loadMysql?: () => Promise<{ createConnection(options: Record<string, unknown>): Promise<unknown> }>;
  now?: () => number;
}

interface ConnectionLike {
  query(options: { sql: string; timeout?: number } | string): Promise<[unknown, unknown]>;
  end(): Promise<void> | void;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapMysqlError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case "ER_ACCESS_DENIED_ERROR":
      return "MYSQL_ACCESS_DENIED";
    case "ER_DBACCESS_DENIED_ERROR":
      return "MYSQL_DATABASE_ACCESS_DENIED";
    case "ER_TABLEACCESS_DENIED_ERROR":
      return "MYSQL_TABLE_ACCESS_DENIED";
    case "ER_NO_SUCH_TABLE":
      return "MYSQL_TABLE_NOT_FOUND";
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "EHOSTUNREACH":
      return "MYSQL_UNAVAILABLE";
    case "ETIMEDOUT":
    case "PROTOCOL_SEQUENCE_TIMEOUT":
      return "MYSQL_TIMEOUT";
    default:
      return "MYSQL_QUERY_FAILED";
  }
}

function sanitizeRows(rows: unknown[], maxRows: number): {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  bytes: number;
} {
  const truncated = rows.length > maxRows;
  const limited = rows.slice(0, maxRows);
  const output: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for (const row of limited) {
    const record: Record<string, unknown> = {};
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        if (/^(?:constructor|__proto__|prototype)$/.test(key)) continue;
        let next: unknown;
        if (value === null || value === undefined) next = null;
        else if (typeof value === "number" || typeof value === "boolean") next = value;
        else if (typeof value === "string") next = value.slice(0, MAX_CELL_CHARS);
        else if (value instanceof Date) next = value.toISOString();
        else if (Buffer.isBuffer(value)) next = `[BINARY ${value.byteLength} B]`;
        else next = String(value).slice(0, MAX_CELL_CHARS);
        record[key] = next;
      }
    } else {
      record.value = typeof row === "string" ? row.slice(0, MAX_CELL_CHARS) : String(row);
    }
    const encoded = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (bytes + encoded > MAX_RESPONSE_BYTES) {
      return { rows: output, truncated: true, bytes };
    }
    bytes += encoded;
    output.push(record);
  }
  return { rows: output, truncated, bytes };
}

export class MysqlBridge {
  private readonly now: () => number;
  private readonly loadMysql: () => Promise<{ createConnection(options: Record<string, unknown>): Promise<unknown> }>;

  constructor(private readonly options: MysqlBridgeOptions) {
    this.now = options.now ?? Date.now;
    this.loadMysql = options.loadMysql ?? (async () => {
      const mod = await import("mysql2/promise");
      return mod as unknown as { createConnection(options: Record<string, unknown>): Promise<unknown> };
    });
  }

  private async datasource(id: string): Promise<{ meta: DataSourceMeta; password: string }> {
    const meta = await this.options.store.get(id);
    const password = await this.options.store.getSecret(meta.id);
    return { meta, password };
  }

  private async connect(meta: DataSourceMeta, password: string): Promise<ConnectionLike> {
    const mysql = await this.loadMysql();
    try {
      return await mysql.createConnection({
        host: meta.host,
        port: meta.port,
        user: meta.user,
        password,
        database: meta.database,
        connectTimeout: 5_000,
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        charset: "utf8mb4",
      }) as ConnectionLike;
    } catch (error: unknown) {
      throw new DataSourceError(mapMysqlError(error));
    }
  }

  private async run<T>(meta: DataSourceMeta, password: string, sql: string, timeoutMs: number): Promise<T> {
    try {
      const connection = await this.connect(meta, password);
      try {
        const [rows] = await connection.query({ sql, timeout: timeoutMs });
        return rows as T;
      } finally {
        await Promise.resolve(connection.end()).catch(() => undefined);
      }
    } catch (error: unknown) {
      if (error instanceof DataSourceError) throw error;
      throw new DataSourceError(mapMysqlError(error));
    }
  }

  private async audit(event: Omit<MysqlAuditEvent, "timestamp" | "elapsed_ms"> & { elapsed_ms?: number }): Promise<void> {
    await this.options.audit({
      ...event,
      timestamp: new Date(this.now()).toISOString(),
      elapsed_ms: event.elapsed_ms ?? 0,
    }).catch(() => undefined);
  }

  async test(id: string): Promise<Record<string, unknown>> {
    const { meta, password } = await this.datasource(id);
    const connection = await this.connect(meta, password);
    try {
      const [versionRows] = await connection.query("SELECT VERSION() AS version, CURRENT_USER() AS current_user") as unknown as [
        Array<{ version?: unknown; current_user?: unknown }>,
      ];
      const version = versionRows?.[0]?.version;
      const currentUser = versionRows?.[0]?.current_user;
      let grants: string[] = [];
      try {
        const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()") as unknown as [Array<Record<string, unknown>>];
        grants = (grantRows ?? []).flatMap((row) => Object.values(row).filter((value): value is string => typeof value === "string"));
      } catch {
        grants = [];
      }
      const writePrivileges = grants.filter((grant) =>
        /\b(?:ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT OPTION)\b/i.test(grant));
      return {
        ok: true,
        datasource_id: meta.id,
        server_version: typeof version === "string" ? version : null,
        current_user: typeof currentUser === "string" ? currentUser : null,
        grants,
        write_privileges: writePrivileges,
        read_only_account: writePrivileges.length === 0,
        warnings: writePrivileges.length > 0
          ? ["这个账号带有写权限；只读工具仍会拦截写 SQL，但建议改用仅 SELECT/SHOW VIEW 的账号。"]
          : [],
      };
    } catch (error: unknown) {
      throw new DataSourceError(mapMysqlError(error));
    } finally {
      await Promise.resolve(connection.end()).catch(() => undefined);
      await this.audit({
        datasource_id: meta.id,
        operation: "TEST",
        sql_sha256: null,
        tables: [],
        row_count: 0,
        outcome: "TEST",
      });
    }
  }

  async listSchemas(id: string): Promise<Record<string, unknown>> {
    const { meta, password } = await this.datasource(id);
    const started = this.now();
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await this.run<Array<Record<string, unknown>>>(meta, password, "SHOW DATABASES", meta.options.timeoutMs);
    } catch (error: unknown) {
      await this.audit({
        datasource_id: meta.id, operation: "SHOW_DATABASES", sql_sha256: null, tables: [],
        row_count: 0, elapsed_ms: this.now() - started,
        outcome: error instanceof DataSourceError ? error.code : "MYSQL_QUERY_FAILED",
      });
      throw error;
    }
    const system = new Set(["information_schema", "mysql", "performance_schema", "sys"]);
    const names = rows
      .map((row) => String(Object.values(row)[0] ?? ""))
      .filter((name) => name && !system.has(name));
    await this.audit({
      datasource_id: meta.id, operation: "SHOW_DATABASES", sql_sha256: null, tables: [],
      row_count: names.length, elapsed_ms: this.now() - started, outcome: "OK",
    });
    return { datasource_id: meta.id, schemas: names, count: names.length, system_schemas_excluded: true };
  }

  async describeTable(id: string, table: unknown, database?: unknown): Promise<Record<string, unknown>> {
    const { meta, password } = await this.datasource(id);
    if (typeof table !== "string" || !/^[A-Za-z0-9_$]{1,64}$/.test(table)) {
      throw new DataSourceError("MYSQL_IDENTIFIER_INVALID");
    }
    const databaseName = database === undefined || database === null ? meta.database : database;
    if (typeof databaseName !== "string" || !/^[A-Za-z0-9_$-]{1,64}$/.test(databaseName)) {
      throw new DataSourceError("MYSQL_IDENTIFIER_INVALID");
    }
    const sql = `SHOW FULL COLUMNS FROM \`${table}\` FROM \`${databaseName}\``;
    const started = this.now();
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await this.run<Array<Record<string, unknown>>>(meta, password, sql, meta.options.timeoutMs);
    } catch (error: unknown) {
      await this.audit({
        datasource_id: meta.id, operation: "DESCRIBE", sql_sha256: digest(sql), tables: [table],
        row_count: 0, elapsed_ms: this.now() - started,
        outcome: error instanceof DataSourceError ? error.code : "MYSQL_QUERY_FAILED",
      });
      throw error;
    }
    const columns = rows.map((row) => ({
      field: row.Field ?? null,
      type: row.Type ?? null,
      nullable: String(row.Null ?? "").toUpperCase() === "YES",
      key: row.Key ?? null,
      default: row.Default ?? null,
      extra: row.Extra ?? null,
    }));
    await this.audit({
      datasource_id: meta.id, operation: "DESCRIBE", sql_sha256: digest(sql), tables: [table],
      row_count: columns.length, elapsed_ms: this.now() - started, outcome: "OK",
    });
    return { datasource_id: meta.id, database: databaseName, table, columns, count: columns.length };
  }

  async query(id: string, sqlInput: unknown, requestedMaxRows?: unknown): Promise<Record<string, unknown>> {
    const { meta, password } = await this.datasource(id);
    const maxRows = Math.min(
      meta.options.maxRows,
      typeof requestedMaxRows === "number" && Number.isInteger(requestedMaxRows)
        ? Math.max(1, Math.min(500, requestedMaxRows))
        : meta.options.maxRows,
    );
    let guarded;
    try {
      guarded = guardReadOnlySql(sqlInput, { maxRows, allowedTables: meta.options.allowedTables });
    } catch (error: unknown) {
      if (error instanceof SqlGuardError) throw new DataSourceError(error.code);
      throw new DataSourceError("MYSQL_SQL_GUARD_FAILED");
    }
    const started = this.now();
    let rows: unknown[];
    try {
      rows = await this.run<unknown[]>(meta, password, guarded.sql, meta.options.timeoutMs);
    } catch (error: unknown) {
      await this.audit({
        datasource_id: meta.id, operation: guarded.operation, sql_sha256: digest(guarded.sql),
        tables: guarded.tables, row_count: 0, elapsed_ms: this.now() - started,
        outcome: error instanceof DataSourceError ? error.code : "MYSQL_QUERY_FAILED",
      });
      if (error instanceof DataSourceError) throw error;
      throw new DataSourceError("MYSQL_QUERY_FAILED");
    }
    const safe = sanitizeRows(Array.isArray(rows) ? rows : [], maxRows);
    await this.audit({
      datasource_id: meta.id, operation: guarded.operation, sql_sha256: digest(guarded.sql),
      tables: guarded.tables, row_count: safe.rows.length, elapsed_ms: this.now() - started, outcome: "OK",
    });
    return {
      datasource_id: meta.id,
      operation: guarded.operation,
      tables: guarded.tables,
      columns: safe.rows.length > 0 ? Object.keys(safe.rows[0]!) : [],
      rows: safe.rows,
      row_count: safe.rows.length,
      truncated: safe.truncated,
      bytes: safe.bytes,
      elapsed_ms: this.now() - started,
      sql_sha256: digest(guarded.sql),
      read_only: true,
    };
  }
}
