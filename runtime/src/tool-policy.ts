/**
 * ToolPolicy — 每个工具单独开关 + 危险等级 + 审批方式。
 *
 * 存储：状态目录下的 `tool-policy.json`，形如
 *   { "version": 1, "tools": { "read_file": { "enabled": true, "approval": "auto" } } }
 *
 * 默认值来自工具清单（TOOL_INVENTORY）：
 *   - 只读类：开启 + 自动（不会改动本机）
 *   - 写入类：开启 + 人工审批（必须本机点头）
 *   - 屏幕类：**默认关闭** + 人工审批（涉及泄露桌面内容）
 *   - Shell 类：**默认关闭** + 人工审批
 *
 * 找不到文件时用默认值；写入失败不影响读取（回退默认）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { TOOL_INVENTORY } from "./mcp-tools.js";
import { writeAtomicJson } from "./atomic-write.js";

export type ApprovalMode = "auto" | "manual";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolPolicyEntry {
  enabled: boolean;
  approval: ApprovalMode;
}

export interface ToolPolicy {
  version: 1;
  tools: Record<string, ToolPolicyEntry>;
}

const RISK_BY_GROUP: Record<string, RiskLevel> = {
  工作区: "low",
  文件: "low",
  搜索: "low",
  数据: "low",
  批量: "medium",
  项目: "low",
  产物: "low",
  组件: "low",
  Git: "low",
  测试: "low",
  执行: "low",
  自检: "low",
  任务: "medium",
  工作流: "low",
  数据源: "high",
  设置: "low",
  联网: "medium",
  写入: "high",
  屏幕: "high",
  命令: "critical",
};

const MANUAL_GROUPS = new Set(["写入", "屏幕", "命令"]);
const DISABLED_BY_DEFAULT = new Set(["屏幕", "命令"]);

export function riskOf(group: string): RiskLevel {
  return RISK_BY_GROUP[group] ?? "medium";
}

export function defaultPolicy(): ToolPolicy {
  const tools: Record<string, ToolPolicyEntry> = {};
  for (const t of TOOL_INVENTORY) {
    tools[t.name] = {
      enabled: t.enabled ?? !DISABLED_BY_DEFAULT.has(t.group),
      approval: t.approval ?? (MANUAL_GROUPS.has(t.group) ? "manual" : "auto"),
    };
  }
  return { version: 1, tools };
}

export function policyFile(dir: string): string {
  return path.join(dir, "tool-policy.json");
}

/** 工作区级策略文件：<profile>/workspaces/<workspaceId>/tool-policy.json。 */
export function workspacePolicyFile(dir: string, workspaceId: string): string {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
    throw new Error("workspace_id_invalid");
  }
  return path.join(dir, "workspaces", workspaceId, "tool-policy.json");
}

export interface LoadedToolPolicy {
  policy: ToolPolicy;
  /** workspace=工作区级；profile=旧的 Profile 级文件；default=内置默认。 */
  source: "workspace" | "profile" | "default";
  file: string | null;
}

function mergePolicy(base: ToolPolicy, raw: Partial<ToolPolicy>): ToolPolicy {
  const merged: ToolPolicy = { version: 1, tools: { ...base.tools } };
  for (const [name, entry] of Object.entries(raw.tools ?? {})) {
    if (!merged.tools[name]) continue; // 不认识的名字忽略，避免被塞入任意工具
    const e = entry as Partial<ToolPolicyEntry>;
    merged.tools[name] = {
      enabled: typeof e.enabled === "boolean" ? e.enabled : base.tools[name]!.enabled,
      approval: e.approval === "manual" || e.approval === "auto" ? e.approval : base.tools[name]!.approval,
    };
  }
  return merged;
}

/**
 * 解析顺序：工作区级 → Profile 级（兼容旧文件）→ 内置默认。
 * 只读一次文件；损坏的工作区文件会退到 Profile 级，不会把整份策略清空。
 */
export async function loadToolPolicyWithSource(dir: string, workspaceId?: string | null): Promise<LoadedToolPolicy> {
  const base = defaultPolicy();
  const candidates: Array<{ file: string; source: "workspace" | "profile" }> = [];
  if (workspaceId) {
    try {
      candidates.push({ file: workspacePolicyFile(dir, workspaceId), source: "workspace" });
    } catch {
      /* 非法 workspaceId 直接忽略工作区级 */
    }
  }
  candidates.push({ file: policyFile(dir), source: "profile" });

  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate.file, "utf8")) as Partial<ToolPolicy>;
      return { policy: mergePolicy(base, raw), source: candidate.source, file: candidate.file };
    } catch {
      /* 不存在或损坏：继续下一层 */
    }
  }
  return { policy: base, source: "default", file: null };
}

export async function loadToolPolicy(dir: string, workspaceId?: string | null): Promise<ToolPolicy> {
  return (await loadToolPolicyWithSource(dir, workspaceId)).policy;
}

export async function saveToolPolicy(dir: string, policy: ToolPolicy, workspaceId?: string | null): Promise<ToolPolicy> {
  const base = defaultPolicy();
  const safe: ToolPolicy = { version: 1, tools: { ...base.tools } };
  for (const [name, entry] of Object.entries(policy.tools ?? {})) {
    if (!safe.tools[name]) continue;
    safe.tools[name] = {
      enabled: entry.enabled === true,
      approval: entry.approval === "manual" ? "manual" : "auto",
    };
  }
  const file = workspaceId ? workspacePolicyFile(dir, workspaceId) : policyFile(dir);
  await writeAtomicJson(file, safe);
  return safe;
}

export function isToolEnabled(policy: ToolPolicy, name: string): boolean {
  return policy.tools[name]?.enabled === true;
}

export function approvalFor(policy: ToolPolicy, name: string): ApprovalMode {
  return policy.tools[name]?.approval ?? "manual";
}
