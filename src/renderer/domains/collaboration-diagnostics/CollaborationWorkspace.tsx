import React, { useCallback, useEffect, useState } from "react";
import type { ProfileConfig, WorkspaceInfo, ExecutionListResponse, ExecutionOutputResponse, GitChangeSummary } from "../../../shared/types.js";
import "./collaboration-diagnostics.css";

export type CollaborationView = "overview" | "git" | "tests" | "tasks" | "review";

interface CollaborationEvidence {
  profile: Pick<ProfileConfig, "profileId" | "profileName" | "profileType" | "currentWorkspace"> | null;
  workspace: WorkspaceInfo | null;
  receivedAt: string;
}

function tailName(root: string | null | undefined): string {
  if (!root) return "未配置";
  const pieces = root.split(/[\\/]+/).filter(Boolean);
  return pieces[pieces.length - 1] ?? "已配置";
}

function readableProfileType(value: ProfileConfig["profileType"] | undefined): string {
  if (value === "company") return "Legacy";
  if (value === "home") return "Home";
  if (value === "custom") return "Custom";
  return "未知";
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return <section className="c2c-domain-card"><h2>{title}</h2>{children}</section>;
}

function Fact({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return <div className="c2c-domain-fact"><span>{label}</span><strong>{value}</strong></div>;
}

function EmptyState({ title, body, kind = "gap" }: { title: string; body: string; kind?: "gap" | "empty" }): JSX.Element {
  return <div className={"c2c-empty-state " + kind} role="status"><strong>{title}</strong><p>{body}</p></div>;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "未提供";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "时间格式不可识别" : time.toLocaleString();
}

function statusLabel(status: string): string {
  if (status === "PASS") return "通过";
  if (status === "FAIL") return "失败";
  return "未知";
}

function ExecutionList({ response, loading, failed, onRefresh }: {
  response: ExecutionListResponse | null;
  loading: boolean;
  failed: boolean;
  onRefresh: () => void;
}): JSX.Element {
  const records = response?.records ?? [];
  if (loading) return <EmptyState title="正在读取执行记录" body="等待经 Supervisor 授权的只读投影返回。" kind="empty" />;
  if (failed) return <EmptyState title="执行记录读取失败" body="接口错误不会被显示成空记录；可重试读取。" />;
  if (records.length === 0) {
    return (
      <EmptyState title="当前 Profile 暂无执行记录" body="这是 Execution Store 的真实空结果；Runtime 启动会写入一条就绪记录。" kind="empty" />
    );
  }
  return (
    <div className="c2c-domain-stack">
      {records.map((record) => {
        const testCount = record.tests.reduce((sum, item) => sum + (item.testCount ?? 1), 0);
        const failedCount = record.tests.reduce((sum, item) => sum + (item.failedCount ?? (item.passed ? 0 : 1)), 0);
        return (
          <article className="c2c-observation-card" key={record.id}>
            <div className="c2c-observation-heading">
              <strong>{record.taskId}</strong>
              <span className={"c2c-evidence-badge " + (record.status === "PASS" ? "success" : record.status === "FAIL" ? "danger" : "warning")}>{statusLabel(record.status)}</span>
            </div>
            <ul>
              <li>迭代 {record.iteration} · {formatTimestamp(record.timestamp)}</li>
              <li>测试：{testCount} 项 · 失败 {failedCount} 项</li>
              <li>变更文件：{record.changedFiles.length} 个</li>
              {record.summary && <li>摘要：{record.summary}</li>}
              {record.publicOutput && <li className="c2c-muted">含公开输出（只读投影不返回输出正文）。</li>}
            </ul>
          </article>
        );
      })}
    </div>
  );
}

function TestList({ response, loading, failed }: {
  response: ExecutionListResponse | null;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  const records = (response?.records ?? []).filter((record) => record.tests.length > 0);
  if (loading) return <EmptyState title="正在读取测试记录" body="等待经 Supervisor 授权的只读投影返回。" kind="empty" />;
  if (failed) return <EmptyState title="测试记录读取失败" body="接口错误不会被显示成空记录。" />;
  if (records.length === 0) {
    return <EmptyState title="当前 Profile 暂无测试记录" body="这是 Execution Store 的真实空结果；不会把未运行的测试标为通过。" kind="empty" />;
  }
  return (
    <div className="c2c-domain-stack">
      {records.map((record) => (
        <article className="c2c-observation-card" key={record.id}>
          <div className="c2c-observation-heading">
            <strong>{record.taskId}</strong>
            <span className={"c2c-evidence-badge " + (record.status === "PASS" ? "success" : record.status === "FAIL" ? "danger" : "warning")}>{statusLabel(record.status)}</span>
          </div>
          <ul>
            <li>{formatTimestamp(record.timestamp)} · 迭代 {record.iteration}</li>
            {record.tests.map((test, index) => (
              <li key={index}>
                测试类别「{test.category}」：{test.passed ? "通过" : "失败"}
                {test.testCount !== undefined ? `（${test.testCount} 项` : ""}
                {test.failedCount !== undefined ? `，失败 ${test.failedCount}）` : test.testCount !== undefined ? "）" : ""}
                {test.command ? ` · ${test.command}` : ""}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

function GitChangeList({ summary, loading, failed, onRefresh }: {
  summary: GitChangeSummary | null;
  loading: boolean;
  failed: boolean;
  onRefresh: () => void;
}): JSX.Element {
  if (loading) return <EmptyState title="正在读取 Git 变更" body="等待本机 git 命令返回有界统计。" kind="empty" />;
  if (failed) return <EmptyState title="Git 变更读取失败" body="本机 git 命令失败；不会把失败显示成无变更。" />;
  // Fail closed: a failed git command must never read as a clean tree.
  if (summary && !summary.available && summary.reasonCode === "GIT_COMMAND_FAILED") {
    return (
      <>
        <EmptyState title="Git 命令执行失败" body="无法确认工作区变更状态；这不等于“无变更”。请检查 git 是否可用后重试。" />
        <button className="btn secondary" type="button" onClick={onRefresh}>重试</button>
      </>
    );
  }
  if (!summary || !summary.available) {
    return <EmptyState title="当前工作区不是 Git 仓库" body="只有 Git 仓库才会展示变更统计；不会编造文件清单。" kind="empty" />;
  }
  const { stats, changedFiles, truncated } = summary;
  if (changedFiles.length === 0 && stats.filesChanged === 0) {
    return (
      <>
        <EmptyState title="当前没有未提交变更" body="这是本机 git 的真实结果；工作区干净。" kind="empty" />
        <button className="btn secondary" type="button" onClick={onRefresh}>刷新变更</button>
      </>
    );
  }
  return (
    <>
      <p className="c2c-source-line">
        分支 {summary.branch ?? "未知"} · {stats.filesChanged} 个文件 · +{stats.insertions} / -{stats.deletions}
        {truncated ? " · 文件清单已截断" : ""}。只展示文件路径与行数统计，不含 diff 正文。
      </p>
      <div className="c2c-domain-stack">
        {changedFiles.map((file, index) => (
          <div className="c2c-observation-card" key={index}>
            <div className="c2c-observation-heading">
              <span className="c2c-evidence-badge neutral">{file.status || "?"}</span>
              <strong>{file.path}</strong>
            </div>
          </div>
        ))}
      </div>
      <button className="btn secondary" type="button" onClick={onRefresh}>刷新变更</button>
    </>
  );
}

function PublicOutputList({ response, loading, failed }: {
  response: ExecutionListResponse | null;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [output, setOutput] = useState<ExecutionOutputResponse | null>(null);
  const [outputLoading, setOutputLoading] = useState(false);
  const [outputFailed, setOutputFailed] = useState(false);

  const publicRecords = (response?.records ?? []).filter((record) => record.publicOutput);

  async function openOutput(id: string): Promise<void> {
    setSelectedId(id);
    setOutput(null);
    setOutputLoading(true);
    setOutputFailed(false);
    try {
      setOutput(await window.c2c.collaboration.getExecutionOutput(id));
    } catch {
      setOutput(null);
      setOutputFailed(true);
    } finally {
      setOutputLoading(false);
    }
  }

  if (loading) return <EmptyState title="正在读取公开输出记录" body="等待经 Supervisor 授权的只读投影返回。" kind="empty" />;
  if (failed) return <EmptyState title="公开输出记录读取失败" body="接口错误不会被显示成空记录。" />;
  if (publicRecords.length === 0) {
    return <EmptyState title="当前 Profile 暂无公开输出" body="只有明确标记为 publicOutput 的记录才会在此展示；这是白名单的真实空结果。" kind="empty" />;
  }
  return (
    <>
      <p className="c2c-source-line">只展示白名单 publicOutput 记录；正文需经 Supervisor 授权按 id 读取，且不含原始 stdout/stderr/diff。</p>
      <div className="c2c-domain-stack">
        {publicRecords.map((record) => (
          <article className="c2c-observation-card" key={record.id}>
            <div className="c2c-observation-heading">
              <strong>{record.taskId}</strong>
              <span className={"c2c-evidence-badge " + (record.status === "PASS" ? "success" : record.status === "FAIL" ? "danger" : "warning")}>{statusLabel(record.status)}</span>
            </div>
            <ul>
              <li>{formatTimestamp(record.timestamp)} · 迭代 {record.iteration}</li>
              {record.summary && <li>摘要：{record.summary}</li>}
            </ul>
            <button className="btn secondary" type="button" onClick={() => void openOutput(record.id)} disabled={outputLoading && selectedId === record.id}>
              {outputLoading && selectedId === record.id ? "读取中…" : "查看公开输出"}
            </button>
            {selectedId === record.id && outputFailed && <EmptyState title="公开输出读取失败" body="该记录没有可读取的公开输出正文。" />}
            {selectedId === record.id && output && (
              <pre className="c2c-public-output">{output.output}</pre>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

export function CollaborationWorkspace({ view }: { view: CollaborationView }): JSX.Element {
  const [evidence, setEvidence] = useState<CollaborationEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const [executions, setExecutions] = useState<ExecutionListResponse | null>(null);
  const [executionsFailed, setExecutionsFailed] = useState(false);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [gitChanges, setGitChanges] = useState<GitChangeSummary | null>(null);
  const [gitFailed, setGitFailed] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);

  const refreshGit = useCallback(async () => {
    const active = await window.c2c.profile.getActive().catch(() => null);
    if (!active?.currentWorkspace?.root) {
      setGitChanges(null);
      setGitFailed(false);
      setGitLoading(false);
      return;
    }
    setGitLoading(true);
    setGitFailed(false);
    try {
      setGitChanges(await window.c2c.workspace.gitChanges(active.currentWorkspace?.root));
    } catch {
      setGitChanges(null);
      setGitFailed(true);
    } finally {
      setGitLoading(false);
    }
  }, []);

  const refreshExecutions = useCallback(async () => {
    setExecutionsLoading(true);
    setExecutionsFailed(false);
    try {
      const result = await window.c2c.collaboration.listExecutions(20);
      setExecutions(result);
    } catch {
      setExecutionsFailed(true);
      setExecutions(null);
    } finally {
      setExecutionsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      const active = await window.c2c.profile.getActive();
      let workspace: WorkspaceInfo | null = null;
      if (active?.currentWorkspace?.root) {
        workspace = await window.c2c.workspace.validate(active.currentWorkspace?.root);
      }
      setEvidence({
        profile: active ? {
          profileId: active.profileId,
          profileName: active.profileName,
          profileType: active.profileType,
          currentWorkspace: active.currentWorkspace,
        } : null,
        workspace,
        receivedAt: new Date().toISOString(),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshExecutions(); }, [refreshExecutions]);
  useEffect(() => { void refreshGit(); }, [refreshGit]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const evidenceAt = evidence ? new Date(evidence.receivedAt).getTime() : Number.NaN;
  const stale = evidence !== null && (!Number.isFinite(evidenceAt) || clockNow - evidenceAt > 5 * 60_000);

  const title: Record<CollaborationView, string> = {
    overview: "协作概览",
    git: "Git 变更",
    tests: "测试与构建",
    tasks: "Harness 任务",
    review: "输出与 Review",
  };

  return (
    <div className="c2c-domain-page">
      <div className="c2c-domain-heading">
        <div><h1>{title[view]}</h1><p>只展示从本机 typed API 读取到的工作区事实；未接入的协作证据会标为 API 缺口。</p></div>
        {(view === "overview" || view === "git") && <button className="btn" onClick={() => void refresh()} disabled={busy}>{busy ? "读取中…" : "刷新工作区"}</button>}
      </div>

      {failed && <EmptyState title="工作区证据读取失败" body="Profile 或 Workspace typed API 调用失败。本次没有可展示的新证据。" />}

      {(view === "overview" || view === "git") && evidence && (
        <>
          <p className="c2c-source-line">数据来源：window.c2c.profile.getActive + window.c2c.workspace.validate。前端收到时间：{new Date(evidence.receivedAt).toLocaleString()}。{stale ? " 此快照超过 5 分钟，当前标记为过期。" : ""}</p>
          <InfoCard title="当前上下文">
            <div className="c2c-domain-grid">
              <Fact label="Profile" value={evidence.profile?.profileName ?? "未取得"} />
              <Fact label="Profile 类型" value={readableProfileType(evidence.profile?.profileType)} />
              <Fact label="Workspace" value={tailName(evidence.workspace?.root ?? evidence.profile?.currentWorkspace?.root)} />
              <Fact label="Workspace ID" value={evidence.workspace?.workspaceId ?? evidence.profile?.currentWorkspace.workspaceId ?? "未取得"} />
              <Fact label="Git 仓库" value={evidence.workspace ? (evidence.workspace.isGitRepo ? "是" : "否") : "未检查"} />
              <Fact label="分支" value={evidence.workspace?.branch ?? "未取得"} />
              <Fact label="Commit" value={evidence.workspace?.commit ?? "未取得"} />
              <Fact label="工作区状态" value={evidence.workspace?.dirty === true ? "有未提交变更" : evidence.workspace?.dirty === false ? "当前干净" : "未知"} />
            </div>
          </InfoCard>
          {view === "git" && <GitChangeList summary={gitChanges} loading={gitLoading} failed={gitFailed} onRefresh={refreshGit} />}
        </>
      )}

      {view === "overview" && (
        <div className="c2c-domain-grid">
          <InfoCard title="测试与构建"><TestList response={executions} loading={executionsLoading} failed={executionsFailed} /></InfoCard>
          <InfoCard title="Harness 执行"><ExecutionList response={executions} loading={executionsLoading} failed={executionsFailed} onRefresh={refreshExecutions} /></InfoCard>
          <InfoCard title="公开输出与 Review"><EmptyState title="Review 证据读取接口尚未接入" body="现有公开输出能力不能由此页面直接读取；未接入前不显示演示任务、输出或 Review 状态。" /></InfoCard>
        </div>
      )}

      {view === "tests" && (
        <>
          <div className="c2c-domain-heading" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={() => void refreshExecutions()} disabled={executionsLoading}>刷新测试记录</button>
          </div>
          <p className="c2c-source-line">数据来源：Runtime 的 Execution Store 中带 tests 的记录，经 Supervisor 授权的只读投影。未运行的测试不会被标为通过。</p>
          <TestList response={executions} loading={executionsLoading} failed={executionsFailed} />
        </>
      )}
      {view === "tasks" && (
        <>
          <div className="c2c-domain-heading" style={{ marginTop: 12 }}>
            <button className="btn secondary" type="button" onClick={() => void refreshExecutions()} disabled={executionsLoading}>刷新执行记录</button>
          </div>
          <p className="c2c-source-line">数据来源：Runtime 的 Execution Store，经 Supervisor 授权的只读投影。公开输出正文不会在此返回。</p>
          <ExecutionList response={executions} loading={executionsLoading} failed={executionsFailed} onRefresh={refreshExecutions} />
        </>
      )}
      {view === "review" && <PublicOutputList response={executions} loading={executionsLoading} failed={executionsFailed} />}
    </div>
  );
}
