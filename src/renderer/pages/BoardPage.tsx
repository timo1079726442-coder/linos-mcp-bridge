import { useCallback, useEffect, useMemo, useState } from "react";

type BoardStatus = "done" | "active" | "pending" | "blocked";

interface BoardTask { id: string; title: string; status: BoardStatus; startedAt?: string | null; endedAt?: string | null; note?: string }
interface BoardMilestone { id: string; title: string; status: BoardStatus; startedAt?: string | null; endedAt?: string | null; progress?: number; tasks?: BoardTask[] }
interface BoardBranch { id: string; title: string; status: BoardStatus; parent?: string; startedAt?: string | null; endedAt?: string | null; note?: string }
interface Intent { raw: string; deliverables: string[]; acceptance: string[]; constraints: string[] }
interface Decision { id: string; at: string; title: string; decision: string; reason: string }
interface FileRef { path: string; role: string }
interface NextAction { id: string; title: string; owner?: string; priority?: "high" | "normal" | "low"; note?: string }
interface Blocker { at: string; what: string; reason: string; resolution?: string }
interface GlossaryItem { term: string; meaning: string }
interface Board {
  project: string; goal: string; updatedAt: string;
  milestones: BoardMilestone[]; branches: BoardBranch[];
  intent: Intent; decisions: Decision[]; files: FileRef[];
  nextActions: NextAction[]; blockers: Blocker[]; glossary: GlossaryItem[];
}

interface BoardSummary { file: string; project: string; goal: string; updatedAt: string; percent: number; done: number; total: number; active: boolean }

const STATUS_LABEL: Record<BoardStatus, string> = { done: "已完成", active: "进行中", pending: "未开始", blocked: "卡住" };
const STATUS_COLOR: Record<BoardStatus, string> = { done: "#22c55e", active: "#f59e0b", pending: "#94a3b8", blocked: "#ef4444" };

function linesOf(values: string[]): string {
  return values.join("\n");
}
function arrayOf(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function duration(item: { startedAt?: string | null; endedAt?: string | null }): string {
  if (!item.startedAt) return "未开始";
  const start = Date.parse(item.startedAt);
  if (!Number.isFinite(start)) return "未开始";
  const end = item.endedAt ? Date.parse(item.endedAt) : Date.now();
  const ms = Math.max(0, end - start);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/**
 * 多项目看板：每个项目一个文件（<工作区>\.c2c\projects\<项目>.json），
 * 界面可切换项目、表单编辑、一键复制交接卡。
 */
export function BoardPage(): JSX.Element {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [handoff, setHandoff] = useState("");
  const [creating, setCreating] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [newGoal, setNewGoal] = useState("");

  const refreshList = useCallback(async (file?: string | null): Promise<void> => {
    const res = (await window.c2c.board.list()) as { dir: string; current: string | null; boards: BoardSummary[] };
    setBoards(res.boards);
    setDir(res.dir);
    const nextFile = file ?? currentFile ?? res.boards[0]?.file ?? null;
    setCurrentFile(nextFile);
    if (nextFile) {
      const detail = (await window.c2c.board.read(nextFile)) as { board: Board | null };
      setBoard(detail.board);
    } else {
      setBoard(null);
    }
  }, [currentFile]);

  useEffect(() => { void refreshList().catch((e) => setError(String(e))); }, []);

  async function open(file: string): Promise<void> {
    setBusy(true);
    setError(null);
    setHandoff("");
    try {
      setCurrentFile(file);
      const detail = (await window.c2c.board.read(file)) as { board: Board | null };
      setBoard(detail.board);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!board) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.c2c.board.write(board, currentFile ?? undefined);
      setCurrentFile(res.file);
      setSaved(`已保存到 ${res.path}`);
      await refreshList(res.file ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    if (!newProject.trim()) return;
    setBusy(true);
    try {
      const res = (await window.c2c.board.create({ project: newProject.trim(), goal: newGoal.trim() })) as { board: Board | null; file?: string };
      setCreating(false);
      setNewProject("");
      setNewGoal("");
      await refreshList(res.file ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function makeHandoff(full: boolean): Promise<void> {
    setBusy(true);
    try {
      const res = await window.c2c.board.handoff(currentFile ?? undefined);
      const text = full ? res.markdown : (res.markdown.split("## 机读数据")[0] ?? res.markdown).trim();
      setHandoff(text);
      await navigator.clipboard.writeText(text).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const stats = useMemo(() => {
    if (!board || board.milestones.length === 0) return { percent: 0, done: 0, total: 0 };
    let score = 0;
    for (const m of board.milestones) {
      if (m.status === "done") score += 1;
      else if (typeof m.progress === "number") score += m.progress / 100;
      else if (m.tasks && m.tasks.length > 0) score += m.tasks.filter((t) => t.status === "done").length / m.tasks.length;
    }
    return {
      percent: Math.round((score / board.milestones.length) * 100),
      done: board.milestones.filter((m) => m.status === "done").length,
      total: board.milestones.length,
    };
  }, [board]);

  function patch(update: Partial<Board>): void {
    setBoard((prev) => (prev ? { ...prev, ...update } : prev));
  }

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div>
          <h1>项目看板</h1>
          <p>每个项目一个文件，放在 <code>{dir || "<工作区>\\.c2c\\projects"}</code>；切换项目、直接改、复制交接卡。</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn secondary" type="button" onClick={() => setCreating((v) => !v)} disabled={busy}>新建项目</button>
          <button className="btn secondary" type="button" onClick={() => void refreshList(currentFile)} disabled={busy}>刷新</button>
          <button className="btn" type="button" onClick={() => void save()} disabled={busy || !board}>保存</button>
        </div>
      </div>

      {error && <p className="err">{error}</p>}
      {saved && <p className="muted" style={{ fontSize: 12 }}>{saved}</p>}

      {creating && (
        <div className="card">
          <div className="section-title">新建项目</div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input" placeholder="项目名称（会作为文件名）" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
            <input className="input" placeholder="总目标（一句话）" value={newGoal} onChange={(e) => setNewGoal(e.target.value)} style={{ flex: 1 }} />
            <button className="btn" type="button" onClick={() => void create()} disabled={busy || !newProject.trim()}>创建</button>
          </div>
        </div>
      )}

      {boards.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="section-title">项目（{boards.length}）</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {boards.map((item) => (
              <button
                key={item.file}
                type="button"
                onClick={() => void open(item.file)}
                className="v2-tr"
                style={{
                  display: "flex", gap: 10, alignItems: "center", textAlign: "left", cursor: "pointer",
                  width: "100%", padding: "8px 10px",
                  border: item.file === currentFile ? "1px solid #2563eb" : undefined,
                }}
              >
                <strong style={{ minWidth: 160 }}>{item.project}</strong>
                <span className="muted" style={{ fontSize: 12, flex: 1 }}>{item.goal}</span>
                <span className="muted" style={{ fontSize: 12 }}>{item.percent}%（{item.done}/{item.total}）</span>
                <span className="muted" style={{ fontSize: 12 }}>{new Date(item.updatedAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!board && boards.length === 0 && (
        <div className="card">
          <div className="section-title">还没有项目看板</div>
          <p className="muted">点「新建项目」创建；或者让 AI 把需求写进 <code>.c2c\projects\&lt;项目名&gt;.json</code>，这里会自动出现。</p>
        </div>
      )}

      {board && (
        <>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">基本</div>
            <div className="kv">
              <div className="k">项目名称</div>
              <div className="v"><input className="input" value={board.project} onChange={(e) => patch({ project: e.target.value })} style={{ width: "100%" }} /></div>
              <div className="k">总目标</div>
              <div className="v"><input className="input" value={board.goal} onChange={(e) => patch({ goal: e.target.value })} style={{ width: "100%" }} /></div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
              <div style={{ flex: 1, height: 10, background: "#e2e8f0", borderRadius: 6, overflow: "hidden" }}>
                <div style={{ width: `${stats.percent}%`, height: "100%", background: "linear-gradient(90deg,#2563eb,#22c55e)" }} />
              </div>
              <strong>{stats.percent}%</strong>
              <span className="muted">{stats.done}/{stats.total} 里程碑</span>
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">用户要什么（原话）</div>
            <textarea className="input" style={{ width: "100%", minHeight: 90 }} value={board.intent.raw}
              onChange={(e) => patch({ intent: { ...board.intent, raw: e.target.value } })} />
            <div className="kv" style={{ marginTop: 8 }}>
              <div className="k">要交付什么</div>
              <div className="v"><textarea className="input" style={{ width: "100%", minHeight: 60 }} value={linesOf(board.intent.deliverables)}
                onChange={(e) => patch({ intent: { ...board.intent, deliverables: arrayOf(e.target.value) } })} /></div>
              <div className="k">验收标准</div>
              <div className="v"><textarea className="input" style={{ width: "100%", minHeight: 60 }} value={linesOf(board.intent.acceptance)}
                onChange={(e) => patch({ intent: { ...board.intent, acceptance: arrayOf(e.target.value) } })} /></div>
              <div className="k">约束与禁止</div>
              <div className="v"><textarea className="input" style={{ width: "100%", minHeight: 60 }} value={linesOf(board.intent.constraints)}
                onChange={(e) => patch({ intent: { ...board.intent, constraints: arrayOf(e.target.value) } })} /></div>
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>每行一条。</p>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">里程碑（主线）</div>
            {board.milestones.map((m, index) => (
              <div key={m.id} style={{ borderLeft: `3px solid ${STATUS_COLOR[m.status]}`, padding: "6px 10px", marginBottom: 8 }}>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <input className="input" value={m.title} style={{ flex: 1, minWidth: 220 }}
                    onChange={(e) => {
                      const next = [...board.milestones];
                      next[index] = { ...m, title: e.target.value };
                      patch({ milestones: next });
                    }} />
                  <select className="input" value={m.status}
                    onChange={(e) => {
                      const next = [...board.milestones];
                      const status = e.target.value as BoardStatus;
                      next[index] = { ...m, status, endedAt: status === "done" ? new Date().toISOString() : m.endedAt };
                      patch({ milestones: next });
                    }}>
                    {(["pending", "active", "done", "blocked"] as BoardStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                  <span className="muted" style={{ fontSize: 12 }}>耗时 {duration(m)}</span>
                  <button className="btn secondary" type="button" onClick={() => patch({ milestones: board.milestones.filter((_, i) => i !== index) })}>删除</button>
                </div>
              </div>
            ))}
            <button className="btn secondary" type="button" onClick={() => patch({
              milestones: [...board.milestones, {
                id: `M${board.milestones.length + 1}`, title: "新里程碑", status: "pending",
                startedAt: new Date().toISOString(), endedAt: null, progress: 0, tasks: [],
              }],
            })}>+ 加里程碑</button>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">下一个待办（每行一条，可用 high: 前缀标优先级）</div>
            <textarea className="input" style={{ width: "100%", minHeight: 70 }}
              value={board.nextActions.map((a) => (a.priority === "high" ? `high: ${a.title}` : a.title)).join("\n")}
              onChange={(e) => patch({
                nextActions: arrayOf(e.target.value).map((line, i) => {
                  const isHigh = line.startsWith("high:");
                  return { id: `A${i + 1}`, title: line.replace(/^high:\s*/, ""), priority: isHigh ? "high" as const : "normal" as const };
                }),
              })} />
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">卡住 / 失败原因（每行：现象｜原因）</div>
            <textarea className="input" style={{ width: "100%", minHeight: 60 }}
              value={board.blockers.map((b) => `${b.what}｜${b.reason}`).join("\n")}
              onChange={(e) => patch({
                blockers: arrayOf(e.target.value).map((line) => {
                  const [what = "", reason = ""] = line.split("｜");
                  return { at: new Date().toISOString(), what: what.trim(), reason: reason.trim() };
                }),
              })} />
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="section-title">交接</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" type="button" disabled={busy} onClick={() => void makeHandoff(false)}>复制简短交接卡</button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => void makeHandoff(true)}>复制完整交接卡（含 JSON）</button>
            </div>
            {handoff && <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12 }}>{handoff}</pre>}
          </div>
        </>
      )}
    </div>
  );
}
