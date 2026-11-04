import { useEffect, useState } from "react";
import { annotateTool } from "../lib/toolGlossary.ts";

interface ProgressCall {
  at: string;
  tool: string;
  ok: boolean;
  target: string | null;
  errorCode: string | null;
}

interface ProgressSession {
  id: string;
  project: string | null;
  autoProject?: string | null;
  startedAt: string;
  endedAt: string;
  active: boolean;
  calls: number;
  failures: number;
  clientId?: string | null;
  tools: Array<{ name: string; count: number }>;
  files: string[];
  commands: string[];
  recent: ProgressCall[];
  checkpoints: Array<{ at: string; kind: string; detail: string; hash: string | null; bytes: number | null }>;
}

const CLIENT_LABEL = (clientId?: string | null): string => {
  if (!clientId) return "来源未知";
  if (clientId === "c2c_api_token") return "长期令牌客户端（Cursor / Claude / 扩展）";
  if (clientId.startsWith("c2c_client")) return "OAuth 客户端（ChatGPT 等）";
  return clientId;
};
function time(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

/**
 * MCP 进度看板：网页版 AI 超时/上下文满之后，靠这里判断"干到哪了"，
 * 并一键生成可粘回新对话的交接卡。
 */
export function ProgressPage(): JSX.Element {
  const [sessions, setSessions] = useState<ProgressSession[]>([]);
  const [selected, setSelected] = useState<ProgressSession | null>(null);
  const [handoff, setHandoff] = useState<string>("");
  const [nameInput, setNameInput] = useState("");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(() => localStorage.getItem("c2c.progress.auto") === "1");
  const [intervalSec, setIntervalSec] = useState<number>(() => Number(localStorage.getItem("c2c.progress.interval") ?? 10) || 10);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const autoProject = (session: ProgressSession | null): string | undefined => session?.autoProject ?? undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveLabel(sessionId: string, name: string | null): Promise<void> {
    const cleaned = name?.trim() ? name.trim() : null;
    // 本地也存一份：IPC 万一失败，界面仍记得名字。
    try {
      const local = JSON.parse(localStorage.getItem("c2c.progress.labels") ?? "{}") as Record<string, string>;
      if (cleaned) local[sessionId] = cleaned; else delete local[sessionId];
      localStorage.setItem("c2c.progress.labels", JSON.stringify(local));
    } catch { /* 忽略本地缓存损坏 */ }
    // 先本地更新：即使随后刷新失败，界面也不会"看着像没保存"。
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, project: cleaned ?? s.autoProject ?? s.project } : s)));
    setSelected((prev) => (prev && prev.id === sessionId ? { ...prev, project: cleaned ?? prev.autoProject ?? prev.project } : prev));
    try {
      await window.c2c.progress.label(sessionId, cleaned);
      setSavedLabel(sessionId);
      window.setTimeout(() => setSavedLabel(null), 1500);
    } catch (cause) {
      setError(`命名保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function refresh(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.c2c.progress.sessions()) as { sessions: ProgressSession[] };
      let local: Record<string, string> = {};
      try { local = JSON.parse(localStorage.getItem("c2c.progress.labels") ?? "{}") as Record<string, string>; } catch { local = {}; }
      const merged: ProgressSession[] = (res.sessions ?? []).map((s) => (local[s.id] ? { ...s, project: local[s.id] ?? null } : s));
      setSessions(merged);
      setSelected((prev) => (prev ? merged.find((s) => s.id === prev.id) ?? merged[0] ?? null : merged[0] ?? null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // 自动刷新默认关闭；开启后按用户选的秒数刷新。
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), Math.max(3, intervalSec) * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, intervalSec]);

  async function makeHandoff(session: ProgressSession, full = false): Promise<void> {
    setBusy(true);
    try {
      const res = await window.c2c.progress.handoff(session.id, { full });
      setHandoff(res.markdown);
      await navigator.clipboard.writeText(res.markdown).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // 断点按文件分组，同文件的多次写入折叠成一条时间线。
  const checkpointGroups = selected
    ? Object.values(selected.checkpoints.reduce((acc: Record<string, { file: string; items: typeof selected.checkpoints }>, c) => {
      const key = c.detail;
      if (!acc[key]) acc[key] = { file: key, items: [] as typeof selected.checkpoints };
      acc[key].items.push(c);
      return acc;
    }, {} as Record<string, { file: string; items: typeof selected.checkpoints }>))
    : [];

  const checkpointText = checkpointGroups.length === 0
    ? "本次会话还没有已提交的写入（没有断点）。"
    : checkpointGroups.map((group) => [
      `## ${group.file}`,
      ...group.items.map((c) => `- ${new Date(c.at).toLocaleString()}｜${c.hash ? c.hash.slice(0, 12) : "无哈希"}｜${c.bytes ?? "?"} B`),
    ].join("\n")).join("\n\n");

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div>
          <h1>MCP 进度</h1>
          <p>按时间间隔把工具调用聚成"会话"；断点在最上面，超时或上下文满了就复制交接卡。</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={autoRefresh}
              onChange={(e) => { setAutoRefresh(e.target.checked); localStorage.setItem("c2c.progress.auto", e.target.checked ? "1" : "0"); }} />
            自动刷新
          </label>
          <select className="input" style={{ width: 90 }} value={intervalSec} disabled={!autoRefresh}
            onChange={(e) => { const v = Number(e.target.value) || 10; setIntervalSec(v); localStorage.setItem("c2c.progress.interval", String(v)); }}>
            {[5, 10, 15, 30, 60].map((s) => <option key={s} value={s}>{s} 秒</option>)}
          </select>
          <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && <p className="err">{error}</p>}

      <section className="card">
        <div className="section-title">选择会话（{sessions.length}）· 点铅笔可改名</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => { if (editingId !== session.id) { setSelected(session); setHandoff(""); } }}
              style={{
                textAlign: "left",
                cursor: "pointer",
                padding: "6px 10px",
                borderRadius: 8,
                border: selected?.id === session.id ? "1px solid #2563eb" : "1px solid #d6dde8",
                background: selected?.id === session.id ? "#eff6ff" : "#fff",
                maxWidth: 340,
              }}
            >
              {editingId === session.id ? (
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input className="input" autoFocus style={{ width: 150, fontSize: 12 }} value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { void saveLabel(session.id, editingValue); setEditingId(null); }
                      if (e.key === "Escape") setEditingId(null);
                    }} />
                  <button className="btn" type="button" style={{ padding: "2px 6px" }}
                    onClick={() => { void saveLabel(session.id, editingValue); setEditingId(null); }}>保存</button>
                  <button className="btn secondary" type="button" style={{ padding: "2px 6px" }}
                    onClick={() => setEditingId(null)}>取消</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <strong style={{ fontSize: 13 }}>{session.project ?? "（未识别项目）"}</strong>
                  {savedLabel === session.id && <span style={{ color: "#15803d", fontSize: 11 }}>已保存</span>}
                  <span
                    role="button"
                    title="重命名"
                    style={{ cursor: "pointer", fontSize: 12, color: "#2563eb" }}
                    onClick={(e) => { e.stopPropagation(); setEditingId(session.id); setEditingValue(session.project ?? ""); }}
                  >✎</span>
                </div>
              )}
              <span className={"v2-badge " + (session.active ? "warn" : "pass")} style={{ marginLeft: 6 }}>
                {session.active ? "进行中" : "已结束"}
              </span>
              <div className="muted" style={{ fontSize: 11 }}>
                {new Date(session.startedAt).toLocaleTimeString()} → {new Date(session.endedAt).toLocaleTimeString()} · {session.calls} 次
                {session.failures > 0 ? ` · 失败 ${session.failures}` : ""}
              </div>
            </div>
          ))}
        </div>
      </section>

      {!selected && <p className="muted" style={{ marginTop: 12 }}>选一个会话查看详情。</p>}

      {selected && (
        <>
          <section className="card" style={{ marginTop: 12, borderLeft: "4px solid #2563eb" }}>
            <div className="section-title">断点（按文件分组，含版本哈希）· {selected.checkpoints.length} 个</div>
            {checkpointGroups.length === 0 && <p className="muted">本次会话还没有已提交的写入。</p>}
            {checkpointGroups.map((group) => (
              <div key={group.file} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{group.file}</div>
                {group.items.map((c, i) => (
                  <div key={i} className="muted" style={{ fontSize: 12, marginLeft: 10 }}>
                    {new Date(c.at).toLocaleString()} · {c.kind} · {c.hash ? c.hash.slice(0, 12) : "无哈希"} · {c.bytes ?? "?"} B
                  </div>
                ))}
              </div>
            ))}
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(checkpointText)}>复制断点清单</button>
            </div>
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <div className="section-title">概览</div>
            <div className="kv">
              <div className="k">项目线索</div><div className="v">{selected.project ?? "未识别"}</div>
              <div className="k">调用方</div><div className="v">{CLIENT_LABEL(selected.clientId)}</div>
              <div className="k">时间范围</div><div className="v">{time(selected.startedAt)} → {time(selected.endedAt)}</div>
              <div className="k">调用 / 失败</div><div className="v">{selected.calls} / {selected.failures}</div>
              <div className="k">工具分布</div><div className="v">{selected.tools.map((t) => `${t.name}×${t.count}`).join("、")}</div>
            </div>
          </section>

          {selected.commands.length > 0 && (
            <section className="card" style={{ marginTop: 12 }}>
              <div className="section-title">执行过的命令</div>
              <pre className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap", margin: 0 }}>{selected.commands.join("\n")}</pre>
            </section>
          )}

          <section className="card" style={{ marginTop: 12 }}>
            <div className="section-title">最近 15 次调用（真实记录）</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {selected.recent.map((call, index) => {
                const note = annotateTool(call.tool, "", "");
                return (
                  <div key={`${call.at}-${index}`} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 10px" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span className="muted" style={{ fontSize: 12 }}>{new Date(call.at).toLocaleTimeString()}</span>
                      <strong style={{ fontSize: 13 }}>{call.tool}</strong>
                      <span style={{ fontSize: 12, color: call.ok ? "#15803d" : "#b91c1c" }}>
                        {call.ok ? "成功" : `失败 ${call.errorCode ?? ""}`}
                      </span>
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>{note.zh}</div>
                    {call.target && <div style={{ fontSize: 12, overflowWrap: "anywhere", marginTop: 2 }}>{call.target}</div>}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card" style={{ marginTop: 12 }}>
            <div className="section-title">交接</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" type="button" disabled={busy} onClick={() => void makeHandoff(selected, false)}>复制简短交接卡</button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => void makeHandoff(selected, true)}>复制完整交接卡</button>
            </div>
            {handoff && <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12 }}>{handoff}</pre>}
          </section>
        </>
      )}
    </div>
  );
}
