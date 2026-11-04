/**
 * LogsService — 把本机已有的真实日志读出来给界面看。
 *
 * 数据来源（全部在本机状态目录内，只读）：
 *   <stateRoot>/profiles/<id>/audit/active.log  审计链，JSONL，每行一个事件
 *   <stateRoot>/profiles/<id>/executions/*.json 执行记录
 *   <stateRoot>/restart-budget.json             重启预算
 *
 * 安全：所有输出在离开主进程前做一次脱敏（令牌、长 hex、配对码形态）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface LogEntry {
  ts: string;
  source: "audit" | "execution" | "system";
  event: string;
  detail: string;
}

export interface LogsResult {
  entries: LogEntry[];
  sources: Array<{ name: string; path: string; bytes: number; lastWriteAt: string | null }>;
  truncated: boolean;
  stateRoot: string;
}

const MAX_ENTRIES = 500;
const MAX_LINE_BYTES = 8 * 1024;

/** 简单脱敏：令牌/长十六进制/配对码形态一律替换。 */
export function redactText(input: string): string {
  if (!input) return input;
  let out = input;
  // JWT / bearer
  out = out.replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, "<REDACTED_JWT>");
  // 长 hex（>=32）
  out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, "<REDACTED_HEX>");
  // 常见字段名后跟值
  out = out.replace(
    /\b(adminToken|access_token|refresh_token|token|secret|password|pairing_code|pairingCode)\b\s*[:=]\s*"?([^"\s,}]{6,})"?/gi,
    (_m, k: string) => `${k}=<REDACTED>`,
  );
  if (out.length > 4000) out = out.slice(0, 4000) + "…";
  return out;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readTailLines(file: string, maxLines: number): Promise<string[]> {
  const handle = await fs.open(file, "r");
  try {
    const st = await handle.stat();
    const size = st.size;
    // 从末尾读一大块，避免整文件载入（active.log 可能几十 MB）
    const want = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(want);
    await handle.read(buf, 0, want, size - want);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    // 若从中间截断，丢掉第一行
    if (want < size) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readLogs(stateRoot: string, limit = 200): Promise<LogsResult> {
  const entries: LogEntry[] = [];
  const sources: LogsResult["sources"] = [];
  let truncated = false;

  const profilesDir = path.join(stateRoot, "profiles");
  let profileIds: string[] = [];
  try {
    profileIds = (await fs.readdir(profilesDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    profileIds = [];
  }

  for (const pid of profileIds) {
    const auditFile = path.join(profilesDir, pid, "audit", "active.log");
    try {
      const st = await fs.stat(auditFile);
      sources.push({
        name: `审计链 · ${pid}`,
        path: auditFile,
        bytes: st.size,
        lastWriteAt: st.mtime.toISOString(),
      });
      const lines = await readTailLines(auditFile, MAX_ENTRIES);
      if (lines.length >= MAX_ENTRIES) truncated = true;
      for (const line of lines) {
        if (line.length > MAX_LINE_BYTES) continue;
        const obj = safeJson(line);
        if (!obj) continue;
        const payload = (obj.payload ?? {}) as Record<string, unknown>;
        const event = typeof payload.event === "string" ? payload.event : "(未命名事件)";
        const ts = typeof obj.timestamp === "string" ? obj.timestamp : "";
        const { event: _e, ...rest } = payload;
        entries.push({
          ts,
          source: "audit",
          event,
          detail: redactText(JSON.stringify(rest)),
        });
      }
    } catch {
      /* 该 profile 没有审计链 */
    }

    // 执行记录
    const execDir = path.join(profilesDir, pid, "executions");
    try {
      const files = (await fs.readdir(execDir)).filter((f) => f.endsWith(".json"));
      for (const f of files.slice(0, 20)) {
        const full = path.join(execDir, f);
        try {
          const raw = await fs.readFile(full, "utf8");
          const obj = safeJson(raw);
          if (!obj) continue;
          entries.push({
            ts: typeof obj.startedAt === "string" ? obj.startedAt : "",
            source: "execution",
            event: `执行记录 · ${f.replace(/\.json$/, "")}`,
            detail: redactText(
              JSON.stringify({
                command: obj.command,
                exitCode: obj.exitCode,
                status: obj.status,
              }),
            ),
          });
        } catch {
          /* 忽略单个文件 */
        }
      }
    } catch {
      /* 无执行记录 */
    }
  }

  // 重启预算（系统级）
  try {
    const budgetFile = path.join(stateRoot, "restart-budget.json");
    const st = await fs.stat(budgetFile);
    sources.push({
      name: "重启预算",
      path: budgetFile,
      bytes: st.size,
      lastWriteAt: st.mtime.toISOString(),
    });
    const raw = await fs.readFile(budgetFile, "utf8");
    const obj = safeJson(raw);
    if (obj) {
      entries.push({
        ts: st.mtime.toISOString(),
        source: "system",
        event: "重启预算",
        detail: redactText(JSON.stringify(obj)),
      });
    }
  } catch {
    /* 无 */
  }

  // 时间倒序
  entries.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));

  return {
    entries: entries.slice(0, Math.max(1, Math.min(1000, limit))),
    sources,
    truncated,
    stateRoot,
  };
}
