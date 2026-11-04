import type {
  ApprovalDecision,
  ApprovalExecution,
  ApprovalVerification,
  ApprovalDecisionActions,
  ApprovalQueueSnapshot,
  ApprovalRecordRef,
  ApprovalRecordView,
  FolderAccessCheckInput,
  FolderAccess,
  FolderAccessEntry,
  FolderAccessVerdict,
  FolderAclAddInput,
  FolderAclRemoveInput,
  FolderAclSnapshot as FolderAccessSnapshot,
} from "../../shared/security.js";

export type {
  ApprovalDecision,
  ApprovalExecution,
  ApprovalVerification,
  ApprovalDecisionActions,
  ApprovalQueueSnapshot,
  ApprovalRecordRef,
  ApprovalRecordView,
  FolderAccessCheckInput,
  FolderAccess,
  FolderAccessEntry,
  FolderAccessVerdict,
  FolderAclAddInput,
  FolderAclRemoveInput,
  FolderAclSnapshot as FolderAccessSnapshot,
} from "../../shared/security.js";

export function formatFolderAccess(access: FolderAccess): string {
  switch (access) {
    case "READ_ONLY": return "只读";
    case "READ_WRITE": return "可写";
    case "DENY": return "禁止访问";
  }
}

export function formatApprovalDecision(decision: ApprovalDecision): string {
  switch (decision) {
    case "PENDING": return "等待本机审批";
    case "APPROVED": return "已批准";
    case "REJECTED": return "已拒绝";
    case "REVOKED": return "已撤销";
    case "EXPIRED": return "已过期";
    case "STALE": return "版本已变化，审批失效";
  }
}

export function formatExecutionResult(execution: ApprovalExecution, verification: ApprovalVerification): string {
  switch (execution) {
    case "NOT_STARTED": return "未执行；审批通过不代表写入完成";
    case "QUEUED": return "已排队，尚未验证写入";
    case "RUNNING": return "正在执行，尚未验证写入";
    case "SUCCEEDED":
      if (verification === "VERIFIED") return "写入成功，目标状态复核通过";
      if (verification === "MISMATCH") return "执行返回完成，但目标状态复核失败";
      if (verification === "UNAVAILABLE") return "执行返回完成，但目标状态无法读取";
      return "执行返回完成，尚未完成目标状态复核";
    case "FAILED": return "写入执行失败";
    case "CANCELLED": return "写入未执行（已取消）";
    case "UNKNOWN": return "执行状态未知（UNKNOWN）";
  }
}

export function isApprovalExpired(expiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

export function isSnapshotStale(observedAt: string, staleAfterMs: number, now = Date.now()): boolean {
  const observed = Date.parse(observedAt);
  return !Number.isFinite(observed) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0 || now - observed > staleAfterMs;
}
