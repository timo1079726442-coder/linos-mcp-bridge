import React, { useCallback, useEffect, useMemo, useState } from "react";

interface LogEntry {
  ts: string;
  source: string;
  event: string;
  detail: string;
}

interface LogsResult {
  entries: LogEntry[];
  sources: Array<{ name: string; path: string; bytes: number; lastWriteAt: string | null }>;
  truncated: boolean;
  stateRoot: string;
}

const MUTED = "#8b98ab";

const SOURCE_LABEL: Record<string, string> = {
  audit: "审计",
  execution: "执行",
  system: "系统",
};

const SOURCE_COLOR: Record<string, string> = {
  audit: "#7aa2ff",
  execution: "#3ddc84",
  system: "#f0b429",
};

function fmtTime(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

function fmtBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function LogsPage(): JSX.Element {
  const [data, setData] = useState<LogsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      setData(await window.c2c.logs.read(500));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const list = data?.entries ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((e) => {
      if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        e.event.toLowerCase().includes(q) ||
        e.detail.toLowerCase().includes(q) ||
        e.ts.includes(q)
      );
    });
  }, [data, query, sourceFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: data?.entries.length ?? 0 };
    for (const e of data?.entries ?? []) c[e.source] = (c[e.source] ?? 0) + 1;
    return c;
  }, [data]);

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div>
          <h1>日志</h1>
          <p>来自本机审计链与执行记录的真实内容，敏感值在进入界面前已脱敏。</p>
        </div>
        <button className="btn" type="button" onClick={() => void load()} disabled={loading}>
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>

      {err && (
        <div className="banner warn" role="status">
          读取失败：{err}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))",
              gap: 10,
              marginBottom: 12,
            }}
          >
            {data.sources.length === 0 && (
              <div style={{ color: MUTED, fontSize: 13 }}>没有找到日志来源。</div>
            )}
            {data.sources.map((s) => (
              <div
                key={s.path}
                style={{
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div style={{ color: MUTED, fontSize: 12 }}>{s.name}</div>
                <div style={{ marginTop: 4, fontSize: 14, fontWeight: 600 }}>{fmtBytes(s.bytes)}</div>
                <div style={{ color: MUTED, fontSize: 11, marginTop: 2 }}>
                  最后写入 {fmtTime(s.lastWriteAt ?? "")}
                </div>
              </div>
            ))}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            {["all", "audit", "execution", "system"].map((k) => (
              <button
                key={k}
                type="button"
                className={sourceFilter === k ? "btn" : "btn secondary"}
                onClick={() => setSourceFilter(k)}
                style={{ padding: "4px 12px", fontSize: 12 }}
              >
                {k === "all" ? "全部" : SOURCE_LABEL[k] ?? k} ({counts[k] ?? 0})
              </button>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索事件、内容或时间"
              style={{
                marginLeft: "auto",
                minWidth: 240,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent",
                color: "inherit",
                fontSize: 13,
              }}
            />
          </div>

          {data.truncated && (
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              日志很大，只读取了最近的一部分。
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filtered.length === 0 && (
              <div style={{ color: MUTED, fontSize: 13, padding: "16px 0" }}>没有匹配的记录。</div>
            )}
            {filtered.map((e, i) => (
              <div
                key={`${e.ts}-${i}`}
                style={{
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderLeft: `3px solid ${SOURCE_COLOR[e.source] ?? MUTED}`,
                  borderRadius: 6,
                  padding: "7px 10px",
                  cursor: "pointer",
                }}
                onClick={() => setExpanded(expanded === i ? null : i)}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <code style={{ fontSize: 11, color: MUTED, minWidth: 138 }}>{fmtTime(e.ts)}</code>
                  <span style={{ fontSize: 11, color: SOURCE_COLOR[e.source] ?? MUTED }}>
                    {SOURCE_LABEL[e.source] ?? e.source}
                  </span>
                  <span style={{ fontSize: 13 }}>{e.event}</span>
                </div>
                {expanded === i && (
                  <pre
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: MUTED,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 260,
                      overflow: "auto",
                    }}
                  >
                    {e.detail || "(无附加内容)"}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
