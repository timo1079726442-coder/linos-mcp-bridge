import React, { useCallback, useEffect, useState } from "react";

interface PeerInfo {
  port: number;
  reachable: boolean;
  name: string | null;
  version: string | null;
  authMode: string | null;
  toolCount: number | null;
  tools: Array<{ name: string; registered: boolean; description: string; group: string; conditional: boolean; risk?: string; enabled?: boolean; approval?: string }>;
  dangerousMode: {
    enabled: boolean;
    autoApprovePreparedWrites: boolean;
    exposeDirectWriteFile: boolean;
    allowCreate: boolean;
    allowOverwrite: boolean;
    allowDelete: boolean;
    allowMove: boolean;
    allowShell: boolean;
  } | null;
  roots: Array<{ id: string; path: string; access: string }>;
  chatgptConnectorUrl: string | null;
  publicBaseUrl: string | null;
  session: {
    expired: boolean | null;
    createdAt: string | null;
    expiresAt: string | null;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    clientCount: number;
  } | null;
  audit: {
    exists: boolean;
    lastWriteAt: string | null;
    minutesSinceLastCall: number | null;
  } | null;
  findings: string[];
  checkedAt: number;
}

const GREEN = "var(--green)";
const RED = "var(--red)";
const AMBER = "var(--yellow)";
const MUTED = "var(--text-muted)";

function ago(minutes: number | null): string {
  if (minutes == null) return "无记录";
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

/**
 * 本机 MCP 服务实时状态卡。
 * 数据来自该服务自己的 /tools 与配置文件（只读），不依赖 Supervisor，
 * 用来替代原来总览页上的"工具数：未核实"。
 */
export function PeerStatusCard({
  port = 48766,
  role = "测试",
}: {
  port?: number;
  role?: string;
}): JSX.Element {
  const [info, setInfo] = useState<PeerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const createPairing = useCallback(async (): Promise<void> => {
    setBusy("pairing");
    setActionMsg(null);
    setPairingCode(null);
    try {
      const r = await window.c2c.service.createPairing(port);
      setPairingCode(r.code);
      setActionMsg(`配对码有效期至 ${new Date(r.expiresAt).toLocaleTimeString()}`);
    } catch (e) {
      setActionMsg(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [port]);

  const clearPairing = useCallback(async (): Promise<void> => {
    setBusy("pairing-clear");
    setActionMsg(null);
    try {
      await window.c2c.service.clearPairing(port);
      setPairingCode(null);
      setActionMsg("已清除会话与配对码");
    } catch (e) {
      setActionMsg(`清除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [port]);

  const act = useCallback(
    async (kind: "runtime" | "transport"): Promise<void> => {
      setBusy(kind);
      setActionMsg(null);
      try {
        if (kind === "runtime") {
          await window.c2c.service.restartRuntime();
          setActionMsg("已重启我们的服务");
        } else {
          const r = await window.c2c.service.restartTransport();
          setActionMsg(`已重启隧道（${r.provider} : ${r.port}）`);
        }
      } catch (e) {
        setActionMsg(`失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
        await new Promise((r) => setTimeout(r, 1500));
        try {
          setInfo(await window.c2c.peer.inspect(port));
        } catch {
          /* 忽略 */
        }
      }
    },
    [port],
  );

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const r = await window.c2c.peer.inspect(port);
      setInfo(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [port]);

  useEffect(() => {
    void load();
    // 该卡片依赖的后台服务可能仍在启动，定期自愈，避免显示成"没在监听"。
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const reachable = info?.reachable === true;
  const toolOk = (info?.toolCount ?? 0) > 0;
  const sessionOk = info?.session ? info.session.expired === false : null;

  const accent = !reachable ? RED : toolOk ? GREEN : AMBER;
  const summary = !info
    ? "读取中…"
    : !reachable
      ? `端口 ${port} 上没有服务在监听`
      : info.name
        ? `${info.name} ${info.version ?? ""} 正在运行`
        : `端口 ${port} 有服务响应`;

  return (
    <section
      className="card"
      style={{
        marginTop: 12,
        borderLeft: `3px solid ${accent}`,
        paddingTop: 12,
      }}
      data-testid="peer-status-card"
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: accent,
            boxShadow: `0 0 8px ${accent}`,
            flex: "none",
          }}
        />
        <strong style={{ fontSize: 14, letterSpacing: 0.3 }}>
          {role} · {port}
        </strong>
        <span style={{ color: MUTED, fontSize: 12 }}>{summary}</span>
        <button
          className="btn secondary"
          type="button"
          style={{ marginLeft: "auto", padding: "4px 12px", fontSize: 12 }}
          onClick={() => void load()}
          disabled={loading}
          data-testid="btn-peer-status-refresh"
        >
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>

      {port === 48767 && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
          <button
            className="btn"
            type="button"
            style={{ padding: "5px 14px", fontSize: 13 }}
            disabled={busy !== null}
            onClick={() => void act("runtime")}
            data-testid="btn-restart-runtime"
          >
            {busy === "runtime" ? "重启中…" : "重启我们的服务"}
          </button>
          <button
            className="btn secondary"
            type="button"
            style={{ padding: "5px 14px", fontSize: 13 }}
            disabled={busy !== null}
            onClick={() => void act("transport")}
            data-testid="btn-restart-transport"
          >
            {busy === "transport" ? "重启中…" : "重启隧道"}
          </button>
          <button
            className="btn"
            type="button"
            style={{ padding: "5px 14px", fontSize: 13 }}
            disabled={busy !== null}
            onClick={() => void createPairing()}
            data-testid="btn-create-pairing"
          >
            {busy === "pairing" ? "生成中…" : "生成配对码"}
          </button>
          <button
            className="btn secondary"
            type="button"
            style={{ padding: "5px 14px", fontSize: 13 }}
            disabled={busy !== null}
            onClick={() => void clearPairing()}
            data-testid="btn-clear-pairing"
          >
            {busy === "pairing-clear" ? "清除中…" : "清除会话"}
          </button>
          {pairingCode && (
            <code
              data-testid="pairing-code-value"
              style={{
                fontSize: 18,
                letterSpacing: 3,
                padding: "4px 12px",
                borderRadius: 8,
                border: "1px solid rgba(61,220,132,0.45)",
                background: "rgba(61,220,132,0.10)",
                alignSelf: "center",
              }}
            >
              {pairingCode}
            </code>
          )}
          {actionMsg && (
            <span style={{ color: MUTED, fontSize: 12, alignSelf: "center" }}>{actionMsg}</span>
          )}
        </div>
      )}

      {err && <div className="banner warn" role="status">读取失败：{err}</div>}

      {info && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
              gap: 10,
            }}
          >
            {[
              {
                label: "在线工具",
                value: info.toolCount != null ? `${info.toolCount} 个` : "未取得",
                ok: toolOk,
              },
              {
                label: "危险模式",
                value: info.dangerousMode
                  ? info.dangerousMode.enabled
                    ? "已开启"
                    : "未开启"
                  : "未知",
                ok: info.dangerousMode ? !info.dangerousMode.enabled || true : false,
              },
              {
                label: "授权文件夹",
                value: `${info.roots.length} 个`,
                ok: info.roots.length > 0,
              },
              {
                label: "会话",
                value:
                  sessionOk === null ? "未知" : sessionOk ? "有效" : "已过期",
                ok: sessionOk === true,
              },
              {
                label: "最后工具调用",
                value: ago(info.audit?.minutesSinceLastCall ?? null),
                ok: (info.audit?.minutesSinceLastCall ?? Infinity) < 1440,
              },
            ].map((c) => (
              <div
                key={c.label}
                style={{
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div style={{ color: MUTED, fontSize: 12 }}>{c.label}</div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 15,
                    fontWeight: 600,
                    color: c.ok ? GREEN : AMBER,
                  }}
                >
                  {c.value}
                </div>
              </div>
            ))}
          </div>

          {info.dangerousMode?.enabled && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <span style={{ color: MUTED }}>危险模式明细：</span>
              {[
                info.dangerousMode.autoApprovePreparedWrites ? "自动批准" : null,
                info.dangerousMode.allowCreate ? "新建" : null,
                info.dangerousMode.allowOverwrite ? "覆盖" : null,
                info.dangerousMode.allowDelete ? "删除" : null,
                info.dangerousMode.allowMove ? "移动" : null,
                info.dangerousMode.allowShell ? "Shell" : null,
                info.dangerousMode.exposeDirectWriteFile ? "直写入口" : null,
              ]
                .filter(Boolean)
                .join("、")}
            </div>
          )}

          {info.roots.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <span style={{ color: MUTED }}>授权目录：</span>
              {info.roots.map((r) => `${r.id}(${r.access})`).join("、")}
            </div>
          )}

          {info.findings.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {info.findings.map((f, i) => (
                <div key={i} style={{ color: MUTED, fontSize: 12, padding: "2px 0" }}>
                  · {f}
                </div>
              ))}
            </div>
          )}

          {info.tools.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button
                className="btn secondary"
                type="button"
                onClick={() => setShowTools((v) => !v)}
                data-testid="btn-peer-toggle-tools"
              >
                {showTools ? "收起工具清单" : `展开全部 ${info.tools.length} 个工具`}
              </button>
              {showTools && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                  {info.tools.map((t) => (
                    <div
                      key={t.name}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 6,
                        border: "1px solid rgba(255,255,255,0.06)",
                        borderLeft: `3px solid ${t.conditional ? "#f0b429" : "#7aa2ff"}`,
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <code style={{ fontSize: 12, color: "var(--text)" }}>{t.name}</code>
                        {t.group ? (
                          <span style={{ fontSize: 11, color: MUTED }}>{t.group}</span>
                        ) : null}
                        {t.conditional ? (
                          <span style={{ fontSize: 11, color: AMBER }}>需授权</span>
                        ) : null}
                      </div>
                      {t.description ? (
                        <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.7 }}>
                          {t.description}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
