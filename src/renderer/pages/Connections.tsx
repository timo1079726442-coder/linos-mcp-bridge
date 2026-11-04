import React, { useEffect, useState } from "react";
import type {
  ConnectionIntent,
  DiagnosticsReport,
  LayerState,
  ProfileConfig,
  ServiceConnectionSettingsPatch,
  ServiceConnectionSettingsView,
  ServiceTransportProvider,
} from "../../shared/types.js";
import { checkConnectionPreflight, checkLocalIntentPreflight } from "../connectionPreflight.ts";
import { publicProbeLayer } from "../connectionStatus.ts";
import { formatReadinessFreshness, getReadinessFreshness } from "../readinessFreshness.ts";
import { StatusCard } from "../components/StatusCard.tsx";
import { MetricHelp } from "../components/MetricHelp.tsx";
import { McpServerWizard } from "../components/McpServerWizard.tsx";
import { McpServiceStatus } from "../components/McpServiceStatus.tsx";
import { MultiServicePanel } from "../components/MultiServicePanel.tsx";
import { pickSelfHealSuggestion, reasonCodeToMessage } from "../domains/transport/selfHeal.ts";

export type ConnectionView = "chatgpt" | "clients" | "mcp" | "tunnel";

export function ConnectionsPage({ view }: { view: ConnectionView }): JSX.Element {
  const [active, setActive] = useState<ProfileConfig | null>(null);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [intent, setIntent] = useState<ConnectionIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const [serviceSettings, setServiceSettings] = useState<ServiceConnectionSettingsView | null>(null);
  const [serviceDraft, setServiceDraft] = useState<ServiceConnectionSettingsPatch | null>(null);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  async function refresh(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const [nextProfile, nextReport] = await Promise.all([
        window.c2c.profile.getActive(),
        window.c2c.diagnostics.run(),
      ]);
      if (active?.profileId !== nextProfile?.profileId) setIntent(null);
      setActive(nextProfile);
      setReport(nextReport);
      setLoadError(null);

      // Service configuration is supplementary. An older/temporarily unavailable
      // Supervisor must not take down the connection health page.
      try {
        const nextServiceSettings = await window.c2c.profile.getServiceSettings();
        setServiceSettings(nextServiceSettings);
        setServiceDraft({
          expectedProfileId: nextServiceSettings.profileId,
          provider: nextServiceSettings.provider,
          hostname: nextServiceSettings.hostname,
          tunnelName: nextServiceSettings.tunnelName,
          tunnelId: nextServiceSettings.tunnelId,
          zone: nextServiceSettings.zone,
          binaryPath: nextServiceSettings.binaryPath,
        });
      } catch {
        setServiceSettings(null);
        setServiceDraft(null);
      }
    } catch {
      setLoadError("控制面暂不可用：当前未能从 Supervisor 取得 Profile/Diagnostics。下方 UNKNOWN 只表示未取得证据，不代表 Tunnel、OAuth、Runtime 同时故障。");
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }

  async function handleConnect(): Promise<void> {
    const preflight = checkConnectionPreflight(active, report?.readiness ?? null);
    if (!preflight.allowed) {
      setMessage(preflight.reason ?? "当前状态不满足连接前置条件。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const created = await window.c2c.intent.create();
      setIntent(created);
      await window.c2c.intent.openChatgpt();
      setMessage("授权页面已打开。请在 ChatGPT 完成确认，然后返回本页刷新；本地流程创建或客户端识别不代表真实工具调用已验证。");
    } catch {
      setMessage("无法启动授权流程。请检查本地 Runtime 与连接诊断；敏感信息不会在此展示。");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateLocalIntent(): Promise<void> {
    const preflight = checkLocalIntentPreflight(active, readiness);
    if (!preflight.allowed) {
      setMessage(preflight.reason ?? "当前状态不满足本地连接申请前置条件。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const created = await window.c2c.intent.create();
      setIntent(created);
      setMessage(`本地连接申请已建立并绑定当前 Runtime。Intent: ${created.intentId}；有效期至 ${new Date(created.expiresAt).toLocaleString()}。现在可运行隔离 CREATE 测试脚本；此状态不代表 OAuth 或 MCP 调用已完成。`);
    } catch {
      setMessage("无法建立本地连接申请。请刷新诊断，并确认当前 Runtime 正常；不会跳过 Supervisor 授权校验。");
    } finally {
      setBusy(false);
    }
  }

  const readiness = report?.readiness ?? null;
  const freshness = getReadinessFreshness(readiness, nowMs);
  const fresh = freshness.status === "FRESH";
  const freshnessText = formatReadinessFreshness(freshness);
  const preflight = loading
    ? { allowed: false, reason: "正在读取 Profile 与连接诊断。" }
    : checkConnectionPreflight(active, readiness);
  const localIntentPreflight = loading
    ? { allowed: false, reason: "正在读取 Profile 与连接诊断。" }
    : checkLocalIntentPreflight(active, readiness);
  const selfHealSuggestion = loading ? null : pickSelfHealSuggestion(report, active);

  async function handleSelfHeal(): Promise<void> {
    if (!active || !selfHealSuggestion) return;
    setBusy(true);
    setMessage("正在重测公网状态…");
    let freshReport: DiagnosticsReport;
    try {
      freshReport = await window.c2c.diagnostics.run();
      setReport(freshReport);
    } catch {
      setBusy(false);
      setMessage("无法读取最新诊断，请稍后重试。");
      return;
    }
    const suggestion = pickSelfHealSuggestion(freshReport, active);
    if (!suggestion) {
      setBusy(false);
      setMessage("当前 Profile 不满足自修前置条件。");
      return;
    }
    const match = await window.c2c.diagnostics
      .matchRepairOptions({
        signature: "fault:v1:" + "0".repeat(64),
        expectedProfileId: active.profileId,
        expectedWorkspaceId: active.currentWorkspace.workspaceId,
        diagnosisObservedAt: freshReport.generatedAt,
      })
      .catch(() => null);
    const matchEntry = match?.suggestions?.find((entry) => entry.suggestionId === suggestion);
    if (!matchEntry || !matchEntry.executable) {
      setBusy(false);
      setMessage(reasonCodeToMessage(matchEntry?.reasonCode ?? match?.reasonCode ?? "NO_MATCH"));
      return;
    }
    try {
      const attempt = await window.c2c.diagnostics.runRepair({
        signature: "fault:v1:" + "0".repeat(64),
        expectedProfileId: active.profileId,
        expectedWorkspaceId: active.currentWorkspace.workspaceId,
        diagnosisObservedAt: freshReport.generatedAt,
        suggestionId: suggestion,
      });
      if (attempt.result === "SUCCEEDED") {
        setMessage("隧道自修成功，已重新检查公网状态。");
        await refresh();
        return;
      }
      if (attempt.result === "REJECTED") {
        setMessage("已在系统弹窗中取消自修。");
        return;
      }
      setMessage(reasonCodeToMessage(attempt.postCheck.reasonCode ?? attempt.code ?? null));
    } catch {
      setMessage(reasonCodeToMessage(null));
    } finally {
      setBusy(false);
    }
  }
  async function handleImportServiceCredential(): Promise<void> {
    if (!active || !serviceDraft) return;
    setBusy(true);
    setMessage(null);
    try {
      const imported = await window.c2c.profile.importServiceCredential();
      if (imported.canceled) {
        setMessage("已取消凭证导入，没有修改当前 Profile。");
        return;
      }
      if (!imported.storedPath || imported.profileId !== active.profileId) {
        setMessage("凭证导入没有返回可绑定到当前 Profile 的结果。");
        return;
      }
      updateServiceDraft("credentialPath", imported.storedPath);
      setMessage(`凭证已复制到当前 Profile 私有目录：${imported.fileName ?? "已导入"}。还需点击“保存服务配置”后才会绑定到 Tunnel。`);
    } catch {
      setMessage("凭证导入失败。只接受 1 MB 以内的 JSON；文件内容不会显示在界面或日志中。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveServiceSettings(): Promise<void> {
    if (!serviceDraft || !active || serviceDraft.expectedProfileId !== active.profileId) {
      setMessage("当前 Profile 与服务配置草稿不一致，请重新诊断后再保存。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.c2c.profile.updateServiceSettings(serviceDraft);
      setServiceSettings(result.settings);
      setServiceDraft({
        expectedProfileId: result.settings.profileId,
        provider: result.settings.provider,
        hostname: result.settings.hostname,
        tunnelName: result.settings.tunnelName,
        tunnelId: result.settings.tunnelId,
        zone: result.settings.zone,
        binaryPath: result.settings.binaryPath,
      });
      setMessage(result.changed
        ? result.restartRequired
          ? "服务配置已安全保存。旧 Transport 已停止；请重启 C2C Supervisor/控制中心以按新配置启动，不会接管 48765。"
          : "服务配置已保存并生效。"
        : "配置没有变化，无需重启。");
    } catch {
      setMessage("服务配置未保存。可能是本机确认取消、Profile 已变化、生产隔离规则命中、凭证位置不安全或配置不完整。");
    } finally {
      setBusy(false);
    }
  }

  function updateServiceDraft<K extends keyof ServiceConnectionSettingsPatch>(
    key: K,
    value: ServiceConnectionSettingsPatch[K],
  ): void {
    setServiceDraft((current) => current ? { ...current, [key]: value } : current);
  }

  const statusLabel: Record<ConnectionIntent["status"], string> = {
    PENDING: "等待客户端确认",
    CLIENT_BOUND: "客户端已识别，授权尚未完成",
    CONSENT_PENDING: "等待本机 OAuth 确认",
    CONSUMED: "本次 OAuth 流程已完成",
    EXPIRED: "流程已过期",
    REVOKED: "流程已撤销",
    REVOKED_RUNTIME_RESTART: "Runtime 重启后流程失效",
  };
  const reportAgeMs = report ? nowMs - Date.parse(report.generatedAt) : Number.NaN;
  const reportMatchesProfile = report !== null && (report.profileMetadata?.profileId ?? null) === (active?.profileId ?? null);
  const reportIsFresh = fresh && report !== null && reportMatchesProfile && Number.isFinite(reportAgeMs) && reportAgeMs >= 0 && reportAgeMs <= 60_000;
  const intentExpired = Boolean(intent && Date.parse(intent.expiresAt) <= nowMs && !["CONSUMED", "REVOKED", "EXPIRED", "REVOKED_RUNTIME_RESTART"].includes(intent.status));
  const intentStatus = intentExpired ? "EXPIRED" : intent?.status;
  const viewInfo: Record<ConnectionView, { title: string; desc: string }> = {
    chatgpt: { title: "ChatGPT 连接", desc: "把本机 Runtime 授权给 ChatGPT 网页版：先建连接申请，再用配对码/授权页完成绑定。" },
    clients: { title: "其他 AI 客户端", desc: "给 Cursor、Claude 等客户端使用的 MCP 地址与授权信息。" },
    mcp: { title: "MCP 服务", desc: "本机三个服务的端口、健康检查与工具清单；48765 / 48766 / 48767 各自独立。" },
    tunnel: { title: "Cloudflare 隧道", desc: "把本机 MCP 暴露成公网 HTTPS；ChatGPT 网页版必须走这一步。" },
  };

  return (
    <>
      
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">{viewInfo[view].title}</div>
        <p className="muted" style={{ margin: 0 }}>{viewInfo[view].desc}</p>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted">当前 Profile：<strong>{active?.profileName ?? (loading ? "读取中" : "未配置或未知")}</strong></span>
        <span className="muted" style={{ marginLeft: "auto" }}>{freshnessText}</span>
        {view === "tunnel" && selfHealSuggestion && (
          <button
            className="btn"
            type="button"
            onClick={() => void handleSelfHeal()}
            disabled={busy}
            data-testid="btn-tunnel-self-heal"
            style={{ marginLeft: 8 }}
          >
            {busy ? "自修中…" : "自检自修"}
          </button>
        )}
        <button className="btn secondary" type="button" onClick={() => void refresh()} disabled={busy} data-testid="btn-refresh-connections">
          {busy ? "检查中…" : "重新诊断"}
        </button>
      </div>

      {loadError && <div className="banner warn" role="status">{loadError}</div>}
      {report && !reportMatchesProfile && <div className="banner warn" role="status">Profile 在读取期间发生变化。此份 Diagnostics 结果不与当前 Profile 合并，请重新检查。</div>}
      {message && <div className="banner info" role="status">{message}</div>}

      {/* 一键配对/隧道/检测修复：放在标签页之上，任何标签下都能看到重点 */}

      <section className="card" aria-label="连接授权当前状态" style={{ marginBottom: 16 }}>
        <div className="section-title">一、当前连接概况</div>
        <div className="kv">
          <div className="k">使用模式</div><div className="v">{active?.transport.provider === "LOCAL_ONLY" ? "仅本机（不需要公网隧道）" : active?.transport.provider === "CLOUDFLARE_NAMED" ? "Cloudflare 公网隧道" : "暂未取得配置"}</div>
          <div className="k">本机服务</div><div className="v">{reportIsFresh ? (report?.runtime.healthEndpointOk ? "已响应健康检查" : "健康检查未通过") : "尚无有效实时证据"}</div>
          <div className="k">真实 MCP 调用</div><div className="v">{reportIsFresh ? (readiness?.layers.conversation === "PASS" ? "已取得真实调用通过证据" : "尚未确认真实工具调用成功") : "尚无有效实时证据"}</div>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>配置已保存、服务可访问、客户端已授权、工具实际调用成功，是四个不同阶段；请以实际调用结果作为最终验收。</p>
      </section>
      <section className="page-section" role="tabpanel" id={`connection-panel-${view}`} aria-labelledby={`connection-tab-${view}`}>
        {view === "chatgpt" && (
          <>
            <section className="card">
              <div className="section-title">二、ChatGPT 授权与连接操作</div>
              <div className="card-grid">
                <StatusCard
                  title="OAuth / 客户端层"
                  state={layerForDisplay(readiness?.layers.connector, reportIsFresh)}
                  detail={reportIsFresh ? "来自本机 Readiness 观测；它不代表已发生成功的 MCP 工具调用。" : freshnessText}
                />
                <StatusCard
                  title="实际工具调用"
                  state={layerForDisplay(readiness?.layers.conversation, reportIsFresh)}
                  detail="只根据 Readiness 的真实调用观测展示；本页面不会用客户端注册或授权流程代替调用证据。"
                />
              </div>
              <div className="kv" style={{ marginTop: 14 }}>
                <div className="k"><MetricHelp term="Profile">Profile</MetricHelp></div><div className="v">{active?.profileName ?? "—"}</div>
                <div className="k"><MetricHelp term="Workspace">Workspace</MetricHelp></div><div className="v">{active?.currentWorkspace?.root ?? "—"}</div>
                <div className="k">授权流程</div><div className="v">{intent && intentStatus ? statusLabel[intentStatus] : "本页尚未发起流程；历史 Intent 列表 API 未公开。"}</div>
                {intent && <><div className="k">Intent ID</div><div className="v" data-testid="connection-intent-id">{intent.intentId}</div><div className="k">流程有效期</div><div className="v">{new Date(intent.expiresAt).toLocaleString()}</div></>}
              </div>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn" type="button" onClick={() => void handleCreateLocalIntent()} disabled={busy || !localIntentPreflight.allowed} data-testid="btn-create-local-intent">
                  创建本地连接申请
                </button>
                {!localIntentPreflight.allowed && <span className="muted">{localIntentPreflight.reason}</span>}
                {active?.transport.provider !== "LOCAL_ONLY" && (
                  <button className="btn secondary" type="button" onClick={() => void handleConnect()} disabled={busy || !preflight.allowed} data-testid="btn-connect-chatgpt">
                    连接 ChatGPT
                  </button>
                )}
                {active?.transport.provider !== "LOCAL_ONLY" && !preflight.allowed && <span className="muted">{preflight.reason}</span>}
              </div>
            </section>
            <div className="muted" style={{ marginTop: 12 }}>已配置、已授权、已连接和已验证是不同状态。每个状态必须由对应的真实来源确认。</div>
          </>
        )}

        {view === "clients" && (
          <section className="card">
            <div className="section-title">其他 AI 客户端</div>
            <div className="banner warn">当前没有公开的客户端注册/配置列表 API，因此列表状态为 NO_DATA；不会把 OAuth 注册记录当成真实工具调用成功。</div>
            <div className="list-item">
              <div><strong>已配置客户端</strong><div className="muted">未取得数据，数量未知。</div></div>
              <span className="tag">NO_DATA</span>
            </div>
            <div className="list-item">
              <div><strong>真实工具调用</strong><div className="muted">尚无按客户端区分的真实调用历史接口。</div></div>
              <span className="tag">UNKNOWN</span>
            </div>
          </section>
        )}

        {view === "mcp" && (
          <>
          <McpServiceStatus />
          <MultiServicePanel />
          <McpServerWizard />
          <section className="card">
            <div className="section-title">二、本地 MCP 服务检查</div>
            <div className="card-grid">
              <StatusCard
                title="本地 Runtime 健康端点"
                state={!active || !reportIsFresh ? "UNKNOWN" : report?.runtime.healthEndpointOk ? "PASS" : "FAIL"}
                detail={reportIsFresh ? "由本机 Diagnostics 探测；不受公网探测状态替代。" : freshnessText}
              />
              <StatusCard
                title="真实 MCP 调用"
                state={layerForDisplay(readiness?.layers.conversation, reportIsFresh)}
                detail="Runtime 可达不等于 MCP 工具调用已成功。"
              />
            </div>
            <div className="kv" style={{ marginTop: 14 }}>
              <div className="k">Profile 配置的 Transport</div><div className="v">{active?.transport.provider ?? "未配置"}</div>
              <div className="k">Diagnostics 观察的 Transport</div><div className="v">{reportIsFresh ? report?.transport.provider ?? "UNKNOWN" : "UNKNOWN / STALE"}</div>
              <div className="k">配置的本地端口</div><div className="v">{active?.transport.expectedLocalPort ?? "—"}</div>
              <div className="k">探测端口</div><div className="v">{reportIsFresh ? report?.runtime.port ?? "未观察到" : "UNKNOWN / STALE"}</div>
            </div>
          </section>
          </>
        )}

        {view === "tunnel" && (
          <section className="card">
            <div className="section-title">二、公网隧道检查（仅启用公网模式时需要）</div>
            {reportIsFresh && report?.transport.publicHealthStatus === 530 && (
              <div className="banner warn">公网探测返回 HTTP 530。此结果只表示公网链路异常；本地 Runtime 健康状态单独显示。</div>
            )}
            {selfHealSuggestion && reportIsFresh && (
              <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                按上方“自检自修”可重启当前 Profile 隧道；操作需要本机确认且不修改 48765。
              </div>
            )}
            <div className="card-grid">
              <div className="card">
                <div className="card-title"><MetricHelp term="Profile Transport 选择">Profile Transport 选择</MetricHelp></div>
                <div className="card-value">{active?.transport.provider ?? "UNKNOWN"}</div>
                <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>此处只显示配置值；不表示 Tunnel 已启动或公网可用。</div>
              </div>
              <StatusCard
                title="Cloudflare Edge"
                state={!reportIsFresh ? "UNKNOWN" : active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "NOT_APPLICABLE" : report?.transport.edgeConnected ? "PASS" : "FAIL"}
                detail={reportIsFresh ? "来自本机 Diagnostics 的 Tunnel health 探测。" : freshnessText}
              />
              <StatusCard
                title="公网 HTTP"
                state={!reportIsFresh ? "UNKNOWN" : active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "NOT_APPLICABLE" : publicProbeLayer(report?.transport.publicHealthStatus ?? null, true)}
                detail={!reportIsFresh ? freshnessText : active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "当前为 LOCAL_ONLY，没有公网 HTTP 探测要求。" : `HTTP ${report?.transport.publicHealthStatus ?? "无响应"}；此状态不会覆盖本地 Runtime。`}
              />
              <StatusCard
                title="OAuth Discovery"
                state={!reportIsFresh ? "UNKNOWN" : active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "NOT_APPLICABLE" : report?.transport.oauthDiscoveryOk ? "PASS" : "FAIL"}
                detail={active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "当前为 LOCAL_ONLY，不需要公网 OAuth Discovery。" : "只表示 Discovery 探测结果，不代表 OAuth 已授权。"}
              />
              <StatusCard
                title="未授权 MCP 探测"
                state={!reportIsFresh ? "UNKNOWN" : active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "NOT_APPLICABLE" : report?.transport.publicMcpAnonymous === 401 ? "PASS" : report?.transport.publicMcpAnonymous === null ? "UNKNOWN" : "DEGRADED"}
                detail={active?.transport.provider?.toUpperCase() !== "CLOUDFLARE_NAMED" ? "当前为 LOCAL_ONLY，不执行公网匿名 MCP 探测。" : "预期 401 表示匿名访问被拒绝，不代表已登录客户端成功调用。"}
              />
            </div>
            <div className="kv" style={{ marginTop: 14 }}>
              <div className="k"><MetricHelp term="Profile 配置 URL">Profile 配置 URL</MetricHelp></div><div className="v">{active?.transport.publicMcpUrl ?? "未配置"}</div>
              <div className="k"><MetricHelp term="Diagnostics 探测时间">Diagnostics 探测时间</MetricHelp></div><div className="v">{reportIsFresh && report ? new Date(report.generatedAt).toLocaleString() : "UNKNOWN / STALE"}</div>
            </div>

            <div style={{ borderTop: "1px solid var(--border)", marginTop: 18, paddingTop: 16 }}>
              <div className="section-title">三、OAuth / Tunnel 服务配置（高级操作）</div>
              <div className="muted" style={{ marginBottom: 12 }}>
                配置只作用于当前 V2 Profile。本地端口固定为 48766；生产 48765、生产域名和生产 Tunnel 由 Supervisor 硬性拒绝。
              </div>
              {!serviceDraft || !serviceSettings ? (
                <div className="banner warn">服务配置尚未读取，不能安全编辑。</div>
              ) : (
                <>
                  <div className="kv">
                    <div className="k"><MetricHelp term="本地 Host / Port">本地 Host / Port</MetricHelp></div>
                    <div className="v">{serviceSettings.expectedLocalHost}:{serviceSettings.expectedLocalPort}（固定）</div>
                    <div className="k"><MetricHelp term="ChatGPT 启动地址">ChatGPT 启动地址</MetricHelp></div>
                    <div className="v">{serviceSettings.chatgptLaunchUrl}</div>
                    <div className="k">凭证状态</div>
                    <div className="v">{serviceSettings.credentialConfigured ? "当前 Profile 已配置" : "未配置"}</div>
                  </div>

                  <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
                    <label>
                      <span className="muted"><MetricHelp term="Transport 模式">Transport 模式</MetricHelp></span>
                      <select
                        value={serviceDraft.provider}
                        onChange={(event) => updateServiceDraft("provider", event.target.value as ServiceTransportProvider)}
                        disabled={busy}
                        style={{ display: "block", width: "100%", marginTop: 4 }}
                      >
                        <option value="LOCAL_ONLY">LOCAL_ONLY（仅本机）</option>
                        <option value="CLOUDFLARE_NAMED">CLOUDFLARE_NAMED（命名隧道）</option>
                      </select>
                    </label>

                    {serviceDraft.provider === "CLOUDFLARE_NAMED" && (
                      <>
                        <label>
                          <span className="muted"><MetricHelp term="Hostname">Hostname</MetricHelp></span>
                          <input value={serviceDraft.hostname ?? ""} onChange={(event) => updateServiceDraft("hostname", event.target.value)} placeholder="例如 c2c-v2-preview.example.com" disabled={busy} style={{ display: "block", width: "100%", marginTop: 4 }} />
                        </label>
                        <label>
                          <span className="muted"><MetricHelp term="Tunnel 名称">Tunnel 名称</MetricHelp></span>
                          <input value={serviceDraft.tunnelName ?? ""} onChange={(event) => updateServiceDraft("tunnelName", event.target.value)} placeholder="V2 独立 Tunnel 名称" disabled={busy} style={{ display: "block", width: "100%", marginTop: 4 }} />
                        </label>
                        <label>
                          <span className="muted"><MetricHelp term="Tunnel ID">Tunnel ID</MetricHelp></span>
                          <input value={serviceDraft.tunnelId ?? ""} onChange={(event) => updateServiceDraft("tunnelId", event.target.value)} placeholder="Cloudflare Tunnel ID" disabled={busy} style={{ display: "block", width: "100%", marginTop: 4 }} />
                        </label>
                        <label>
                          <span className="muted"><MetricHelp term="Zone">Zone</MetricHelp>（可选）</span>
                          <input value={serviceDraft.zone ?? ""} onChange={(event) => updateServiceDraft("zone", event.target.value || null)} disabled={busy} style={{ display: "block", width: "100%", marginTop: 4 }} />
                        </label>
                        <label>
                          <span className="muted"><MetricHelp term="cloudflared">cloudflared</MetricHelp> 可执行文件（可选；空值使用系统解析）</span>
                          <input value={serviceDraft.binaryPath ?? ""} onChange={(event) => updateServiceDraft("binaryPath", event.target.value || null)} placeholder="cloudflared.exe 的本机路径" disabled={busy} style={{ display: "block", width: "100%", marginTop: 4 }} />
                        </label>
                        <div>
                          <span className="muted">Tunnel 凭证</span>
                          <div className="row" style={{ marginTop: 4, flexWrap: "wrap" }}>
                            <button className="btn secondary" type="button" onClick={() => void handleImportServiceCredential()} disabled={busy}>
                              选择并导入凭证 JSON
                            </button>
                            <span className="muted">
                              {serviceDraft.credentialPath ? "本次已选择新的 Profile 私有凭证" : serviceSettings.credentialConfigured ? "沿用当前 Profile 已配置凭证" : "尚未配置凭证"}
                            </span>
                          </div>
                          <p className="muted" style={{ margin: "6px 0 0" }}>凭证内容不进入 Renderer；选择后先复制到当前 Profile 私有目录，保存配置时再绑定。</p>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="row" style={{ marginTop: 14 }}>
                    <button className="btn" type="button" onClick={() => void handleSaveServiceSettings()} disabled={busy}>
                      {busy ? "处理中…" : "保存服务配置"}
                    </button>
                    <span className="muted">保存前会弹本机确认；远程配置变化后需重启 Supervisor 才会启动新 Tunnel。</span>
                  </div>
                </>
              )}
            </div>
          </section>
        )}
      </section>
    </>
  );
}

function layerForDisplay(state: LayerState | undefined, fresh: boolean): LayerState {
  return fresh ? (state ?? "UNKNOWN") : "UNKNOWN";
}



