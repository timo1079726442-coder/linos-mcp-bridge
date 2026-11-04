import { describe, expect, it } from "vitest";
import { evaluateAutomaticApproval, type AutomationApprovalRule } from "./AutomationApprovalPolicy.js";

const base: AutomationApprovalRule = {
  enabled: true,
  grantId: "grant-task-12345678",
  taskId: "C2C-20261015-01",
  workspaceRoot: "C:\workspace\\worktrees\\test",
  clientId: "local-client",
  expiresAt: "2026-10-16T00:00:00.000Z",
  allowedOperations: ["READ", "TEST", "BUILD", "EXCEL_PREVIEW", "UPDATE", "LAUNCH_APP"],
  maxUses: 3,
  used: 0,
};
const input = (operation: "READ" | "TEST" | "BUILD" | "UPDATE" | "LAUNCH_APP", rule: AutomationApprovalRule = base) => ({
  operation, rule, taskId: base.taskId, clientId: base.clientId,
  workspaceRoot: base.workspaceRoot, now: new Date("2026-10-15T10:00:00.000Z"),
});
describe("automation approvals", () => {
  it("permits bounded low-risk calls only", () => {
    expect(evaluateAutomaticApproval(input("TEST"))).toEqual({ approved: true, via: "TASK_GRANT", grantId: base.grantId });
    expect(evaluateAutomaticApproval(input("BUILD")).approved).toBe(true);
  });
  it("never auto-approves writes or program launches", () => {
    expect(evaluateAutomaticApproval(input("UPDATE"))).toEqual({ approved: false, reason: "MANUAL_APPROVAL_REQUIRED" });
    expect(evaluateAutomaticApproval(input("LAUNCH_APP"))).toEqual({ approved: false, reason: "MANUAL_APPROVAL_REQUIRED" });
  });
  it("enforces disabled, expiry, identity, and usage limits", () => {
    expect(evaluateAutomaticApproval(input("TEST", { ...base, enabled: false })).approved).toBe(false);
    expect(evaluateAutomaticApproval(input("TEST", { ...base, used: 3 })).approved).toBe(false);
    expect(evaluateAutomaticApproval(input("TEST", { ...base, expiresAt: "2026-10-14T00:00:00.000Z" })).approved).toBe(false);
    expect(evaluateAutomaticApproval({ ...input("TEST"), clientId: "untrusted" }).approved).toBe(false);
  });
});
