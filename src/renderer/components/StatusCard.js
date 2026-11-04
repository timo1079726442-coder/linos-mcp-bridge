import React from "react";
const colorMap = {
    PASS: "green",
    DEGRADED: "yellow",
    FAIL: "red",
    UNKNOWN: "gray",
    NOT_APPLICABLE: "gray",
};
const labelMap = {
    PASS: "🟢 PASS",
    DEGRADED: "🟡 DEGRADED",
    FAIL: "🔴 FAIL",
    UNKNOWN: "⚪ UNKNOWN",
    NOT_APPLICABLE: "⚪ N/A",
};
export function StatusCard({ title, state, detail }) {
    return (<div className="card" data-testid={`status-card-${title.toLowerCase()}`}>
      <div className="card-title">{title}</div>
      <div className="card-value">
        <span className={`indicator ${colorMap[state]}`}></span>
        {labelMap[state]}
      </div>
      {detail && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{detail}</div>}
    </div>);
}
