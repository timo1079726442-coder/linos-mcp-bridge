import React, { useEffect, useState } from "react";
import type { DiagnosticsReport, ProfileConfig } from "../../shared/types.js";
import { formatReadinessFreshness, getReadinessFreshness } from "../readinessFreshness.ts";

export function AboutPage(): JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const [active, diagnostics] = await Promise.all([
        window.c2c.profile.getActive(),
        window.c2c.diagnostics.run(),
      ]);
      setProfile(active);
      setReport(diagnostics);
      setError(null);
    } catch {
      setError("无法读取应用诊断信息。所有未取得的状态保持未知。");
    } finally {
      setBusy(false);
    }
  }

  const readiness = report?.readiness ?? null;
  const freshness = getReadinessFreshness(readiness, nowMs);
  const generatedAtMs = report ? Date.parse(report.generatedAt) : Number.NaN;
  const reportAgeMs = nowMs - generatedAtMs;
  const reportFresh = Boolean(report && Number.isFinite(generatedAtMs) && reportAgeMs >= 0 && reportAgeMs <= 60_000 && freshness.status === "FRESH");
  const profileMatchesReport = (report?.profileMetadata?.profileId ?? null) === (profile?.profileId ?? null);
  const identityFresh = reportFresh && profileMatchesReport;
  const watchdogStatus = reportFresh ? (report?.watchdog.status ?? "UNKNOWN") : "UNKNOWN / STALE";
  const supervisorStatus = !reportFresh || typeof report?.supervisor.pid !== "number"
    ? "UNKNOWN / STALE"
    : report?.supervisor.alive ? "ALIVE" : "NOT ALIVE";

  return (
    <>
      <div className="page-title">关于</div>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted">{reportFresh ? formatReadinessFreshness(freshness) : "状态过期或未验证"}</span>
        <button className="btn secondary" type="button" onClick={() => void refresh()} disabled={busy}>
          {busy ? "检查中…" : "刷新应用信息"}
        </button>
      </div>
      {error && <div className="banner warn" role="status">{error}</div>}
      {report && !profileMatchesReport && <div className="banner warn" role="status">Profile 在读取期间发生变化。当前 Profile 相关状态暂显示为未知，请重新检查。</div>}

      <section className="card">
        <div className="section-title">MCP Bridge</div>
        <div className="kv">
          <div className="k">版本（Diagnostics 报告）</div><div className="v">{report?.appVersion ?? "UNKNOWN"}</div>
          <div className="k">版本来源</div><div className="v">Diagnostics API；安装包元数据/构建修订号尚未单独提供。</div>
          <div className="k">Runtime 来源配置</div><div className="v">{identityFresh ? profile?.runtime.source ?? "未配置" : "UNKNOWN / STALE"}</div>
          <div className="k">Active Profile</div><div className="v">{identityFresh ? profile?.profileName ?? "未配置" : "UNKNOWN / STALE"}</div>
          <div className="k">Workspace</div><div className="v">{identityFresh ? report?.workspace.root ?? "未配置" : "UNKNOWN / STALE"}</div>
          <div className="k">Profile Transport 配置</div><div className="v">{identityFresh ? profile?.transport.provider ?? "未配置" : "UNKNOWN / STALE"}</div>
          <div className="k">Diagnostics 观察的 Transport</div><div className="v">{identityFresh ? report?.transport.provider ?? "UNKNOWN" : "UNKNOWN / STALE"}</div>
          <div className="k">本地端口（Profile 配置）</div><div className="v">{identityFresh ? profile?.transport.expectedLocalPort ?? "未配置" : "UNKNOWN / STALE"}</div>
          <div className="k">本地端口（Diagnostics 观察）</div><div className="v">{identityFresh ? report?.runtime.port ?? "未观察到" : "UNKNOWN / STALE"}</div>
          <div className="k">本地 Runtime 健康端点</div><div className="v">{identityFresh ? profile ? report?.runtime.healthEndpointOk ? "PASS" : "FAIL" : "NO_ACTIVE_PROFILE" : "UNKNOWN / STALE"}</div>
          <div className="k">Supervisor</div><div className="v">{supervisorStatus}</div>
          <div className="k">Watchdog</div><div className="v">{watchdogStatus}</div>
          <div className="k">OAuth / 客户端层</div><div className="v">{identityFresh ? readiness?.layers.connector ?? "UNKNOWN" : "UNKNOWN / STALE"}</div>
          <div className="k">真实工具调用</div><div className="v">{identityFresh ? readiness?.layers.conversation ?? "UNKNOWN" : "UNKNOWN / STALE"}</div>
          <div className="k">Diagnostics 观测时间</div><div className="v">{report?.generatedAt ? new Date(report.generatedAt).toLocaleString() : "无观测"}</div>
        </div>
        <div className="muted" style={{ marginTop: 12 }}>
          Profile 配置字段只表示配置意图。Runtime、Supervisor、Watchdog、OAuth 客户端层和实际工具调用分别展示自己的观测结果，不互相代替。
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          超过 60 秒、缺少或无效的 Readiness 检查会显示为 UNKNOWN / STALE。
        </div>
      </section>
    </>
  );
}
