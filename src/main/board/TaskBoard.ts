import { promises as fs } from "node:fs";
import * as path from "node:path";

export type BoardStatus = "done" | "active" | "pending" | "blocked";

export interface BoardTask {
  id: string;
  title: string;
  status: BoardStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  note?: string;
}

export interface BoardMilestone {
  id: string;
  title: string;
  status: BoardStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  progress?: number;
  tasks?: BoardTask[];
}

export interface BoardBranch {
  id: string;
  title: string;
  status: BoardStatus;
  parent?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  note?: string;
}

export interface BoardIntent {
  /** 用户原话/需求原文，越多越好，接手方不用再问一遍。 */
  raw: string;
  /** 要交付什么（可逐条勾选）。 */
  deliverables: string[];
  /** 怎么算做完（验收标准）。 */
  acceptance: string[];
  /** 约束与禁止事项（技术栈、不能动的东西、口径等）。 */
  constraints: string[];
}

export interface BoardDecision {
  id: string;
  at: string;
  title: string;
  decision: string;
  reason: string;
}

export interface BoardFileRef {
  path: string;
  role: string;
}

export interface BoardNextAction {
  id: string;
  title: string;
  owner?: string;
  priority?: "high" | "normal" | "low";
  note?: string;
}

export interface BoardBlocker {
  at: string;
  what: string;
  reason: string;
  resolution?: string;
}

export interface BoardGlossaryItem {
  term: string;
  meaning: string;
}
export interface TaskBoard {
  schemaVersion: 1;
  project: string;
  goal: string;
  updatedAt: string;
  milestones: BoardMilestone[];
  branches: BoardBranch[];
  intent: BoardIntent;
  decisions: BoardDecision[];
  files: BoardFileRef[];
  nextActions: BoardNextAction[];
  blockers: BoardBlocker[];
  glossary: BoardGlossaryItem[];
}

const BOARD_DIR = ".c2c";
const DEFAULT_BOARD_FILE = "taskboard.json";

export function boardDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, BOARD_DIR, "projects");
}

/** 当前会话声明的项目（AI 开局写一次）放在这里，便于界面标出"正在做哪个"。 */
export function currentProjectPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, BOARD_DIR, "current-project.json");
}

export function boardPath(workspaceRoot: string, file = DEFAULT_BOARD_FILE): string {
  return path.join(boardDir(workspaceRoot), file);
}

export function slugifyProject(project: string): string {
  const cleaned = project
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${cleaned || "project"}.json`;
}

/** 只允许 projects 目录下的普通 json 文件名，拒绝任何路径穿越。 */
export function safeBoardFile(file: unknown): string {
  const value = typeof file === "string" ? file.trim() : "";
  if (!value || value === "." || value === "..") return DEFAULT_BOARD_FILE;
  if (value.includes("..") || /[\\/]/.test(value)) return DEFAULT_BOARD_FILE;
  if (!/^[^\\/:*?"<>|]{1,80}\.json$/.test(value)) return DEFAULT_BOARD_FILE;
  return value;
}

export interface BoardSummary {
  file: string;
  project: string;
  goal: string;
  updatedAt: string;
  percent: number;
  done: number;
  total: number;
  active: boolean;
}

export async function listBoards(workspaceRoot: string): Promise<{ dir: string; current: string | null; boards: BoardSummary[] }> {
  const dir = boardDir(workspaceRoot);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const boards: BoardSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(dir, entry.name), "utf8").catch(() => null);
    if (!raw) continue;
    let parsed: TaskBoard | null = null;
    try {
      parsed = normalize(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const stats = milestoneProgress(parsed);
    boards.push({
      file: entry.name,
      project: parsed.project,
      goal: parsed.goal,
      updatedAt: parsed.updatedAt,
      percent: stats.percent,
      done: stats.done,
      total: stats.total,
      active: parsed.milestones.some((m) => m.status === "active") || parsed.nextActions.length > 0,
    });
  }
  boards.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const current = await readCurrentProject(workspaceRoot);
  return { dir, current: current?.project ?? null, boards };
}

export async function readCurrentProject(workspaceRoot: string): Promise<{ project: string; file: string; at: string } | null> {
  const raw = await fs.readFile(currentProjectPath(workspaceRoot), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { project?: unknown; file?: unknown; at?: unknown };
    if (typeof parsed.project !== "string") return null;
    return {
      project: parsed.project,
      file: safeBoardFile(parsed.file),
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function templateBoard(project: string, goal: string): TaskBoard {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    project,
    goal,
    updatedAt: now,
    milestones: [
      {
        id: "M1",
        title: "第一个里程碑（请改写）",
        status: "active",
        startedAt: now,
        endedAt: null,
        progress: 0,
        tasks: [{ id: "T1", title: "第一个任务（请改写）", status: "pending", startedAt: null, endedAt: null, note: "" }],
      },
    ],
    branches: [],
    intent: {
      raw: "把用户原话/需求描述粘到这里（越完整，接手方越不用重新问）",
      deliverables: ["最终要交付的东西（文件/结论/系统）"],
      acceptance: ["怎么算做完（可验收的具体标准）"],
      constraints: ["不能违反的约束（技术栈、口径、禁改文件）"],
    },
    decisions: [],
    files: [],
    nextActions: [],
    blockers: [],
    glossary: [],
  };
}

function asStatus(value: unknown): BoardStatus {
  return value === "done" || value === "active" || value === "blocked" ? value : "pending";
}

function normalize(raw: unknown): TaskBoard | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const milestones: BoardMilestone[] = Array.isArray(obj.milestones)
    ? obj.milestones.map((item, index) => {
      const m = (item ?? {}) as Record<string, unknown>;
      const tasks: BoardTask[] = Array.isArray(m.tasks)
        ? m.tasks.map((t, i) => {
          const task = (t ?? {}) as Record<string, unknown>;
          return {
            id: typeof task.id === "string" ? task.id : `T${i + 1}`,
            title: typeof task.title === "string" ? task.title : "未命名任务",
            status: asStatus(task.status),
            startedAt: typeof task.startedAt === "string" ? task.startedAt : null,
            endedAt: typeof task.endedAt === "string" ? task.endedAt : null,
            note: typeof task.note === "string" ? task.note : "",
          };
        })
        : [];
      return {
        id: typeof m.id === "string" ? m.id : `M${index + 1}`,
        title: typeof m.title === "string" ? m.title : "未命名里程碑",
        status: asStatus(m.status),
        startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
        endedAt: typeof m.endedAt === "string" ? m.endedAt : null,
        progress: typeof m.progress === "number" ? Math.max(0, Math.min(100, m.progress)) : undefined,
        tasks,
      };
    })
    : [];
  const branches: BoardBranch[] = Array.isArray(obj.branches)
    ? obj.branches.map((item, index) => {
      const b = (item ?? {}) as Record<string, unknown>;
      return {
        id: typeof b.id === "string" ? b.id : `B${index + 1}`,
        title: typeof b.title === "string" ? b.title : "未命名支线",
        status: asStatus(b.status),
        parent: typeof b.parent === "string" ? b.parent : "main",
        startedAt: typeof b.startedAt === "string" ? b.startedAt : null,
        endedAt: typeof b.endedAt === "string" ? b.endedAt : null,
        note: typeof b.note === "string" ? b.note : "",
      };
    })
    : [];
  const intentRaw = (obj.intent ?? {}) as Record<string, unknown>;
  const strList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
  const intent: BoardIntent = {
    raw: typeof intentRaw.raw === "string" ? intentRaw.raw : "",
    deliverables: strList(intentRaw.deliverables),
    acceptance: strList(intentRaw.acceptance),
    constraints: strList(intentRaw.constraints),
  };
  const decisions: BoardDecision[] = Array.isArray(obj.decisions)
    ? obj.decisions.map((item, index) => {
      const d = (item ?? {}) as Record<string, unknown>;
      return {
        id: typeof d.id === "string" ? d.id : `D${index + 1}`,
        at: typeof d.at === "string" ? d.at : "",
        title: typeof d.title === "string" ? d.title : "未命名决策",
        decision: typeof d.decision === "string" ? d.decision : "",
        reason: typeof d.reason === "string" ? d.reason : "",
      };
    })
    : [];
  const files: BoardFileRef[] = Array.isArray(obj.files)
    ? obj.files.map((item) => {
      const f = (item ?? {}) as Record<string, unknown>;
      return {
        path: typeof f.path === "string" ? f.path : "",
        role: typeof f.role === "string" ? f.role : "",
      };
    }).filter((f) => f.path)
    : [];
  const nextActions: BoardNextAction[] = Array.isArray(obj.nextActions)
    ? obj.nextActions.map((item, index) => {
      const a = (item ?? {}) as Record<string, unknown>;
      return {
        id: typeof a.id === "string" ? a.id : `A${index + 1}`,
        title: typeof a.title === "string" ? a.title : "未命名待办",
        owner: typeof a.owner === "string" ? a.owner : undefined,
        priority: a.priority === "high" || a.priority === "low" ? a.priority : "normal",
        note: typeof a.note === "string" ? a.note : undefined,
      };
    })
    : [];
  const blockers: BoardBlocker[] = Array.isArray(obj.blockers)
    ? obj.blockers.map((item) => {
      const b = (item ?? {}) as Record<string, unknown>;
      return {
        at: typeof b.at === "string" ? b.at : "",
        what: typeof b.what === "string" ? b.what : "",
        reason: typeof b.reason === "string" ? b.reason : "",
        resolution: typeof b.resolution === "string" ? b.resolution : undefined,
      };
    })
    : [];
  const glossary: BoardGlossaryItem[] = Array.isArray(obj.glossary)
    ? obj.glossary.map((item) => {
      const g = (item ?? {}) as Record<string, unknown>;
      return {
        term: typeof g.term === "string" ? g.term : "",
        meaning: typeof g.meaning === "string" ? g.meaning : "",
      };
    }).filter((g) => g.term)
    : [];

  return {
    schemaVersion: 1,
    project: typeof obj.project === "string" ? obj.project : "未命名项目",
    goal: typeof obj.goal === "string" ? obj.goal : "",
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
    milestones,
    branches,
    intent,
    decisions,
    files,
    nextActions,
    blockers,
    glossary,
  };
}

export async function readBoard(workspaceRoot: string, file?: string): Promise<{ exists: boolean; board: TaskBoard | null; path: string; file: string }> {
  const name = safeBoardFile(file ?? (await readCurrentProject(workspaceRoot))?.file ?? DEFAULT_BOARD_FILE);
  const filePath = boardPath(workspaceRoot, name);
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) return { exists: false, board: null, path: filePath, file: name };
  try {
    return { exists: true, board: normalize(JSON.parse(raw)), path: filePath, file: name };
  } catch {
    return { exists: true, board: null, path: filePath, file: name };
  }
}

export async function writeBoard(workspaceRoot: string, board: unknown, file?: string): Promise<{ path: string; file: string }> {
  const normalized = normalize(board);
  if (!normalized) throw new Error("BOARD_INVALID");
  const name = safeBoardFile(typeof file === "string" && file.trim() ? file : `${slugifyProject(normalized.project)}`);
  const filePath = boardPath(workspaceRoot, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  normalized.updatedAt = new Date().toISOString();
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return { path: filePath, file: name };
}

export function milestoneProgress(board: TaskBoard): { percent: number; done: number; total: number } {
  const total = board.milestones.length;
  if (total === 0) return { percent: 0, done: 0, total: 0 };
  let score = 0;
  for (const m of board.milestones) {
    if (m.status === "done") score += 1;
    else if (typeof m.progress === "number") score += m.progress / 100;
    else if (m.tasks && m.tasks.length > 0) {
      score += m.tasks.filter((t) => t.status === "done").length / m.tasks.length;
    }
  }
  return { percent: Math.round((score / total) * 100), done: board.milestones.filter((m) => m.status === "done").length, total };
}

export function durationMs(item: { startedAt?: string | null; endedAt?: string | null }): number | null {
  if (!item.startedAt) return null;
  const start = Date.parse(item.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = item.endedAt ? Date.parse(item.endedAt) : Date.now();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function humanDuration(ms: number | null): string {
  if (ms === null) return "未开始";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/**
 * 交接卡：任何 agent（不管哪家的模型）都能读的纯文本。
 * 含 YAML 头 + 人话摘要 + 机读 JSON 块。
 */
export function boardHandoff(board: TaskBoard): string {
  const stats = milestoneProgress(board);
  const lines: string[] = [];
  lines.push("---");
  lines.push(`project: ${board.project}`);
  lines.push(`goal: ${board.goal}`);
  lines.push(`updated_at: ${board.updatedAt}`);
  lines.push(`progress: ${stats.percent}%`);
  lines.push("---");
  lines.push("");
  lines.push(`# 交接卡 · ${board.project}`);
  lines.push("");
  lines.push(`**总目标**：${board.goal}`);
  lines.push(`**总进度**：${stats.percent}%（${stats.done}/${stats.total} 个里程碑完成）`);
  lines.push("");

  // ↓ 这几节是"接手方不用再问一遍"的关键：意图、交付物、验收、约束、已定决策。
  if (board.intent.raw.trim()) {
    lines.push("## 用户要什么（原话）");
    lines.push(board.intent.raw.trim());
    lines.push("");
  }
  if (board.intent.deliverables.length > 0) {
    lines.push("## 要交付什么");
    for (const d of board.intent.deliverables) lines.push(`- ${d}`);
    lines.push("");
  }
  if (board.intent.acceptance.length > 0) {
    lines.push("## 验收标准（怎么算做完）");
    for (const a of board.intent.acceptance) lines.push(`- [ ] ${a}`);
    lines.push("");
  }
  if (board.intent.constraints.length > 0) {
    lines.push("## 约束与禁止事项");
    for (const c of board.intent.constraints) lines.push(`- ${c}`);
    lines.push("");
  }
  if (board.decisions.length > 0) {
    lines.push("## 已确认的决策（不要再推翻）");
    for (const d of board.decisions) {
      lines.push(`- ${d.id}｜${d.title}：${d.decision}${d.reason ? `（理由：${d.reason}）` : ""}`);
    }
    lines.push("");
  }
  if (board.files.length > 0) {
    lines.push("## 相关文件清单");
    for (const f of board.files) lines.push(`- \`${f.path}\`${f.role ? `：${f.role}` : ""}`);
    lines.push("");
  }
  if (board.nextActions.length > 0) {
    lines.push("## 下一个待办（按优先级）");
    const order = { high: 0, normal: 1, low: 2 } as const;
    for (const a of [...board.nextActions].sort((x, y) => order[x.priority ?? "normal"] - order[y.priority ?? "normal"])) {
      lines.push(`- [${a.priority ?? "normal"}] ${a.id} ${a.title}${a.owner ? `｜负责：${a.owner}` : ""}${a.note ? `（${a.note}）` : ""}`);
    }
    lines.push("");
  }
  if (board.blockers.length > 0) {
    lines.push("## 上次失败 / 卡住的原因");
    for (const b of board.blockers) {
      lines.push(`- ${b.at || "时间未知"}｜${b.what}｜原因：${b.reason}${b.resolution ? `｜已解决：${b.resolution}` : "｜未解决"}`);
    }
    lines.push("");
  }
  if (board.glossary.length > 0) {
    lines.push("## 名词表（避免重复解释）");
    for (const g of board.glossary) lines.push(`- **${g.term}**：${g.meaning}`);
    lines.push("");
  }

  lines.push("## 里程碑（主线）");
  for (const m of board.milestones) {
    const d = humanDuration(durationMs(m));
    lines.push(`- [${m.status === "done" ? "x" : " "}] ${m.id} ${m.title}｜${m.status}｜耗时 ${d}`);
    for (const t of m.tasks ?? []) {
      lines.push(`  - [${t.status === "done" ? "x" : " "}] ${t.id} ${t.title}${t.note ? `（${t.note}）` : ""}`);
    }
  }
  if (board.branches.length > 0) {
    lines.push("");
    lines.push("## 支线");
    for (const b of board.branches) {
      lines.push(`- ${b.id} ${b.title}｜${b.status}｜父级 ${b.parent ?? "main"}｜耗时 ${humanDuration(durationMs(b))}${b.note ? `｜${b.note}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## 机读数据（保持格式，可直接回写 .c2c/taskboard.json）");
  lines.push("```json");
  lines.push(JSON.stringify(board, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## 给接手 agent 的指令");
  lines.push("1. 先读这份交接卡，从\"active\"的里程碑与任务继续，不要重复已完成项。");
  lines.push("2. 已确认的决策不要推翻；要改先说明理由。");
  lines.push("3. 每完成一个任务，把 `.c2c/taskboard.json` 里对应 status 改成 done 并填 endedAt。");
  lines.push("4. 遇到阻塞把 status 改 blocked，并在 note 里写清卡点。");
  return lines.join("\n");
}
