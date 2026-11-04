import React from "react";
import { useLocation, useNavigate } from "react-router-dom";

export interface SectionTab {
  label: string;
  path: string;
}

interface SectionTabsProps {
  title: string;
  description: string;
  tabs: readonly SectionTab[];
  children: React.ReactNode;
}

export function SectionTabs({ title, description, tabs, children }: SectionTabsProps): JSX.Element {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <section className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">{title}</div>
          <p className="muted v2-subtitle">{description}</p>
        </div>
      </div>
      <nav className="v2-tabs" aria-label={title + "页面"} style={{ position: "relative", zIndex: 2 }}>
        {/* 用 button 而不是 <a>：实测从「日志」点「实时诊断」时链接点击不生效
            （相邻标签却正常），换成按钮 + 显式 navigate 可绕开锚点相关的命中问题。 */}
        {tabs.map((tab) => {
          const active = pathname === tab.path;
          return (
            <button
              key={tab.path}
              type="button"
              onClick={() => navigate(tab.path)}
              className={"v2-tab" + (active ? " active" : "")}
              aria-current={active ? "page" : undefined}
              style={{ position: "relative", zIndex: 3, cursor: "pointer" }}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
      <div>{children}</div>
    </section>
  );
}
