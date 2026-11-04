import { Link } from "react-router-dom";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { DiagnosticsReport, LayerState } from "../../../shared/types.js";
import { observeReport } from "./faultAnalysis.js";
import { MetricHelp } from "../../components/MetricHelp.tsx";
import "./collaboration-diagnostics.css";

const layerNames: Record<keyof DiagnosticsReport["readiness"]["layers"], string> = {
  runtime: "Runtime",
  transport: "Tunnel / Transport",
  connector: "Connector",
  conversation: "Conversation",
  workspace: "Workspace",
  repository: "Repository",
};

function layerLabel(state: LayerState): string {
  switch (state) {
    case "PASS": return "通过";
    case "DEGRADED": return "降级";
    case "FAIL": return "失败";
    case "NOT_APPLICABLE": return "不适用";
    case "UNKNOWN": return "未知";
  }
}

function stateTone(state: LayerState): string {
  if (state === "PASS") return "success";
  if (state === "FAIL") return "danger";
  if (state === "DEGRADED") return "warning";
  return "neutral";
}

function dateTime(value: string | null | undefined): string {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间格式不可识别" : date.toLocaleString();
}

function safeOrigin(value: string | null | undefined): string {
  if (!value) return "未配置";
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "已配置（地址细节隐藏）";
  }
}

function safeWorkspaceName(value: string | null | undefined): string {
  if (!value) return "未配置";
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-1)[0] ?? "已配置";
}

function safeProcessName(value: string | null | undefined): string {
  if (!value) return "未知";
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-1)[0] ?? "未知";
}

function booleanLabel(value: boolean | null | undefined, yes: string, no: string): string {
  return value === true ? yes : value === false ? no : "未知";
}

function oauthLabel(state: NonNullable<DiagnosticsReport["oauthAuthorization"]>["state"]): string {
  switch (state) {
    case "AUTHORIZED": return "有效 Workspace 授权";
    case "AUTH_REQUIRED": return "需要授权";
    case "REVOKED": return "授权已撤销";
    case "EXPIRED": return "授权已过期";
    case "WORKSPACE_REQUIRED": return "先选择 Workspace";
    case "NOT_CONFIGURED": return "未配置客户端";
    case "UNKNOWN": return "状态未知";
  }
}

function oauthTone(state: NonNullable<DiagnosticsReport["oauthAuthorization"]>["state"]): string {
  if (state === "AUTHORIZED") return "success";
  if (state === "AUTH_REQUIRED" || state === "REVOKED" || state === "EXPIRED") return "warning";
  if (state === "UNKNOWN") return "danger";
  return "neutral";
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }): JSX.Element {
  return <span className={"c2c-evidence-badge " + tone}>{children}</span>;
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return <section className="c2c-domain-card"><h2>{title}</h2>{children}</section>;
}

function SourceLine({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="c2c-source-line">{children}</p>;
}

function EmptyState({ title, body, kind = "gap" }: { title: string; body: string; kind?: "gap" | "empty" }): JSX.Element {
  return (
    <div className={"c2c-empty-state " + kind} role="status">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return <div className="c2c-domain-fact"><span><MetricHelp term={label}>{label}</MetricHelp></span><strong>{value}</strong></div>;
}

export function RealtimeDiagnosticsView(): JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      setReport(await window.c2c.diagnostics.run());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const layers = report ? Object.entries(report.readiness.layers) as Array<[keyof DiagnosticsReport["readiness"]["layers"], LayerState]> : [];
  const observations = useMemo(() => report ? observeReport(report) : [], [report]);
  const reportAt = report ? new Date(report.generatedAt).getTime() : Number.NaN;
  const stale = report !== null && (!Number.isFinite(reportAt) || clockNow - reportAt > 5 * 60_000);

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div>
          <h1>实时诊断</h1>
          <p>读取本机 Supervisor 转发的 Diagnostics 观测；观测异常只说明现象，不自动确定根因。</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className="btn secondary"
            data-testid="diagnostics-export"
            disabled={busy || exporting}
            onClick={() => {
              setExporting(true);
              setExportMsg(null);
              void window.c2c.diagnostics.exportBundle()
                .then((r) => setExportMsg(`诊断包已导出：${r.path}`))
                .catch((error: unknown) => setExportMsg(`导出失败：${error instanceof Error ? error.message : String(error)}`))
                .finally(() => setExporting(false));
            }}
          >
            {exporting ? "导出中…" : "导出诊断包"}
          </button>
          <button className="btn" onClick={() => void refresh()} disabled={busy}>
            {busy ? "检查中…" : "重新诊断"}
          </button>
        </div>
      </div>

      {exportMsg && <SourceLine>{exportMsg}</SourceLine>}

      {failed && <EmptyState title="控制面诊断未取得结果" body="当前无法从 Supervisor 取得 Diagnostics。此状态只证明控制面证据缺失，不会把 Runtime、Tunnel、OAuth 等子模块直接判为故障。" />}
      {!report && !failed && <EmptyState title="正在读取本机状态" body="诊断结果尚未返回。" kind="empty" />}

      {report && (
        <>
          <SourceLine>数据来源：window.c2c.diagnostics.run → 本机 Supervisor / Diagnostics。读取时间：{dateTime(report.generatedAt)}。{stale ? " 此报告已超过 5 分钟，标记为过期；请重新诊断。" : " 当前报告在 5 分钟有效窗口内。"}</SourceLine>

          <InfoCard title="端口与服务链路（当前 Profile）">
            <div className="c2c-domain-grid">
              <Fact label="Profile" value={report.profileMetadata?.profileName ?? "未取得"} />
              <Fact label="Runtime 端口" value={report.runtime.port ?? "未知"} />
              <Fact label="端口监听" value={<Badge tone={report.runtime.portListening === true ? "success" : report.runtime.portListening === false ? "danger" : "neutral"}>{booleanLabel(report.runtime.portListening, "正在监听", "无人监听")}</Badge>} />
              <Fact label="Runtime Health" value={<Badge tone={report.runtime.healthEndpointOk ? "success" : "danger"}>{report.runtime.healthEndpointOk ? "HTTP Health 通过" : "Health 未通过"}</Badge>} />
              <Fact label="Runtime PID" value={report.runtime.pid ?? "未知"} />
              <Fact label="Runtime 进程" value={safeProcessName(report.runtime.processExe)} />
              <Fact label="Supervisor" value={<Badge tone={report.supervisor.alive ? "success" : "danger"}>{report.supervisor.alive ? "在线" : "未确认在线"}</Badge>} />
              <Fact label="Supervisor PID" value={report.supervisor.pid ?? "未知"} />
              <Fact label="Watchdog" value={<Badge tone={report.watchdog.alive ? "success" : report.watchdog.status === "DEAD" ? "danger" : "neutral"}>{report.watchdog.status === "NOT_STARTED" ? "不适用（V2 无独立看门狗进程）" : report.watchdog.status ?? booleanLabel(report.watchdog.alive, "在线", "未知")}</Badge>} />
              <Fact label="Tunnel Provider" value={report.transport.provider ?? "未配置"} />
              <Fact label="Tunnel 进程" value={report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED" ? booleanLabel(report.transport.processAlive, "在线", "未运行") : "不适用"} />
              <Fact label="Tunnel Edge" value={report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED" ? booleanLabel(report.transport.edgeConnected, "已连接", "未连接") : "不适用"} />
              <Fact label="公网 Health" value={report.transport.publicHealthStatus ?? "未取得"} />
              <Fact label="匿名 MCP" value={report.transport.publicMcpAnonymous ?? "未取得"} />
              <Fact label="OAuth Discovery" value={report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED" ? booleanLabel(report.transport.oauthDiscoveryOk, "通过", "未通过") : "不适用"} />
            </div>
            {report.runtime.portListening === true && !report.runtime.healthEndpointOk && (
              <p className="c2c-diagnostic-note">OBSERVED_GAP：端口正在监听，但 Runtime Health 未通过。这里只确认现象，不直接把“端口占用”“Runtime 卡死”或“错误进程监听”写成根因。</p>
            )}
            {report.runtime.portListening === true && report.runtime.pid === null && (
              <p className="c2c-diagnostic-note">OBSERVED_GAP：端口存在监听者，但当前诊断没有取得受信任的 Runtime PID。应继续核对进程归属，禁止自动结束未知进程。</p>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <Link className="btn secondary" to="/diagnostics/knowledge">查看故障知识库</Link>
              <Link className="btn secondary" to="/diagnostics/fixes">进入快速修复</Link>
              <Link className="btn secondary" to="/diagnostics/history">查看修复历史</Link>
            </div>
            <SourceLine>端口、PID、进程、Tunnel、OAuth 分开判断；端口监听成功不等于 MCP 可用，OAuth 成功也不等于真实工具调用成功。</SourceLine>
          </InfoCard>

          <InfoCard title="分层状态">
            <div className="c2c-domain-grid">
              {layers.map(([key, state]) => (
                <Fact key={key} label={layerNames[key]} value={<Badge tone={stateTone(state)}>{layerLabel(state)}</Badge>} />
              ))}
            </div>
            {report.readiness.lastError && <p className="c2c-diagnostic-note">诊断源返回了错误标记；原始异常文本未在页面展开，以避免意外显示敏感值。</p>}
          </InfoCard>

          <InfoCard title="本机与连接观测">
            <div className="c2c-domain-grid">
              <Fact label="当前 Profile" value={report.profileMetadata?.profileName ?? "未取得"} />
              <Fact label="Workspace" value={safeWorkspaceName(report.workspace.root)} />
              <Fact label="Runtime Health" value={<Badge tone={report.runtime.healthEndpointOk ? "success" : "danger"}>{report.runtime.healthEndpointOk ? "探测通过" : "探测未通过"}</Badge>} />
              <Fact label="本地端口" value={report.runtime.port ?? "未知"} />
              <Fact label="Transport 类型" value={report.transport.provider ?? "未知"} />
              <Fact label="公网 Origin" value={safeOrigin(report.transport.publicUrl)} />
              <Fact label="公网 Health" value={report.transport.publicHealthStatus ?? "未取得"} />
              <Fact label="Tunnel Edge" value={report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED" ? (report.transport.edgeConnected ? "已连接" : "未连接") : "不适用 / 未配置"} />
              <Fact label="OAuth Discovery" value={report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED" ? (report.transport.oauthDiscoveryOk ? "探测通过" : "未通过探测") : "不适用 / 未配置"} />
              <Fact label="本机 OAuth 授权" value={report.oauthAuthorization ? <Badge tone={oauthTone(report.oauthAuthorization.state)}>{oauthLabel(report.oauthAuthorization.state)}</Badge> : "未取得"} />
              <Fact label="已注册客户端" value={report.oauthAuthorization?.activeClientCount ?? "未知"} />
            </div>
            <SourceLine>公网地址只显示 Origin；本地路径只显示末级目录名。OAuth Discovery 来自公网探测；本机授权来自当前 Profile 的客户端注册表与 Workspace Grant。两者都不等同于真实对话成功。</SourceLine>
          </InfoCard>

          <InfoCard title="当前可见异常现象">
            {observations.length === 0
              ? <EmptyState title="没有可从本次报告确认的异常现象" body="这不等于所有功能已验证；UNKNOWN、未覆盖层和接口缺口仍按各自状态保留。" kind="empty" />
              : <div className="c2c-domain-stack">
                {observations.map((item) => (
                  <article className="c2c-observation-card" key={item.code}>
                    <div className="c2c-observation-heading"><strong>{item.title}</strong><Badge tone="warning">仅观测</Badge></div>
                    <ul>{item.evidence.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                    <p>历史资料关联：{item.relatedLessonIds.join("、")}。关联资料不代表当前根因已确认，也不代表已有可执行修复。</p>
                  </article>
                ))}
              </div>}
          </InfoCard>
        </>
      )}
    </div>
  );
}
