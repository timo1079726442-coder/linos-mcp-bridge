/**
 * Local automation authorization rules for C2C 48766.
 * This evaluator never grants permissions on its own: callers must separately
 * verify OAuth, ACL, runtime identity and an owner-approved policy revision.
 */
export type AutomationOperation =
  | "READ" | "TEST" | "BUILD" | "EXCEL_PREVIEW"
  | "CREATE" | "UPDATE" | "PATCH" | "BATCH_WRITE"
  | "EXCEL_WRITE" | "GIT_COMMIT" | "LAUNCH_APP"
  | "POWERSHELL" | "DELETE" | "FORCE_PUSH";

export interface AutomationApprovalRule {
  enabled: boolean;
  /** Owner-issued approval identifier, never client-supplied. */
  grantId: string;
  taskId: string;
  workspaceRoot: string;
  clientId: string;
  expiresAt: string;
  allowedOperations: AutomationOperation[];
  maxUses: number;
  used: number;
}

export type ApprovalVerdict =
  | { approved: true; via: "TASK_GRANT"; grantId: string }
  | { approved: false; reason: string };

const AUTO_ELIGIBLE: ReadonlySet<AutomationOperation> = new Set(["READ", "TEST", "BUILD", "EXCEL_PREVIEW"]);

export function evaluateAutomaticApproval(input: {
  rule: AutomationApprovalRule | null;
  operation: AutomationOperation;
  taskId: string;
  workspaceRoot: string;
  clientId: string;
  now: Date;
}): ApprovalVerdict {
  const rule = input.rule;
  if (!rule?.enabled) return { approved: false, reason: "AUTO_APPROVAL_DISABLED" };
  if (!AUTO_ELIGIBLE.has(input.operation)) return { approved: false, reason: "MANUAL_APPROVAL_REQUIRED" };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(rule.grantId)) return { approved: false, reason: "INVALID_GRANT" };
  if (rule.taskId !== input.taskId || rule.clientId !== input.clientId) return { approved: false, reason: "IDENTITY_MISMATCH" };
  if (!rule.workspaceRoot || rule.workspaceRoot.toLowerCase() !== input.workspaceRoot.toLowerCase()) {
    return { approved: false, reason: "WORKSPACE_MISMATCH" };
  }
  const expiry = Date.parse(rule.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= input.now.getTime()) return { approved: false, reason: "EXPIRED" };
  if (!Number.isSafeInteger(rule.maxUses) || rule.maxUses <= 0
    || !Number.isSafeInteger(rule.used) || rule.used < 0 || rule.used >= rule.maxUses) {
    return { approved: false, reason: "USE_LIMIT" };
  }
  if (!rule.allowedOperations.includes(input.operation)) return { approved: false, reason: "OPERATION_NOT_ALLOWED" };
  return { approved: true, via: "TASK_GRANT", grantId: rule.grantId };
}

/** Auditing is mandatory for both automatic and manual modes. */
export const AUDIT_REQUIRED = true;
