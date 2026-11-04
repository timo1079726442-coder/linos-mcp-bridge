import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProfileConfig } from "../../shared/types.js";
import type { ManagedServiceView } from "../../shared/multiService.js";

type RowStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

interface ActiveRow {
  id: string;
  name: string;
  port: number;
  workspace: string;
  url: string;
  provider: string;
  status: RowStatus;
  toolCount: number | null;
  audit: string;
  current: true;
}

interface ExtraRow {
  id: string;
  name: string;
  port: number;
  workspace: string;
  url: string;
  provider: string;
  status: RowStatus;
  toolCount: null;
  audit: string;
  current: false;
}

type Row = ActiveRow | ExtraRow;

function statusOf(value: string | null | undefined): RowStatus {
  if (value === "RUNNING") return "PASS";
  if (value === "STOPPED") return "FAIL";
  return "UNKNOWN";
}

export function ServicesPage(): JSX.Element {
  const [active, setActive] = useState<ProfileConfig | null>(null);
  const [extras, setExtras] = useState<ManagedServiceView[]>([]);
  const [peer, setPeer] = useState<{ reachable: boolean; toolCount: number | null } | null>(null);
  const [audit, setAudit] = useState<{ ok: boolean; entries: number; brokenAt?: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const [profile, services] = await Promise.all([
        window.c2c.profile.getActive(),
        window.c2c.multiService.list().catch(() => []),
      ]);
      setActive(profile);
      setExtras(services);
      if (profile) {
        const port = profile.transport.expectedLocalPort;
        const [inspection, auditStatus] = await Promise.all([
          window.c2c.peer.inspect(port).catch(() => null),
          window.c2c.audit.toolStatus().catch(() => null),
        ]);
        setPeer(inspection ? { reachable: true, toolCount: inspection.toolCount } : { reachable: false, toolCount: null });
        setAudit(auditStatus ? { ok: auditStatus.ok, entries: auditStatus.entries, brokenAt: auditStatus.brokenAt } : null);
      }
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const rows: Row[] = [];
  if (active) {
    rows.push({
      id: "current",
      name: active.profileName,
      port: active.transport.expectedLocalPort,
      workspace: active.currentWorkspace.root ?? "未绑定工作区",
      url: active.transport.publicMcpUrl ?? `http://127.0.0.1:${active.transport.expectedLocalPort}/mcp`,
      provider: active.transport.provider ?? "LOCAL_ONLY",
      status: peer?.reachable ? "PASS" : "WARN",
      toolCount: peer?.toolCount ?? null,
      audit: audit ? (audit.ok ? `完整 · ${audit.entries}` : `断链 · #${audit.brokenAt ?? "?"}`) : "未知",
      current: true,
    });
  }
  for (const service of extras) {
    rows.push({
      id: service.id,
      name: service.name,
      port: service.port,
      workspace: service.workspace,
      url: service.publicMcpUrl ?? `http://127.0.0.1:${service.port}/mcp`,
      provider: service.hostname ? "CLOUDFLARE_NAMED" : "LOCAL_ONLY",
      status: statusOf(service.status),
      toolCount: null,
      audit: "独立链路",
      current: false,
    });
  }

  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">MCP 服务</div>
          <p className="muted v2-subtitle">每个服务一个端口、一套 Profile、一条隧道和一条审计链。多服务可同时运行。</p>
        </div>
        <Link className="btn" to="/services/new">+ 新建 MCP 服务</Link>
      </div>

      {err && <div className="banner error" role="alert">{err}</div>}

      <div className="v2-card">
        <div className="v2-card-head">
          <strong>服务列表</strong>
          <span className="muted" style={{ fontSize: 12 }}>{loading ? "读取中…" : `共 ${rows.length} 个`}</span>
        </div>
        {rows.length === 0 ? (
          <div className="v2-empty">
            <p>还没有 MCP 服务。</p>
            <Link className="btn" to="/services/new">创建第一个服务</Link>
          </div>
        ) : (
          <div className="v2-table" role="table" aria-label="MCP 服务列表">
            <div className="v2-tr v2-th" role="row">
              <span>服务 / Profile</span><span>端口</span><span>公网 URL</span><span>状态</span><span>工具</span><span>审计</span><span>操作</span>
            </div>
            {rows.map((row) => (
              <div className="v2-tr" role="row" key={row.id}>
                <span>
                  <strong>{row.name}</strong>
                  <small className="muted">{row.current ? "当前 Active Profile" : row.workspace}</small>
                </span>
                <span><code>{row.port}</code></span>
                <span className="v2-url" title={row.url}><code>{row.url}</code></span>
                <span><span className={`v2-badge ${row.status === "PASS" ? "pass" : row.status === "FAIL" ? "fail" : "warn"}`}>{row.status === "PASS" ? "在线" : row.status === "FAIL" ? "已停止" : "待确认"}</span></span>
                <span>{row.toolCount ?? "—"}</span>
                <span>{row.audit}</span>
                <span className="v2-actions">
                  <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(row.url)}>复制 URL</button>
                  <Link className="btn secondary" to={`/services/${row.id}`}>详情</Link>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="v2-card v2-note">
        <strong>端口说明</strong>
        <p className="muted">默认 48766；创建时可改，不能占用 48765/48766。新增服务会启动独立 Supervisor 和 Runtime，不是切换。</p>
      </div>
    </div>
  );
}
