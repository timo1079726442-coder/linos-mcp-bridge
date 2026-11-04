import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { redactObject, redactString } from "./redaction.js";

export type ExecutionStatus = "PASS" | "FAIL" | "UNKNOWN";

export class ExecutionStoreUnavailableError extends Error {
  constructor() {
    super("execution_store_unavailable");
    this.name = "ExecutionStoreUnavailableError";
  }
}

export interface ExecutionRecord {
  id: string;
  taskId: string;
  iteration: number;
  timestamp: string;
  changedFiles: string[];
  tests: Array<{ category: string; command?: string; passed: boolean; testCount?: number; failedCount?: number }>;
  status: ExecutionStatus;
  summary: string;
  publicOutput: boolean;
  allowedOutput?: string;
}

function isRecord(value: unknown): value is ExecutionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.taskId === "string"
    && typeof record.iteration === "number"
    && typeof record.timestamp === "string"
    && Array.isArray(record.changedFiles) && record.changedFiles.every((item) => typeof item === "string")
    && Array.isArray(record.tests)
    && (record.status === "PASS" || record.status === "FAIL" || record.status === "UNKNOWN")
    && typeof record.summary === "string"
    && typeof record.publicOutput === "boolean";
}

function safeRecord(record: ExecutionRecord): ExecutionRecord {
  return redactObject({
    ...record,
    changedFiles: record.changedFiles.slice(0, 200),
    summary: redactString(record.summary).slice(0, 4000),
    allowedOutput: record.publicOutput ? redactString(record.allowedOutput ?? "").slice(0, 32_000) : undefined,
    tests: record.tests.slice(0, 100),
  });
}

export class ExecutionRecordStore {
  constructor(private readonly directory: string | null) {}

  async list(): Promise<ExecutionRecord[]> {
    if (!this.directory) throw new ExecutionStoreUnavailableError();
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch {
      throw new ExecutionStoreUnavailableError();
    }
    const records: ExecutionRecord[] = [];
    for (const entry of entries.filter((item) => item.toLowerCase().endsWith(".json")).slice(0, 500)) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.directory, entry), "utf8")) as unknown;
        if (isRecord(parsed)) records.push(safeRecord(parsed));
      } catch {
        // Malformed/unreadable records are ignored and never become MCP output.
      }
    }
    return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async write(record: Omit<ExecutionRecord, "id"> & { id?: string }): Promise<ExecutionRecord> {
    if (!this.directory) throw new Error("execution_store_unavailable");
    const next = safeRecord({ ...record, id: record.id ?? `exec_${randomBytes(12).toString("base64url")}` });
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${next.id}.json`);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(temporary, target);
    return next;
  }

  async latestTest(): Promise<ExecutionRecord | null> {
    const records = await this.list();
    return records.find((record) => record.tests.length > 0) ?? null;
  }

  async recent(limit: number): Promise<ExecutionRecord[]> {
    return (await this.list()).slice(0, limit);
  }

  async publicOutput(id: string): Promise<{ record: ExecutionRecord; output: string } | null> {
    const record = (await this.list()).find((item) => item.id === id);
    if (!record || !record.publicOutput || !record.allowedOutput) return null;
    return { record, output: redactString(record.allowedOutput) };
  }
}
