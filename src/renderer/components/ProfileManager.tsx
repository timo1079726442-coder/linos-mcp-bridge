import React, { useCallback, useEffect, useState } from "react";
import type { ProfileSummary } from "../../shared/types.js";

/**
 * Profile 管理：
 * Profile 是“一台机器上的一套隔离配置”（身份、工作区、端口、隧道、权限、审计），
 * 不是固定死的；可以建多个，但 Supervisor 同时只运行一个 Active Profile。
 */
export function ProfileManager(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const [list, active] = await Promise.all([
        window.c2c.profile.list(),
        window.c2c.profile.getActive(),
      ]);
      setProfiles(list);
      setActiveId(active?.profileId ?? null);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchTo(profileId: string): Promise<void> {
    if (busy) return;
    if (!window.confirm("切换 Profile 会停止当前 Runtime，并在新端口上重启。确定切换吗？")) return;
    setBusy(profileId);
    setErr(null);
    setMsg(null);
    try {
      await window.c2c.profile.setActive(profileId);
      setMsg("已切换；正在重新加载界面。");
      window.setTimeout(() => window.location.reload(), 600);
    } catch (cause) {
      setErr(`切换失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="profile-manager">
      <div className="section-title">本机 Profile</div>
      <p className="muted" style={{ marginTop: 0 }}>
        Profile 是这台电脑上的一套隔离配置：身份、工作区、端口、隧道、权限和审计都跟着它走。
        它不是固定死的，可以建多个；但同一时间只有一个 <strong>Active Profile</strong> 在运行，
        切换会重启 Runtime。
      </p>

      {err && <div className="banner error" role="alert">{err}</div>}
      {msg && <div className="banner info" role="status">{msg}</div>}

      {profiles.length === 0 ? (
        <div className="muted">还没有 Profile。到「MCP 服务 → 新建 MCP 服务」用一键向导新建。</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          {profiles.map((profile) => {
            const active = profile.profileId === activeId;
            return (
              <div
                key={profile.profileId}
                className="list-item"
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderColor: active ? "var(--green)" : undefined,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div>
                    <strong>{profile.profileName}</strong>{" "}
                    <span className="tag">{profile.profileType.toUpperCase()}</span>{" "}
                    {active && <span className="tag" style={{ borderColor: "var(--green)" }}>ACTIVE</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                    端口 {profile.expectedLocalPort ?? "?"} · {profile.transportProvider ?? "LOCAL_ONLY"} ·{" "}
                    {profile.currentWorkspaceRoot ?? "未绑定工作区"}
                  </div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {profile.profileId}
                  </div>
                </div>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={active || busy !== null}
                  onClick={() => void switchTo(profile.profileId)}
                >
                  {active ? "当前运行" : busy === profile.profileId ? "切换中…" : "切换到此 Profile"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


