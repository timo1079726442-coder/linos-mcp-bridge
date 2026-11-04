import React from "react";

interface SectionPlaceholderProps {
  title: string;
  description: string;
}

export function SectionPlaceholder({ title, description }: SectionPlaceholderProps): JSX.Element {
  return (
    <div className="section-empty-state" data-testid="section-empty-state">
      <span className="empty-state-mark" aria-hidden="true">—</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
        <p className="empty-state-note">
          此页尚未接入真实数据或操作接口；接入前不会显示演示状态，也不会执行相关操作。
        </p>
      </div>
      <span className="status-badge status-unknown">待接入</span>
    </div>
  );
}
