/**
 * 工具调用哈希链审计。
 *
 * 与 48765 的 workspace-write-audit.jsonl 对齐：
 * - 每条记录包含 prevHash + hash，任何一条被改都会断链；
 * - 只记录工具名、路径/命令、结果与哈希，不记录文件正文；
 * - 追加失败不阻断业务，但会写到 stderr，便于诊断。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ToolAuditInput {
  tool: string;
  ok: boolean;
  durationMs: number;
  path?: string;
  paths?: string[];
  command?: string;
  bytes?: number;
  sha256?: string;
  errorCode?: string;
  /** 调用方标识：c2c_api_token=长期令牌客户端；c2c_client_*=OAuth 客户端。 */
  clientId?: string;
}

interface ToolAuditEntry extends ToolAuditInput {
  seq: number;
  at: string;
  prevHash: string;
}

const GENESIS = "0".repeat(64);
const queues = new Map<string, Promise<void>>();

export function toolAuditPath(profileDir: string): string {
  return path.join(profileDir, "audit", "tool-calls.jsonl");
}

function digest(prevHash: string, entry: ToolAuditEntry): string {
  return createHash("sha256").update(prevHash).update(JSON.stringify(entry)).digest("hex");
}

async function readTail(file: string): Promise<{ seq: number; hash: string }> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as { seq?: unknown; hash?: unknown };
        if (typeof parsed.seq === "number" && typeof parsed.hash === "string") {
          return { seq: parsed.seq, hash: parsed.hash };
        }
      } catch {
        /* 跳过损坏行，继续向前找 */
      }
    }
    return { seq: 0, hash: GENESIS };
  } catch {
    return { seq: 0, hash: GENESIS };
  }
}

export async function appendToolAudit(profileDir: string, input: ToolAuditInput): Promise<void> {
  const file = toolAuditPath(profileDir);
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tail = await readTail(file);
    const entry: ToolAuditEntry = {
      seq: tail.seq + 1,
      at: new Date().toISOString(),
      prevHash: tail.hash,
      ...input,
    };
    if (entry.command) entry.command = entry.command.slice(0, 200);
    const hash = digest(tail.hash, entry);
    await fs.appendFile(file, `${JSON.stringify({ ...entry, hash })}\n`, "utf8");
  }).catch((error: unknown) => {
    console.error(`tool audit append failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  queues.set(file, next);
  await next;
}

export async function verifyToolAudit(profileDir: string): Promise<{ ok: boolean; entries: number; brokenAt?: number }> {
  const file = toolAuditPath(profileDir);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { ok: true, entries: 0 };
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let prev = GENESIS;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: (ToolAuditEntry & { hash?: string }) | null = null;
    try {
      parsed = JSON.parse(lines[index]) as ToolAuditEntry & { hash?: string };
    } catch {
      return { ok: false, entries: lines.length, brokenAt: index + 1 };
    }
    const { hash, ...entry } = parsed;
    if (!hash || entry.prevHash !== prev || digest(prev, entry) !== hash) {
      return { ok: false, entries: lines.length, brokenAt: index + 1 };
    }
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}
