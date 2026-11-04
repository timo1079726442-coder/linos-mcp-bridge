/**
 * sql-guard — 只读 SQL 的最后一道文本防线。
 *
 * 注意：这不是唯一防线。数据源必须使用**数据库侧只读账号**（仅 SELECT / SHOW VIEW），
 * 本守卫只做纵深防御：拦多语句、注释夹带、写/DDL/管理关键字、系统库与可疑函数，
 * 并强制行数上限。
 */
export type SqlOperation = "SELECT" | "SHOW" | "DESCRIBE" | "EXPLAIN";

export class SqlGuardError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SqlGuardError";
  }
}

export interface GuardedSql {
  sql: string;
  operation: SqlOperation;
  tables: string[];
}

const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
  "GRANT", "REVOKE", "CALL", "EXECUTE", "PREPARE", "DEALLOCATE", "HANDLER",
  "LOCK", "UNLOCK", "LOAD", "OUTFILE", "DUMPFILE", "INTO",
  "SLEEP", "BENCHMARK", "GET_LOCK", "RELEASE_LOCK", "MASTER_POS_WAIT",
  "SET", "USE", "KILL", "SHUTDOWN", "FLUSH", "RESET", "PURGE",
  "CHANGE", "COMMIT", "ROLLBACK", "SAVEPOINT",
  "LOAD_FILE", "FOR UPDATE", "LOCK IN SHARE MODE",
] as const;

const SYSTEM_SCHEMA = /\b(?:mysql|performance_schema|sys)\s*\./i;

export function assertSqlIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_$-]{1,64}$/.test(value)) {
    throw new SqlGuardError(`SQL_${label.toUpperCase()}_INVALID`);
  }
  return value;
}

function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/g, "");
}

function clampLimit(sql: string, maxRows: number): string {
  const match = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$/i.exec(sql);
  if (!match) return `${sql} LIMIT ${maxRows + 1}`;
  const offset = match[2] !== undefined ? Number(match[1])
    : match[3] !== undefined ? Number(match[3]) : null;
  const count = match[2] !== undefined ? Number(match[2])
    : match[3] !== undefined ? Number(match[1]) : Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 0 || (offset !== null && !Number.isSafeInteger(offset))) {
    throw new SqlGuardError("SQL_LIMIT_INVALID");
  }
  if (count <= maxRows) return sql;
  const replacement = offset === null
    ? `LIMIT ${maxRows + 1}`
    : match[3] !== undefined
      ? `LIMIT ${maxRows + 1} OFFSET ${offset}`
      : `LIMIT ${offset}, ${maxRows + 1}`;
  return sql.slice(0, match.index) + replacement;
}

/**
 * 校验并规范化一条只读 SQL。
 * @param input 原始 SQL
 * @param options.maxRows 1..500；SELECT/WITH 会自动补/收紧 LIMIT（多取一行用于判断截断）
 * @param options.allowedTables 可选表白名单（只匹配 FROM/JOIN 后的简单表名）
 */
export function guardReadOnlySql(
  input: unknown,
  options: { maxRows: number; allowedTables?: string[] },
): GuardedSql {
  if (typeof input !== "string") throw new SqlGuardError("SQL_REQUIRED");
  if (!Number.isInteger(options.maxRows) || options.maxRows < 1 || options.maxRows > 500) {
    throw new SqlGuardError("SQL_MAX_ROWS_INVALID");
  }
  if (input.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) {
    throw new SqlGuardError("SQL_CONTROL_CHARACTER");
  }
  const original = input.trim();
  if (original.length < 1 || original.length > 4000) throw new SqlGuardError("SQL_LENGTH_INVALID");

  // 注释一律拒绝：既可能是正常注释，也最常见于夹带语句。
  if (/--|#|\/\*|\*\//.test(original)) throw new SqlGuardError("SQL_COMMENT_REJECTED");

  // 允许且仅允许末尾一个分号，其余分号视为多语句。
  const withoutTrailing = stripTrailingSemicolons(original);
  if (withoutTrailing.includes(";")) throw new SqlGuardError("SQL_MULTI_STATEMENT_REJECTED");
  const sql = withoutTrailing;

  const first = /^([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() ?? "";
  let operation: SqlOperation;
  if (first === "SELECT" || first === "WITH") {
    operation = "SELECT";
    if (first === "WITH" && !/\bSELECT\b/i.test(sql)) throw new SqlGuardError("SQL_NOT_READ_ONLY");
  } else if (first === "SHOW") {
    operation = "SHOW";
  } else if (first === "DESCRIBE" || first === "DESC") {
    operation = "DESCRIBE";
  } else if (first === "EXPLAIN") {
    operation = "EXPLAIN";
    if (!/\b(?:SELECT|WITH)\b/i.test(sql)) throw new SqlGuardError("SQL_NOT_READ_ONLY");
  } else {
    throw new SqlGuardError("SQL_STATEMENT_NOT_ALLOWED");
  }

  for (const keyword of FORBIDDEN) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${keyword.replace(/ /g, "\\s+")}([^A-Za-z0-9_$]|$)`, "i");
    if (pattern.test(sql)) throw new SqlGuardError(`SQL_KEYWORD_REJECTED:${keyword.replace(/ /g, "_")}`);
  }
  if (SYSTEM_SCHEMA.test(sql)) throw new SqlGuardError("SQL_SYSTEM_SCHEMA_REJECTED");

  const tables: string[] = [];
  const tablePattern = /\b(?:FROM|JOIN)\s+(`[^`]+`|[A-Za-z0-9_$.]+)/gi;
  for (let match = tablePattern.exec(sql); match; match = tablePattern.exec(sql)) {
    const raw = match[1]!.replace(/`/g, "");
    const name = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    if (!/^[A-Za-z0-9_$]{1,64}$/.test(name)) throw new SqlGuardError("SQL_TABLE_UNVERIFIABLE");
    tables.push(name);
  }
  if (options.allowedTables && options.allowedTables.length > 0) {
    const allowed = new Set(options.allowedTables.map((table) => table.toLowerCase()));
    if (/\bFROM\s*\(/i.test(sql) || /\bJOIN\s*\(/i.test(sql)) throw new SqlGuardError("SQL_TABLE_UNVERIFIABLE");
    for (const table of tables) {
      if (!allowed.has(table.toLowerCase())) throw new SqlGuardError("SQL_TABLE_NOT_ALLOWED");
    }
  }

  const normalized = operation === "SELECT" ? clampLimit(sql, options.maxRows) : sql;
  return { sql: normalized, operation, tables };
}
