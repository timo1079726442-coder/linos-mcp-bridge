/**
 * LocalApprovalBridge — 主进程侧的"本机人工确认"动作（供 runtime 远程调用工具时使用）。
 *
 * 为什么需要它：runtime 是纯 Node 子进程，拿不到 Electron 的 dialog；
 * 而"写入类工具需要本机点头"不能靠调用方自己传一个 approved=true。
 *
 * 安全要求：
 * - 只接受结构化、限量文本（工具名 + 摘要 + 至多 40 行明细），不接收文件正文；
 * - 必须对应当前活跃 Profile 与其工作区，否则拒绝；
 * - Legacy Profile 一律拒绝（沿用现有写入审批的内部保护）；
 * - 每次调用都弹一次原生对话框，返回一次性结果，不缓存、不落审批队列；
 * - 决策写 JSONL 审计（只有工具名/摘要/决定，不含正文）。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue } from "electron";
import type { ControlHandler } from "./ControlServer.js";

const MAX_SUMMARY_LENGTH = 300;
const MAX_DETAIL_LENGTH = 300;
const MAX_DETAILS = 40;
const MAX_WORKSPACE_ROOT_LENGTH = 500;
const MAX_AUDIT_BYTES = 512 * 1024;

export interface ApprovalRequest {
  tool: string;
  summary: string;
  details: string[];
  workspaceId: string;
  workspaceRoot: string;
}

export interface ActiveProfileContext {
  profileId: string;
  profileName: string;
  profileType: string;
  workspaceId: string;
  workspaceRoot: string;
}

export type ShowDialog = (
  window: BrowserWindow,
  options: MessageBoxOptions,
) => Promise<MessageBoxReturnValue>;

export interface LocalApprovalBridgeOptions {
  stateRoot: string;
  getMainWindow: () => BrowserWindow | null;
  /** 测试注入；生产使用 electron dialog。 */
  showDialog?: ShowDialog;
  now?: () => number;
}

export class ApprovalRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ApprovalRequestError";
  }
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text || text.length > maxLength) return null;
  return text;
}

export function parseApprovalRequest(params: Record<string, unknown>): ApprovalRequest {
  const tool = typeof params.tool === "string" ? params.tool : "";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool)) throw new ApprovalRequestError("APPROVAL_TOOL_INVALID");

  const summary = cleanText(params.summary, MAX_SUMMARY_LENGTH);
  if (!summary) throw new ApprovalRequestError("APPROVAL_SUMMARY_INVALID");

  if (!Array.isArray(params.details) || params.details.length < 1 || params.details.length > MAX_DETAILS) {
    throw new ApprovalRequestError("APPROVAL_DETAILS_INVALID");
  }
  const details: string[] = [];
  for (const entry of params.details) {
    const line = cleanText(entry, MAX_DETAIL_LENGTH);
    if (!line) throw new ApprovalRequestError("APPROVAL_DETAILS_INVALID");
    details.push(line);
  }

  const workspaceId = typeof params.workspace_id === "string" ? params.workspace_id : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) throw new ApprovalRequestError("APPROVAL_WORKSPACE_INVALID");

  const workspaceRoot = typeof params.workspace_root === "string" ? params.workspace_root : "";
  if (!workspaceRoot || workspaceRoot.length > MAX_WORKSPACE_ROOT_LENGTH
    || workspaceRoot.includes("\0") || !path.isAbsolute(workspaceRoot)) {
    throw new ApprovalRequestError("APPROVAL_WORKSPACE_INVALID");
  }

  return { tool, summary, details, workspaceId, workspaceRoot };
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 读取 <stateRoot>/active-profile.json 指向的 Profile；任何缺失都失败关闭。 */
export async function readActiveProfileContext(stateRoot: string): Promise<ActiveProfileContext> {
  let profileId: string;
  try {
    const active = JSON.parse(await fs.readFile(path.join(stateRoot, "active-profile.json"), "utf8")) as {
      profileId?: unknown;
    };
    if (typeof active.profileId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(active.profileId)) {
      throw new Error("bad");
    }
    profileId = active.profileId;
  } catch {
    throw new ApprovalRequestError("APPROVAL_CONTEXT_UNAVAILABLE");
  }

  try {
    const config = JSON.parse(
      await fs.readFile(path.join(stateRoot, "profiles", profileId, "config.json"), "utf8"),
    ) as {
      profileType?: unknown;
      profileName?: unknown;
      currentWorkspace?: { root?: unknown; workspaceId?: unknown };
    };
    const workspaceRoot = config.currentWorkspace?.root;
    const workspaceId = config.currentWorkspace?.workspaceId;
    if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)
      || typeof workspaceId !== "string" || !workspaceId) {
      throw new Error("bad workspace");
    }
    return {
      profileId,
      profileName: typeof config.profileName === "string" ? config.profileName : profileId,
      profileType: typeof config.profileType === "string" ? config.profileType : "custom",
      workspaceId,
      workspaceRoot,
    };
  } catch {
    throw new ApprovalRequestError("APPROVAL_CONTEXT_UNAVAILABLE");
  }
}

async function appendAudit(stateRoot: string, profileId: string, event: Record<string, unknown>): Promise<void> {
  const file = path.join(stateRoot, "profiles", profileId, "local-approval-audit.jsonl");
  try {
    const current = await fs.stat(file).catch(() => null);
    if (current && current.size > MAX_AUDIT_BYTES) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    /* 审计写失败不影响本次决策结果，但也不会声称已审计 */
  }
}

export function createLocalApprovalHandler(options: LocalApprovalBridgeOptions): ControlHandler {
  const now = options.now ?? Date.now;
  const showDialog: ShowDialog = options.showDialog ?? ((win, opts) => dialog.showMessageBox(win, opts));

  return async (params: Record<string, unknown>): Promise<unknown> => {
    const request = parseApprovalRequest(params);
    const context = await readActiveProfileContext(options.stateRoot);
    if (context.profileType === "company") throw new Error("COMPANY_PROFILE_PROTECTED");
    if (context.workspaceId !== request.workspaceId
      || normalizePath(context.workspaceRoot) !== normalizePath(request.workspaceRoot)) {
      throw new Error("APPROVAL_CONTEXT_MISMATCH");
    }

    const window = options.getMainWindow();
    if (!window || window.isDestroyed()) throw new Error("APPROVAL_WINDOW_UNAVAILABLE");
    if (!window.isVisible()) window.show();
    window.focus();

    const detail = [
      `Profile：${context.profileName} (${context.profileId})`,
      `工作区：${context.workspaceId} · ${context.workspaceRoot}`,
      `工具：${request.tool}`,
      `说明：${request.summary}`,
      "",
      ...request.details,
      "",
      "这次确认只对当前这一次调用有效；不会写入审批队列，也不会授权后续调用。",
    ].join("\n");

    const result = await showDialog(window, {
      type: "warning",
      title: "LinOS 本机确认",
      message: `允许 Agent 调用「${request.tool}」？`,
      detail,
      buttons: ["允许一次", "拒绝"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });

    const approved = result.response === 0;
    const decidedAt = new Date(now()).toISOString();
    const decisionId = randomBytes(8).toString("hex");
    await appendAudit(options.stateRoot, context.profileId, {
      timestamp: decidedAt,
      decision_id: decisionId,
      tool: request.tool,
      summary: request.summary,
      detail_lines: request.details.length,
      workspace_id: context.workspaceId,
      workspace_root: context.workspaceRoot,
      decision: approved ? "APPROVED_ONCE" : "DENIED",
    });

    return {
      approved,
      decision: approved ? "APPROVED_ONCE" : "DENIED",
      decision_id: decisionId,
      decided_at: decidedAt,
      tool: request.tool,
    };
  };
}
