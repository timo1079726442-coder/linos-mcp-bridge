import React, { useEffect, useState } from "react";
import { StatusCard } from "../components/StatusCard.js";
export function DashboardPage() {
    const [profile, setProfile] = useState(null);
    const [profiles, setProfiles] = useState([]);
    const [readiness, setReadiness] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { void refresh(); }, []);
    async function refresh() {
        const list = await window.c2c.profile.list();
        setProfiles(list);
        const active = await window.c2c.profile.getActive();
        setProfile(active);
        const r = await window.c2c.readiness.get();
        setReadiness(r);
    }
    async function handleConnectChatgpt() {
        if (!profile?.currentWorkspace.root) {
            alert("请先在 Workspace 页面选择工作目录。");
            return;
        }
        setBusy(true);
        try {
            await window.c2c.intent.create();
            await window.c2c.intent.openChatgpt();
            // Periodic readiness poll to pick up ChatGPT side effects.
            const timer = setInterval(async () => {
                const r = await window.c2c.readiness.get();
                setReadiness(r);
            }, 3000);
            setTimeout(() => clearInterval(timer), 60_000);
        }
        finally {
            setBusy(false);
        }
    }
    const r = readiness;
    return (<>
      <div className="page-title">Dashboard</div>

      <div className="row" style={{ marginBottom: 18 }}>
        <span className={`indicator ${r?.overall === "GREEN" ? "green" : r?.overall === "YELLOW" ? "yellow" : r?.overall === "RED" ? "red" : "gray"}`}></span>
        <strong style={{ fontSize: 18 }}>
          {r?.overall ?? "GRAY"} · {profile?.profileName ?? "未选择 Profile"}
        </strong>
        <span className="muted" style={{ marginLeft: "auto" }}>
          Last Full Verification: {r?.lastFullVerification ? new Date(r.lastFullVerification).toLocaleString() : "—"}
        </span>
      </div>

      {r?.overall === "RED" && (<div className="banner error">
          ⚠ {r.lastError ?? "有 Layer 失败。点击 Diagnostics 查看详情。"}
        </div>)}
      {r?.overall === "YELLOW" && (<div className="banner warn">
          ℹ 部分 Layer 进入降级状态。Runtime / Transport 仍可能正常。详细见 Diagnostics。
        </div>)}

      <div className="card-grid" data-testid="status-grid">
        <StatusCard title="Runtime" state={r?.layers.runtime ?? "UNKNOWN"}/>
        <StatusCard title="Transport" state={r?.layers.transport ?? "UNKNOWN"}/>
        <StatusCard title="Connector" state={r?.layers.connector ?? "UNKNOWN"}/>
        <StatusCard title="Conversation" state={r?.layers.conversation ?? "UNKNOWN"} detail={r?.layers.conversation === "FAIL" ? "当前 ChatGPT 会话不支持 Developer MCP，本地 Runtime 正常，无需重启。" : undefined}/>
        <StatusCard title="Workspace" state={r?.layers.workspace ?? "UNKNOWN"}/>
        <StatusCard title="Repository" state={r?.layers.repository ?? "NOT_APPLICABLE"}/>
      </div>

      <div className="page-section">
        <div className="section-title">当前 Workspace</div>
        <div className="kv">
          <div className="k">Root</div>
          <div className="v">{profile?.currentWorkspace.root ?? "—"}</div>
          <div className="k">Workspace ID</div>
          <div className="v">{profile?.currentWorkspace.workspaceId ?? "—"}</div>
          <div className="k">Profile ID</div>
          <div className="v">{profile?.profileId ?? "—"}</div>
          <div className="k">Public MCP</div>
          <div className="v">{profile?.transport.publicMcpUrl ?? "—"}</div>
        </div>
      </div>

      <div className="page-section">
        <div className="toolbar">
          <button className="btn" disabled={busy} onClick={handleConnectChatgpt} data-testid="btn-connect">
            Connect ChatGPT
          </button>
          <button className="btn secondary" onClick={() => void refresh()} data-testid="btn-refresh">
            Refresh
          </button>
          <a className="btn secondary" href="#/workspace">Change Workspace</a>
          <a className="btn secondary" href="#/diagnostics">Run Diagnostics</a>
        </div>
      </div>

      <div className="page-section">
        <div className="section-title">Profiles</div>
        {profiles.length === 0 && <div className="muted">暂无 Profile。请到 Workspace 页创建。</div>}
        {profiles.map((p) => (<div key={p.profileId} className={"list-item" + (p.profileId === profile?.profileId ? " active" : "")}>
            <div>
              <strong>{p.profileName}</strong>
              <span className="tag">{p.profileType}</span>
              {p.currentWorkspaceRoot && <span className="muted" style={{ marginLeft: 8 }}>{p.currentWorkspaceRoot}</span>}
            </div>
            <button className="btn secondary" onClick={async () => {
                const p2 = await window.c2c.profile.setActive(p.profileId);
                setProfile(p2);
            }}>
              {p.profileId === profile?.profileId ? "Active" : "Activate"}
            </button>
          </div>))}
      </div>
    </>);
}
