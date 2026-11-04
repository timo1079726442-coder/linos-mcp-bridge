import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { BrowserWindow, MessageBoxOptions } from "electron";
import {
  ApprovalRequestError,
  createLocalApprovalHandler,
  parseApprovalRequest,
  readActiveProfileContext,
} from "./LocalApprovalBridge.js";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

const PROFILE_ID = "mb_pf_TestProfile01";
const WORKSPACE_ID = "0123456789ab";

let stateRoot: string;
let workspaceRoot: string;

async function writeProfile(options: { profileType?: string } = {}): Promise<void> {
  await mkdir(path.join(stateRoot, "profiles", PROFILE_ID), { recursive: true });
  await writeFile(path.join(stateRoot, "active-profile.json"), JSON.stringify({ profileId: PROFILE_ID }), "utf8");
  await writeFile(path.join(stateRoot, "profiles", PROFILE_ID, "config.json"), JSON.stringify({
    schemaVersion: "v2.0",
    profileId: PROFILE_ID,
    profileName: "V2_TEST",
    profileType: options.profileType ?? "custom",
    currentWorkspace: { root: workspaceRoot, workspaceId: WORKSPACE_ID },
  }), "utf8");
}

function fakeWindow(visible = true): { window: BrowserWindow; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> } {
  const show = vi.fn();
  const focus = vi.fn();
  const window = {
    isDestroyed: () => false,
    isVisible: () => visible,
    show,
    focus,
  } as unknown as BrowserWindow;
  return { window, show, focus };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: "commit_operation",
    summary: "暂存写入 1 笔操作、2 个文件（新增 1 / 修改 1）",
    details: ["操作 0123456789abcdef0123456789abcdef · 文件写入", "  src/a.ts · 覆盖 · 10 B → 12 B · abcdef123456…"],
    workspace_id: WORKSPACE_ID,
    workspace_root: workspaceRoot,
    ...overrides,
  };
}

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-approval-state-"));
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "c2c-approval-ws-"));
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("parseApprovalRequest", () => {
  it("接受结构化请求并清理控制字符", () => {
    const parsed = parseApprovalRequest(request({ summary: "写入\u0000两个文件" }));
    expect(parsed.tool).toBe("commit_operation");
    expect(parsed.summary).toBe("写入 两个文件");
    expect(parsed.details).toHaveLength(2);
  });

  it("拒绝非法工具名、超长摘要与过多明细", () => {
    expect(() => parseApprovalRequest(request({ tool: "Bad Tool" }))).toThrow(/APPROVAL_TOOL_INVALID/);
    expect(() => parseApprovalRequest(request({ summary: "x".repeat(301) }))).toThrow(/APPROVAL_SUMMARY_INVALID/);
    expect(() => parseApprovalRequest(request({ details: Array.from({ length: 41 }, (_, i) => `line ${i}`) })))
      .toThrow(/APPROVAL_DETAILS_INVALID/);
    expect(() => parseApprovalRequest(request({ details: [] }))).toThrow(/APPROVAL_DETAILS_INVALID/);
  });

  it("工作区必须是绝对路径", () => {
    expect(() => parseApprovalRequest(request({ workspace_root: "relative/path" })))
      .toThrow(/APPROVAL_WORKSPACE_INVALID/);
    expect(() => parseApprovalRequest(request({ workspace_id: "" }))).toThrow(/APPROVAL_WORKSPACE_INVALID/);
  });
});

describe("readActiveProfileContext", () => {
  it("读取活跃 Profile 与工作区", async () => {
    await writeProfile();
    const context = await readActiveProfileContext(stateRoot);
    expect(context.profileId).toBe(PROFILE_ID);
    expect(context.workspaceId).toBe(WORKSPACE_ID);
    expect(context.workspaceRoot).toBe(workspaceRoot);
  });

  it("缺少 active-profile.json 时失败关闭", async () => {
    await expect(readActiveProfileContext(stateRoot)).rejects.toThrow(/APPROVAL_CONTEXT_UNAVAILABLE/);
  });
});

describe("createLocalApprovalHandler", () => {
  it("用户点“允许一次”时返回批准并写审计", async () => {
    await writeProfile();
    const { window, show, focus } = fakeWindow(false);
    const showDialog = vi.fn(async (_win: BrowserWindow, _options: MessageBoxOptions) => ({ response: 0, checkboxChecked: false }));
    const handler = createLocalApprovalHandler({
      stateRoot,
      getMainWindow: () => window,
      showDialog,
      now: () => Date.parse("2026-10-20T10:00:00.000Z"),
    });

    const result = await handler(request()) as { approved: boolean; decision: string; decision_id: string };
    expect(result.approved).toBe(true);
    expect(result.decision).toBe("APPROVED_ONCE");
    expect(result.decision_id).toMatch(/^[0-9a-f]{16}$/);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);

    const options = showDialog.mock.calls[0]![1];
    expect(options.title).toBe("LinOS 本机确认");
    expect(options.detail).toContain(PROFILE_ID);
    expect(options.detail).toContain(WORKSPACE_ID);
    expect(options.detail).toContain("src/a.ts");
    expect(options.detail).toContain("只对当前这一次调用有效");
    expect(options.buttons).toEqual(["允许一次", "拒绝"]);

    const audit = await readFile(
      path.join(stateRoot, "profiles", PROFILE_ID, "local-approval-audit.jsonl"),
      "utf8",
    );
    const event = JSON.parse(audit.trim()) as Record<string, unknown>;
    expect(event.tool).toBe("commit_operation");
    expect(event.decision).toBe("APPROVED_ONCE");
    expect(event.workspace_id).toBe(WORKSPACE_ID);
  });

  it("用户点“拒绝”时返回未批准", async () => {
    await writeProfile();
    const { window } = fakeWindow();
    const handler = createLocalApprovalHandler({
      stateRoot,
      getMainWindow: () => window,
      showDialog: async () => ({ response: 1, checkboxChecked: false }),
    });
    const result = await handler(request()) as { approved: boolean; decision: string };
    expect(result.approved).toBe(false);
    expect(result.decision).toBe("DENIED");
  });

  it("工作区与活跃 Profile 不一致时拒绝且不弹框", async () => {
    await writeProfile();
    const { window } = fakeWindow();
    const showDialog = vi.fn();
    const handler = createLocalApprovalHandler({ stateRoot, getMainWindow: () => window, showDialog });
    await expect(handler(request({ workspace_root: path.join(workspaceRoot, "other") })))
      .rejects.toThrow(/APPROVAL_CONTEXT_MISMATCH/);
    expect(showDialog).not.toHaveBeenCalled();
  });

  it("Legacy Profile 一律拒绝", async () => {
    await writeProfile({ profileType: "company" });
    const { window } = fakeWindow();
    const handler = createLocalApprovalHandler({ stateRoot, getMainWindow: () => window, showDialog: vi.fn() });
    await expect(handler(request())).rejects.toThrow(/COMPANY_PROFILE_PROTECTED/);
  });

  it("没有主窗口时拒绝", async () => {
    await writeProfile();
    const handler = createLocalApprovalHandler({ stateRoot, getMainWindow: () => null, showDialog: vi.fn() });
    await expect(handler(request())).rejects.toThrow(/APPROVAL_WINDOW_UNAVAILABLE/);
  });

  it("错误类型可被调用方区分", () => {
    const error = new ApprovalRequestError("APPROVAL_TOOL_INVALID");
    expect(error.code).toBe("APPROVAL_TOOL_INVALID");
    expect(error.message).toBe("APPROVAL_TOOL_INVALID");
  });
});
