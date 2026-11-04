import React, { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";
import {
  buildDangerousPermissionsViewModel,
  type DangerousPermissionsSnapshot,
} from "./security/dangerousPermissionsModel.ts";
import "./security/securityPages.css";
import { ToolPolicyPanel } from "../components/ToolPolicyPanel.tsx";

export interface DangerousPermissionsPageProps {
  snapshot?: DangerousPermissionsSnapshot | null;
  apiAvailable?: boolean;
}

export function DangerousPermissionsPage({
  snapshot = null,
  apiAvailable = false,
}: DangerousPermissionsPageProps): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileReadAt, setProfileReadAt] = useState<string | null>(null);
  const [profileReadFailed, setProfileReadFailed] = useState(false);
  const view = buildDangerousPermissionsViewModel(snapshot, profile?.profileId ?? null, apiAvailable);

  async function refreshProfile(): Promise<void> {
    setProfileLoading(true);
    setProfileReadFailed(false);
    try {
      const active = await window.c2c.profile.getActive();
      setProfile(active);
      setProfileReadAt(new Date().toLocaleString());
    } catch {
      setProfile(null);
      setProfileReadFailed(true);
    } finally {
      setProfileLoading(false);
    }
  }

  useEffect(() => {
    void refreshProfile();
  }, []);

  return (
    <div className="security-feature-page" data-testid="dangerous-permissions-page">
      <ToolPolicyPanel port={profile?.transport?.expectedLocalPort ?? undefined} profile={profile} />
      {/* Legacy MCP 已停用，相关开关不再展示（本内核已覆盖其能力）。 */}
      <div className="banner warn">
        高风险能力遵循默认关闭和 fail-closed。没有可信本机控制层状态时，页面显示“未知”，不会推断为已关闭或已授权。
      </div>

      <div className="security-card">
        <div className="security-card-heading">
          <div>
            <div className="section-title">当前 Profile 与状态来源</div>
            <div className="muted">权限只能作用于当前 Profile；状态读取失败时不得沿用其他配置的授权。</div>
          </div>
          <button className="btn secondary" onClick={() => void refreshProfile()} disabled={profileLoading}>
            {profileLoading ? "读取中…" : "重读当前 Profile"}
          </button>
        </div>
        <div className="security-facts">
          <div>
            <span className="security-fact-label">当前 Profile</span>
            <strong>{profile ? profile.profileName + " · " + profile.profileType.toUpperCase() : "未知"}</strong>
          </div>
          <div>
            <span className="security-fact-label">Shell 状态来源</span>
            <strong>{apiAvailable ? "本机受控层" : "接口尚未接入"}</strong>
          </div>
          <div>
            <span className="security-fact-label">Profile 读取时间</span>
            <strong>{profileReadAt ?? "尚未读取"}</strong>
          </div>
        </div>
        {profileReadFailed && (
          <p className="security-error" role="status">
            当前 Profile 读取失败；未展示底层异常内容。
          </p>
        )}
        {!profile && !profileReadFailed && !profileLoading && (
          <p className="security-muted">当前没有活动 Profile。任何危险权限都不得启用。</p>
        )}
      </div>

      <div className="security-grid">
        <section className="security-card" aria-labelledby="shell-permission-title">
          <div className="section-title" id="shell-permission-title">Shell 权限</div>
          <div className="security-status-panel" data-state={view.shellState.toLowerCase()}>
            <span className="security-fact-label">当前状态</span>
            <strong>{view.shellLabel}</strong>
            {view.shellReason && <span className="security-muted">{view.shellReason}</span>}
          </div>
          <ul className="security-policy-list">
            <li>默认策略：关闭。接口缺失或状态无法验证时，当前有效状态按未知并拒绝授权处理。</li>
            <li>任何启用请求必须在本机弹出独立确认，并核验进程归属、Profile、范围和权限。</li>
            <li>此页面不会开放远程 Shell、任意命令执行或直接文件写入。</li>
          </ul>
          {!apiAvailable && (
            <div className="security-disabled-action" aria-disabled="true">
              Shell 授权与撤销暂不可用
              <span>可信控制层 API 尚未接入；不会在界面本地模拟授权状态。</span>
            </div>
          )}
        </section>

        <section className="security-card" aria-labelledby="audit-mode-title">
          <div className="section-title" id="audit-mode-title">安全审计模式</div>
          <div className="security-status-panel" data-state={view.auditModeState.toLowerCase()}>
            <span className="security-fact-label">当前状态</span>
            <strong>{view.auditModeLabel}</strong>
            {view.auditModeReason && <span className="security-muted">{view.auditModeReason}</span>}
          </div>
          <p className="security-muted">
            审计模式状态必须来自 AuditChain / 受控层；页面文案和本地开关不能替代真实审计记录。
          </p>
          {!apiAvailable && (
            <div className="security-disabled-action" aria-disabled="true">
              审计模式控制暂不可用
              <span>当前没有读取或修改审计策略的 renderer API。</span>
            </div>
          )}
        </section>

        <section className="security-card" aria-labelledby="other-dangerous-title">
          <div className="section-title" id="other-dangerous-title">其他高风险能力</div>
          <div className="security-scope-list">
            <div><strong>全屏抓取</strong><span>策略要求默认关闭，需独立本机确认。</span></div>
            <div><strong>直接文件写入</strong><span>策略要求默认关闭，需独立审批和受控执行。</span></div>
            <div><strong>屏幕远程操控</strong><span>不提供此能力。</span></div>
          </div>
          <p className="security-muted">
            状态接口未接入时，上述项目只表示安全策略要求，不代表设备已完成实测或授权状态读取。
          </p>
        </section>

        <section className="security-card" aria-labelledby="repair-guard-title">
          <div className="section-title" id="repair-guard-title">安全恢复约束</div>
          <ul className="security-policy-list">
            <li>只允许由 Supervisor / 本机受控层执行经过归属验证的动作。</li>
            <li>高风险动作需本机二次确认；确认取消、权限不足或 Profile 不匹配时必须停止。</li>
            <li>自动重试必须遵守既有次数上限和冷却策略，操作后执行真实健康复测。</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
