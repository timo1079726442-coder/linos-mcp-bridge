import { Link } from "react-router-dom";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DiagnosticsReport,
  FaultCaseView,
  FaultCasesResponse,
  RepairAttemptView,
  RepairHistoryResponse,
  RepairSuggestionView,
} from "../../../shared/types.js";
import { lessonCatalog, lessonsById, searchLessons, type LessonEvidenceStatus, type LessonRecord } from "./lessonCatalog.js";
import "./collaboration-diagnostics.css";

type LoadState = "loading" | "error" | "ready";

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }): JSX.Element {
  return <span className={"c2c-evidence-badge " + tone}>{children}</span>;
}
function Card({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return <section className="c2c-domain-card"><h2>{title}</h2>{children}</section>;
}
function SourceLine({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="c2c-source-line">{children}</p>;
}
function EmptyState({ title, body, kind = "gap" }: { title: string; body: string; kind?: "gap" | "empty" }): JSX.Element {
  return <div className={"c2c-empty-state " + kind} role="status"><strong>{title}</strong><p>{body}</p></div>;
}
function formatTime(value: string | null | undefined): string {
  if (!value) return "未提供";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "时间格式不可识别" : time.toLocaleString();
}
function safeReasonCode(value: string | null | undefined): string {
  return value && /^[A-Z0-9_]{1,64}$/.test(value) ? value : "UNKNOWN";
}

function useLiveDiagnostics(): {
  report: DiagnosticsReport | null;
  state: LoadState;
  refresh: () => Promise<DiagnosticsReport | null>;
} {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const refresh = useCallback(async (): Promise<DiagnosticsReport | null> => {
    setState("loading");
    try {
      const next = await window.c2c.diagnostics.run();
      setReport(next);
      setState("ready");
      return next;
    } catch {
      setState("error");
      return null;
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { report, state, refresh };
}

function useFaultCases(report: DiagnosticsReport | null, diagnosticsState: LoadState): { snapshot: FaultCasesResponse | null; state: LoadState } {
  const [snapshot, setSnapshot] = useState<FaultCasesResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const profileId = report?.profileMetadata?.profileId ?? null;
  const observedAt = report?.generatedAt ?? null;
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    if (!observedAt) {
      setState(diagnosticsState === "error" ? "error" : "loading");
      return () => { current = false; };
    }
    if (!profileId) {
      setState("error");
      return () => { current = false; };
    }
    setState("loading");
    void window.c2c.diagnostics.listFaultCases({ expectedProfileId: profileId, limit: 100 })
      .then((result) => {
        if (current) {
          setSnapshot(result);
          setState("ready");
        }
      })
      .catch(() => { if (current) setState("error"); });
    return () => { current = false; };
  }, [diagnosticsState, observedAt, profileId]);
  return { snapshot, state };
}

function useRepairHistory(report: DiagnosticsReport | null, diagnosticsState: LoadState): { snapshot: RepairHistoryResponse | null; state: LoadState } {
  const [snapshot, setSnapshot] = useState<RepairHistoryResponse | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const profileId = report?.profileMetadata?.profileId ?? null;
  const observedAt = report?.generatedAt ?? null;
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    if (!observedAt) {
      setState(diagnosticsState === "error" ? "error" : "loading");
      return () => { current = false; };
    }
    if (!profileId) {
      setState("error");
      return () => { current = false; };
    }
    setState("loading");
    void window.c2c.diagnostics.listRepairHistory({ expectedProfileId: profileId, limit: 100 })
      .then((result) => {
        if (current) {
          setSnapshot(result);
          setState("ready");
        }
      })
      .catch(() => { if (current) setState("error"); });
    return () => { current = false; };
  }, [diagnosticsState, observedAt, profileId]);
  return { snapshot, state };
}

function evidenceLabel(status: LessonEvidenceStatus): string {
  if (status === "CONFIRMED") return "文档字段明确且有验证";
  if (status === "HIGH_CONFIDENCE") return "文档有证据与验证";
  return "候选经验";
}
function evidenceTone(status: LessonEvidenceStatus): string {
  if (status === "CONFIRMED") return "success";
  if (status === "HIGH_CONFIDENCE") return "warning";
  return "neutral";
}
function LessonCard({ lesson }: { lesson: LessonRecord }): JSX.Element {
  const fields: Array<[string, string | null]> = [
    ["现象", lesson.symptom],
    ["错误码 / 标识", lesson.errorCodes.length ? lesson.errorCodes.join(", ") : null],
    ["错误假设", lesson.mistakenAssumption],
    ["文档记载的根因", lesson.documentedRootCause],
    ["证据", lesson.documentedEvidence],
    ["处理方案", lesson.documentedFix],
    ["验证", lesson.verification],
    ["避免方法", lesson.prevention],
  ];
  return (
    <details className="c2c-lesson-card">
      <summary><span><strong>{lesson.id}</strong> {lesson.title}</span><Badge tone={evidenceTone(lesson.evidenceStatus)}>{evidenceLabel(lesson.evidenceStatus)}</Badge></summary>
      <div className="c2c-lesson-fields">
        {fields.filter(([, value]) => value).map(([label, value]) => <p key={label}><strong>{label}：</strong>{value}</p>)}
        <SourceLine>来源：{lesson.provenance}。这是版本化历史资料，不表示当前 Profile 的根因已经确认。</SourceLine>
      </div>
    </details>
  );
}

function FaultCaseCard({ fault, onSelect, selected = false }: {
  fault: FaultCaseView;
  onSelect?: (fault: FaultCaseView) => void;
  selected?: boolean;
}): JSX.Element {
  const lessons = lessonsById(fault.matchingLessonIds);
  return (
    <article className="c2c-observation-card" data-testid="fault-case">
      <div className="c2c-observation-heading">
        <strong>{fault.code}</strong>
        <Badge tone={fault.state === "OPEN" ? "warning" : "success"}>{fault.state === "OPEN" ? "当前未恢复" : "复测后已恢复"}</Badge>
      </div>
      <p>签名 {fault.signature} · Profile 隔离 · 出现 {fault.occurrenceCount} 次</p>
      <ul>
        <li>观测证据：{fault.evidenceCodes.join("、") || "暂无可展示证据码"}</li>
        <li>根因状态：候选；现象记录本身不构成根因确认。</li>
        <li>首次 / 最近：{formatTime(fault.firstSeenAt)} / {formatTime(fault.lastSeenAt)}</li>
      </ul>
      {lessons.length > 0 && <p className="c2c-muted">关联历史资料：{lessons.map((lesson) => lesson.id + " " + lesson.title).join("；")}</p>}
      {onSelect && fault.state === "OPEN" && (
        <button className={selected ? "btn" : "btn secondary"} type="button" onClick={() => onSelect(fault)}>
          {selected ? "已选择此故障" : "匹配受控修复"}
        </button>
      )}
    </article>
  );
}

export function FaultKnowledgeBaseView(): JSX.Element {
  const { report, state, refresh } = useLiveDiagnostics();
  const { snapshot, state: casesState } = useFaultCases(report, state);
  const [query, setQuery] = useState("");
  const lessons = useMemo(() => searchLessons(query), [query]);
  const faults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (snapshot?.cases ?? []).filter((fault) => !normalized || [
      fault.code, fault.signature, fault.layer, ...fault.evidenceCodes, ...fault.matchingLessonIds,
    ].some((value) => value.toLocaleLowerCase().includes(normalized)));
  }, [query, snapshot]);

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div><h1>故障知识库</h1><p>检索 L01–L32 历史经验，并查看由本机 AuditChain 自动归并的当前故障记录。</p></div>
        <button className="btn" type="button" onClick={() => void refresh()} disabled={state === "loading"}>
          {state === "loading" ? "诊断中…" : "重新诊断并归档"}
        </button>
      </div>
      <label className="c2c-search-field">
        <span>搜索现象、根因、方案、错误码或编号</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：530、Workspace、OAuth、L31" />
      </label>
      <SourceLine>
        历史资料来自 docs/LESSONS_LEARNED.md；当前故障来自本次 Diagnostics 与当前 Profile 的 AuditChain 投影。
        {report ? " 最近观测：" + formatTime(report.generatedAt) + "。" : ""}
      </SourceLine>
      <Card title={"当前 Profile 故障 · " + faults.length + " 条"}>
        {casesState === "loading" && <EmptyState title="正在读取故障档案" body="Diagnostics 已触发本机观测，随后读取当前 Profile 的脱敏审计投影。" kind="empty" />}
        {casesState === "error" && <EmptyState title="故障档案暂不可用" body="没有取得可靠的 Profile 或 AuditChain 投影；不会把不可用显示成空记录。" />}
        {casesState === "ready" && snapshot?.state === "UNAVAILABLE" && <EmptyState title="故障档案不可用" body={"本机投影返回 " + safeReasonCode(snapshot.reasonCode) + "。"} />}
        {casesState === "ready" && snapshot?.state === "STALE" && <EmptyState title="Profile 已变化，档案快照过期" body="重新诊断后再读取当前 Profile 的故障记录。" />}
        {casesState === "ready" && snapshot?.state === "NO_DATA" && <EmptyState title="当前 Profile 暂无归档故障" body="这是本机 AuditChain 投影的真实空结果；静态历史经验仍可在下方搜索。" kind="empty" />}
        {casesState === "ready" && faults.map((fault) => <FaultCaseCard key={fault.signature} fault={fault} />)}
      </Card>
      <Card title={"版本化历史经验 · " + lessons.length + " 条"}>
        <SourceLine>经验的证据等级只描述文档明确记载的材料；带有“可能、推测、待确认”等表述的根因保留为候选。</SourceLine>
        {lessons.length === 0
          ? <EmptyState title="没有匹配的历史经验" body="试试更短的关键字。" kind="empty" />
          : <div className="c2c-domain-stack">{lessons.map((lesson) => <LessonCard key={lesson.id} lesson={lesson} />)}</div>}
      </Card>
      {state === "error" && <EmptyState title="实时诊断调用失败" body="本次没有取得新的 Diagnostics 报告，已归档状态不会被推断或覆盖。" />}
    </div>
  );
}

function repairResultLabel(attempt: RepairAttemptView): string {
  if (attempt.result === "SUCCEEDED" && attempt.postCheck.state === "PASS") return "修复动作完成，真实复测通过";
  if (attempt.result === "SUCCEEDED") return "动作报告成功，但复测未证明恢复";
  if (attempt.result === "FAILED") return "修复动作失败，未恢复";
  if (attempt.result === "UNVERIFIED") return "结果未验证；不能确认服务状态";
  if (attempt.result === "CANCELLED") return "已取消本机确认，未开始修复";
  if (attempt.result === "STALE") return "诊断或 Profile 已过期，修复未获准";
  if (attempt.result === "REJECTED") return "受控层拒绝修复";
  return "修复尝试状态：" + attempt.result;
}
function suggestionEvidenceLabel(suggestion: RepairSuggestionView): string {
  return suggestion.evidenceStatus === "HIGH_CONFIDENCE"
    ? "历史同签名修复且复测通过"
    : "候选方案：尚无同签名复测通过记录";
}

export function QuickFixCenterView(): JSX.Element {
  const { report, state, refresh } = useLiveDiagnostics();
  const { snapshot, state: casesState } = useFaultCases(report, state);
  const [selectedSignature, setSelectedSignature] = useState<string | null>(null);
  const [options, setOptions] = useState<Awaited<ReturnType<typeof window.c2c.diagnostics.matchRepairOptions>> | null>(null);
  const [matching, setMatching] = useState(false);
  const [runningSuggestion, setRunningSuggestion] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<RepairAttemptView | null>(null);
  const [operationFailed, setOperationFailed] = useState(false);
  const selectedFault = snapshot?.cases.find((fault) => fault.signature === selectedSignature) ?? null;

  const inspectFault = useCallback(async (fault: FaultCaseView): Promise<void> => {
    const profileId = report?.profileMetadata?.profileId;
    if (!profileId || !report) {
      setOperationFailed(true);
      return;
    }
    setSelectedSignature(fault.signature);
    setOptions(null);
    setAttempt(null);
    setOperationFailed(false);
    setMatching(true);
    try {
      const result = await window.c2c.diagnostics.matchRepairOptions({
        signature: fault.signature,
        expectedProfileId: profileId,
        expectedWorkspaceId: report.workspace.workspaceId,
        diagnosisObservedAt: report.generatedAt,
      });
      setOptions(result);
    } catch {
      setOperationFailed(true);
    } finally {
      setMatching(false);
    }
  }, [report]);

  const runSuggestion = useCallback(async (suggestionId: RepairSuggestionView["suggestionId"]): Promise<void> => {
    const profileId = report?.profileMetadata?.profileId;
    if (!profileId || !report || !selectedFault) {
      setOperationFailed(true);
      return;
    }
    setRunningSuggestion(suggestionId);
    setOperationFailed(false);
    try {
      const result = await window.c2c.diagnostics.runRepair({
        signature: selectedFault.signature,
        suggestionId,
        expectedProfileId: profileId,
        expectedWorkspaceId: report.workspace.workspaceId,
        diagnosisObservedAt: report.generatedAt,
      });
      setAttempt(result);
      setOptions(null);
      await refresh();
    } catch {
      setOperationFailed(true);
      await refresh();
    } finally {
      setRunningSuggestion(null);
    }
  }, [refresh, report, selectedFault]);

  const reportFresh = state === "ready" && report !== null && Number.isFinite(Date.parse(report.generatedAt)) &&
    Date.now() - Date.parse(report.generatedAt) <= 5 * 60_000;
  const openFaults = snapshot?.cases.filter((fault) => fault.state === "OPEN") ?? [];

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div><h1>快速修复</h1><p>按当前故障签名匹配历史已验证方案；Supervisor 会复核身份、权限、进程归属和重试预算。「MCP 服务 → 服务详情 → 公网隧道」提供一键自检自修（含本机确认）。</p></div>
        <button className="btn" type="button" onClick={() => void refresh()} disabled={state === "loading"}>
          {state === "loading" ? "诊断中…" : "重新诊断"}
        </button>
      </div>
      <SourceLine>修复权限只来自本机受控 IPC。高风险动作将弹出操作系统本机确认框；未通过真实复测的动作不会显示为成功。</SourceLine>

      {report && (
        <Card title="基础检查">
          <div className="c2c-domain-grid">
            <div className="c2c-fact">
              <span>Runtime</span>
              <strong><Badge tone={report.runtime.healthEndpointOk ? "success" : "danger"}>{report.runtime.healthEndpointOk ? "Health 通过" : "Health 未通过"}</Badge></strong>
            </div>
            <div className="c2c-fact">
              <span>端口</span>
              <strong>{report.runtime.port ?? "未知"} · {report.runtime.portListening === true ? "正在监听" : report.runtime.portListening === false ? "无人监听" : "监听状态未知"}</strong>
            </div>
            <div className="c2c-fact">
              <span>Tunnel</span>
              <strong>
                {report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED"
                  ? <Badge tone={report.transport.edgeConnected && report.transport.publicHealthStatus === 200 ? "success" : "danger"}>
                      {report.transport.edgeConnected ? "Edge 已连接" : "Edge 未连接"} · HTTP {report.transport.publicHealthStatus ?? "未知"}
                    </Badge>
                  : <Badge>LOCAL_ONLY / 不适用</Badge>}
              </strong>
            </div>
            <div className="c2c-fact">
              <span>OAuth</span>
              <strong><Badge tone={report.oauthAuthorization?.state === "AUTHORIZED" ? "success" : report.oauthAuthorization?.state === "UNKNOWN" || !report.oauthAuthorization ? "neutral" : "warning"}>{report.oauthAuthorization?.state ?? "授权状态未取得"}</Badge></strong>
            </div>
            <div className="c2c-fact">
              <span>Workspace</span>
              <strong>{report.workspace.workspaceId ?? "身份未取得"}</strong>
            </div>
            <div className="c2c-fact">
              <span>Workspace 身份匹配</span>
              <strong>{report.runtime.workspaceIdMatches === true ? "匹配" : report.runtime.workspaceIdMatches === false ? "不匹配" : "未知"}</strong>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <Link className="btn secondary" to="/diagnostics">查看完整证据</Link>
            <Link className="btn secondary" to="/diagnostics/knowledge">查看故障经验</Link>
            <Link className="btn secondary" to="/diagnostics/history">查看修复历史</Link>
          </div>
          <SourceLine>基础检查只展示 OBSERVED_GAP。具体根因必须经过故障匹配、受控修复和真实复测后才能提升证据等级。</SourceLine>
        </Card>
      )}
      {state === "error" && <EmptyState title="控制面诊断未取得结果" body="当前无法从 Supervisor 取得实时证据，因此不会匹配或执行任何修复；这不等于各子模块同时故障。" />}
      {casesState === "loading" && <EmptyState title="正在读取当前故障" body="等待诊断归档和本机 AuditChain 投影。" kind="empty" />}
      {casesState === "error" && <EmptyState title="当前故障投影不可用" body="无法安全匹配历史修复方案。" />}
      {casesState === "ready" && snapshot?.state === "STALE" && <EmptyState title="Profile 已变化" body="故障快照与当前 Profile 不匹配；请重新诊断。" />}
      {casesState === "ready" && snapshot?.state === "UNAVAILABLE" && <EmptyState title="故障投影不可用" body={"本机控制层返回 " + safeReasonCode(snapshot.reasonCode) + "。"} />}
      {casesState === "ready" && snapshot?.state === "NO_DATA" && <EmptyState title="当前没有待处理故障" body="本机 AuditChain 投影当前没有开放故障记录；系统没有基于历史经验自行启动服务。" kind="empty" />}
      {openFaults.length > 0 && (
        <Card title="选择当前故障">
          <div className="c2c-domain-stack">
            {openFaults.map((fault) => <FaultCaseCard key={fault.signature} fault={fault} onSelect={(item) => void inspectFault(item)} selected={fault.signature === selectedSignature} />)}
          </div>
        </Card>
      )}
      {selectedFault && (
        <Card title={"匹配结果 · " + selectedFault.code}>
          <SourceLine>
            当前诊断时间：{formatTime(report?.generatedAt)}。Profile：{options?.activeProfileId ?? report?.profileMetadata?.profileId ?? "未证明"}。
            工作区匹配与进程归属未知时，修复会保持不可执行。
          </SourceLine>
          {matching && <EmptyState title="正在由 Supervisor 重新诊断并匹配" body="修复选项以最新 Diagnostics、当前身份和历史成功复测记录为准。" kind="empty" />}
          {operationFailed && <EmptyState title="修复接口调用失败或没有返回结果" body="请读取修复历史并重新诊断；此提示不代表动作已执行或状态已改变。" />}
          {options?.state === "STALE" && <EmptyState title="诊断或身份已过期" body={"受控层返回 " + safeReasonCode(options.reasonCode) + "。重新诊断后再匹配。"} />}
          {options?.state === "UNAVAILABLE" && <EmptyState title="匹配服务不可用" body={"本机控制层返回 " + safeReasonCode(options.reasonCode) + "。"} />}
          {options?.state === "NO_MATCH" && <EmptyState title="没有可靠匹配方案" body={"受控层返回 " + safeReasonCode(options.reasonCode) + "。没有证据时不会生成执行动作。"} kind="empty" />}
          {options && options.suggestions.length === 0 && options.state !== "NO_MATCH" && <EmptyState title="没有可展示的修复方案" body="此故障当前无受支持的安全修复动作。" kind="empty" />}
          {options?.suggestions.map((suggestion) => (
            <article className="c2c-observation-card" key={suggestion.suggestionId}>
              <div className="c2c-observation-heading">
                <strong>{suggestion.title}</strong>
                <Badge tone={suggestion.evidenceStatus === "HIGH_CONFIDENCE" ? "success" : "warning"}>{suggestionEvidenceLabel(suggestion)}</Badge>
              </div>
              <p>匹配依据：{suggestion.matchBasis.join("、") || "无"}。历史条目：{suggestion.sourceLessonIds.join("、") || "无"}。</p>
              <p>风险：{suggestion.risk === "LOW" ? "低风险受控动作" : "高风险，必须本机确认"}。</p>
              {!suggestion.executable && <p className="c2c-muted">当前不可执行：{safeReasonCode(suggestion.reasonCode)}。仅作为候选建议显示。</p>}
              <button
                className={suggestion.risk === "MANUAL_ONLY" ? "btn secondary" : "btn"}
                type="button"
                disabled={!suggestion.executable || !reportFresh || runningSuggestion !== null}
                onClick={() => void runSuggestion(suggestion.suggestionId)}
              >
                {runningSuggestion === suggestion.suggestionId
                  ? "受控修复与复测中…"
                  : suggestion.executable
                    ? suggestion.requiresNativeConfirmation ? "执行（将请求本机确认）" : "执行受控修复"
                    : "当前不可执行"}
              </button>
            </article>
          ))}
          {!reportFresh && <p className="c2c-muted">当前诊断已过期；先重新诊断后才能执行。</p>}
        </Card>
      )}
      {attempt && (
        <Card title="本次修复结果">
          <div className="c2c-observation-card">
            <strong>{repairResultLabel(attempt)}</strong>
            <ul>
              <li>结果：{attempt.result} · 动作状态：{attempt.actionState}</li>
              <li>动作时间：{formatTime(attempt.startedAt)} / {formatTime(attempt.completedAt)}</li>
              <li>真实复测：{attempt.postCheck.state} · {safeReasonCode(attempt.postCheck.reasonCode)} · {formatTime(attempt.postCheck.observedAt)}</li>
              <li>回滚：{attempt.rollback.state}{attempt.rollback.reasonCode ? " · " + safeReasonCode(attempt.rollback.reasonCode) : ""}</li>
            </ul>
            <SourceLine>记录来自当前 Profile 的 AuditChain；只有结果 SUCCEEDED 且复测 PASS 才算已恢复。</SourceLine>
          </div>
        </Card>
      )}
    </div>
  );
}

function historyResultTone(result: RepairAttemptView["result"]): string {
  if (result === "SUCCEEDED") return "success";
  if (result === "FAILED" || result === "REJECTED" || result === "UNVERIFIED") return "danger";
  return "warning";
}

export function RepairHistoryView(): JSX.Element {
  const { report, state, refresh } = useLiveDiagnostics();
  const { snapshot, state: historyState } = useRepairHistory(report, state);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderEntries, setOlderEntries] = useState<RepairAttemptView[]>([]);
  const [olderLoadFailed, setOlderLoadFailed] = useState(false);
  const entries = useMemo(() => {
    const all = [...(snapshot?.entries ?? []), ...olderEntries];
    const normalized = query.trim().toLocaleLowerCase();
    return all.filter((entry) => !normalized || [
      entry.code, entry.signature, entry.suggestionId, entry.result, entry.postCheck.reasonCode, entry.rollback.reasonCode ?? "",
    ].some((value) => value.toLocaleLowerCase().includes(normalized)));
  }, [olderEntries, query, snapshot]);

  useEffect(() => {
    setOlderEntries([]);
    setCursor(snapshot?.nextCursor ?? null);
  }, [snapshot]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const profileId = report?.profileMetadata?.profileId;
    if (!profileId || !cursor || !report) return;
    setOlderLoadFailed(false);
    try {
      const page = await window.c2c.diagnostics.listRepairHistory({ expectedProfileId: profileId, limit: 100, cursor });
      if (page.activeProfileId !== profileId || page.state === "STALE" || page.state === "UNAVAILABLE") {
        setOlderLoadFailed(true);
        return;
      }
      setOlderEntries((previous) => [...previous, ...page.entries.filter((item) => !previous.some((known) => known.attemptId === item.attemptId))]);
      setCursor(page.nextCursor);
    } catch {
      setOlderLoadFailed(true);
    }
  }, [cursor, report]);

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div><h1>修复历史</h1><p>按当前 Profile 读取 AuditChain 中每次修复尝试、执行结果、真实复测和回滚状态。</p></div>
        <button className="btn" type="button" onClick={() => void refresh()} disabled={state === "loading"}>
          {state === "loading" ? "读取中…" : "刷新历史"}
        </button>
      </div>
      <label className="c2c-search-field">
        <span>搜索故障、动作或结果</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：PUBLIC_530、FAILED、TUNNEL" />
      </label>
      <SourceLine>数据来源：本机 AuditChain 的脱敏只读投影。审批通过、动作执行和复测通过分别记录。</SourceLine>
      {historyState === "loading" && <EmptyState title="正在读取修复历史" body="等待当前 Profile 的 AuditChain 投影返回。" kind="empty" />}
      {historyState === "error" && <EmptyState title="修复历史读取失败" body="接口错误不会被显示成“没有历史记录”。" />}
      {historyState === "ready" && snapshot?.state === "STALE" && <EmptyState title="Profile 已变化" body="拒绝展示其他 Profile 的历史快照；刷新后重新读取。" />}
      {historyState === "ready" && snapshot?.state === "UNAVAILABLE" && <EmptyState title="审计投影不可用" body={"本机控制层返回 " + safeReasonCode(snapshot.reasonCode) + "。"} />}
      {historyState === "ready" && snapshot?.state === "NO_DATA" && <EmptyState title="当前 Profile 暂无修复尝试" body="这是 AuditChain 投影的真实空结果。" kind="empty" />}
      {entries.length > 0 && (
        <Card title={"修复尝试 · " + entries.length + (cursor ? "（可加载更早记录）" : "")}>
          <div className="c2c-domain-stack">
            {entries.map((entry) => (
              <article className="c2c-observation-card" key={entry.attemptId}>
                <div className="c2c-observation-heading">
                  <strong>{entry.code} · {entry.suggestionId}</strong>
                  <Badge tone={historyResultTone(entry.result)}>{entry.result}</Badge>
                </div>
                <ul>
                  <li>故障签名：{entry.signature}</li>
                  <li>尝试：{formatTime(entry.startedAt)} / {formatTime(entry.completedAt)}</li>
                  <li>动作：{entry.actionState} · 证据：{entry.evidenceStatus}</li>
                  <li>真实复测：{entry.postCheck.state} · {safeReasonCode(entry.postCheck.reasonCode)} · {formatTime(entry.postCheck.observedAt)}</li>
                  <li>回滚：{entry.rollback.state}{entry.rollback.reasonCode ? " · " + safeReasonCode(entry.rollback.reasonCode) : ""}</li>
                </ul>
              </article>
            ))}
          </div>
          {olderLoadFailed && <EmptyState title="更早的记录暂不可用" body="保留当前游标；可以重试加载，不会把加载失败当成没有历史。" />}
          {cursor && <button className="btn secondary" type="button" onClick={() => void loadOlder()}>加载更早记录</button>}
        </Card>
      )}
    </div>
  );
}
