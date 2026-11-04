import React, { useState } from "react";
import {
  formatApprovalDecision,
  formatExecutionResult,
  isApprovalExpired,
  isSnapshotStale,
  type ApprovalDecisionActions,
  type ApprovalQueueSnapshot,
  type ApprovalRecordView,
} from "../../domain/workspaceSecurity.js";

export interface WriteApprovalsPageProps {
  snapshot?: ApprovalQueueSnapshot | null;
  loadState?: "loading" | "error";
  errorMessage?: string;
  actions?: ApprovalDecisionActions;
  refresh?: () => Promise<void>;
}

function ActionControls({ record, actions, disabled, executionAvailability, profileReadOnly, refresh }: {
  record: ApprovalRecordView;
  actions?: ApprovalDecisionActions;
  disabled: boolean;
  executionAvailability: "AVAILABLE" | "UNAVAILABLE";
  profileReadOnly: boolean;
  refresh?: () => Promise<void>;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  if (!actions) return null;

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setFailure(false);
    try {
      await action();
      await refresh?.();
    } catch {
      // Do not echo arbitrary IPC error text into the UI. The trusted diagnostics
      // source is responsible for safe, actionable error details.
      setFailure(true);
    } finally {
      setBusy(false);
    }
  }

  const pending = record.decision === "PENDING";
  const canApprove = record.diff.state === "AVAILABLE";
  const canRevoke = record.decision === "APPROVED" && record.execution === "NOT_STARTED";
  const canExecute = record.decision === "APPROVED"
    && (record.execution === "NOT_STARTED" || record.execution === "FAILED")
    && executionAvailability === "AVAILABLE";
  return (
    <div>
      <div className="row" aria-label="审批操作">
        {pending && (
          <>
            <button className="btn" type="button" disabled={disabled || busy || !canApprove} onClick={() => void run(() => actions.decide({ requestId: record.requestId, revision: record.revision }, "APPROVE"))}>
              本机确认并批准
            </button>
            <button className="btn secondary" type="button" disabled={disabled || busy} onClick={() => void run(() => actions.decide({ requestId: record.requestId, revision: record.revision }, "REJECT"))}>
              拒绝请求
            </button>
          </>
        )}
        {canRevoke && (
          <button className="btn secondary" type="button" disabled={disabled || busy} onClick={() => void run(() => actions.revoke({ requestId: record.requestId, revision: record.revision }))}>
            撤销未执行审批
          </button>
        )}
        {canExecute && (
          <button className="btn" type="button" disabled={disabled || busy} onClick={() => void run(() => actions.execute({ requestId: record.requestId, revision: record.revision }))}>
            本机确认并执行
          </button>
        )}
        {pending && disabled && !profileReadOnly && <span className="muted">快照过期或请求已过期；刷新后才能操作。</span>}
        {pending && !canApprove && <span className="muted">安全内容预览不可用或被脱敏；为避免批准未审阅内容，批准按钮保持禁用。</span>}
      </div>
      {failure && <div className="banner error" role="alert" style={{ marginTop: 10 }}>审批操作未确认成功。请刷新队列，并查看安全诊断；不能据此认为状态已改变。</div>}
    </div>
  );
}

function ApprovalCard({ record, actions, snapshotStale, executionAvailability, executionUnavailableReason, profileReadOnly, refresh }: {
  record: ApprovalRecordView;
  actions?: ApprovalDecisionActions;
  snapshotStale: boolean;
  executionAvailability: "AVAILABLE" | "UNAVAILABLE";
  executionUnavailableReason: string | null;
  profileReadOnly: boolean;
  refresh?: () => Promise<void>;
}): JSX.Element {
  const requestExpired = isApprovalExpired(record.expiresAt);
  const operationLabel = { CREATE: "新建", UPDATE: "更新", DELETE: "删除", RENAME: "重命名" }[record.operation];
  const diffLines = record.diff.lines.slice(0, 500);

  return (
    <article className="card" style={{ marginBottom: 14 }} data-testid="approval-record">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>{operationLabel} · {record.summary}</h2>
          <div className="muted" style={{ marginTop: 5, fontSize: 11 }}>请求 {record.requestId} · 修订 r{record.revision}</div>
        </div>
        <span className={`status-badge ${record.decision === "APPROVED" ? "status-success" : record.decision === "PENDING" ? "status-warning" : record.decision === "REJECTED" || record.decision === "STALE" ? "status-danger" : "status-unknown"}`}>
          {formatApprovalDecision(record.decision)}
        </span>
      </div>

      <div className="banner info" style={{ marginTop: 12 }} role="status">
        <strong>当前重点：</strong>{record.decision === "PENDING"
          ? "先核对下面的文件差异，再决定批准或拒绝；批准本身不会改动文件。"
          : record.execution === "SUCCEEDED" ? "文件执行已有记录，请核对读回验证状态。" : record.decision === "APPROVED"
            ? executionAvailability === "UNAVAILABLE" ? "已批准，但安全执行器不可用；文件尚未写入。" : "已批准，仍需单独进行本机执行确认。"
            : "此请求不再等待审批。"}
      </div>
      <div className="kv" style={{ marginTop: 12 }}>
        <div className="k">目标文件</div><div className="v">{record.targetPath}</div>
        <div className="k">处理结果</div><div className="v" data-testid="approval-execution-result">{formatExecutionResult(record.execution, record.verification)}</div>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>查看技术明细（身份、SHA、时间及重试）</summary>
        <div className="kv" style={{ marginTop: 12 }}>
        <div className="k">目标路径</div><div className="v">{record.targetPath}</div>
        <div className="k">Profile / Workspace</div><div className="v">{record.profileName} ({record.profileId}) / {record.workspaceId}</div>
        <div className="k">请求身份</div><div className="v">{record.requester ? `${record.requester.clientId} · MCP ${String(record.requester.requestId)} · Runtime ${record.requester.runtimeInstanceId}` : "本地/旧请求（无 MCP 身份）"}</div>
        <div className="k">请求 / 到期时间</div><div className="v">{record.createdAt} / {record.expiresAt}{requestExpired ? " · 已到期" : ""}</div>
        <div className="k">内容摘要</div><div className="v">SHA-256 {record.binding.contentDigest}</div>
        <div className="k">目标文件版本</div><div className="v">{record.binding.expectedTargetVersion}</div>
        <div className="k">操作摘要版本</div><div className="v">{record.binding.operationDigest}</div>
        <div className="k">审批决定时间</div><div className="v">{record.decidedAt ?? "尚未决定"}</div>
        <div className="k">执行状态</div><div className="v">{formatExecutionResult(record.execution, record.verification)}</div>
        <div className="k">执行 / 复核时间</div><div className="v">{record.executedAt ?? "未执行"} / {record.verifiedAt ?? "未复核"}</div>
        <div className="k">重试次数</div><div className="v">{record.attemptCount} / {record.maxAttempts}{record.lastFailureCode ? ` · 最近错误 ${record.lastFailureCode}` : ""}</div>
        </div>
      </details>

      {record.decision === "APPROVED" && record.execution === "NOT_STARTED" && (
        <div className="banner warn" role="status" style={{ marginTop: 12 }}>
          {executionAvailability === "UNAVAILABLE"
            ? `审批已通过，但没有安全文件执行器；文件未写入。${executionUnavailableReason ? ` 原因：${executionUnavailableReason}。` : ""}`
            : "审批已通过，等待独立的本机执行确认；审批本身不代表文件已写入。"}
        </div>
      )}

      <div className="page-section">
        <div className="section-title">第 1 步 · 检查修改内容</div>
        <p className="muted">减号 − 是将删除的旧内容，加号 + 是将写入的新内容。看不懂或不确定时，请拒绝请求。</p>
        {record.diff.state === "AVAILABLE" ? (
          <>
            <pre style={{ maxHeight: 320, overflow: "auto", padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "#0b1118", color: "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11 }}>
              {diffLines.map((line, index) => `${line.kind === "ADD" ? "+" : line.kind === "REMOVE" ? "−" : " "}${line.text}`).join("\n") || "（无差异行）"}
            </pre>
            {(record.diff.omittedLineCount > 0 || record.diff.lines.length > diffLines.length) && <p className="muted" style={{ fontSize: 11 }}>其余差异行已省略。</p>}
          </>
        ) : (
          <div className="banner warn">
            {record.diff.state === "REDACTED" ? "差异包含敏感内容，已由本机控制层隐藏。" : "差异预览不可用；未读取或输出文件原文。"}
          </div>
        )}
      </div>

      <div className="section-title" style={{ marginTop: 12 }}>第 2 步 · 本机审批与执行</div>
      {actions ? (
        <ActionControls
          record={record}
          actions={actions}
          refresh={refresh}
          executionAvailability={executionAvailability}
          profileReadOnly={profileReadOnly}
          disabled={profileReadOnly || snapshotStale || requestExpired || record.decision === "STALE"}
        />
      ) : (
        <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>当前仅展示只读审批投影；此页面未提供操作接口，不会伪造批准、拒绝或撤销结果。</p>
      )}
    </article>
  );
}

/** Without a live Supervisor snapshot, this page is NO_DATA and must not fabricate requests. */
export function WriteApprovalsPage({ snapshot = null, loadState, errorMessage, actions, refresh }: WriteApprovalsPageProps): JSX.Element {
  if (loadState === "loading") {
    return <div data-testid="write-approvals-page"><div className="section-empty-state"><div className="empty-state-mark">…</div><div><h2>正在读取审批队列</h2><p>等待本机 ApprovalQueue 返回当前 Profile 的请求状态。</p></div></div></div>;
  }
  if (loadState === "error") {
    return <div data-testid="write-approvals-page"><div className="banner error" role="alert">审批队列读取失败（UNKNOWN）：{errorMessage || "本机审批接口不可用。"}</div></div>;
  }
  if (!snapshot) {
    return (
      <div data-testid="write-approvals-page">
      <div className="section-empty-state" data-testid="approval-queue-no-data">
        <div className="empty-state-mark">?</div>
        <div>
          <h2>审批队列快照不可用 · NO_DATA</h2>
          <p>当前没有可读取的 ApprovalQueue 快照。此页面不伪造待办，也不把审批通过当作写入成功。</p>
          <p className="empty-state-note">MCP 只读工具保持只读。审批动作必须绑定 Profile、Workspace、路径、内容摘要、目标版本和有效期，并由本机 Supervisor 再校验。</p>
        </div>
        <span className="status-badge status-unknown">暂无数据</span>
      </div>
      </div>
    );
  }

  const stale = isSnapshotStale(snapshot.observedAt, snapshot.staleAfterMs);
  const profileReadOnly = snapshot.profileType === "company";
  const needsAttention = snapshot.records.filter((record) => record.decision === "PENDING" || (record.decision === "APPROVED" && record.execution !== "SUCCEEDED"));
  const history = snapshot.records.filter((record) => !needsAttention.includes(record));
  return (
    <div data-testid="write-approvals-page">
      <div className={`banner ${stale ? "warn" : "info"}`}>
        Profile {snapshot.profileName} ({snapshot.profileType}) · Workspace <code>{snapshot.workspaceId}</code> · 队列读取于 {snapshot.observedAt}
        {stale ? " · 快照已过期，审批动作已禁用。" : " · 审批决定和实际执行状态分开显示。"}
      </div>
      <div className={`banner ${profileReadOnly ? "warn" : "info"}`} role="status" data-testid="approval-action-availability">
        {profileReadOnly
          ? "Legacy Profile 仅提供只读审批快照；批准、拒绝和撤销操作不可用。"
          : "审批操作已接通：待处理请求可批准或拒绝，未执行的已批准请求可撤销；按钮受当前 Profile、Workspace、快照新鲜度和有效期校验。"}
      </div>
      {snapshot.executionAvailability === "UNAVAILABLE" && (
        <div className="banner warn" role="status" data-testid="approval-execution-unavailable">
          文件执行当前 UNAVAILABLE（{snapshot.executionUnavailableReason ?? "UNKNOWN"}）。批准不会触发文件写入；不显示执行按钮。
        </div>
      )}
      {snapshot.records.length === 0 ? (
        <div className="section-empty-state" data-testid="approval-queue-empty">
          <div className="empty-state-mark">—</div><div><h2>当前没有待展示的请求</h2><p>队列接口已返回空列表；不代表写入能力已开放。</p></div><span className="status-badge status-unknown">0 条记录</span>
        </div>
      ) : (
        <>
          <section aria-label="当前待处理" data-testid="approval-inbox">
            <div className="section-title">需要处理 · {needsAttention.length} 条</div>
            {needsAttention.length === 0 ? (
              <p className="muted">当前无需处理，历史记录在下方。</p>
            ) : needsAttention.map((record) => (
              <ApprovalCard
                key={record.requestId}
                record={record}
                actions={actions}
                snapshotStale={stale}
                executionAvailability={snapshot.executionAvailability}
                executionUnavailableReason={snapshot.executionUnavailableReason}
                profileReadOnly={profileReadOnly}
                refresh={refresh}
              />
            ))}
          </section>
          {history.length > 0 && (
            <details className="technical-details" data-testid="approval-history">
              <summary>历史与已结束请求 · {history.length} 条（点击展开）</summary>
              {history.map((record) => (
                <ApprovalCard
                  key={record.requestId}
                  record={record}
                  actions={actions}
                  snapshotStale={stale}
                  executionAvailability={snapshot.executionAvailability}
                  executionUnavailableReason={snapshot.executionUnavailableReason}
                  profileReadOnly={profileReadOnly}
                  refresh={refresh}
                />
              ))}
            </details>
          )}
        </>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        决策接口必须校验请求修订、绑定摘要、Profile、Workspace、目标文件版本和过期时间；批准后仍须由 Supervisor 执行并复核目标文件状态。
      </p>
    </div>
  );
}
