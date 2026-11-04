import React, { useEffect, useState } from "react";
/**
 * Advanced mode — exposes full PROTECTED_DEFAULT values for editing.
 * All edits go through: Edit → Validate → Warning → Pending → Controlled Transition → Verify → Promote.
 * CP3+ implements the actual promote/rollback pipeline.
 */
export function AdvancedPage() {
    const [profile, setProfile] = useState(null);
    useEffect(() => { void refresh(); }, []);
    async function refresh() {
        const a = await window.c2c.profile.getActive();
        setProfile(a);
    }
    if (!profile) {
        return (<>
        <div className="page-title">Advanced</div>
        <div className="banner warn">未选择 Active Profile。</div>
      </>);
    }
    return (<>
      <div className="page-title">Advanced</div>
      <div className="banner warn">
        ⚠ Advanced Mode 修改 Production 关键字段。修改走 Pending Config → Verify → Promote；
        失败自动回滚 Previous Known Good。
      </div>

      <div className="card">
        <div className="section-title">Transport</div>
        <div className="kv">
          <div className="k">Provider</div><div className="v">{profile.transport.provider ?? "—"}</div>
          <div className="k">Hostname</div><div className="v">{profile.transport.hostname ?? "—"}</div>
          <div className="k">Tunnel Name</div><div className="v">{profile.transport.tunnelName ?? "—"}</div>
          <div className="k">Tunnel ID</div><div className="v">{profile.transport.tunnelId ?? "—"}</div>
          <div className="k">Zone</div><div className="v">{profile.transport.zone ?? "—"}</div>
          <div className="k">Public MCP URL</div><div className="v">{profile.transport.publicMcpUrl ?? "—"}</div>
          <div className="k">Expected Local Port</div><div className="v">{profile.transport.expectedLocalPort}</div>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          CP4+ 启用 GUI 编辑。修改 Transport Config 会触发 TRANSPORT_REPROVISION_REQUIRED 与可能的 Connector URL 变更。
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Runtime</div>
        <div className="kv">
          <div className="k">Source</div><div className="v">{profile.runtime.source}</div>
          <div className="k">Binary Path</div><div className="v">{profile.runtime.binaryPath ?? "(auto)"}</div>
          <div className="k">Entry Path</div><div className="v">{profile.runtime.entryPath ?? "(auto)"}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Trusted Redirect Policy</div>
        <div className="kv">
          <div className="k">builtinOrigins</div>
          <div className="v">{profile.trustedRedirectPolicy.builtinOrigins.length ? profile.trustedRedirectPolicy.builtinOrigins.join(", ") : "—"}</div>
          <div className="k">userApprovedOrigins</div>
          <div className="v">{profile.trustedRedirectPolicy.userApprovedOrigins.length ? profile.trustedRedirectPolicy.userApprovedOrigins.join(", ") : "—"}</div>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          CP2+ 阶段 Trusted Redirect 默认为空（待 CP2 Integration Spike 冻结 Known-Good Origin）。
          Unknown Redirect = FAIL CLOSED。
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Path 完整列表</div>
        <div className="kv">
          <div className="k">Local Host</div><div className="v">{profile.expectedLocalHost}</div>
          <div className="k">State Path</div><div className="v">(由 V2 决定)</div>
          <div className="k">Log Path</div><div className="v">(由 V2 决定)</div>
          <div className="k">Auth Store</div><div className="v">DPAPI-managed</div>
        </div>
      </div>
    </>);
}
