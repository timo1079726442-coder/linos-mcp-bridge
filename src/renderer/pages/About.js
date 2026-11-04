import React from "react";
export function AboutPage() {
    return (<>
      <div className="page-title">About</div>
      <div className="card">
        <div className="section-title">MCP Bridge</div>
        <div className="kv">
          <div className="k">Version</div><div className="v">2.0.0-dev.0</div>
          <div className="k">Codename</div><div className="v">V2 (CP2 dev)</div>
          <div className="k">Build</div><div className="v">local</div>
          <div className="k">Runtime Source</div><div className="v">PACKAGED_V2</div>
          <div className="k">Architecture</div><div className="v">Per CP1 docs/ARCHITECTURE_V2.md</div>
        </div>
        <div className="muted" style={{ marginTop: 12 }}>
          本应用是 LinOS C2C 的下一代桌面端产品。当前为 CP2 开发阶段，已实现
          Desktop Shell、Profile System、Workspace Manager、Readiness Engine。
          后续 CP 将逐步启用 Runtime Supervisor / Transport / OAuth / Installer。
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          设计文档：<code>docs/PRODUCT_SPEC_V2.md</code> 起的 17 份正式文档。
        </div>
      </div>
    </>);
}
