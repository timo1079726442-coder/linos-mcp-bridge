import { useEffect, useState } from "react";

interface AiRequest {
  id: string;
  file: string;
  at: string;
  kind: "git_init" | "git_fetch" | "git_push" | "note" | "enable_dir_read";
  title: string;
  reason: string;
  detail: string;
  status: "pending" | "approved" | "rejected";
}

const KIND_LABEL: Record<AiRequest["kind"], string> = {
  git_init: "初始化 Git 仓库",
  git_fetch: "拉取远端（git fetch）",
  git_push: "推送当前分支（git push，不带 force）",
  enable_dir_read: "申请读取某目录",
  note: "其它说明",
};

const STATUS_LABEL: Record<AiRequest["status"], string> = {
  pending: "待你确认",
  approved: "已批准",
  rejected: "已拒绝",
};

/**
 * AI 请求收件箱：AI 缺什么就写一个请求文件，这里列出来，你点批准/拒绝。
 * 批准只执行低风险动作（目前只有 git init），其它只记录决定。
 */
export function RequestsPage(): JSX.Element {
  const [requests, setRequests] = useState<AiRequest[]>([]);
  const [dir, setDir] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = (await window.c2c.requests.list()) as { dir: string; dirs?: string[]; requests: AiRequest[] };
      setDir(res.dir);
      setDirs(res.dirs ?? []);
      setRequests(res.requests);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function decide(file: string, approve: boolean): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      if (approve) {
        const res = (await window.c2c.requests.approve(file)) as { executed: string; output?: string };
        setResult(`已批准：${res.executed}${res.output ? ` → ${res.output}` : ""}`);
      } else {
        await window.c2c.requests.reject(file);
        setResult("已拒绝");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div>
          <h1>AI 请求</h1>
          <p>AI 缺权限、缺仓库、缺目录时写一个请求文件到这里；你批准后只执行低风险动作。</p>
        </div>
        <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? "读取中…" : "刷新"}
        </button>
      </div>

      {error && <p className="err">{error}</p>}
      {result && <p className="muted" style={{ fontSize: 12 }}>{result}</p>}

      <section className="card">
        <div className="section-title">待确认（{pending.length}）</div>
        <p className="muted" style={{ fontSize: 12 }}>扫描到 {dirs.length} 个请求目录（含子项目）：{dirs.length === 0 ? <code>{dir}</code> : dirs.map((d) => <div key={d}><code>{d}</code></div>)}</p>
        {pending.length === 0 && <p className="muted">没有待确认的请求。</p>}
        {pending.map((request) => (
          <div key={request.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <strong>{request.title}</strong>
              <span className="v2-badge">{KIND_LABEL[request.kind]}</span>
              <span className="muted" style={{ fontSize: 12 }}>{new Date(request.at).toLocaleString()}</span>
            </div>
            {request.reason && <div style={{ fontSize: 12, marginTop: 4 }}>{request.reason}</div>}
            {request.detail && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{request.detail}</div>}
            <div className="row" style={{ gap: 8, marginTop: 6 }}>
              <button className="btn" type="button" disabled={busy} onClick={() => void decide(request.id, true)}>批准</button>
              <button className="btn secondary" type="button" disabled={busy} onClick={() => void decide(request.id, false)}>拒绝</button>
            </div>
          </div>
        ))}
      </section>

      {decided.length > 0 && (
        <section className="card" style={{ marginTop: 12 }}>
          <div className="section-title">已处理（{decided.length}）</div>
          {decided.map((request) => (
            <div key={request.id} className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {new Date(request.at).toLocaleString()} · {request.title} · {STATUS_LABEL[request.status]}
            </div>
          ))}
        </section>
      )}

      <section className="card" style={{ marginTop: 12 }}>
        <div className="section-title">怎么让 AI 发请求（把这段给它）</div>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{`如果你缺能力（例如工作区不是 git 仓库、需要读另一个目录），不要自己猜，
写一个文件到 <工作区>\\.c2c\\requests\\<简短英文名>.json：

{
  "at": "<当前时间 ISO>",
  "kind": "git_init" | "git_fetch" | "git_push" | "enable_dir_read" | "note",
  "title": "一句话说明你要什么",
  "reason": "为什么需要",
  "detail": "补充信息，例如目录路径"
}

然后用 commit_operation 提交。人在控制中心「诊断与日志 → AI 请求」里批准或拒绝。
批准后我会收到你写入的结果；在此之前不要假设已经获得权限。`}</pre>
      </section>
    </div>
  );
}
