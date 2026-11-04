import React, { useCallback, useEffect, useState } from "react";
import { annotateTool } from "../lib/toolGlossary.ts";

interface DiscoveredService {
  port: number;
  reachable: boolean;
  kind: string;
  name: string | null;
  version: string | null;
  source: string;
  hasTools: boolean | null;
}

interface DiscoveryResult {
  services: DiscoveredService[];
  expected: Array<{ kind: string; label: string; present: boolean; port: number | null }>;
  checkedPorts: number[];
  checkedAt: number;
}

interface ToolRow {
  name: string;
  description: string;
  group: string;
  conditional: boolean;
}

interface PeerDetail {
  reachable: boolean;
  toolCount: number | null;
  tools: ToolRow[];
  dangerousMode: Record<string, boolean> | null;
  roots: Array<{ id: string; path: string; access: string }>;
  session: { expired: boolean | null; expiresAt: string | null } | null;
  audit: { minutesSinceLastCall: number | null } | null;
  findings: string[];
  publicBaseUrl: string | null;
}

const MUTED = "var(--text-muted)";
const GREEN = "var(--green)";
const AMBER = "var(--yellow)";
const RED = "var(--red)";
const BLUE = "var(--accent)";

const KIND_META: Record<string, { label: string; color: string; ours: boolean }> = {
  "our-runtime": { label: "我们的服务", color: BLUE, ours: true },
  "local-files-mcp": { label: "Legacy MCP", color: GREEN, ours: false },
  "company-bridge": { label: "保留实例桥", color: AMBER, ours: false },
  unknown: { label: "未知服务", color: MUTED, ours: false },
};

const SOURCE_LABEL: Record<string, string> = {
  profile: "Profile 配置",
  "peer-config": "对方配置文件",
  known: "已知端口",
};

function ago(min: number | null): string {
  if (min == null) return "无记录";
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时前`;
  return `${Math.floor(min / 1440)} 天前`;
}

export function ServiceOverview(): JSX.Element {
  const [data, setData] = useState<DiscoveryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<PeerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const discover = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const r = await window.c2c.services.discover();
      setData(r);
      setSelected((prev) => {
        if (prev != null && r.services.some((s) => s.port === prev && s.reachable)) return prev;
        const first =
          r.services.find((s) => s.reachable && s.kind === "our-runtime") ??
          r.services.find((s) => s.reachable);
        return first ? first.port : null;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (port: number): Promise<void> => {
    setDetailLoading(true);
    try {
      const info = await window.c2c.peer.inspect(port);
      // 本机 V2 服务直接用真实审计时间；旧 POC 的 session.json/audit.jsonl 不再冒充。
      const isOurs = Array.isArray(info.tools) && (info as unknown as { kind?: string }).kind !== "peer";
      const self = isOurs ? await window.c2c.serviceSelf.lastCall().catch(() => null) : null;
      setDetail({
        reachable: info.reachable,
        toolCount: info.toolCount,
        tools: info.tools as ToolRow[],
        dangerousMode: info.dangerousMode as unknown as Record<string, boolean> | null,
        roots: info.roots,
        session: self ? null : info.session,
        audit: self ? { minutesSinceLastCall: self.minutesSinceLastCall } : info.audit,
        findings: info.findings,
        publicBaseUrl: info.publicBaseUrl,
      });
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void discover();
    const timer = setInterval(() => void discover(), 30_000);
    return () => clearInterval(timer);
  }, [discover]);

  useEffect(() => {
    if (selected != null) void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  const run = async (name: string, fn: () => Promise<string | null>): Promise<void> => {
    setBusy(name);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
    } catch (e) {
      setMsg(`失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
      await discover();
      if (selected != null) await loadDetail(selected);
    }
  };

  const sel = data?.services.find((s) => s.port === selected) ?? null;
  const meta = sel ? (KIND_META[sel.kind] ?? { label: "未知服务", color: MUTED, ours: false }) : null;
  const missing = (data?.expected ?? []).filter((e) => !e.present);

  return (
    <section className="card" style={{ marginTop: 12 }} data-testid="service-overview">
      {/* 顶部：发现状态 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>本机服务</strong>
        <span style={{ color: MUTED, fontSize: 12 }}>
          {data ? `检查 ${data.checkedPorts.length} 个端口 · 运行中 ${data.services.filter((s) => s.reachable).length} 个` : "发现中…"}
        </span>
        <button
          className="btn secondary"
          type="button"
          style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
          onClick={() => void discover()}
          disabled={loading}
          data-testid="btn-discover-refresh"
        >
          {loading ? "发现中…" : "重新发现"}
        </button>
      </div>

      {err && <div className="banner warn" role="status">发现失败：{err}</div>}

      {missing.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "9px 12px",
            borderRadius: 8,
            border: `1px solid ${AMBER}55`,
            background: "rgba(240,180,41,0.08)",
            fontSize: 13,
          }}
        >
          <div style={{ marginBottom: 6, color: AMBER }}>这几项没有发现：</div>
          {missing.map((m) => (
            <div key={m.kind} style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 0", flexWrap: "wrap" }}>
              <span>· {m.label}</span>
              <button
                className="btn secondary"
                type="button"
                style={{ padding: "2px 10px", fontSize: 12 }}
                disabled={busy !== null}
                onClick={() =>
                  void run(m.kind, async () => {
                    if (m.kind === "our-runtime") {
                      await window.c2c.service.restartRuntime();
                      return "已尝试重启我们的服务";
                    }
                    const target = m.port ?? (m.kind === "local-files-mcp" ? 48766 : 48765);
                    const rep = await window.c2c.connection.diagnose(target);
                    const bad = rep.stages.filter((s) => s.status === "FAIL");
                    return bad.length === 0
                      ? `端口 ${target} 检测通过`
                      : `端口 ${target} 有 ${bad.length} 项异常（${bad.map((b) => b.label).join("、")}）。该服务不归我们托管，请用它的面板处理。`;
                  })
                }
                data-testid={`btn-repair-${m.kind}`}
              >
                {busy === m.kind ? "处理中…" : "检测修复"}
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && (
        <div className="banner info" role="status" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      )}

      {/* 左右分栏 */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 14 }}>
        {/* 左：服务列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(data?.services ?? []).filter((s) => s.reachable).length === 0 && !loading && (
            <div style={{ color: MUTED, fontSize: 13 }}>没有发现运行中的服务。</div>
          )}
          {(data?.services ?? [])
            .filter((s) => s.reachable)
            .map((s) => {
              const m = KIND_META[s.kind] ?? { label: "未知服务", color: MUTED, ours: false };
              const active = s.port === selected;
              return (
                <button
                  key={s.port}
                  type="button"
                  onClick={() => setSelected(s.port)}
                  data-testid={`service-row-${s.port}`}
                  style={{
                    textAlign: "left",
                    padding: "9px 11px",
                    borderRadius: 8,
                    border: `1px solid ${active ? m.color : "rgba(255,255,255,0.08)"}`,
                    borderLeft: `3px solid ${m.color}`,
                    background: active ? "rgba(255,255,255,0.04)" : "transparent",
                    color: "inherit",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: m.color, flex: "none" }} />
                    <span style={{ fontSize: 13 }}>{m.label}</span>
                  </div>
                  <div style={{ color: MUTED, fontSize: 11, marginTop: 3 }}>
                    127.0.0.1:{s.port} · {SOURCE_LABEL[s.source] ?? s.source}
                  </div>
                </button>
              );
            })}

          {(data?.services ?? []).filter((s) => !s.reachable).length > 0 && (
            <div style={{ marginTop: 8, color: MUTED, fontSize: 11 }}>
              未监听：
              {(data?.services ?? [])
                .filter((s) => !s.reachable)
                .map((s) => s.port)
                .join("、")}
            </div>
          )}
        </div>

        {/* 右：详情 */}
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.06)", paddingLeft: 14 }}>
          {!sel && <div style={{ color: MUTED, fontSize: 13 }}>← 左边选一个服务看详情</div>}

          {sel && meta && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: meta.color }} />
                <strong style={{ fontSize: 15 }}>{meta.label}</strong>
                <code style={{ fontSize: 12, color: MUTED }}>
                  {sel.name ?? "?"} {sel.version ?? ""} · 127.0.0.1:{sel.port}
                </code>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))",
                  gap: 8,
                  marginTop: 10,
                }}
              >
                {[
                  {
                    label: "在线工具",
                    value: sel.hasTools === false
                      ? "不可枚举"
                      : detail?.toolCount != null ? `${detail.toolCount} 个` : "—",
                  },
                  { label: "授权文件夹", value: detail ? `${detail.roots.length} 个` : "—" },
                  {
                    label: "会话",
                    value: detail?.session ? (detail.session.expired ? "已过期" : "有效") : "按需生成（1 小时有效）",
                  },
                  { label: "最后调用", value: ago(detail?.audit?.minutesSinceLastCall ?? null) },
                ].map((c) => (
                  <div
                    key={c.label}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)" }}
                  >
                    <div style={{ color: MUTED, fontSize: 11 }}>{c.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{c.value}</div>
                  </div>
                ))}
              </div>

              {/* 我们的服务才有的操作 */}
              {meta.ours && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <button
                    className="btn"
                    type="button"
                    style={{ padding: "5px 14px", fontSize: 13 }}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("runtime", async () => {
                        await window.c2c.service.restartRuntime();
                        return "已重启我们的服务";
                      })
                    }
                    data-testid="btn-restart-runtime"
                  >
                    {busy === "runtime" ? "重启中…" : "重启服务"}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    style={{ padding: "5px 14px", fontSize: 13 }}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("transport", async () => {
                        const r = await window.c2c.service.restartTransport();
                        return `已重启隧道（${r.provider} : ${r.port}）`;
                      })
                    }
                    data-testid="btn-restart-transport"
                  >
                    {busy === "transport" ? "重启中…" : "重启隧道"}
                  </button>
                  <button
                    className="btn"
                    type="button"
                    style={{ padding: "5px 14px", fontSize: 13 }}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("pairing", async () => {
                        const r = await window.c2c.service.createPairing(sel.port);
                        setPairingCode(r.code);
                        return `配对码有效期至 ${new Date(r.expiresAt).toLocaleTimeString()}`;
                      })
                    }
                    data-testid="btn-create-pairing"
                  >
                    {busy === "pairing" ? "生成中…" : "生成配对码"}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    style={{ padding: "5px 14px", fontSize: 13 }}
                    disabled={busy !== null}
                    onClick={() =>
                      void run("clear", async () => {
                        await window.c2c.service.clearPairing(sel.port);
                        setPairingCode(null);
                        return "已清除会话与配对码";
                      })
                    }
                    data-testid="btn-clear-pairing"
                  >
                    {busy === "clear" ? "清除中…" : "清除会话"}
                  </button>
                  {pairingCode && (
                    <>
                      <code
                        style={{
                          fontSize: 17,
                          letterSpacing: 3,
                          padding: "4px 12px",
                          borderRadius: 8,
                          border: `1px solid ${GREEN}77`,
                          background: "rgba(61,220,132,0.10)",
                          alignSelf: "center",
                        }}
                        data-testid="pairing-code-value"
                      >
                        {pairingCode}
                      </code>
                      <button
                        className="btn secondary"
                        type="button"
                        style={{ padding: "5px 14px", fontSize: 13 }}
                        onClick={() => void navigator.clipboard.writeText(pairingCode).catch(() => undefined)}
                        data-testid="btn-copy-pairing"
                      >
                        复制配对码
                      </button>
                    </>
                  )}
                  <button
                    className="btn secondary"
                    type="button"
                    style={{ padding: "5px 14px", fontSize: 13 }}
                    onClick={() => void navigator.clipboard
                      .writeText(`http://127.0.0.1:${sel.port}/mcp`)
                      .catch(() => undefined)}
                    data-testid="btn-copy-mcp-url"
                  >
                    复制本机 MCP 地址
                  </button>
                </div>
              )}

              {detail?.findings && detail.findings.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {detail.findings.map((f, i) => (
                    <div key={i} style={{ color: MUTED, fontSize: 12, padding: "2px 0" }}>
                      · {f}
                    </div>
                  ))}
                </div>
              )}

              {/* 工具清单 */}
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>
                  工具清单{" "}
                  <span style={{ color: MUTED, fontSize: 12 }}>
                    {sel.hasTools === false
                      ? "不可枚举"
                      : detailLoading ? "读取中…" : `${detail?.tools.length ?? 0} 个`}
                  </span>
                </div>
                {sel.hasTools === false && (
                  <div style={{ color: MUTED, fontSize: 12 }}>
                    该服务没有 /tools 接口，也不提供会话/工具清单；这里只能确认端口在线。
                    它的配置由所属产品管理，本控制中心不会修改。
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 380, overflow: "auto" }}>
                  {(detail?.tools ?? []).map((t) => {
                    const a = annotateTool(t.name, t.description, t.group);
                    return (
                      <div
                        key={t.name}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 6,
                          border: "1px solid rgba(255,255,255,0.05)",
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <code style={{ fontSize: 12, color: "var(--text)" }}>{t.name}</code>
                          {a.group ? <span style={{ fontSize: 11, color: MUTED }}>{a.group}</span> : null}
                          {t.conditional ? <span style={{ fontSize: 11, color: AMBER }}>需授权</span> : null}
                        </div>
                        <div style={{ fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.7 }}>
                          {a.zh || "（无说明）"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
