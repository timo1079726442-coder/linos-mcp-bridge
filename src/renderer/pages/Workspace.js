import React, { useEffect, useState } from "react";
export function WorkspacePage() {
    const [profiles, setProfiles] = useState([]);
    const [active, setActive] = useState(null);
    const [pickerPath, setPickerPath] = useState("");
    const [detected, setDetected] = useState(null);
    const [busy, setBusy] = useState(false);
    const [createMode, setCreateMode] = useState(false);
    const [newProfileName, setNewProfileName] = useState("");
    const [newProfileType, setNewProfileType] = useState("company");
    useEffect(() => { void refresh(); }, []);
    async function refresh() {
        const list = await window.c2c.profile.list();
        setProfiles(list);
        const cur = await window.c2c.profile.getActive();
        setActive(cur);
    }
    async function handlePick() {
        setBusy(true);
        try {
            const picked = await window.c2c.workspace.pick();
            if (picked) {
                setPickerPath(picked);
                const det = await window.c2c.workspace.detect(picked);
                setDetected(det);
            }
        }
        finally {
            setBusy(false);
        }
    }
    async function handleDetect() {
        if (!pickerPath)
            return;
        const det = await window.c2c.workspace.detect(pickerPath);
        setDetected(det);
    }
    async function handleApply() {
        if (!detected || !active)
            return;
        setBusy(true);
        try {
            await window.c2c.workspace.changePrepare({
                profileId: active.profileId,
                newWorkspaceRoot: detected.root,
            });
            alert("Workspace Change 已进入 PREPARE 阶段。CP3+ 会接管 COMMITTING 与 Recovery。");
            await refresh();
        }
        catch (e) {
            alert(`Prepare 失败: ${e.message}`);
        }
        finally {
            setBusy(false);
        }
    }
    async function handleCreateProfile() {
        if (!newProfileName.trim())
            return;
        setBusy(true);
        try {
            const created = await window.c2c.profile.create({
                profileName: newProfileName.trim(),
                profileType: newProfileType,
            });
            setNewProfileName("");
            setCreateMode(false);
            await window.c2c.profile.setActive(created.profileId);
            await refresh();
        }
        finally {
            setBusy(false);
        }
    }
    return (<>
      <div className="page-title">Workspace</div>

      <div className="banner info">
        选择工作目录后，应用会自动创建独立的 Identity、Runtime 配置、Transport 配置、OAuth Client Registry。
        不同 Profile 之间物理隔离。
      </div>

      <div className="toolbar">
        <button className="btn" onClick={handlePick} disabled={busy} data-testid="btn-pick-workspace">
          选择工作目录…
        </button>
        <input className="input" placeholder="或粘贴目录路径" value={pickerPath} onChange={(e) => setPickerPath(e.target.value)} style={{ minWidth: 360 }}/>
        <button className="btn secondary" onClick={handleDetect} disabled={!pickerPath || busy}>
          Detect
        </button>
      </div>

      {detected && (<div className="card">
          <div className="section-title">检测结果</div>
          <div className="kv">
            <div className="k">Realpath</div><div className="v">{detected.root}</div>
            <div className="k">Workspace ID</div><div className="v">{detected.workspaceId}</div>
            <div className="k">Project Type</div><div className="v">{detected.projectType}</div>
            <div className="k">Languages</div><div className="v">{detected.languages.join(", ") || "—"}</div>
            <div className="k">Frameworks</div><div className="v">{detected.frameworks.join(", ") || "—"}</div>
            <div className="k">Git Repo</div><div className="v">{detected.isGitRepo ? "Yes" : "No"}</div>
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={handleApply} disabled={!active || busy}>
              Apply Workspace Change (PREPARE)
            </button>
            {!active && <span className="muted">需先激活一个 Profile</span>}
          </div>
        </div>)}

      <div className="page-section">
        <div className="section-title">Profiles</div>
        {profiles.map((p) => (<div key={p.profileId} className={"list-item" + (p.profileId === active?.profileId ? " active" : "")}>
            <div>
              <strong>{p.profileName}</strong>
              <span className="tag">{p.profileType}</span>
              {p.currentWorkspaceRoot && (<span className="muted" style={{ marginLeft: 8 }}>{p.currentWorkspaceRoot}</span>)}
            </div>
            <div className="row">
              <button className="btn secondary" onClick={async () => {
                const a = await window.c2c.profile.setActive(p.profileId);
                setActive(a);
            }}>
                {p.profileId === active?.profileId ? "Active" : "Activate"}
              </button>
            </div>
          </div>))}
      </div>

      <div className="page-section">
        <div className="section-title">新增 Profile</div>
        {!createMode ? (<button className="btn secondary" onClick={() => setCreateMode(true)}>+ 添加 Profile</button>) : (<div className="card">
            <div className="row">
              <input className="input" placeholder="Profile 名称" value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)}/>
              <select className="input" value={newProfileType} onChange={(e) => setNewProfileType(e.target.value)}>
                <option value="company">COMPANY</option>
                <option value="home">HOME</option>
                <option value="custom">CUSTOM</option>
              </select>
              <button className="btn" onClick={handleCreateProfile} disabled={busy || !newProfileName.trim()}>
                Create
              </button>
              <button className="btn secondary" onClick={() => {
                setCreateMode(false);
                setNewProfileName("");
            }}>
                Cancel
              </button>
            </div>
          </div>)}
      </div>
    </>);
}
