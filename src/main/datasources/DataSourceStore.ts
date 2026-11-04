/**
 * DataSourceStore — 每工作区的数据源元数据 + DPAPI 密码。
 *
 * 元数据文件：<profile>/workspaces/<workspaceId>/datasources.json
 * 密码：SecretStore（DPAPI），名称 `ds_<id>`；**永不写进 JSON、日志或返回值**。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type DataSourceKind = "mysql";

export interface DataSourceOptions {
  maxRows: number;
  timeoutMs: number;
  allowedTables?: string[];
}

export interface DataSourceMeta {
  id: string;
  kind: DataSourceKind;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  options: DataSourceOptions;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DataSourceInput {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  host?: unknown;
  port?: unknown;
  database?: unknown;
  user?: unknown;
  password?: unknown;
  options?: unknown;
}

export interface DataSourceSecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export class DataSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DataSourceError";
  }
}

interface Document {
  version: 1;
  workspaceId: string | null;
  datasources: DataSourceMeta[];
}

const ID = /^mysql_[a-f0-9]{12}$/;
const NAME = /^[\p{L}\p{N} _.\-()（）]{1,80}$/u;
const HOST = /^[A-Za-z0-9.-]{1,255}$/;
const IDENTIFIER = /^[A-Za-z0-9_$-]{1,64}$/;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || text.length > max) return null;
  return text;
}

function secretName(id: string): string {
  return `ds_${id}`;
}

export class DataSourceStore {
  private readonly dir: string;
  private readonly file: string;

  constructor(
    private readonly stateRoot: string,
    private readonly profileId: string,
    private readonly workspaceId: string | null,
    private readonly secrets: DataSourceSecretStore,
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(profileId)) throw new DataSourceError("DATASOURCE_PROFILE_INVALID");
    if (workspaceId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
      throw new DataSourceError("DATASOURCE_WORKSPACE_INVALID");
    }
    this.dir = workspaceId
      ? path.join(stateRoot, "profiles", profileId, "workspaces", workspaceId)
      : path.join(stateRoot, "profiles", profileId);
    this.file = path.join(this.dir, "datasources.json");
  }

  private async read(): Promise<Document> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<Document>;
      if (raw.version !== 1 || !Array.isArray(raw.datasources)) throw new Error("bad");
      const datasources = raw.datasources.filter((entry): entry is DataSourceMeta =>
        Boolean(entry) && typeof entry.id === "string" && ID.test(entry.id)
        && typeof entry.name === "string" && typeof entry.host === "string"
        && typeof entry.database === "string" && typeof entry.user === "string");
      return { version: 1, workspaceId: this.workspaceId, datasources };
    } catch {
      return { version: 1, workspaceId: this.workspaceId, datasources: [] };
    }
  }

  private async write(document: Document): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(document, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  async list(): Promise<DataSourceMeta[]> {
    return (await this.read()).datasources;
  }

  async get(id: unknown): Promise<DataSourceMeta> {
    if (typeof id !== "string" || !ID.test(id)) throw new DataSourceError("DATASOURCE_ID_INVALID");
    const found = (await this.read()).datasources.find((entry) => entry.id === id);
    if (!found) throw new DataSourceError("DATASOURCE_NOT_FOUND");
    return found;
  }

  async getSecret(id: string): Promise<string> {
    const value = await this.secrets.get(secretName(id));
    if (!value) throw new DataSourceError("DATASOURCE_SECRET_UNAVAILABLE");
    return value;
  }

  async save(input: DataSourceInput): Promise<DataSourceMeta> {
    const name = cleanText(input.name, 80);
    if (!name || !NAME.test(name)) throw new DataSourceError("DATASOURCE_NAME_INVALID");
    const host = cleanText(input.host, 255);
    if (!host || !HOST.test(host)) throw new DataSourceError("DATASOURCE_HOST_INVALID");
    const port = input.port === undefined ? 3306 : input.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DataSourceError("DATASOURCE_PORT_INVALID");
    }
    const database = cleanText(input.database, 64);
    if (!database || !IDENTIFIER.test(database)) throw new DataSourceError("DATASOURCE_DATABASE_INVALID");
    const user = cleanText(input.user, 64);
    if (!user || !IDENTIFIER.test(user)) throw new DataSourceError("DATASOURCE_USER_INVALID");

    const rawOptions = (input.options ?? {}) as Record<string, unknown>;
    const maxRows = rawOptions.maxRows === undefined ? 100 : rawOptions.maxRows;
    if (typeof maxRows !== "number" || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) {
      throw new DataSourceError("DATASOURCE_MAX_ROWS_INVALID");
    }
    const timeoutMs = rawOptions.timeoutMs === undefined ? 10_000 : rawOptions.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new DataSourceError("DATASOURCE_TIMEOUT_INVALID");
    }
    let allowedTables: string[] | undefined;
    if (rawOptions.allowedTables !== undefined) {
      if (!Array.isArray(rawOptions.allowedTables) || rawOptions.allowedTables.length > 50
        || rawOptions.allowedTables.some((table) => typeof table !== "string" || !/^[A-Za-z0-9_$]{1,64}$/.test(table))) {
        throw new DataSourceError("DATASOURCE_ALLOWED_TABLES_INVALID");
      }
      allowedTables = [...new Set(rawOptions.allowedTables as string[])];
    }

    const document = await this.read();
    const requestedId = input.id === undefined ? null : input.id;
    if (requestedId !== null && (typeof requestedId !== "string" || !ID.test(requestedId))) {
      throw new DataSourceError("DATASOURCE_ID_INVALID");
    }
    const existing = requestedId === null
      ? undefined
      : document.datasources.find((entry) => entry.id === requestedId);
    if (requestedId !== null && !existing) throw new DataSourceError("DATASOURCE_NOT_FOUND");

    const password = typeof input.password === "string" ? input.password : "";
    if (password.length > 512 || (password.length > 0 && password.length < 8)) {
      throw new DataSourceError("DATASOURCE_PASSWORD_INVALID");
    }
    if (!existing && password.length === 0) throw new DataSourceError("DATASOURCE_PASSWORD_REQUIRED");

    const id = existing?.id ?? `mysql_${randomBytes(6).toString("hex")}`;
    if (password.length > 0) {
      try {
        await this.secrets.set(secretName(id), password);
      } catch {
        throw new DataSourceError("DATASOURCE_SECRET_WRITE_FAILED");
      }
    }
    const storedSecret = password.length > 0 ? password : await this.secrets.get(secretName(id)).catch(() => null);

    const now = new Date().toISOString();
    const meta: DataSourceMeta = {
      id,
      kind: "mysql",
      name,
      host,
      port,
      database,
      user,
      options: { maxRows, timeoutMs, ...(allowedTables ? { allowedTables } : {}) },
      hasSecret: storedSecret !== null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? document.datasources.map((entry) => (entry.id === id ? meta : entry))
      : [...document.datasources, meta];
    await this.write({ version: 1, workspaceId: this.workspaceId, datasources: next });
    return meta;
  }

  async remove(id: unknown): Promise<{ ok: true; id: string }> {
    if (typeof id !== "string" || !ID.test(id)) throw new DataSourceError("DATASOURCE_ID_INVALID");
    const document = await this.read();
    if (!document.datasources.some((entry) => entry.id === id)) throw new DataSourceError("DATASOURCE_NOT_FOUND");
    await this.write({
      version: 1,
      workspaceId: this.workspaceId,
      datasources: document.datasources.filter((entry) => entry.id !== id),
    });
    await this.secrets.delete(secretName(id));
    return { ok: true, id };
  }
}
