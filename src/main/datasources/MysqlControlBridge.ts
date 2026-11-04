/**
 * MysqlControlBridge — 把只读 MySQL 能力注册到主进程控制端点。
 *
 * 调用方是 runtime（无凭据）；这里负责：
 * - 确认请求来自当前活跃 Profile/工作区（防跨工作区读取）；
 * - 用 DPAPI 取出只读账号密码；
 * - 连接、SQL 守卫、行数/超时/字节上限；
 * - 写不含 SQL 正文的数据源审计。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ControlHandler } from "../control/ControlServer.js";
import { readActiveProfileContext } from "../control/LocalApprovalBridge.js";
import { SecretStore } from "../security/SecretStore.js";
import { DataSourceStore } from "./DataSourceStore.js";
import { MysqlBridge, type MysqlAuditEvent } from "./MysqlBridge.js";

const MAX_AUDIT_BYTES = 512 * 1024;
const MAX_SQL_LENGTH = 4_000;

export interface MysqlControlOptions {
  stateRoot: string;
  /** 测试注入 */
  createBridge?: (context: {
    profileId: string;
    workspaceId: string;
    stateRoot: string;
  }) => Pick<MysqlBridge, "test" | "listSchemas" | "describeTable" | "query">;
}

function datasourceId(value: unknown): string {
  if (typeof value !== "string" || !/^mysql_[a-f0-9]{12}$/.test(value)) {
    throw new Error("DATASOURCE_ID_INVALID");
  }
  return value;
}

function workspaceIdOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("WORKSPACE_ID_INVALID");
  return value;
}

async function appendAudit(stateRoot: string, profileId: string, event: MysqlAuditEvent): Promise<void> {
  const file = path.join(stateRoot, "profiles", profileId, "datasource-audit.jsonl");
  try {
    const current = await fs.stat(file).catch(() => null);
    if (current && current.size > MAX_AUDIT_BYTES) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* 审计失败不影响查询结果，但不会声称已审计 */
  }
}

/** 供 IPC（控制中心自己的"测试连接"）复用同一份审计格式。 */
export async function appendDatasourceAudit(stateRoot: string, profileId: string, event: MysqlAuditEvent): Promise<void> {
  await appendAudit(stateRoot, profileId, event);
}

export function createMysqlControlHandlers(options: MysqlControlOptions): Record<string, ControlHandler> {
  const bridgeFor = async (requestedWorkspace: unknown): Promise<{
    profileId: string;
    workspaceId: string;
    bridge: Pick<MysqlBridge, "test" | "listSchemas" | "describeTable" | "query">;
  }> => {
    const context = await readActiveProfileContext(options.stateRoot);
    const requested = workspaceIdOf(requestedWorkspace);
    if (requested !== null && requested !== context.workspaceId) {
      throw new Error("DATASOURCE_WORKSPACE_MISMATCH");
    }
    if (options.createBridge) {
      return {
        profileId: context.profileId,
        workspaceId: context.workspaceId,
        bridge: options.createBridge({
          profileId: context.profileId,
          workspaceId: context.workspaceId,
          stateRoot: options.stateRoot,
        }),
      };
    }
    const store = new DataSourceStore(
      options.stateRoot,
      context.profileId,
      context.workspaceId,
      new SecretStore(options.stateRoot, context.profileId),
    );
    const bridge = new MysqlBridge({
      store,
      audit: (event) => appendAudit(options.stateRoot, context.profileId, event),
    });
    return { profileId: context.profileId, workspaceId: context.workspaceId, bridge };
  };

  return {
    "mysql.test": async (params) => {
      const { bridge } = await bridgeFor(params.workspace_id);
      return await bridge.test(datasourceId(params.datasource_id));
    },
    "mysql.list_schemas": async (params) => {
      const { bridge } = await bridgeFor(params.workspace_id);
      return await bridge.listSchemas(datasourceId(params.datasource_id));
    },
    "mysql.describe_table": async (params) => {
      const { bridge } = await bridgeFor(params.workspace_id);
      const table = params.table;
      if (typeof table !== "string" || table.length > 64) throw new Error("MYSQL_IDENTIFIER_INVALID");
      return await bridge.describeTable(datasourceId(params.datasource_id), table, params.database);
    },
    "mysql.query": async (params) => {
      const { bridge } = await bridgeFor(params.workspace_id);
      const sql = params.sql;
      if (typeof sql !== "string" || sql.length > MAX_SQL_LENGTH) throw new Error("SQL_LENGTH_INVALID");
      return await bridge.query(datasourceId(params.datasource_id), sql, params.max_rows);
    },
  };
}
