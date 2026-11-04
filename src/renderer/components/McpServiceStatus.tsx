import React, { useCallback, useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";

interface PeerInfo {
  reachable: boolean;
  toolCount: number | null;
  findings: string[];
}

interface AuditInfo {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  path: string;
}

export function McpServiceStatus(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [peer, setPeer] = useState<PeerInfo | null>(null);
  const [audit, setAudit] = useState<AuditInfo | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const active = await window.c2c.profile.getActive();
      setProfile(active);
      if (!active) return;
      const port = active.transport.expectedLocalPort;
      const [inspection, auditStatus] = await Promise.all([
        window.c2c.peer.inspect(port).catch(() => null),
        window.c2c.audit.toolStatus().catch(() => null),
      ]);
      setPeer(inspection
        ? { reachable: true, toolCount: inspection.toolCount, findings: inspection.findings ?? [] }
        : { reachable: false, toolCount: null, findings: [] });
      setAudit(auditStatus);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, action: () => Promise<string>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      setMsg(await action());
      await load();
    } catch (cause) {
      setErr(`${label}失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  const port = profile?.transport.expectedLocalPort ?? null;
  const mcpUrl = profile?.transport.publicMcpUrl ?? (port ? `http://127.0.0.1:${port}/mcp` : "");

  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="mcp-service-status">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div className="section-title" style={{ margin: 0 }}>当前 MCP 服务</div>
        <button className="btn secondary" type="button" onClick={() => void load()} disabled={busy}>
          {busy ? "处理中…" : "刷新"}
        </button>
      </div>

      {err && <div className="banner error" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      {msg && <div className="banner" style={{ marginTop: 8 }}>{msg}</div>}

      {!profile ? (
        <p className="muted" style={{ marginTop: 8 }}>还没有当前 Profile。用下面的向导新建一个 MCP 服务。</p>
      ) : (
        <>
          <div className="kv" style={{ marginTop: 10 }}>
            <div className="k">端口</div><div className="v">{port}</div>
            <div className="k">Profile</div><div className="v">{profile.profileName}</div>
            <div className="k">工作区</div><div className="v"><code>{profile.currentWorkspace.root ?? "未绑定"}</code></div>
            <div className="k">传输</div><div className="v">{profile.transport.provider ?? "LOCAL_ONLY"}</div>
            <div className="k">MCP URL</div><div className="v"><code>{mcpUrl}</code></div>
            <div className="k">Runtime</div>
            <div className="v">{peer ? (peer.reachable ? "在线" : "不可达") : "读取中…"}</div>
            <div className="k">工具数</div><div className="v">{peer?.toolCount ?? "未知"}</div>
            <div className="k">审计链</div>
            <div className="v">
              {!audit ? "读取中…" : audit.ok
                ? `完整（${audit.entries} 条）`
                : `断裂于第 ${audit.brokenAt ?? "?"} 条（共 ${audit.entries} 条）`}
            </div>
            {audit?.path && <><div className="k">审计文件</div><div className="v"><code>{audit.path}</code></div></>}
          </div>

          {code && (
            <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 10 }}>
              <span className="muted" style={{ fontSize: 12 }}>配对码</span>
              <code style={{ fontSize: 17, letterSpacing: 3 }} data-testid="current-pairing-code">{code}</code>
              <span className="muted" style={{ fontSize: 12 }}>
                {expiresAt ? `有效期至 ${new Date(expiresAt).toLocaleTimeString()}` : ""}
              </span>
              <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(code)}>
                复制
              </button>
            </div>
          )}

          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" type="button" disabled={busy || !port} onClick={() => void run("生成配对码", async () => {
              const result = await window.c2c.service.createPairing(port ?? undefined);
              setCode(result.code);
              setExpiresAt(result.expiresAt);
              return "配对码已生成，一次性有效。";
            })}>
              获取配对码
            </button>
            <button className="btn secondary" type="button" disabled={!mcpUrl} onClick={() => void navigator.clipboard.writeText(mcpUrl)}>
              复制 MCP URL
            </button>
            <button className="btn secondary" type="button" onClick={() => void window.c2c.intent.openChatgpt()}>
              打开 ChatGPT
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => void run("重启 Runtime", async () => {
              await window.c2c.service.restartRuntime();
              return "已重启 Runtime。";
            })}>
              重启 Runtime
            </button>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => void run("重启隧道", async () => {
              const result = await window.c2c.service.restartTransport();
              return `已重启隧道（${result.provider} : ${result.port}）。`;
            })}>
              重启隧道
            </button>
          </div>

          {peer?.findings?.length ? (
            <div style={{ marginTop: 8 }}>
              {peer.findings.map((finding, index) => (
                <div key={index} className="muted" style={{ fontSize: 12 }}>· {finding}</div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
