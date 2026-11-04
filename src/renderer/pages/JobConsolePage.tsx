import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

type JobRow = {
  job_id?: string;
  id?: string;
  state: string;
  kind: string;
  attempts: number;
  duration_ms?: number;
  durationMs?: number;
  output_bytes?: number;
  outputBytes?: number;
  progress: string;
  error_code?: string;
  errorCode?: string;
  finished_at?: string | null;
  finishedAt?: string | null;
  display: string;
};

type JobOutput = {
  output: string;
  nextOffset: number;
  next_offset?: number;
  eof: boolean;
  truncated: boolean;
};

function jobIdOf(row: JobRow): string {
  const id = row.job_id ?? row.id ?? "";
  if (!id) throw new Error("JOB_ID_REQUIRED");
  return id;
}

function durationOf(row: JobRow): number {
  return row.duration_ms ?? row.durationMs ?? 0;
}

function outputBytesOf(row: JobRow): number {
  return row.output_bytes ?? row.outputBytes ?? 0;
}

export function JobConsolePage(): JSX.Element {
  const [rows, setRows] = useState<JobRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobRow | null>(null);
  const [output, setOutput] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timer = useRef<number | null>(null);

  const loadList = useCallback(async () => {
    try {
      const list = (await window.c2c.jobs.list(50)) as unknown as JobRow[];
      setRows(Array.isArray(list) ? list : []);
      setError(null);
      return Array.isArray(list) ? list : [];
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return [];
    }
  }, []);

  const loadDetail = useCallback(async (id: string, nextOffset: number, append: boolean) => {
    try {
      const status = (await window.c2c.jobs.get(id)) as unknown as JobRow;
      const out = (await window.c2c.jobs.output({ id, offset: nextOffset, maxBytes: 8192 })) as unknown as JobOutput;
      setDetail(status);
      if (out.output) setOutput((previous) => append ? `${previous}${out.output}` : out.output);
      setOffset(out.nextOffset ?? out.next_offset ?? nextOffset);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const list = await loadList();
      const running = list.find((item) => item.state === "RUNNING");
      const first = running ?? list[0] ?? null;
      if (first) {
        const id = jobIdOf(first);
        setSelectedId(id);
        setOutput("");
        setOffset(0);
        await loadDetail(id, 0, false);
      }
      setLoading(false);
    })();
  }, [loadDetail, loadList]);

  useEffect(() => {
    if (!autoRefresh || !selectedId) return;
    timer.current = window.setInterval(() => {
      void (async () => {
        if (!selectedId) return;
        const status = (await window.c2c.jobs.get(selectedId).catch(() => null)) as JobRow | null;
        if (!status) return;
        setDetail(status);
        if (status.state === "RUNNING") {
          await loadDetail(selectedId, offset, true);
        }
        await loadList();
      })();
    }, 3000);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [autoRefresh, selectedId, offset, loadDetail, loadList]);

  async function cancelSelected(): Promise<void> {
    if (!selectedId) return;
    if (!window.confirm("确定要取消这条后台任务吗？正在运行的进程会被尽力终止。")) return;
    try {
      await window.c2c.jobs.cancel(selectedId);
      await loadDetail(selectedId, offset, true);
      await loadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function copyResumeCommand(): Promise<void> {
    if (!selectedId) return;
    await navigator.clipboard.writeText(`job_resume ${selectedId}`).catch(() => undefined);
  }

  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">后台任务</div>
          <p className="muted v2-subtitle">长任务在这里续跑：新增任务由 ChatGPT 发起，本控制台只做状态、输出与取消。断线后回来用同一个任务 ID 继续轮询。</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" type="button" onClick={() => void (async () => { await loadList(); if (selectedId) await loadDetail(selectedId, 0, false); })()}>刷新</button>
          <label className="muted" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> 自动续跑
          </label>
          <Link className="btn secondary" to="/services">服务详情</Link>
        </div>
      </div>

      {error && <div className="banner error" role="alert">{error}</div>}
      {loading ? <p className="muted">读取中…</p> : (
        <div className="v2-grid-2">
          <section className="v2-card" aria-label="后台任务列表">
            <div className="v2-card-head"><strong>任务列表</strong><span className="muted" style={{ fontSize: 12 }}>{`共 ${rows.length} 个`}</span></div>
            {rows.length === 0 ? (
              <div className="v2-empty">
                <p>还没有后台任务。在 ChatGPT 里调用 <code>start_job</code> 后这里会出现可续跑的任务。</p>
              </div>
            ) : (
              <div className="v2-table" role="table" aria-label="后台任务">
                <div className="v2-tr v2-tr-jobs v2-th" role="row"><span>任务</span><span>状态</span><span>耗时</span><span>输出</span><span>操作</span></div>
                {rows.map((row) => {
                  const id = jobIdOf(row);
                  return (
                    <div
                      className="v2-tr v2-tr-jobs"
                      role="row"
                      key={id}
                      style={{ cursor: "pointer" }}
                      onClick={() => { setSelectedId(id); setOutput(""); setOffset(0); void loadDetail(id, 0, false); }}
                    >
                      <span><strong>{id}</strong><small className="muted">{row.display || row.kind}</small></span>
                      <span><span className={`v2-badge ${row.state === "SUCCEEDED" ? "pass" : row.state === "FAILED" || row.state === "TIMED_OUT" ? "fail" : row.state === "RUNNING" || row.state === "QUEUED" ? "warn" : ""}`}>{row.state}</span></span>
                      <span>{Math.floor(durationOf(row) / 1000)}s</span>
                      <span>{outputBytesOf(row)} B</span>
                      <span className="v2-actions">
                        <button className="btn secondary" type="button" onClick={() => { setSelectedId(id); setOutput(""); setOffset(0); void loadDetail(id, 0, false); }}>查看</button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="v2-card" aria-label="任务详情">
            <div className="v2-card-head"><strong>任务详情</strong>{detail ? <span className="muted" style={{ fontSize: 12 }}>{detail.job_id ?? detail.id}</span> : null}</div>
            {!detail ? (
              <p className="muted">选择左侧任务查看可恢复的执行状态与输出。</p>
            ) : (
              <>
                <div className="kv">
                  <div className="k">状态</div><div className="v">{detail.state}</div>
                  <div className="k">进度</div><div className="v">{detail.progress}</div>
                  <div className="k">尝试</div><div className="v">{detail.attempts}</div>
                  <div className="k">错误</div><div className="v">{detail.error_code ?? detail.errorCode ?? "无"}</div>
                  <div className="k">结束</div><div className="v">{detail.finished_at ?? detail.finishedAt ?? "未结束"}</div>
                </div>
                <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button className="btn secondary" type="button" disabled={!selectedId || detail.state !== "RUNNING" && detail.state !== "QUEUED"} onClick={() => void cancelSelected()}>取消任务</button>
                  <button className="btn secondary" type="button" disabled={!selectedId} onClick={() => void copyResumeCommand()}>复制 resume 命令</button>
                  <button className="btn secondary" type="button" disabled={!selectedId} onClick={() => { setOutput(""); setOffset(0); if (selectedId) void loadDetail(selectedId, 0, false); }}>从头读取输出</button>
                </div>
                <pre className="v2-pre" style={{ marginTop: 10, maxHeight: 320 }}>{output || "暂无输出。"}</pre>
                <p className="muted" style={{ fontSize: 12 }}>resume 需要回到 ChatGPT 用同一身份调用 <code>{`job_resume ${selectedId ?? ""}`}</code>重新审批后排队同一任务。</p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
