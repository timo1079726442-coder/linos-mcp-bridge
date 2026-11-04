/**
 * mysql-tools — runtime 侧的只读 MySQL 工具（委托主进程执行）。
 *
 * runtime 不持有数据库凭据：只传数据源 id、工作区 id 与只读 SQL；
 * 主进程用 DPAPI 取密码、连接、执行守卫与限额，并返回脱敏后的行。
 */
import { callControl } from "./control-client.js";

export interface MysqlCallContext {
  /** profile 目录（control.json 在它的上一级）。 */
  profileDir: string;
  workspaceId: string;
}

function base(context: MysqlCallContext): Record<string, unknown> {
  return { workspace_id: context.workspaceId };
}

export async function mysqlListSchemas(context: MysqlCallContext, datasourceId: string): Promise<unknown> {
  return await callControl(context.profileDir, "mysql.list_schemas", {
    ...base(context),
    datasource_id: datasourceId,
  }, 30_000);
}

export async function mysqlDescribeTable(
  context: MysqlCallContext,
  args: { datasource_id: string; table: string; database?: string },
): Promise<unknown> {
  return await callControl(context.profileDir, "mysql.describe_table", {
    ...base(context),
    datasource_id: args.datasource_id,
    table: args.table,
    ...(args.database ? { database: args.database } : {}),
  }, 30_000);
}

export async function mysqlQuery(
  context: MysqlCallContext,
  args: { datasource_id: string; sql: string; max_rows?: number },
): Promise<unknown> {
  return await callControl(context.profileDir, "mysql.query", {
    ...base(context),
    datasource_id: args.datasource_id,
    sql: args.sql,
    ...(args.max_rows === undefined ? {} : { max_rows: args.max_rows }),
  }, 60_000);
}
