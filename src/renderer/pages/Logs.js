import React from "react";
export function LogsPage() {
    return (<>
      <div className="page-title">Logs</div>
      <div className="banner info">
        日志由 Supervisor / Runtime 写入；CP9 完成后此处接入真实日志流与过滤器。
        当前 Stub 阶段日志由 Electron console 输出。
      </div>
      <div className="card">
        <div className="section-title">查看方式</div>
        <ul style={{ paddingLeft: 18, color: "var(--text-dim)" }}>
          <li>Human Timeline: 按时间顺序列出事件</li>
          <li>Technical Logs: JSON + stack trace</li>
          <li>Audit Logs: APPEND_ONLY + Hash Chain（CP9 实现）</li>
        </ul>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          所有日志自动 Redact token / pairing code / admin token / runtimeInstanceSecret。
        </div>
      </div>
    </>);
}
