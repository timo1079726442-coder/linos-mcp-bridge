import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { C2CApi } from "../../../preload/preload.js";
import type { ApprovalQueueSnapshot, FolderAclSnapshot, FolderAccessEntry } from "../../../shared/security.js";
import { FolderPermissionsRoute, WriteApprovalsRoute } from "./SecurityRoutes.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let mounted: Array<{ root: Root; host: HTMLElement }> = [];

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return host;
}

async function clickButton(host: HTMLElement, label: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`BUTTON_NOT_FOUND:${label}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => {
    for (const item of mounted) item.root.unmount();
  });
  for (const item of mounted) item.host.remove();
  mounted = [];
  vi.restoreAllMocks();
});

function aclSnapshot(): FolderAclSnapshot {
  return {
    profileId: "profile-home",
    profileName: "Home",
    profileType: "home",
    workspaceId: "workspace-one",
    observedAt: new Date().toISOString(),
    staleAfterMs: 60_000,
    revision: 0,
    mutationAvailability: "AVAILABLE",
    mutationBlockReason: null,
    entries: [],
  };
}

function approvalsSnapshot(records: ApprovalQueueSnapshot["records"] = []): ApprovalQueueSnapshot {
  return {
    profileId: "profile-home",
    profileName: "Home",
    profileType: "home",
    workspaceId: "workspace-one",
    observedAt: new Date().toISOString(),
    staleAfterMs: 60_000,
    executionAvailability: "UNAVAILABLE",
    executionUnavailableReason: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE",
    records,
  };
}

function setupApi(overrides: Partial<C2CApi["security"]> = {}): {
  api: C2CApi;
  folderAcl: {
    get: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    check: ReturnType<typeof vi.fn>;
  };
  approvals: {
    list: ReturnType<typeof vi.fn>;
    decide: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
} {
  const added: FolderAccessEntry = {
    ruleId: "rule-1",
    profileId: "profile-home",
    profileName: "Home",
    workspaceId: "workspace-one",
    folderPath: "D:\\work\\docs",
    access: "READ_ONLY",
    extensionPolicy: { mode: "ALLOW_ALL", deniedExtensions: [] },
    inheritance: "DIRECT",
    updatedAt: new Date().toISOString(),
    revision: 1,
  };
  const folderAcl = {
    get: vi.fn().mockResolvedValue(aclSnapshot()),
    add: vi.fn().mockResolvedValue(added),
    remove: vi.fn().mockResolvedValue({ removed: true, revision: 1 }),
    check: vi.fn().mockResolvedValue({
      allowed: false,
      profileId: "profile-home",
      workspaceId: "workspace-one",
      canonicalPath: null,
      operation: "write",
      ruleId: null,
      reason: "NO_RULES",
    }),
  };
  const approvals = {
    list: vi.fn().mockResolvedValue(approvalsSnapshot()),
    decide: vi.fn().mockResolvedValue({}),
    execute: vi.fn().mockResolvedValue({ status: "UNAVAILABLE", code: "APPROVAL_SAFE_EXECUTION_UNAVAILABLE", record: {} }),
    revoke: vi.fn().mockResolvedValue({}),
  };
  const security = { folderAcl, approvals, ...overrides } as C2CApi["security"];
  const api = {
    security,
    company: {
      list: vi.fn().mockResolvedValue({instances:[{id:"company-primary",name:"本机 MCP",port:48765}]}),
      batchPreviews: vi.fn().mockResolvedValue({status:"UNAVAILABLE",reason:"UNSUPPORTED_OR_UNAUTHORIZED",workspaceId:null,pending:[],truncated:false,approvalAvailable:false}),
    },
  } as unknown as C2CApi;
  window.c2c = api;
  return { api, folderAcl, approvals };
}

describe("security route containers", () => {
  it("loads the current ACL snapshot through the typed preload API", async () => {
    const { folderAcl } = setupApi();
    const host = await mount(<FolderPermissionsRoute />);

    expect(folderAcl.get).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("当前没有 ACL 规则");
    expect(host.textContent).toContain("默认拒绝");
  });

  it("routes ACL mutations through preload and refreshes the real snapshot", async () => {
    const { folderAcl } = setupApi();
    const host = await mount(<FolderPermissionsRoute />);
    const pathInput = host.querySelector<HTMLInputElement>("#acl-folder-path");
    if (!pathInput) throw new Error("ACL_PATH_INPUT_NOT_FOUND");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(pathInput, "D:\\work\\docs");
      pathInput.dispatchEvent(new Event("input", { bubbles: true }));
      pathInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    await clickButton(host, "添加授权规则");

    expect(folderAcl.add).toHaveBeenCalledWith(expect.objectContaining({ path: "D:\\work\\docs", access: "READ_ONLY" }));
    expect(folderAcl.get).toHaveBeenCalledTimes(2);
  });

  it("routes approval decisions through preload with the live request revision", async () => {
    const pendingRecord = {
      requestId: "approval-one",
      revision: 4,
      profileId: "profile-home",
      profileName: "Home",
      workspaceId: "workspace-one",
      targetPath: "D:\\work\\docs\\note.md",
      operation: "CREATE" as const,
      summary: "Create note",
      requester: null,
      decision: "PENDING" as const,
      execution: "NOT_STARTED" as const,
      verification: "NOT_RUN" as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      decidedAt: null,
      executedAt: null,
      verifiedAt: null,
      binding: { contentDigest: "a".repeat(64), expectedTargetVersion: "ABSENT", operationDigest: "b".repeat(64) },
      diff: { state: "UNAVAILABLE" as const, lines: [], omittedLineCount: 0 },
      attemptCount: 0,
      maxAttempts: 2,
      lastFailureCode: null,
    };
    const { approvals } = setupApi();
    approvals.list.mockResolvedValue(approvalsSnapshot([pendingRecord]));
    const host = await mount(<WriteApprovalsRoute />);

    const approveButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("本机确认并批准"));
    expect(approveButton?.disabled).toBe(true);
    await clickButton(host, "拒绝请求");

    expect(approvals.decide).toHaveBeenCalledWith(
      { requestId: "approval-one", revision: 4 },
      "REJECT",
    );
    expect(approvals.list).toHaveBeenCalledTimes(2);
  });

  it("keeps file execution hidden when the Supervisor reports it unavailable", async () => {
    const { approvals } = setupApi();
    approvals.list.mockResolvedValue(approvalsSnapshot([{
      requestId: "approval-approved",
      revision: 2,
      profileId: "profile-home",
      profileName: "Home",
      workspaceId: "workspace-one",
      targetPath: "D:\\work\\docs\\note.md",
      operation: "CREATE",
      summary: "Create note",
      requester: null,
      decision: "APPROVED",
      execution: "NOT_STARTED",
      verification: "NOT_RUN",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      decidedAt: new Date().toISOString(),
      executedAt: null,
      verifiedAt: null,
      binding: { contentDigest: "a".repeat(64), expectedTargetVersion: "ABSENT", operationDigest: "b".repeat(64) },
      diff: { state: "UNAVAILABLE", lines: [], omittedLineCount: 0 },
      attemptCount: 0,
      maxAttempts: 2,
      lastFailureCode: null,
    }]));
    const host = await mount(<WriteApprovalsRoute />);

    expect(host.textContent).toContain("文件未写入");
    expect(host.querySelector("[data-testid=\"approval-inbox\"]")).not.toBeNull();
    expect(host.textContent).toContain("需要处理 · 1 条");
    const actionButtons = [...(host.querySelector('[aria-label="审批操作"]')?.querySelectorAll("button") ?? [])];
    expect(actionButtons.some((button) => button.textContent?.includes("本机确认并执行"))).toBe(false);
    expect(approvals.execute).not.toHaveBeenCalled();
  });
});
