import React, { useState } from "react";
export function DiagnosticsPage() {
    const [report, setReport] = useState(null);
    const [busy, setBusy] = useState(false);
    async function run() {
        setBusy(true);
        try {
            const r = await window.c2c.diagnostics.run();
            setReport(r);
        }
        finally {
            setBusy(false);
        }
    }
    async function exportBundle() {
        try {
            const r = await window.c2c.diagnostics.exportBundle();
            alert(`Diagnostic bundle 已保存: ${r.path}`);
        }
        catch (e) {
            alert(`导出失败: ${e.message}`);
        }
    }
    return (<>
      <div className="page-title">Diagnostics</div>
      <div className="banner info">
        一键诊断覆盖 Runtime / Port / PID / Identity / Workspace / Transport / Public Health / OAuth / Secret / Watchdog。
        输出包括用户可读原因 + Technical Evidence。
      </div>

      <div className="toolbar">
        <button className="btn" onClick={run} disabled={busy}>Run Diagnostics</button>
        <button className="btn secondary" onClick={exportBundle} disabled={!report}>Export Diagnostic Bundle</button>
      </div>

      {report && (<div className="card">
          <div className="section-title">Runtime</div>
          <div className="kv">
            <div className="k">PID</div><div className="v">{report.runtime.pid ?? "—"}</div>
            <div className="k">Port</div><div className="v">{report.runtime.port ?? "—"}</div>
            <div className="k">Identity</div>
            <div className="v">
              {report.runtime.identity
                ? `${report.runtime.identity.profileId} / ${report.runtime.identity.runtimeId} / ${report.runtime.identity.workspaceId}`
                : "—"}
            </div>
            <div className="k">Health Endpoint</div>
            <div className="v">{report.runtime.healthEndpointOk ? "OK" : "FAIL"}</div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>Transport</div>
          <div className="kv">
            <div className="k">Provider</div><div className="v">{report.transport.provider ?? "—"}</div>
            <div className="k">Public URL</div><div className="v">{report.transport.publicUrl ?? "—"}</div>
            <div className="k">Edge Connected</div>
            <div className="v">{report.transport.edgeConnected ? "OK" : "FAIL"}</div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>Workspace / Repository</div>
          <div className="kv">
            <div className="k">Root</div><div className="v">{report.workspace.root ?? "—"}</div>
            <div className="k">Workspace ID</div><div className="v">{report.workspace.workspaceId ?? "—"}</div>
            <div className="k">Git Repo</div><div className="v">{report.repository.isGitRepo ? "Yes" : "No"}</div>
            <div className="k">Branch</div><div className="v">{report.repository.branch ?? "—"}</div>
          </div>

          <div className="section-title" style={{ marginTop: 18 }}>Secrets / Watchdog</div>
          <div className="kv">
            <div className="k">DPAPI OK</div><div className="v">{report.secretStore.dpapiOk ? "Yes" : "No"}</div>
            <div className="k">Watchdog Alive</div><div className="v">{report.watchdog.alive ? "Yes" : "No"}</div>
            <div className="k">Supervisor Alive</div><div className="v">{report.supervisor.alive ? "Yes" : "No"}</div>
          </div>
        </div>)}
    </>);
}
