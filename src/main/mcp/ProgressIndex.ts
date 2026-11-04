import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ProgressCall {
  seq: number | null;
  at: string;
  tool: string;
  ok: boolean;
  durationMs: number | null;
  target: string | null;
  errorCode: string | null;
  /** 该文件当时的 SHA256（写入类工具才有）。 */
  hash: string | null;
  bytes: number | null;
  clientId: string | null;
}

export interface ProgressSession {
  id: string;
  project: string | null;
  startedAt: string;
  endedAt: string;
  active: boolean;
  calls: number;
  failures: number;
  tools: Array<{ name: string; count: number }>;
  clientId: string | null;
  files: string[];
  commands: string[];
  recent: ProgressCall[];
  checkpoints: Array<{ at: string; kind: string; detail: string; hash: string | null; bytes: number | null }>;
}

interface RawRow {
  seq?: unknown;
  at?: unknown;
  tool?: unknown;
  ok?: unknown;
  durationMs?: unknown;
  path?: unknown;
  command?: unknown;
  errorCode?: unknown;
  clientId?: unknown;
  hash?: unknown;
  bytes?: unknown;
}

const GAP_MS = 25 * 60_000;
const ACTIVE_MS = 10 * 60_000;
const MAX_ROWS = 5000;

function toIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function isWriteTool(tool: string): boolean {
  return tool === "commit_operation" || tool === "apply_patch" || tool === "delete_file";
}

/**
 * 把 tool-calls.jsonl 里散落的调用按"时间间隔"聚成会话。
 * ChatGPT 网页版不传会话 ID，只能用间隔 + 目标路径推断，够用且不需要客户端改造。
 */
export async function readProgressSessions(stateRoot: string): Promise<ProgressSession[]> {
  const profilesDir = path.join(stateRoot, "profiles");
  const profiles = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const rows: Array<{ row: ProgressCall; profile: string }> = [];

  for (const profile of profiles) {
    if (!profile.isDirectory()) continue;
    const file = path.join(profilesDir, profile.name, "audit", "tool-calls.jsonl");
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (!raw) continue;
    const lines = raw.split("\n").slice(-MAX_ROWS);
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: RawRow;
      try {
        parsed = JSON.parse(line) as RawRow;
      } catch {
        continue;
      }
      const at = toIso(parsed.at);
      const tool = typeof parsed.tool === "string" ? parsed.tool : null;
      if (!at || !tool) continue;
      rows.push({
        profile: profile.name,
        row: {
          seq: typeof parsed.seq === "number" ? parsed.seq : null,
          at,
          tool,
          ok: parsed.ok !== false,
          durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : null,
          target: typeof parsed.path === "string" ? parsed.path : typeof parsed.command === "string" ? parsed.command : null,
          errorCode: typeof parsed.errorCode === "string" ? parsed.errorCode : null,
          hash: typeof parsed.hash === "string" && /^[a-f0-9]{64}$/.test(parsed.hash) ? parsed.hash : null,
          clientId: typeof parsed.clientId === "string" ? parsed.clientId : null,
          bytes: typeof parsed.bytes === "number" ? parsed.bytes : null,
        },
      });
    }
  }

  rows.sort((a, b) => Date.parse(a.row.at) - Date.parse(b.row.at));
  const sessions: ProgressSession[] = [];
  let current: ProgressCall[] = [];
  let currentProfile = "";

  const flush = (): void => {
    if (current.length === 0) return;
    sessions.push(buildSession(current, currentProfile));
    current = [];
  };

  for (const item of rows) {
    const last = current[current.length - 1];
    if (last && (Date.parse(item.row.at) - Date.parse(last.at) > GAP_MS || item.profile !== currentProfile)) {
      flush();
    }
    currentProfile = item.profile;
    current.push(item.row);
  }
  flush();

  return sessions.reverse().slice(0, 40);
}

function buildSession(calls: ProgressCall[], profile: string): ProgressSession {
  const startedAt = calls[0]!.at;
  const endedAt = calls[calls.length - 1]!.at;
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  const commands = new Set<string>();
  const checkpoints: Array<{ at: string; kind: string; detail: string; hash: string | null; bytes: number | null }> = [];

  for (const call of calls) {
    toolCounts.set(call.tool, (toolCounts.get(call.tool) ?? 0) + 1);
    if (call.tool === "run_command" && call.target) commands.add(call.target);
    else if (call.target) files.add(call.target);
    if ((isWriteTool(call.tool) || call.hash) && call.ok) {
      checkpoints.push({ at: call.at, kind: call.tool, detail: call.target ?? call.tool, hash: call.hash, bytes: call.bytes });
    }
  }

  const project = firstSegment([...files][0] ?? null);
  const clientCounts = new Map<string, number>();
  for (const call of calls) { if (call.clientId) clientCounts.set(call.clientId, (clientCounts.get(call.clientId) ?? 0) + 1); }
  const topClient = [...clientCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    id: `${profile}:${startedAt}`,
    project,
    startedAt,
    endedAt,
    active: Date.now() - Date.parse(endedAt) < ACTIVE_MS,
    calls: calls.length,
    clientId: topClient,
    failures: calls.filter((c) => !c.ok).length,
    tools: [...toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    files: [...files].slice(-20),
    commands: [...commands].slice(-10),
    recent: calls.slice(-15),
    checkpoints: checkpoints.slice(-10),
  };
}

function firstSegment(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\\/g, "/").replace(/^\.?\//, "");
  const segment = cleaned.split("/")[0];
  return segment && segment !== "." && segment.length <= 40 ? segment : null;
}

/** 生成一张可粘贴到新对话的"交接卡"。 */
export function buildHandoffCard(session: ProgressSession, options?: { full?: boolean }): string {
  const full = options?.full === true;
  const lines: string[] = [];
  lines.push(`# MCP 交接卡（${session.startedAt} → ${session.endedAt}）`);
  if (session.project) lines.push(`- 项目线索：${session.project}`);
  lines.push(`- 调用次数：${session.calls}（失败 ${session.failures}）`);
  lines.push(`- 工具分布：${session.tools.map((t) => `${t.name}×${t.count}`).join("、")}`);
  if (session.commands.length > 0) lines.push(`- 执行过的命令：\n${session.commands.map((c) => `  - \`${c}\``).join("\n")}`);
  if (full && session.files.length > 0) lines.push(`- 触及文件：\n${session.files.map((f) => `  - ${f}`).join("\n")}`);
  if (session.checkpoints.length > 0) {
    lines.push(`- 已提交的断点：\n${session.checkpoints.map((c) => `  - ${c.at} ${c.detail}`).join("\n")}`);
  }
  lines.push("- 最近动作："+(full ? "（完整 15 条）" : "（最近 5 条，完整版见下）"));
  const recent = full ? session.recent : session.recent.slice(-5);
  for (const call of recent) {
    lines.push(`  - ${call.at} ${call.tool}${call.target ? `：${call.target}` : ""}${call.ok ? "" : `（失败 ${call.errorCode ?? ""}）`}`);
  }
  lines.push("");
  lines.push("请基于以上状态继续，不要重复已完成的部分。");
  return lines.join("\n");
}
