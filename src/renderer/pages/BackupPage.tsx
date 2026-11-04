import React, { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";

/**
 * 备份与恢复 — 只备份当前 Profile 的配置（不含密钥/授权）。
 *
 * - 导出：把当前 Profile 配置（密钥走 DPAPI，不入导出）写成 JSON 文件。
 * - 导入：从 JSON 文件恢复，必须与当前 Profile 同 ID、schema v2.0、通过隔离
 *   校验（任何保留实例残留都会被拒绝），且需本机确认。
 */
export function BackupPage(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh(): Promise<void> {
    try {
      const active = await window.c2c.profile.getActive();
      setProfile(active);
    } catch {
      setError("无法读取当前 Profile。");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await window.c2c.settings.backupExport();
      if (result.canceled) {
        setMessage("已取消导出。");
      } else {
        setMessage(`配置备份已导出到：${result.path}`);
      }
    } catch (e) {
      setError(safeBackupError(e, "导出失败。"));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await window.c2c.settings.backupImport();
      if (result.restored) {
        setMessage("配置已恢复；密钥与授权未受影响。");
        await refresh();
      } else {
        setMessage("已取消恢复。");
      }
    } catch (e) {
      setError(safeBackupError(e, "恢复失败。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-title">备份与恢复</div>
      {loading && <div className="muted">正在读取当前 Profile…</div>}
      {error && <div className="banner error" role="alert">{error}</div>}
      {message && <div className="banner info" role="status">{message}</div>}
      {!profile && !loading && <div className="banner warn">尚未选择配置，无法备份或恢复。</div>}

      {profile && (
        <>
          <section className="card">
            <div className="section-title">当前 Profile</div>
            <div className="kv">
              <div className="k">名称</div><div className="v">{profile.profileName}</div>
              <div className="k">Profile ID</div><div className="v">{profile.profileId}</div>
              <div className="k">类型</div><div className="v">{profile.profileType}</div>
              <div className="k">Workspace</div><div className="v">{profile.currentWorkspace?.root ?? "未配置"}</div>
            </div>
          </section>

          <section className="card" style={{ marginTop: 14 }}>
            <div className="section-title">导出配置备份</div>
            <p className="muted">
              导出当前 Profile 的配置（工作区、Transport、自动启动、健康检查等）。
              <strong>密钥与授权由 DPAPI 单独管理，不会写入备份文件</strong>。
            </p>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => void handleExport()} disabled={busy || profile.profileType === "company"} data-testid="btn-backup-export">
                {busy ? "处理中…" : "导出配置备份"}
              </button>
              {profile.profileType === "company" && <span className="muted">内部 Profile 受保护，不提供配置备份导出。</span>}
            </div>
          </section>

          <section className="card" style={{ marginTop: 14 }}>
            <div className="section-title">从备份恢复</div>
            <p className="muted">
              从 JSON 备份恢复当前 Profile 配置。恢复前会校验：
              必须是同一 Profile ID、schema v2.0，且通过隔离校验（任何保留实例残留都会被拒绝）。
              恢复需本机确认。
            </p>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn" type="button" onClick={() => void handleImport()} disabled={busy || profile.profileType === "company"} data-testid="btn-backup-import">
                {busy ? "处理中…" : "从备份恢复"}
              </button>
              {profile.profileType === "company" && <span className="muted">内部 Profile 受保护，不提供配置恢复。</span>}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function safeBackupError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    const code = error.message.replace(/\s+/g, " ").trim();
    return `${fallback}（${code.slice(0, 160)}）`;
  }
  return fallback;
}
