import React, { useEffect, useRef, useState } from "react";
import type { LayerState, ProfileConfig, ReadinessSnapshot, ExecutionListResponse } from "../../shared/types.js";
import type { ApprovalQueueSnapshot } from "../../shared/security.js";
import { StatusCard } from "../components/StatusCard.tsx";
import { CapabilityCard } from "../components/CapabilityCard.tsx";
import { HealthStrip } from "../components/HealthStrip.tsx";
import { PeerStatusCard } from "../components/PeerStatusCard.tsx";
import { ServiceOverview } from "../components/ServiceOverview.tsx";
import { checkConnectionPreflight } from "../connectionPreflight.ts";
import { formatReadinessFreshness, getReadinessFreshness } from "../readinessFreshness.ts";
import { readStableReadiness } from "../readinessPolling.ts";

const refreshIntervalMs = 30_000;

/** Supervisor/Runtime 刚重启时 IPC 可能短暂不可用；不要一次失败就显示“未配置”。 */
async function readActiveWithRetry(): Promise<ProfileConfig | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await window.c2c.profile.getActive();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw lastError;
}

export function DashboardPage(): JSX.Element {
  const [profile, setProfile] = useState<ProfileConfig | null>(null);
  const [readiness, setReadiness] = useState<ReadinessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalQueueSnapshot | null>(null);
  const [approvalsFailed, setApprovalsFailed] = useState(false);
  const [executions, setExecutions] = useState<ExecutionListResponse | null>(null);
  const [executionsFailed, setExecutionsFailed] = useState(false);
  const refreshActive = useRef(false);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, refreshIntervalMs);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  async function refresh(): Promise<void> {
    if (refreshActive.current) return;
    refreshActive.current = true;
    setBusy(true);
    try {
      const [active, currentReadiness] = await Promise.all([
        readActiveWithRetry(),
        readStableReadiness(() => window.c2c.readiness.get()),
      ]);
      setProfile(active);
      setReadiness(currentReadiness);
      setLoadError(null);
      // Pending approvals + recent executions are supplementary; their failure
      // must not take down the whole dashboard.
      try {
        setApprovals(await window.c2c.security.approvals.list());
        setApprovalsFailed(false);
      } catch {
        setApprovals(null);
        setApprovalsFailed(true);
      }
      try {
        setExecutions(await window.c2c.collaboration.listExecutions(5));
        setExecutionsFailed(false);
      } catch {
        setExecutions(null);
        setExecutionsFailed(true);
      }
    } catch {
      setLoadError("无法读取本机状态。现有状态会随时间过期，请稍后刷新或打开诊断与日志。");
    } finally {
      setLoading(false);
      setBusy(false);
      refreshActive.current = false;
    }
  }

  async function handleConnectChatgpt(): Promise<void> {
    const preflight = checkConnectionPreflight(profile, readiness);
    if (!preflight.allowed) return;
    setBusy(true);
    try {
      await window.c2c.intent.create();
      await window.c2c.intent.openChatgpt();
      await refresh();
    } catch {
      setLoadError("授权流程未能启动。请检查连接授权和诊断结果。");
    } finally {
      setBusy(false);
    }
  }

  const freshness = getReadinessFreshness(readiness);
  const hasFreshObservation = freshness.status === "FRESH";
  const layers = readiness?.layers;
  const displayedLayer = (state: LayerState | undefined): LayerState =>
    hasFreshObservation ? (state ?? "UNKNOWN") : "UNKNOWN";
  const freshnessDetail = formatReadinessFreshness(freshness);
  const preflight = checkConnectionPreflight(profile, readiness);
  const runtimeState = displayedLayer(layers?.runtime);
  const runtimeLabel = loading
    ? "正在读取"
    : loadError && !readiness
      ? "状态未知"
      : !profile
        ? "未选择 Profile"
        : runtimeState === "PASS"
          ? "本地 Runtime 可用"
          : runtimeState === "FAIL"
            ? "本地 Runtime 检查失败"
            : runtimeState === "DEGRADED"
              ? "本地 Runtime 部分可用"
              : !hasFreshObservation
                ? "本地 Runtime 状态已过期或未检查"
                : "本地 Runtime 尚未验证";
  const runtimeTone = runtimeState === "PASS" ? "green" : runtimeState === "FAIL" ? "red" : runtimeState === "DEGRADED" ? "yellow" : "gray";
  const nextAction = getNextAction(profile, layers, hasFreshObservation);
  const pendingApprovalCount = approvals?.records?.filter((record) => record.decision === "PENDING").length ?? null;
  const latestExecution = executions?.records[0] ?? null;
  const executionStatusLabel = latestExecution
    ? (latestExecution.status === "PASS" ? "通过" : latestExecution.status === "FAIL" ? "失败" : "未知")
    : null;

  return (
    <div className="v2-page">
      <div className="v2-page-head">
        <div>
          <div className="page-title">总览</div>
          <p className="muted v2-subtitle">先看异常，再决定连接、授权还是排障。当前 Profile：{profile?.profileName ?? "未选择配置"}。</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn secondary" type="button" onClick={() => void refresh()} disabled={busy} data-testid="btn-refresh">
            {busy ? "检查中…" : "刷新状态"}
          </button>
          <a className="btn" href="#/services/new">+ 新建 MCP 服务</a>
        </div>
      </div>

      <div className="v2-metrics">
        <div className="v2-metric">
          <span>Runtime</span>
          <strong className={`metric-${runtimeTone}`}>{runtimeLabel}</strong>
          <small>{freshnessDetail}</small>
        </div>
        <div className="v2-metric">
          <span>待审批</span>
          <strong>{pendingApprovalCount ?? "—"}</strong>
          <small>{pendingApprovalCount === null ? "审批接口不可用" : pendingApprovalCount === 0 ? "没有等待处理的请求" : "需要本机确认"}</small>
        </div>
        <div className="v2-metric">
          <span>最近任务</span>
          <strong>{executionStatusLabel ?? "—"}</strong>
          <small>{latestExecution?.summary ?? "暂无执行记录"}</small>
        </div>
        <div className="v2-metric">
          <span>工作区</span>
          <strong style={{ fontSize: 13 }}>{profile?.currentWorkspace?.root ?? "未绑定"}</strong>
          <small>{profile?.transport.provider ?? "LOCAL_ONLY"} · 端口 {profile?.transport.expectedLocalPort ?? "—"}</small>
        </div>
      </div>

      {!loading && !profile && <div className="banner info" data-testid="portable-onboarding-cta">本机还没有配置工作区。<a className="btn" href="#/setup">开始配置这台电脑</a></div>}
      {loadError && <p className="dashboard-inline-error" role="status">{loadError}</p>}
      {readiness?.lastError && hasFreshObservation && runtimeState === "FAIL" && (
        <div className="banner error">本地 Runtime 检查失败。请打开诊断与日志查看分层证据。</div>
      )}

      <div className="card hero-card dashboard-hero-card">
        <div className="section-title">下一步</div>
        <div className="hero-row">
          <div>
            <div className="hero-title">{nextAction.title}</div>
            <div className="muted">{nextAction.detail}</div>
          </div>
          <div className="hero-actions">
            {nextAction.href && <a className="btn secondary" href={nextAction.href}>{nextAction.actionLabel}</a>}
            {nextAction.kind === "refresh" && <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>立即检查</button>}
            <button className="btn" type="button" onClick={handleConnectChatgpt} disabled={busy || !preflight.allowed} data-testid="btn-connect">
              连接 ChatGPT
            </button>
          </div>
        </div>
        {!preflight.allowed && <p className="hero-preflight" role="status">连接条件未满足：{preflight.reason}</p>}
      </div>

      <HealthStrip />
      <ServiceOverview />
      <section className="page-section dashboard-quick-workflow" aria-labelledby="quick-workflow-title" data-testid="quick-workflow">
        <div className="section-title" id="quick-workflow-title">常用操作 · 一处开始</div>
        <p className="muted">需要调整 MCP 授权或查看本机审批？<a href="#/company-observer" data-testid="quick-mcp-center">打开 LinOS MCP 控制中心</a></p>
        <div className="quick-action-grid">
          <a className="quick-action" href="#/connect" data-testid="quick-connect">
            <span className="quick-action-number">01</span><strong>连接 ChatGPT</strong><span>连接与 OAuth 授权、MCP 服务检查</span>
          </a>
          <a className="quick-action" href="#/security/approvals" data-testid="quick-approvals">
            <span className="quick-action-number">02</span><strong>审批文件操作</strong><span>{pendingApprovalCount === null ? "查看授权与审批队列" : pendingApprovalCount === 0 ? "当前没有待处理审批" : `${pendingApprovalCount} 条审批等待处理`}</span>
          </a>
          <a className="quick-action" href="#/collaboration/tests" data-testid="quick-tests">
            <span className="quick-action-number">03</span><strong>开发与测试</strong><span>查看 Git、测试记录与实际执行证据</span>
          </a>
          <a className="quick-action" href="#/diagnostics" data-testid="quick-diagnostics">
            <span className="quick-action-number">04</span><strong>诊断与修复</strong><span>查看运行异常、修复建议与审计记录</span>
          </a>
        </div>
      </section>

      <CapabilityCard profile={profile} />

      <details className="status-details page-section" data-testid="status-details">
        <summary>系统详细检查 · 6 项状态（点击展开）</summary>
        <p className="muted">只有真实检测到的状态才能显示为通过；未验证与无数据不能当作正常。</p>
        <div className="card-grid" data-testid="status-grid" aria-label="六层状态">
        <StatusCard title="本地 Runtime" state={displayedLayer(layers?.runtime)} detail={!hasFreshObservation ? freshnessDetail : undefined} />
        <StatusCard title="Tunnel / Transport" state={displayedLayer(layers?.transport)} detail="远程通道状态与本地 Runtime 分开；查看连接授权中的 Edge 与公网探测。" />
        <StatusCard title="OAuth 客户端" state={displayedLayer(layers?.connector)} detail="授权或客户端识别不代表已完成真实工具调用。" />
        <StatusCard title="实际工具调用" state={displayedLayer(layers?.conversation)} detail="仅当来源观察到真实调用时才显示通过。" />
        <StatusCard title="Workspace" state={displayedLayer(layers?.workspace)} detail="根据本机服务返回的工作区身份匹配结果。" />
        <StatusCard title="Git 仓库" state={displayedLayer(layers?.repository)} detail="非 Git 工作区显示为不适用。" />
        </div>
      </details>

      <div className="page-section card-grid">
        <section className="card" aria-labelledby="current-context-title">
          <div className="section-title" id="current-context-title">当前工作区</div>
          <div className="kv">
            <div className="k">连接配置</div><div className="v">{profile?.profileName ?? (loading ? "读取中" : "未配置或未知")}</div>
            <div className="k">工作目录</div><div className="v">{profile?.currentWorkspace?.root ?? "未绑定"}</div>
          </div>
          <details className="technical-details">
            <summary>查看技术标识和连接设置</summary>
            <div className="kv" style={{ marginTop: 10 }}>
            <div className="k">Profile</div><div className="v">{profile?.profileName ?? (loading ? "读取中" : "未配置或未知")}</div>
            <div className="k">Profile ID</div><div className="v">{profile?.profileId ?? "—"}</div>
            <div className="k">Workspace 目录</div><div className="v">{profile?.currentWorkspace?.root ?? "—"}</div>
            <div className="k">Workspace ID</div><div className="v">{profile?.currentWorkspace.workspaceId ?? "—"}</div>
            <div className="k">Transport 配置</div><div className="v">{profile?.transport.provider ?? "未配置"}</div>
            </div>
          </details>
          <div className="toolbar" style={{ marginTop: 14 }}>
            <a className="btn secondary" href="#/workspace">管理工作区</a>
            <a className="btn secondary" href="#/connect">连接授权</a>
          </div>
        </section>

        <section className="card" aria-labelledby="activity-summary-title">
          <div className="section-title" id="activity-summary-title">待办与最近任务</div>
          <div className="list-item">
            <div>
              <strong>待审批</strong>
              <div className="muted">
                {pendingApprovalCount === null
                  ? (approvalsFailed ? "审批队列读取失败。" : "正在读取审批队列。")
                  : pendingApprovalCount === 0
                    ? "当前没有待处理的写入审批。"
                    : `当前有 ${pendingApprovalCount} 条待处理的写入审批。`}
              </div>
            </div>
            <span className="tag">{pendingApprovalCount === null ? (approvalsFailed ? "ERROR" : "…") : pendingApprovalCount === 0 ? "CLEAR" : String(pendingApprovalCount)}</span>
          </div>
          <div className="list-item">
            <div>
              <strong>最近执行</strong>
              <div className="muted">
                {executionsFailed
                  ? "执行记录读取失败。"
                  : latestExecution
                    ? `${latestExecution.taskId} · ${executionStatusLabel} · ${latestExecution.timestamp ? new Date(latestExecution.timestamp).toLocaleString() : "时间未知"}`
                    : executions
                      ? "当前 Profile 暂无执行记录。"
                      : "正在读取执行记录。"}
              </div>
            </div>
            <span className="tag">{executionsFailed ? "ERROR" : latestExecution ? (latestExecution.status === "PASS" ? "PASS" : latestExecution.status === "FAIL" ? "FAIL" : "UNKNOWN") : "NO_DATA"}</span>
          </div>
          <div className="toolbar" style={{ marginTop: 14 }}>
            <a className="btn secondary" href="#/security">查看权限与审批</a>
            <a className="btn secondary" href="#/collaboration">查看开发协作</a>
          </div>
        </section>
      </div>

      <div className="page-section">
        <div className="muted">连接状态来源：本机 Readiness API。观测时间超过 60 秒、缺失或无效时，状态降为“尚未验证”。公网异常不会被解释为本地 Runtime 整体故障。</div>
      </div>
    </div>
  );
}

interface NextAction {
  title: string;
  detail: string;
  href?: string;
  actionLabel?: string;
  kind?: "refresh";
}

function getNextAction(
  profile: ProfileConfig | null,
  layers: ReadinessSnapshot["layers"] | undefined,
  fresh: boolean,
): NextAction {
  if (!profile) return { title: "检查工作区配置", detail: "选择或创建一个 Profile，再选择它可以访问的 Workspace。", href: "#/workspace", actionLabel: "打开工作区" };
  if (!profile.currentWorkspace?.root) return { title: "选择 Workspace", detail: "当前 Profile 尚未绑定工作目录。", href: "#/workspace", actionLabel: "选择工作区" };
  if (!fresh) return { title: "刷新分层状态", detail: "上次观测已过期或没有新检查结果；旧状态不能用于连接前置判断。", kind: "refresh" };
  if (layers?.runtime !== "PASS") return { title: "检查本地 Runtime", detail: "本地服务需要单独验证；Tunnel / 公网异常会在连接授权分层显示。", href: "#/diagnostics", actionLabel: "打开诊断" };
  if (profile.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED" && layers.transport !== "PASS") {
    return { title: "检查 Tunnel 与公网探测", detail: "本地 Runtime 状态独立显示；请查看 Edge 与 Public HTTP 证据。", href: "#/connect", actionLabel: "打开连接授权" };
  }
  if (layers?.connector !== "PASS") return { title: "检查 ChatGPT 授权", detail: "客户端授权状态需要真实来源确认。", href: "#/connect", actionLabel: "打开连接授权" };
  if (layers?.conversation !== "PASS") return { title: "完成真实工具调用验证", detail: "客户端已识别或授权，不代表工具调用已经验证。", href: "#/connect", actionLabel: "查看连接状态" };
  return { title: "检查最近开发任务", detail: "前往开发协作查看真实 Git、测试和执行摘要。", href: "#/collaboration", actionLabel: "打开开发协作" };
}

