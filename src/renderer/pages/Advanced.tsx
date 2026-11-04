import React, { useEffect, useState } from "react";
import type { ProfileConfig } from "../../shared/types.js";

/** Read-only technical details for troubleshooting. */
export function AdvancedPage(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);

  useEffect(() => { void refresh(); }, []);

  async function refresh(): Promise<void> {
    const a = await window.c2c.profile.getActive();
    setProfile(a);
  }

  if (!profile) {
    return (
      <>
      <div className="page-title">高级设置</div>
        <div className="banner warn">尚未选择当前配置。</div>
      </>
    );
  }

  return (
    <>
      <div className="page-title">高级设置</div>
      <div className="banner warn">
        这里仅展示当前运行配置。V2 默认只使用本机模式，不会接管 Legacy 生产环境。
      </div>

      <div className="card">
        <div className="section-title">安全连接通道</div>
        <div className="kv">
          <div className="k">模式</div><div className="v">{profile.transport.provider === "LOCAL_ONLY" ? "仅本地模式（LOCAL_ONLY）" : profile.transport.provider ?? "—"}</div>
          <div className="k">主机名</div><div className="v">{profile.transport.hostname ?? "—"}</div>
          <div className="k">隧道名称</div><div className="v">{profile.transport.tunnelName ?? "—"}</div>
          <div className="k">隧道 ID</div><div className="v">{profile.transport.tunnelId ?? "—"}</div>
          <div className="k">区域</div><div className="v">{profile.transport.zone ?? "—"}</div>
          <div className="k">远程 MCP 地址</div><div className="v">{profile.transport.publicMcpUrl ?? "—"}</div>
          <div className="k">本地端口</div><div className="v">{profile.transport.expectedLocalPort}</div>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          当前版本为只读展示。任何远程连接配置都必须经过单独的安全验证。
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">运行时</div>
        <div className="kv">
          <div className="k">来源</div><div className="v">{profile.runtime.source === "PACKAGED_V2" ? "V2 内置运行时（PACKAGED_V2）" : profile.runtime.source}</div>
          <div className="k">程序路径</div><div className="v">{profile.runtime.binaryPath ?? "自动选择"}</div>
          <div className="k">入口路径</div><div className="v">{profile.runtime.entryPath ?? "自动选择"}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">可信回调来源</div>
        <div className="kv">
          <div className="k">内置来源</div>
          <div className="v">{profile.trustedRedirectPolicy.builtinOrigins.length ? profile.trustedRedirectPolicy.builtinOrigins.join(", ") : "—"}</div>
          <div className="k">用户批准来源</div>
          <div className="v">{profile.trustedRedirectPolicy.userApprovedOrigins.length ? profile.trustedRedirectPolicy.userApprovedOrigins.join(", ") : "—"}</div>
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          未知回调来源会被拒绝（安全默认关闭）。
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">路径与安全存储</div>
        <div className="kv">
          <div className="k">本地地址</div><div className="v">{profile.expectedLocalHost}</div>
          <div className="k">状态路径</div><div className="v">由 V2 管理</div>
          <div className="k">日志路径</div><div className="v">由 V2 管理</div>
          <div className="k">授权存储</div><div className="v">DPAPI 管理</div>
        </div>
      </div>
    </>
  );
}
