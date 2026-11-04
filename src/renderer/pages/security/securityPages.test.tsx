import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FolderPermissionsPage } from "./FolderPermissionsPage.tsx";
import { WriteApprovalsPage } from "./WriteApprovalsPage.tsx";
import { formatExecutionResult, isApprovalExpired, isSnapshotStale, type ApprovalQueueSnapshot } from "../../domain/workspaceSecurity.ts";

describe("workspace security projections", () => {
  it("keeps folder ACL unavailable explicit and does not invent permission controls", () => {
    const html = renderToStaticMarkup(<FolderPermissionsPage />);
    expect(html).toContain("NO_DATA");
    expect(html).toContain("不推断任何目录已授权");
    expect(html).not.toContain("<button");
  });

  it("keeps approvals unavailable explicit and does not invent actions", () => {
    const html = renderToStaticMarkup(<WriteApprovalsPage />);
    expect(html).toContain("ApprovalQueue");
    expect(html).toContain("NO_DATA");
    expect(html).not.toContain("<button");
  });

  it("offers typed ACL actions only for a live non-Legacy snapshot", () => {
    const now = new Date().toISOString();
    const base = {
      profileId: "profile-home",
      profileName: "Home",
      workspaceId: "workspace-one",
      observedAt: now,
      staleAfterMs: 60_000,
      revision: 0,
      entries: [],
    };
    const actions = {
      add: async () => ({
        ruleId: "rule-1", profileId: "profile-home", profileName: "Home", workspaceId: "workspace-one",
        folderPath: "D:\\work", access: "READ_ONLY" as const,
        extensionPolicy: { mode: "ALLOW_ALL" as const, deniedExtensions: [] },
        inheritance: "DIRECT" as const, updatedAt: now, revision: 1,
      }),
      remove: async () => ({ removed: true, revision: 1 }),
      check: async () => ({ allowed: false as const, profileId: "profile-home", workspaceId: "workspace-one", canonicalPath: null, operation: "read" as const, ruleId: null, reason: "NO_RULES" as const }),
    };
    const editableHtml = renderToStaticMarkup(<FolderPermissionsPage snapshot={{
      ...base, profileType: "local", mutationAvailability: "AVAILABLE", mutationBlockReason: null,
    }} actions={actions} />);
    expect(editableHtml).toContain("添加授权规则");
    expect(editableHtml).toContain("默认拒绝");

    const protectedHtml = renderToStaticMarkup(<FolderPermissionsPage snapshot={{
      ...base, profileType: "remote", mutationAvailability: "PROFILE_PROTECTED", mutationBlockReason: "PROTECTED_PROFILE",
    }} actions={actions} />);
    expect(protectedHtml).toContain("Legacy Profile 已保护");
    expect(protectedHtml).toContain("添加授权规则");
    expect(protectedHtml).toContain("disabled");
  });

  it("shows approval and execution as separate states", () => {
    const snapshot: ApprovalQueueSnapshot = {
      profileId: "profile-home",
      profileName: "Home",
      profileType: "local",
      workspaceId: "workspace-one",
      observedAt: "2026-10-08T10:00:00.000Z",
      staleAfterMs: 60_000,
      executionAvailability: "UNAVAILABLE",
      executionUnavailableReason: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
      records: [{
        requestId: "request-1",
        revision: 2,
        profileId: "profile-home",
        profileName: "Home",
        workspaceId: "workspace-one",
        targetPath: "D:\\work\\notes.md",
        operation: "UPDATE",
        summary: "更新一份文件",
        requester: null,
        decision: "APPROVED",
        execution: "NOT_STARTED",
        verification: "NOT_RUN",
        createdAt: "2026-10-08T09:59:00.000Z",
        expiresAt: "2026-10-08T11:00:00.000Z",
        decidedAt: "2026-10-08T10:00:00.000Z",
        executedAt: null,
        verifiedAt: null,
        binding: { contentDigest: "ab12", expectedTargetVersion: "SHA256:cd34", operationDigest: "ef56" },
        diff: { state: "REDACTED", lines: [], omittedLineCount: 0 },
        attemptCount: 0,
        maxAttempts: 2,
        lastFailureCode: null,
      }],
    };
    const html = renderToStaticMarkup(<WriteApprovalsPage snapshot={snapshot} actions={{
      decide: async () => undefined,
      execute: async () => undefined,
      revoke: async () => undefined,
    }} />);
    expect(html).toContain("已批准");
    expect(html).toContain("未执行；审批通过不代表写入完成");
    expect(html).toContain("APPROVAL_SAFE_EXECUTION_UNAVAILABLE");
    expect(html).toContain("审批操作已接通：待处理请求可批准或拒绝，未执行的已批准请求可撤销");
    expect(html).toContain("文件执行当前 UNAVAILABLE");
    expect(html).not.toContain("本机确认并执行");
    expect(html).not.toContain("本机确认并批准");

    const companyHtml = renderToStaticMarkup(<WriteApprovalsPage snapshot={{ ...snapshot, profileType: "remote" }} actions={{
      decide: async () => undefined,
      execute: async () => undefined,
      revoke: async () => undefined,
    }} />);
    expect(companyHtml).toContain("Legacy Profile 仅提供只读审批快照；批准、拒绝和撤销操作不可用。");
    expect(companyHtml).toContain("撤销未执行审批</button>");
    expect(companyHtml).toContain("disabled=\"\"");
  });

  it("does not call execution success verified until the target was re-read", () => {
    expect(formatExecutionResult("SUCCEEDED", "NOT_RUN")).toContain("尚未完成目标状态复核");
    expect(formatExecutionResult("SUCCEEDED", "MISMATCH")).toContain("复核失败");
    expect(formatExecutionResult("SUCCEEDED", "VERIFIED")).toContain("目标状态复核通过");
    expect(formatExecutionResult("FAILED", "NOT_RUN")).toBe("写入执行失败");
  });

  it("treats malformed/expired snapshots and approvals as unsafe", () => {
    expect(isApprovalExpired("not-a-date", Date.parse("2026-10-08T10:00:00.000Z"))).toBe(true);
    expect(isApprovalExpired("2026-10-08T09:59:00.000Z", Date.parse("2026-10-08T10:00:00.000Z"))).toBe(true);
    expect(isSnapshotStale("not-a-date", 10_000, Date.parse("2026-10-08T10:00:00.000Z"))).toBe(true);
    expect(isSnapshotStale("2026-10-08T09:00:00.000Z", 10_000, Date.parse("2026-10-08T10:00:00.000Z"))).toBe(true);
  });
});
