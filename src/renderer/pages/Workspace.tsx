import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ProfileConfig, ProfileSummary, ProfileType, WorkspaceCandidate, WorkspaceInfo } from "../../shared/types.js";
import { FetchAllowlistPanel } from "../components/FetchAllowlistPanel.js";
import { ProfileManager } from "../components/ProfileManager.tsx";

type WorkspaceLoadState = "loading" | "ready" | "unavailable";

interface WorkspaceRead {
  state: WorkspaceLoadState;
  info: WorkspaceInfo | null;
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string): string => value.replace(/[\\/]+$/, "").replaceAll("/", "\\").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function safeRequestError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return "本机接口返回未知错误。";
  // Renderer errors are not a diagnostic export. Keep useful details while masking
  // values that could be copied from an unexpected IPC error message.
  return error.message
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[已隐藏]")
    .replace(/((?:token|cookie|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
    .slice(0, 320);
}

export function WorkspacePage(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profilesState, setProfilesState] = useState<WorkspaceLoadState>("loading");
  const [active, setActive] = useState<ProfileConfig | null>(null);
  const [activeState, setActiveState] = useState<WorkspaceLoadState>("loading");
  const [workspaceRead, setWorkspaceRead] = useState<WorkspaceRead>({ state: "loading", info: null });
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [pickerPath, setPickerPath] = useState("");
  const [detected, setDetected] = useState<WorkspaceCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileType, setNewProfileType] = useState<ProfileType>("custom");
  const [feedback, setFeedback] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh(): Promise<ProfileConfig | null> {
    setProfilesState("loading");
    setActiveState("loading");
    setProfiles([]);
    setActive(null);
    setWorkspaceRead({ state: "loading", info: null });

    const [listResult, activeResult] = await Promise.allSettled([
      window.c2c.profile.list(),
      window.c2c.profile.getActive(),
    ]);

    if (listResult.status === "fulfilled") {
      setProfiles(listResult.value);
      setProfilesState("ready");
    } else {
      setProfiles([]);
      setProfilesState("unavailable");
    }

    if (activeResult.status === "fulfilled") {
      setActive(activeResult.value);
      setActiveState("ready");
      const root = activeResult.value?.currentWorkspace?.root;
      if (root) {
        try {
          const info = await window.c2c.workspace.validate(root);
          setWorkspaceRead({ state: "ready", info });
        } catch {
          setWorkspaceRead({ state: "unavailable", info: null });
        }
      } else {
        setWorkspaceRead({ state: "ready", info: null });
      }
    } else {
      setActive(null);
      setActiveState("unavailable");
      setWorkspaceRead({ state: "unavailable", info: null });
    }

    setObservedAt(new Date().toISOString());
    return activeResult.status === "fulfilled" ? activeResult.value : null;
  }

  async function handleRefresh(): Promise<void> {
    setFeedback(null);
    await refresh();
  }

  async function handlePick(): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const picked = await window.c2c.workspace.pick();
      if (picked) {
        setPickerPath(picked);
        setDetected(await window.c2c.workspace.detect(picked));
      }
    } catch (error: unknown) {
      setFeedback({ kind: "error", text: `选择或识别工作区失败：${safeRequestError(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleDetect(): Promise<void> {
    if (!pickerPath.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      setDetected(await window.c2c.workspace.detect(pickerPath.trim()));
    } catch (error: unknown) {
      setDetected(null);
      setFeedback({ kind: "error", text: `工作区检测失败：${safeRequestError(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (!detected || !active) return;
    setBusy(true);
    setFeedback(null);
    try {
      await window.c2c.workspace.changePrepare({
        profileId: active.profileId,
        newWorkspaceRoot: detected.root,
      });
      const result = await window.c2c.workspace.changeCommit({ profileId: active.profileId });
      const refreshedActive = await refresh();
      const verified = refreshedActive?.profileId === active.profileId
        && samePath(refreshedActive.currentWorkspace?.root, detected.root);
      setFeedback(verified
        ? { kind: "info", text: result.action === "commit" ? "工作区切换已由 Profile 回读确认。" : "工作区未发生变化，Profile 回读与所选目录一致。" }
        : { kind: "error", text: "变更接口已返回，但最新 Profile 回读未确认所选目录；当前状态不能标记为切换成功。请刷新并检查诊断。" });
    } catch (error: unknown) {
      await refresh();
      setFeedback({ kind: "error", text: `工作区变更未完成：${safeRequestError(error)}。已重新读取 Profile；请以回读状态为准。` });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateProfile(): Promise<void> {
    if (!newProfileName.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      const created = await window.c2c.profile.create({
        profileName: newProfileName.trim(),
        profileType: newProfileType,
      });
      const activated = await window.c2c.profile.setActive(created.profileId);
      setNewProfileName("");
      setCreateMode(false);
      await refresh();
      setFeedback(activated
        ? { kind: "info", text: `配置“${created.profileName}”已创建并切换；当前状态已回读。` }
        : { kind: "error", text: "配置已创建，但激活结果未确认。请刷新检查当前 Profile。" });
    } catch (error: unknown) {
      await refresh();
      setFeedback({ kind: "error", text: `创建或激活配置失败：${safeRequestError(error)}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleSwitchProfile(profileId: string): Promise<void> {
    setBusy(true);
    setFeedback(null);
    try {
      const returned = await window.c2c.profile.setActive(profileId);
      const refreshed = await refresh();
      const confirmed = returned?.profileId === profileId && refreshed?.profileId === profileId;
      setFeedback(confirmed
        ? { kind: "info", text: "Profile 切换已由接口返回和回读共同确认。" }
        : { kind: "error", text: "Profile 切换结果未能通过回读确认。请检查当前 Profile 后再继续。" });
    } catch (error: unknown) {
      await refresh();
      setFeedback({ kind: "error", text: `Profile 切换失败：${safeRequestError(error)}` });
    } finally {
      setBusy(false);
    }
  }

  const workspaceIdentityMismatch = Boolean(active && workspaceRead.info && (
    !samePath(active.currentWorkspace?.root, workspaceRead.info.root)
    || active.currentWorkspace.workspaceId !== workspaceRead.info.workspaceId
  ));

  return (
    <>
      <div className="page-title">工作区</div>

      <div className="toolbar">
        <div className="muted" aria-live="polite">
          {observedAt ? `本机 Profile / Workspace 接口读取于 ${new Date(observedAt).toLocaleString()}` : "正在读取本机 Profile 与 Workspace…"}
        </div>
        <button className="btn secondary" type="button" onClick={() => void handleRefresh()} disabled={busy || profilesState === "loading" || activeState === "loading"}>
          刷新状态
        </button>
      </div>

      {feedback && <div className={`banner ${feedback.kind === "error" ? "error" : "info"}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.text}</div>}

      <div className="card">
        <div className="section-title">当前 Profile 与 Workspace 身份</div>
        {activeState === "unavailable" ? (
          <div className="banner error" role="alert">当前 Profile 接口读取失败（UNKNOWN）。工作区归属不能确认。</div>
        ) : activeState === "loading" ? (
          <div className="muted">正在读取当前 Profile…</div>
        ) : !active ? (
          <div className="banner warn">没有 Active Profile，也没有当前工作区授权范围。</div>
        ) : (
          <div className="kv">
            <div className="k">Profile</div><div className="v">{active.profileName} <span className="tag">{active.profileType.toUpperCase()}</span></div>
            <div className="k">Profile ID</div><div className="v">{active.profileId}</div>
            <div className="k">Workspace 目录</div><div className="v">{active.currentWorkspace?.root ?? "未配置"}</div>
            <div className="k">Profile 绑定 Workspace ID</div><div className="v">{active.currentWorkspace.workspaceId ?? "未配置"}</div>
            <div className="k">校验返回 Workspace ID</div><div className="v">{workspaceRead.state === "ready" ? workspaceRead.info?.workspaceId ?? "NO_DATA" : "UNKNOWN · 未能读取"}</div>
            <div className="k">校验返回目录</div><div className="v">{workspaceRead.state === "ready" ? workspaceRead.info?.root ?? "NO_DATA" : "UNKNOWN · 未能读取"}</div>
            <div className="k">Workspace 身份一致性</div><div className="v">
              {workspaceRead.state !== "ready" ? "UNKNOWN · 未能核对" : !workspaceRead.info ? "NO_DATA · 未绑定工作区" : workspaceIdentityMismatch ? "MISMATCH · Profile 与目录校验结果不同" : "一致"}
            </div>
            <div className="k">目录状态</div><div className="v">
              {workspaceRead.state === "unavailable" ? "UNKNOWN · Workspace 校验接口失败" : !active.currentWorkspace?.root ? "NO_DATA · 当前 Profile 未绑定 Workspace" : workspaceRead.info?.exists ? "目录存在" : "目录不存在或不可访问"}
            </div>
            <div className="k">Git 仓库</div><div className="v">
              {workspaceRead.state === "unavailable" ? "UNKNOWN · 未能读取" : workspaceRead.info ? workspaceRead.info.isGitRepo ? "是" : "否" : "NO_DATA"}
            </div>
            <div className="k">Git Branch</div><div className="v">{workspaceRead.state === "ready" ? workspaceRead.info?.branch ?? "无分支 / 未检测到仓库" : "UNKNOWN · 未能读取"}</div>
            <div className="k">Git Commit</div><div className="v">{workspaceRead.state === "ready" ? workspaceRead.info?.commit ?? "无提交 / 未检测到仓库" : "UNKNOWN · 未能读取"}</div>
            <div className="k">Git Dirty</div><div className="v">
              {workspaceRead.state !== "ready" ? "UNKNOWN · 未能读取" : workspaceRead.info?.dirty === null || !workspaceRead.info ? "NO_DATA" : workspaceRead.info.dirty ? "有未提交变更" : "干净"}
            </div>
          </div>
        )}
      </div>

      <ProfileManager />

      <div className="v2-grid-2">
        <Link className="v2-card v2-link-card" to="/workspace/datasources">
          <strong>只读 MySQL 数据源</strong>
          <p className="muted">连接只读账号、查看 Schema、执行查询。密码只保存在主进程。</p>
          <span className="v2-link">去管理数据源 →</span>
        </Link>
        <Link className="v2-card v2-link-card" to="/workspace/permissions">
          <strong>目录与权限（C2C）</strong>
          <p className="muted">任意盘目录、只读/读写/拒绝、扩展名策略。这是 ACL 的唯一编辑入口。</p>
          <span className="v2-link">去管理目录权限 →</span>
        </Link>
      </div>

      <div className="page-section">
        <div className="section-title">项目目录检测</div>
        <div className="banner info">
          项目识别来自本机 Workspace API。当前版本没有独立的多项目目录索引；Profile 列表只代表配置，不代表项目清单。
        </div>
        <div className="toolbar">
          <button className="btn" type="button" onClick={() => void handlePick()} disabled={busy} data-testid="btn-pick-workspace">
            选择工作目录…
          </button>
          <input
            className="input"
            aria-label="工作目录路径"
            placeholder="或粘贴目录路径"
            value={pickerPath}
            onChange={(event) => setPickerPath(event.target.value)}
            style={{ minWidth: "min(360px, 100%)", flex: "1 1 260px" }}
          />
          <button className="btn secondary" type="button" onClick={() => void handleDetect()} disabled={!pickerPath.trim() || busy}>
            检测目录
          </button>
        </div>

        {detected && (
          <div className="card">
            <div className="section-title">本机检测结果</div>
            <div className="kv">
              <div className="k">实际目录</div><div className="v">{detected.root}</div>
              <div className="k">Workspace ID</div><div className="v">{detected.workspaceId}</div>
              <div className="k">项目类型</div><div className="v">{detected.projectType}</div>
              <div className="k">语言</div><div className="v">{detected.languages.join(", ") || "未识别"}</div>
              <div className="k">框架</div><div className="v">{detected.frameworks.join(", ") || "未识别"}</div>
              <div className="k">Git 仓库</div><div className="v">{detected.isGitRepo ? "是" : "否"}</div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn" type="button" onClick={() => void handleApply()} disabled={!active || busy}>
                将此目录绑定到当前 Profile
              </button>
              {!active && <span className="muted">需先创建或激活 Profile。</span>}
              {active?.profileType === "company" && <span className="muted">切换仅影响所选的当前 Profile，并由受控 Workspace 变更事务处理。</span>}
            </div>
          </div>
        )}
      </div>

      <div className="page-section">
        <div className="section-title">Profile 配置列表</div>
        {profilesState === "loading" ? <div className="muted">正在读取 Profile 列表…</div> : null}
        {profilesState === "unavailable" ? <div className="banner error" role="alert">Profile 列表读取失败（UNKNOWN）。请刷新或查看诊断。</div> : null}
        {profilesState === "ready" && profiles.length === 0 ? <div className="muted">暂无 Profile 配置。</div> : null}
        {profiles.map((profile) => (
          <div key={profile.profileId} className={`list-item${profile.profileId === active?.profileId ? " active" : ""}`}>
            <div>
              <strong>{profile.profileName}</strong>
              <span className="tag">{profile.profileType.toUpperCase()}</span>
              <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                {profile.profileId} · Workspace {profile.currentWorkspaceId ?? "未绑定"} · {profile.currentWorkspaceRoot ?? "未绑定目录"}
              </div>
            </div>
            <div className="row">
              <button
                className="btn secondary"
                type="button"
                onClick={() => void handleSwitchProfile(profile.profileId)}
                disabled={busy || profile.profileId === active?.profileId}
              >
                {profile.profileId === active?.profileId ? "当前 Profile" : "切换 Profile"}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="page-section">
        <div className="section-title">新增 Profile</div>
        {!createMode ? (
          <button className="btn secondary" type="button" onClick={() => setCreateMode(true)} disabled={busy}>+ 添加 Profile</button>
        ) : (
          <div className="card">
            <div className="row">
              <input
                className="input"
                aria-label="Profile 名称"
                placeholder="Profile 名称"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
                maxLength={80}
              />
              <select className="input" aria-label="Profile 类型" value={newProfileType} onChange={(event) => setNewProfileType(event.target.value as ProfileType)}>
                <option value="custom">CUSTOM</option>
                <option value="home">HOME</option>
                <option value="company">COMPANY</option>
              </select>
              <button className="btn" type="button" onClick={() => void handleCreateProfile()} disabled={busy || !newProfileName.trim()}>
                创建并激活
              </button>
              <button className="btn secondary" type="button" onClick={() => { setCreateMode(false); setNewProfileName(""); }} disabled={busy}>
                取消
              </button>
            </div>
            <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              创建成功不代表项目权限已配置。目录和 ACL 状态必须分别读取，当前 ACL 尚未接入时不会推断访问范围。
            </p>
          </div>
        )}
      </div>
      <FetchAllowlistPanel />
    </>
  );
}


