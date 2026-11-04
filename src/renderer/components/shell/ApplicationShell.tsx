import React, { useCallback, useEffect, useState } from "react";
import type { ProfileConfig } from "../../../shared/types.js";
import { useLocation } from "react-router-dom";
import { getPrimarySectionForPath } from "../../navigation/sections.ts";
import { PrimaryNavigation } from "./PrimaryNavigation.tsx";

type ProfileReadState = "loading" | "configured" | "not-configured" | "unknown";

type Theme = "dark" | "light";
const THEME_KEY = "linos-c2c-theme";

function readStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ApplicationShell({ children }: { children: React.ReactNode }): JSX.Element {
  const { pathname } = useLocation();
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [profileState, setProfileState] = useState<ProfileReadState>("loading");
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const section = getPrimarySectionForPath(pathname);

  // 切换页面/标签后回到顶部，避免停在长页面的中段看起来“没反应”。
  useEffect(() => {
    document.querySelector<HTMLElement>(".app-main")?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [pathname]);

  // 主题只影响颜色变量，布局不动；选择写入 localStorage，下次打开保持。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 忽略存储失败 */
    }
  }, [theme]);

  const refreshProfile = useCallback(async (): Promise<void> => {
    setProfileState("loading");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const active = await window.c2c.profile.getActive();
        setProfile(active);
        setProfileState(active ? "configured" : "not-configured");
        setObservedAt(new Date());
        return;
      } catch {
        // Supervisor/Runtime 刚重启时 IPC 可能短暂不可用；重试后再报 UNKNOWN，
        // 避免顶部长期挂着“控制面未连接”但页面数据其实正常。
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    setProfile(null);
    setProfileState("unknown");
    setObservedAt(new Date());
  }, []);

  useEffect(() => {
    void refreshProfile();
    const onFocus = (): void => { void refreshProfile(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pathname, refreshProfile]);

  const profileLabel = profileState === "loading"
    ? "读取中"
    : profileState === "configured"
      ? profile?.profileName ?? "未知 Profile"
      : profileState === "not-configured"
        ? "未配置"
        : "状态未知";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">C</span>
          <span className="brand-copy">
            <strong>LinOS MCP 控制中心</strong>
            <small>统一工具 · 内部 / 家庭</small>
          </span>
        </div>
        <PrimaryNavigation />
        <div className="sidebar-footer">
          <span className="sidebar-footer-mark" aria-hidden="true">V2</span>
          <span>本机控制中心</span>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-context">
            <span className="topbar-kicker">工作台</span>
            <strong>{section.label}</strong>
          </div>
          <div className="topbar-status">
            <span className="environment-badge">
              <span className="environment-dot" aria-hidden="true" />
              LinOS MCP · V2
            </span>
            <span
              className={"profile-badge profile-" + profileState}
              title={"来源：本机 Profile 接口" + (observedAt ? " · 检查时间：" + observedAt.toLocaleTimeString() : "")}
            >
              <span className="profile-badge-label">当前 Profile</span>
              <strong>{profileLabel}</strong>
            </span>
            <button
              className="icon-button"
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
              title={theme === "dark" ? "月之亮面（亮色）" : "月之暗面（暗色）"}
              data-testid="btn-theme-toggle"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button className="icon-button" type="button" onClick={() => void refreshProfile()} aria-label="刷新 Profile 状态" title="重新读取当前 Profile">
              ↻
            </button>
          </div>
        </header>
        <main className="main" id="main-content">
          {profileState === "unknown" && (
            <div className="banner warn shell-control-warning" role="status">
              控制面暂未连接，当前状态不可验证。<a href="#/diagnostics">查看诊断</a>；请勿将未知状态当作服务故障或运行成功。
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}


