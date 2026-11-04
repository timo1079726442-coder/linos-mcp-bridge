import React from "react";
import type { LayerState } from "../../shared/types.js";
import { MetricHelp } from "./MetricHelp.tsx";

interface StatusCardProps {
  title: string;
  state: LayerState;
  detail?: string;
}

const colorMap: Record<LayerState, string> = {
  PASS: "green",
  DEGRADED: "yellow",
  FAIL: "red",
  UNKNOWN: "gray",
  NOT_APPLICABLE: "gray",
};

const labelMap: Record<LayerState, string> = {
  PASS: "🟢 正常",
  DEGRADED: "🟡 部分可用",
  FAIL: "🔴 异常",
  UNKNOWN: "⚪ 尚未验证",
  NOT_APPLICABLE: "⚪ 不适用",
};

export function StatusCard({ title, state, detail }: StatusCardProps): JSX.Element {
  return (
    <div className="card" data-testid={`status-card-${title.toLowerCase()}`}>
      <div className="card-title"><MetricHelp term={title}>{title}</MetricHelp></div>
      <div className="card-value">
        <span className={`indicator ${colorMap[state]}`}></span>
        {labelMap[state]}
      </div>
      {detail && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{detail}</div>}
    </div>
  );
}
