import React, { useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ProfileConfig } from "../../shared/types.js";
import type { ManagedServiceView } from "../../shared/multiService.js";
import { ToolPolicyPanel } from "../components/ToolPolicyPanel.tsx";

type Tab = "overview" | "connect" | "tunnel" | "permissions" | "audit";

const TAB_LABEL: Record<Tab, string> = {
  overview: "概览",
  connect: "连接",
  tunnel: "公网隧道",
  permissions: "权限设置",
  audit: "审计日志",
};

function statusBadge(ok: boolean | null): JSX.Element {
  if (ok === null) return <span className="v2-badge warn">待确认</span>;
  return <span className={`v2-badge ${ok ? "pass" : "fail"}`}>{ok ? "在线" : "不可达"}</span>;
}

export function ServiceDetailPage(): JSX.Element {
  const { serviceId = "current" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [extra, setExtra] = useState<ManagedServiceView | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [audit, setAudit] = useState<{ ok: boolean; entries: number; brokenAt?: number; path: string } | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    const active = await window.c2c.profile.getActive().catch(() => null);
    setProfile(active);
    if (serviceId !== "current" && active?.profileId !== serviceId) {
      const list = await window.c2c.multiService.list().catch(() => []);
      const found = list.find((item) => item.id === serviceId) ?? null;
      setExtra(found);
      setOnline(found?.status === "RUNNING");
      return;
    }
    if (!active) return;
    const port = active.transport.expectedLocalPort;
    const [inspection, auditStatus] = await Promise.all([
      window.c2c.peer.inspect(port).catch(() => null),
      window.c2c.audit.toolStatus().catch(() => null),
    ]);
    setOnline(Boolean(inspection));
    setToolCount(inspection?.toolCount ?? null);
    setAudit(auditStatus);
  }, [serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (serviceId === "48765") {
    return (
      <div className="v2-page">
        <div className="v2-page-head">
          <div>
            <div className="page-title">内部 Agent 桥（48765）</div>
            <p className="muted v2-subtitle">这是内部固定使用的桥，不影响 C2C Runtime（48766）。</p>
          </div>
          <Link className="btn secondary" to="/services">← 返回服务列表</Link>
        </div>
      </div>
    );
  }

  const current = !extra;
  const port = current ? profile?.transport.expectedLocalPort ?? null : extra?.port ?? null;
  const name = current ? profile?.profileName ?? "当前服务" : extra?.name ?? "服务";
  const url = current
    ? profile?.transport.publicMcpUrl ?? (port ? `http://127.0.0.1:${port}/mcp` : "")
    : extra?.publicMcpUrl ?? (port ? `http://127.0.0.1:${port}/mcp` : "");
  const provider = current ? profile?.transport.provider ?? "LOCAL_ONLY" : extra?.hostname ? "CLOUDFLARE_NAMED" : "LOCAL_ONLY";
  const workspace = current ? profile?.currentWorkspace.root ?? "未绑定工作区" : extra?.workspace ?? "";

  async function pairing(): Promise<void> {
    if (!port) return;
    setErr(null);
    try {
      // 同连接授权页：ChatGPT 的 DCR 需要先有本机连接意图，否则 503。
      if (current) await window.c2c.intent.create().catch(() => undefined);
      const result = await window.c2c.service.createPairing(port);
      setCode(result.code);
      setExpiresAt(result.expiresAt);
      setMsg("配对码已生成。");
    } catch (cause) {
      setErr(`生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function restart(): Promise<void> {
    setErr(null);
    try {
      if (current) await window.c2c.service.restartRuntime();
      else if (extra) await window.c2c.multiService.stop(extra.id).then(() => window.c2c.multiService.start(extra.id));
      setMsg("已重启服务。");
      await load();
    } catch (cause) {
      setErr(`重启失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  function switchTab(next: Tab): void {
    const nextParams = new URLSearchParams(params);
    nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  }

  return (
    <div className="v2-page">
      <div className="v2-crumbs"><Link to="/services">MCP 服务</Link><span>/</span><span>{name}</span></div>
      <div className="v2-page-head">
        <div>
          <div className="page-title" style={{ marginBottom: 4 }}>{name} {statusBadge(online)}</div>
          <p className="muted v2-subtitle">端口 {port ?? "—"} · 公网 {url || "未配置"} · {workspace}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(url)}>复制公网 URL</button>
          <button className="btn secondary" type="button" onClick={() => void restart()}>重启服务</button>
          <Link className="btn" to="/connect">去连接</Link>
        </div>
      </div>

      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="banner info" role="status">{msg}</div>}

      <div className="v2-tabs" role="tablist">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={`v2-tab ${tab === key ? "active" : ""}`} onClick={() => switchTab(key)}>
            {TAB_LABEL[key]}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="v2-grid-2">
          <section className="v2-card">
            <div className="v2-card-head"><strong>运行参数</strong></div>
            <div className="kv">
              <div className="k">Profile</div><div className="v">{current ? profile?.profileId ?? "—" : extra?.profileId ?? "—"}</div>
              <div className="k">工作区</div><div className="v"><code>{workspace}</code></div>
              <div className="k">传输</div><div className="v">{provider}</div>
              <div className="k">工具数</div><div className="v">{toolCount ?? "—"}</div>
              <div className="k">审计链</div><div className="v">{audit ? (audit.ok ? `完整 · ${audit.entries} 条` : `断链 · #${audit.brokenAt ?? "?"}`) : "独立服务 / 未读取"}</div>
            </div>
          </section>
          <section className="v2-card">
            <div className="v2-card-head"><strong>配对码</strong><span className="v2-badge pass">一次性</span></div>
            {code ? (
              <div>
                <div className="v2-code">{code}</div>
                <p className="muted" style={{ fontSize: 12 }}>有效期至 {expiresAt ? new Date(expiresAt).toLocaleTimeString() : "—"}</p>
                <button className="btn secondary" type="button" onClick={() => void navigator.clipboard.writeText(code)}>复制配对码</button>
              </div>
            ) : (
              <div>
                <p className="muted">用于 ChatGPT 连接器首次授权。配对码不替代 OAuth，只在本机确认。</p>
                <button className="btn" type="button" onClick={() => void pairing()}>生成配对码</button>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "connect" && (
        <section className="v2-card">
          <div className="v2-card-head"><strong>把 {name} 接入 ChatGPT</strong></div>
          <ol className="v2-steps">
            <li>复制下面的 MCP 地址：<code>{url || "尚未配置公网 URL"}</code></li>
            <li>在 ChatGPT 设置 → Connectors → 添加自定义连接器，粘贴地址。</li>
            <li>OAuth 页面输入配对码；没有码就先生成。</li>
          </ol>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn secondary" type="button" disabled={!url} onClick={() => void navigator.clipboard.writeText(url)}>复制 URL</button>
            <button className="btn" type="button" onClick={() => void pairing()}>生成配对码</button>
            <button className="btn secondary" type="button" onClick={() => void window.c2c.intent.openChatgpt()}>打开 ChatGPT</button>
          </div>
        </section>
      )}

      {tab === "tunnel" && (
        <section className="v2-card">
          <div className="v2-card-head"><strong>公网隧道</strong></div>
          <div className="kv">
            <div className="k">类型</div><div className="v">{provider}</div>
            <div className="k">公网 URL</div><div className="v"><code>{url || "未配置"}</code></div>
            <div className="k">域名</div><div className="v">{profile?.transport.hostname ?? extra?.hostname ?? "—"}</div>
            <div className="k">说明</div><div className="v">命名隧道地址稳定；临时隧道地址会变。仅本机模式不能被 ChatGPT 网页版直接访问。</div>
          </div>
          {provider === "LOCAL_ONLY" && (
            <div className="banner warn" style={{ marginTop: 10 }}>
              当前是「仅本机」模式，ChatGPT 网页版访问不到这台电脑。要对外开放，请先配置连接方式。
            </div>
          )}
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <Link className="btn" to="/setup" data-testid="service-configure-tunnel">
              {provider === "LOCAL_ONLY" ? "配置命名隧道 / 临时隧道" : "修改连接方式"}
            </Link>
            <button className="btn secondary" type="button" onClick={() => void window.c2c.service.restartTransport()}>重启隧道</button>
          </div>
        </section>
      )}

      {tab === "permissions" && (
        <div className="v2-stack">
          <section className="v2-card">
            <div className="v2-card-head"><strong>目录权限摘要</strong><Link className="btn secondary" to="/workspace/permissions">去工作区修改</Link></div>
            <p className="muted">目录 ACL 只有一个编辑入口：工作区 → 目录与权限。这里不重复提供修改。</p>
          </section>
          {current ? <ToolPolicyPanel port={port ?? undefined} /> : <section className="v2-card"><p className="muted">额外服务的工具权限需在该服务独立 Profile 中管理；当前界面先提供只读摘要。</p></section>}
        </div>
      )}

      {tab === "audit" && (
        <section className="v2-card">
          <div className="v2-card-head"><strong>工具调用审计链</strong></div>
          {current ? (
            audit ? (
              <>
                <div className="kv">
                  <div className="k">状态</div><div className="v">{audit.ok ? "链完整" : `断链于第 ${audit.brokenAt ?? "?"} 条`}</div>
                  <div className="k">条数</div><div className="v">{audit.entries}</div>
                  <div className="k">文件</div><div className="v"><code>{audit.path}</code></div>
                </div>
                <p className="muted" style={{ fontSize: 12 }}>只记录工具、路径/命令摘要、结果与耗时，不记录文件正文。</p>
              </>
            ) : <p className="muted">审计链尚未读取。</p>
          ) : <p className="muted">额外服务使用独立 state-root，审计链在它自己的 Profile 目录下。</p>}
        </section>
      )}
    </div>
  );
}
