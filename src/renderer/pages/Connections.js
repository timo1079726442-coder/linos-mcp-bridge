import React, { useEffect, useState } from "react";
export function ConnectionsPage() {
    const [active, setActive] = useState(null);
    const [intent, setIntent] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { void refresh(); }, []);
    async function refresh() {
        const a = await window.c2c.profile.getActive();
        setActive(a);
    }
    async function handleConnect() {
        if (!active?.currentWorkspace.root) {
            alert("请先选择 Workspace。");
            return;
        }
        setBusy(true);
        try {
            const i = await window.c2c.intent.create();
            setIntent(i);
            await window.c2c.intent.openChatgpt();
        }
        finally {
            setBusy(false);
        }
    }
    return (<>
      <div className="page-title">Connections</div>
      <div className="banner info">
        ZERO_MANUAL_PAIRING_CODE = REMOVED_FROM_NORMAL_FLOW.
        Connect ChatGPT 会自动创建 LOCAL_CONNECTION_INTENT 并打开 ChatGPT 官方页。
        用户在 ChatGPT 端只点击一次 Allow 即完成授权。
      </div>

      <div className="card">
        <div className="section-title">Active Profile</div>
        <div className="kv">
          <div className="k">Profile Name</div><div className="v">{active?.profileName ?? "—"}</div>
          <div className="k">Profile ID</div><div className="v">{active?.profileId ?? "—"}</div>
          <div className="k">Workspace</div><div className="v">{active?.currentWorkspace.root ?? "—"}</div>
          <div className="k">Public MCP</div><div className="v">{active?.transport.publicMcpUrl ?? "—"}</div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={handleConnect} disabled={busy} data-testid="btn-connect-chatgpt">
            Connect ChatGPT
          </button>
        </div>
      </div>

      {intent && (<div className="card" style={{ marginTop: 16 }}>
          <div className="section-title">Latest Intent</div>
          <div className="kv">
            <div className="k">Intent ID</div><div className="v">{intent.intentId}</div>
            <div className="k">Status</div><div className="v">{intent.status}</div>
            <div className="k">Expires At</div><div className="v">{new Date(intent.expiresAt).toLocaleString()}</div>
            <div className="k">Runtime Instance</div><div className="v">{intent.runtimeInstanceId}</div>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Intent 在 ChatGPT Allow 后会自动进入 CONSUMED；Runtime 重启则所有 PENDING Intent 自动进入 REVOKED_RUNTIME_RESTART。
          </div>
        </div>)}
    </>);
}
