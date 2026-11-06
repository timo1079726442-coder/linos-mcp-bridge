import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ExecutionRecordStore, type ExecutionRecord } from "./execution-store.js";
import { detectWorkspace } from "./workspace.js";
import { parseCsvPreview } from "./csv-preview.js";
import {
  isLikelyBinary,
  isSkippableDirectory,
  McpSecurityBoundary,
  McpSecurityError,
} from "./security-boundary.js";
import {
  auditProjectStructure,
  batchFileStatus,
  batchReadFiles,
  batchSearchPatterns,
  detectArchiveCandidates,
  generateProjectInventory,
  listArtifacts,
  prepareBatchWritePlan,
  projectSnapshot,
  readLatestReport,
  shadcnLocalComponents,
  shadcnProjectInfo,
} from "./advanced-tools.js";
import {
  cancelPendingOperation,
  commitOperation,
  commitOperations,
  describeOperationForApproval,
  describeOperationsForApproval,
  listPendingOperations,
  prepareBatchWrite,
  prepareReplacements,
  prepareScaffold,
  prepareWrite,
  WriteOperationError,
  type WriteContext,
} from "./write-operations.js";
import {
  assertWorkflowStepAllowed,
  cancelWorkflow,
  commitWorkflow,
  continueWorkflow,
  describeWorkflowForApproval,
  finishWorkflowStep,
  prepareWorkflow,
  reserveWorkflowStep,
  statusWorkflow,
  WorkflowError,
  type WorkflowContext,
} from "./workflow-ledger.js";
import {
  getShadcnCatalog,
  planShadcnAdd,
  planShadcnInit,
  ShadcnError,
} from "./shadcn-registry.js";
import {
  mysqlDescribeTable,
  mysqlListSchemas,
  mysqlQuery,
} from "./mysql-tools.js";
import { fetchUrl, FetchError } from "./fetch-tool.js";
import { executeCommand, gitCommit, runPowerShell } from "./command-tools.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1_000_000;
const MAX_SEARCH_FILE_BYTES = 512_000;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 100;
const MAX_DIFF_BYTES = 1_000_000;

const READ_ONLY_TOOL_NAMES = [
  "workspace_info",
  "list_directory",
  "read_file",
  "search_workspace",
  "search_files",
  "file_metadata",
  "directory_tree",
  "file_sha256",
  "compare_files",
  "csv_preview",
  "csv_schema_diff",
  "batch_read_files",
  "batch_file_status",
  "prepare_batch_write_plan",
  "project_snapshot",
  "batch_search_patterns",
  "audit_project_structure",
  "generate_project_inventory",
  "detect_archive_candidates",
  "list_artifacts",
  "read_latest_report",
  "shadcn_info",
  "shadcn_local_components",
  "git_status",
  "git_diff",
  "git_recent_commits",
  "git_changed_files",
  "git_local_branches",
  "test_inventory",
  "test_status",
  "execution_summary",
  "execution_output",
  "mcp_self_check",
  "capability_manifest",
] as const;

/**
 * 工具清单（供 /tools 诊断端点使用）。
 * 只读工具始终可用；写入类需要调用方具备写范围与审批桥，
 * 这里一并列出并标注 conditional，便于控制中心如实展示"能看见什么"。
 */
export const TOOL_INVENTORY: ReadonlyArray<{
  name: string;
  conditional: boolean;
  group: string;
  description: string;
  /** 覆盖按 group 推导的默认审批方式（预演类工具默认免逐次确认）。 */
  approval?: "auto" | "manual";
  /** 覆盖按 group 推导的默认开关。 */
  enabled?: boolean;
}> = [
  { name: "workspace_info", conditional: false, group: "工作区", description: "返回当前工作区身份、根目录与边界是否已解析。" },
  { name: "list_directory", conditional: false, group: "文件", description: "列出某个目录下的文件与子目录，不返回文件内容。" },
  { name: "read_file", conditional: false, group: "文件", description: "读取单个文本文件内容（有大小上限）。" },
  { name: "search_workspace", conditional: false, group: "搜索", description: "在工作区内按关键字搜索文件名与内容。" },
  { name: "search_files", conditional: false, group: "搜索", description: "按名称/通配符查找文件路径。" },
  { name: "file_metadata", conditional: false, group: "文件", description: "查看文件大小、修改时间等元数据。" },
  { name: "directory_tree", conditional: false, group: "文件", description: "输出目录树结构，便于把握项目骨架。" },
  { name: "file_sha256", conditional: false, group: "文件", description: "计算文件 SHA256，用于校验内容是否变化。" },
  { name: "compare_files", conditional: false, group: "文件", description: "比较两个文件是否相同（按哈希或内容）。" },
  { name: "csv_preview", conditional: false, group: "数据", description: "预览 CSV 前若干行，识别分隔符与表头。" },
  { name: "csv_schema_diff", conditional: false, group: "数据", description: "比较两个 CSV 的列结构差异。" },
  { name: "batch_read_files", conditional: false, group: "批量", description: "一次读取多个文本文件，减少往返次数。" },
  { name: "batch_file_status", conditional: false, group: "批量", description: "批量查询多个文件是否存在及大小/时间。" },
  { name: "prepare_batch_write_plan", conditional: false, group: "批量", description: "为批量写入生成计划与 SHA 预检，不直接落盘。" },
  { name: "project_snapshot", conditional: false, group: "项目", description: "生成项目快照：目录、关键文件、体积概览。" },
  { name: "batch_search_patterns", conditional: false, group: "批量", description: "用多个模式一次性搜索，汇总命中位置。" },
  { name: "audit_project_structure", conditional: false, group: "项目", description: "审计项目结构是否规范（入口、配置、测试等）。" },
  { name: "generate_project_inventory", conditional: false, group: "项目", description: "生成项目清单，列出文件分类与数量。" },
  { name: "detect_archive_candidates", conditional: false, group: "项目", description: "找出可归档的临时产物、构建残留等。" },
  { name: "list_artifacts", conditional: false, group: "产物", description: "列出工作区内已产出的报告、日志等产物。" },
  { name: "read_latest_report", conditional: false, group: "产物", description: "读取最近一次生成的报告内容。" },
  { name: "shadcn_info", conditional: false, group: "组件", description: "查看本项目是否使用 shadcn/ui 及版本信息。" },
  { name: "shadcn_local_components", conditional: false, group: "组件", description: "列出本地已安装的 shadcn 组件。" },
  { name: "git_status", conditional: false, group: "Git", description: "显示工作区 git 状态（分支、改动文件）。" },
  { name: "git_diff", conditional: false, group: "Git", description: "查看未提交改动的 diff 内容。" },
  { name: "git_recent_commits", conditional: false, group: "Git", description: "列出最近若干条提交记录。" },
  { name: "git_changed_files", conditional: false, group: "Git", description: "列出相对某个基线有变化的文件。" },
  { name: "git_local_branches", conditional: false, group: "Git", description: "列出本地分支。" },
  { name: "test_inventory", conditional: false, group: "测试", description: "盘点项目里的测试文件与用例数量。" },
  { name: "test_status", conditional: false, group: "测试", description: "读取最近一次测试状态（只读，不执行测试）。" },
  { name: "execution_summary", conditional: false, group: "执行", description: "汇总本机记录的执行结果。", },
  { name: "execution_output", conditional: false, group: "执行", description: "按 id 读取某次执行的脱敏输出。" },
  { name: "mcp_self_check", conditional: false, group: "自检", description: "自检：确认运行时能力边界与关键开关。" },
  { name: "capability_manifest", conditional: false, group: "自检", description: "返回能力分层：只读、需审批写入、不可用项。" },
  { name: "write_file", conditional: true, group: "写入", description: "直接写入文件内容；路径必须在工作区内，受策略与审批控制。" },
  { name: "list_roots", conditional: false, group: "工作区", description: "列出主工作区与控制中心授权的所有目录（可跨盘）及其读写权限。" },
  { name: "create_file", conditional: true, group: "写入", approval: "manual", description: "新建文件；目标已存在时需 overwrite:true，写前备份。" },
  { name: "update_file", conditional: true, group: "写入", approval: "manual", description: "替换已有文件内容；可选 expected_sha256，写前备份。" },
  { name: "delete_file", conditional: true, group: "写入", approval: "manual", description: "删除一个文件：先备份，校验 SHA 与硬链接，再删除。" },
  { name: "move_file", conditional: true, group: "写入", approval: "manual", description: "移动/重命名一个文件：先备份，目标必须不存在。" },
  { name: "apply_patch", conditional: true, group: "写入", approval: "manual", description: "对文件做精确文本替换：每个查找串必须恰好出现一次，写前备份。" },
  { name: "execute_command", conditional: true, group: "命令", approval: "manual", enabled: false, description: "运行白名单内的项目命令（git status/diff、npm test、python/pytest、node 脚本），无 shell、120s 超时。" },
  { name: "run_command", conditional: true, group: "命令", approval: "manual", enabled: false, description: "execute_command 的别名。" },
  { name: "run_powershell", conditional: true, group: "命令", approval: "manual", enabled: false, description: "运行 PowerShell：mode=user 为当前用户（无沙箱），mode=constrained 为受限语言模式（非 OS 沙箱）。" },
  { name: "git_commit", conditional: true, group: "命令", approval: "manual", enabled: false, description: "提交已暂存的 Git 改动（不 add、不 push）。" },
  { name: "start_job", conditional: true, group: "任务", approval: "manual", enabled: false, description: "异步启动一个后台任务并立即返回 job_id；支持 execute_command / run_powershell / git_commit，用于长任务轮询。" },
  { name: "job_status", conditional: true, group: "任务", approval: "auto", description: "查询后台任务状态、进度与退出码；轮询不阻塞。" },
  { name: "job_output", conditional: true, group: "任务", approval: "auto", description: "分页读取后台任务的脱敏输出片段。" },
  { name: "job_list", conditional: true, group: "任务", approval: "auto", description: "列出当前工作区的后台任务与最新状态；不返回输出正文。" },
  { name: "job_cancel", conditional: true, group: "任务", approval: "auto", description: "请求取消一个运行中的后台任务；尽力终止进程。" },
  { name: "job_resume", conditional: true, group: "任务", approval: "manual", enabled: false, description: "用当前授权重新排队一个中断/失败/超时的后台任务；需要重新审批。" },
  { name: "prepare_write", conditional: true, group: "写入", approval: "auto", description: "暂存一次单文件写入：只算哈希并返回操作编号，不落盘；需再用 commit_operation 提交。" },
  { name: "batch_prepare_write", conditional: true, group: "写入", approval: "auto", description: "一次暂存多个文件写入（最多 25 个）：只做校验与预演，不落盘。" },
  { name: "batch_replace_text", conditional: true, group: "写入", approval: "auto", description: "暂存批量精确文本替换：每个查找串必须恰好命中一次；预演不落盘。" },
  { name: "prepare_project_scaffold", conditional: true, group: "写入", approval: "auto", description: "暂存 PROJECT.md / LLM.md / STATUS.md / .brainn/project.json 的项目骨架，不创建目录、不落盘。" },
  { name: "list_pending_operations", conditional: false, group: "写入", approval: "auto", description: "列出当前客户端尚未提交的写入草稿（只有元数据，没有正文）。" },
  { name: "cancel_pending_operation", conditional: false, group: "写入", approval: "auto", description: "丢弃当前客户端的一笔写入草稿，不改动任何文件。" },
  { name: "commit_operation", conditional: true, group: "写入", approval: "manual", description: "提交一笔已暂存的写入；重新校验目标版本、本机确认后落盘并读回复核。" },
  { name: "commit_operations", conditional: true, group: "写入", approval: "manual", description: "按顺序提交多笔已暂存的写入；逐笔报告成功/阻塞，不承诺跨操作事务。" },
  { name: "workflow_prepare", conditional: true, group: "工作流", approval: "auto", description: "登记一个有边界的只读工作流计划；不执行工具、不授予任何写/屏幕/命令权限。" },
  { name: "workflow_commit", conditional: true, group: "工作流", approval: "manual", description: "本机确认后激活工作流计划；只开始记录进度，不自动执行工具。" },
  { name: "workflow_status", conditional: true, group: "工作流", approval: "auto", description: "查看工作流阶段与自报预算使用情况。" },
  { name: "workflow_continue", conditional: true, group: "工作流", approval: "auto", description: "记录一步进度与预算消耗；超出预算或出错按 stop_on_error 停止。" },
  { name: "workflow_run_step", conditional: true, group: "工作流", approval: "auto", description: "在已激活的只读工作流里真正执行一步（受 allowed_actions 与预算限制），并记录结果。" },
  { name: "workflow_cancel", conditional: true, group: "工作流", approval: "auto", description: "取消自己的一个工作流计划；不删除文件、不停止服务。" },
  { name: "shadcn_search", conditional: true, group: "组件", approval: "auto", description: "只读检索官方 shadcn Registry 的组件元数据，不执行 npx、不下载源码。" },
  { name: "shadcn_view", conditional: true, group: "组件", approval: "auto", description: "查看官方组件的依赖、文件与文档链接；不返回可执行源码。" },
  { name: "shadcn_add", conditional: true, group: "组件", approval: "auto", description: "安装 shadcn 组件：dry_run 预演候选文件；dry_run:false 暂存官方源码，commit 后落盘（不执行 npm install）。" },
  { name: "shadcn_init", conditional: true, group: "组件", approval: "auto", description: "初始化 shadcn：暂存 components.json 与 src/lib/utils.ts，commit 后落盘（不执行 CLI）。" },
  { name: "mysql_list_schemas", conditional: true, group: "数据源", approval: "auto", enabled: false, description: "列出只读 MySQL 数据源里可见的数据库（排除系统库）。" },
  { name: "mysql_describe_table", conditional: true, group: "数据源", approval: "auto", enabled: false, description: "查看只读数据源中某张表的列、类型与键。" },
  { name: "mysql_query", conditional: true, group: "数据源", approval: "manual", enabled: false, description: "执行一条只读 SQL（单条 SELECT/SHOW/EXPLAIN），有行数/超时/字节上限。" },
  { name: "search", conditional: false, group: "搜索", approval: "auto", description: "search_workspace 的兼容别名：按关键字搜索工作区内容。" },
  { name: "fetch", conditional: false, group: "联网", approval: "auto", description: "只读 GET 一个白名单域名下的文本 URL（https、20s 总预算、1MB 上限、逐跳重新解析并固定 IP、禁止 https→http 降级）。" },
  { name: "get_mcp_app_settings", conditional: false, group: "设置", approval: "auto", description: "返回这个 MCP 服务给 ChatGPT 用的连接器配置（名称、说明、URL、认证方式、工具数）。" },
  { name: "verify_tool_registered", conditional: false, group: "自检", approval: "auto", description: "核验某个工具是否注册、是否条件工具，以及当前开关与审批方式。" },
  { name: "screen_list_windows", conditional: false, group: "屏幕", description: "列出当前桌面上的可见窗口标题与编号；不抓取画面内容。" },
  { name: "screen_capture_once", conditional: false, group: "屏幕", description: "截取一次整个屏幕，保存到本机并返回路径与尺寸。" },
  { name: "screen_capture_active_window", conditional: false, group: "屏幕", description: "截取当前活动窗口。" },
  { name: "screen_capture_window", conditional: false, group: "屏幕", description: "按窗口编号截取指定窗口。" },
  { name: "screen_capture_windows", conditional: false, group: "屏幕", description: "一次截取多个指定窗口。" },
  { name: "screen_select_latest", conditional: false, group: "屏幕", description: "把某一张已截取的画面设为“最新帧”。" },
  { name: "screen_get_latest_frame", conditional: false, group: "屏幕", description: "读取最新帧的信息（路径、尺寸、时间）。" },
  { name: "screen_export_latest_image", conditional: false, group: "屏幕", description: "把最新帧另存为图片文件到指定位置。" },
  { name: "screen_export_latest_artifact_code", conditional: false, group: "屏幕", description: "把最新帧输出为可嵌入的 Markdown 图片语法。" },
  { name: "screen_latest_image_url", conditional: false, group: "屏幕", description: "给出最新帧的本机 file:// 地址。" },
  { name: "screen_annotate_latest_image", conditional: false, group: "屏幕", description: "在最新帧上合成标注（box/arrow/text，0–1000 归一化坐标），另存 PNG 不覆盖原图。" },
  { name: "screen_export_annotated_image", conditional: false, group: "屏幕", description: "把标注图导出到工作区内指定路径或状态目录。" },
  { name: "screen_export_annotated_artifact_code", conditional: false, group: "屏幕", description: "把标注图输出为可嵌入的 Markdown 图片语法。" },
  { name: "screen_annotated_image_url", conditional: false, group: "屏幕", description: "给出标注图的本机 file:// 地址。" },
];

const CAPABILITY_MANIFEST = [
  { name: "workspace_info", area: "workspace", risk: "READ_ONLY" },
  { name: "list_directory", area: "files", risk: "READ_ONLY" },
  { name: "read_file", area: "files", risk: "READ_ONLY" },
  { name: "search_workspace", area: "files", risk: "READ_ONLY" },
  { name: "search_files", area: "files", risk: "READ_ONLY" },
  { name: "file_metadata", area: "files", risk: "READ_ONLY" },
  { name: "directory_tree", area: "files", risk: "READ_ONLY" },
  { name: "file_sha256", area: "files", risk: "READ_ONLY" },
  { name: "compare_files", area: "files", risk: "READ_ONLY" },
  { name: "csv_preview", area: "data_preview", risk: "READ_ONLY" },
  { name: "csv_schema_diff", area: "data_preview", risk: "READ_ONLY" },
  { name: "batch_read_files", area: "files", risk: "READ_ONLY" },
  { name: "batch_file_status", area: "files", risk: "READ_ONLY" },
  { name: "prepare_batch_write_plan", area: "files", risk: "DRY_RUN_ONLY" },
  { name: "project_snapshot", area: "project_audit", risk: "READ_ONLY" },
  { name: "batch_search_patterns", area: "project_audit", risk: "READ_ONLY" },
  { name: "audit_project_structure", area: "project_audit", risk: "READ_ONLY" },
  { name: "generate_project_inventory", area: "project_audit", risk: "READ_ONLY" },
  { name: "detect_archive_candidates", area: "project_audit", risk: "READ_ONLY" },
  { name: "list_artifacts", area: "artifacts", risk: "READ_ONLY" },
  { name: "read_latest_report", area: "artifacts", risk: "READ_ONLY" },
  { name: "shadcn_info", area: "ui_components", risk: "READ_ONLY" },
  { name: "shadcn_local_components", area: "ui_components", risk: "READ_ONLY" },
  { name: "git_status", area: "git", risk: "READ_ONLY" },
  { name: "git_diff", area: "git", risk: "READ_ONLY" },
  { name: "git_recent_commits", area: "git", risk: "READ_ONLY" },
  { name: "git_changed_files", area: "git", risk: "READ_ONLY" },
  { name: "git_local_branches", area: "git", risk: "READ_ONLY" },
  { name: "test_inventory", area: "execution_evidence", risk: "READ_ONLY" },
  { name: "test_status", area: "execution_evidence", risk: "READ_ONLY" },
  { name: "execution_summary", area: "execution_evidence", risk: "READ_ONLY" },
  { name: "execution_output", area: "execution_evidence", risk: "READ_ONLY" },
  { name: "mcp_self_check", area: "operations", risk: "READ_ONLY" },
  { name: "capability_manifest", area: "operations", risk: "READ_ONLY" },
] as const;

export interface McpToolResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface McpCallerContext {
  /** Derived only from the validated bearer TokenSet; never from MCP input. */
  readonly clientId: string;
  /** Correlates the bridge request with this JSON-RPC request. */
  readonly requestId: string | number | null;
}

export interface McpCreateIntentRequest {
  readonly caller: McpCallerContext;
  readonly intent: {
    readonly operation: "CREATE";
    /** Workspace-relative path only; no profile/workspace/root/absolute path. */
    readonly relativePath: string;
    readonly content: string;
  };
}

export interface McpUpdateIntentRequest {
  readonly caller: McpCallerContext;
  readonly intent: {
    readonly operation: "UPDATE";
    readonly relativePath: string;
    readonly content: string;
    readonly expectedTargetSha256: string;
  };
}

export interface McpCreateIntentResult {
  readonly status: "PENDING" | "REJECTED";
  readonly requestId?: string;
}

/** The bridge carries approval intent only and deliberately exposes no filesystem writer. */
export interface McpCreateIntentBridge {
  requestCreateIntent(request: McpCreateIntentRequest): Promise<McpCreateIntentResult>;
  requestUpdateIntent?(request: McpUpdateIntentRequest): Promise<McpCreateIntentResult>;
}

export interface McpDispatchOptions {
  readonly caller?: McpCallerContext;
  /** Derived only from the validated bearer TokenSet. */
  readonly writeScopeGranted?: boolean;
  readonly createIntentBridge?: McpCreateIntentBridge;
  /** Safe, allowlisted bridge failure categories for isolated CREATE tests. */
  readonly bridgeFailureDiagnostics?: boolean;
  /** 工具策略目录（含 tool-policy.json）；缺省则不做开关拦截。 */
  readonly toolPolicyDir?: string;
  /** 是否持有 workspace.shell（命令/PowerShell/git_commit）。 */
  readonly shellScopeGranted?: boolean;
  /** Durable high-risk audit operation ID; supplied only by dispatchMcp after intent persistence. */
  readonly auditOperationId?: string;
  /** 控制中心展示连接器配置用：本地实际监听端口与公网 MCP 地址。 */
  readonly localPort?: number;
  readonly publicMcpUrl?: string | null;
}

interface WorkspaceContext {
  workspaceRoot: string;
  workspaceId: string;
  boundary: McpSecurityBoundary;
  executionStore: ExecutionRecordStore;
  dispatchOptions: McpDispatchOptions;
}

interface GitSnapshot {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
  porcelain?: string;
  remote?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
}

function isHighRiskAuditTool(tool: string): boolean {
  return WRITE_SCOPE_TOOL_NAMES.has(tool)
    || SHELL_SCOPE_TOOL_NAMES.has(tool)
    || tool === "job_cancel"
    || tool === "workflow_prepare"
    || tool === "workflow_commit"
    || tool === "workflow_continue"
    || tool === "workflow_cancel"
    || tool === "workflow_run_step"
    || tool === "shadcn_add"
    || tool === "shadcn_init";
}

function withAuditState(result: unknown, auditState: string, operationId: string, durability?: string): unknown {
  const auditMeta = { auditState, auditOperationId: operationId, ...(durability ? { auditDurability: durability } : {}) };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const existingMeta = record._meta && typeof record._meta === "object" ? record._meta as Record<string, unknown> : {};
    return { ...record, _meta: { ...existingMeta, ...auditMeta } };
  }
  return { value: result, _meta: auditMeta };
}

function auditErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/[:：]/)[0]?.trim().slice(0, 80) || "TOOL_CALL_FAILED";
}

export async function dispatchMcp(
  body: unknown,
  workspaceId: string,
  workspaceRoot: string,
  executionStorePath: string | null = null,
  dispatchOptions: McpDispatchOptions = {},
): Promise<unknown> {
  const method = String((body as { method?: unknown })?.method ?? "");
  const tool = method === "tools/call"
    ? String((body as { params?: { name?: unknown } })?.params?.name ?? "")
    : "";
  const profileDir = dispatchOptions.toolPolicyDir
    ?? (executionStorePath ? path.dirname(executionStorePath) : "");
  if (method !== "tools/call" || !tool) {
    return dispatchMcpInner(body, workspaceId, workspaceRoot, executionStorePath, dispatchOptions);
  }

  const args = ((body as { params?: { arguments?: Record<string, unknown> } })?.params?.arguments ?? {}) as Record<string, unknown>;
  const started = Date.now();
  const operationId = randomUUID();
  const highRisk = isHighRiskAuditTool(tool);
  const auditInput = {
    tool,
    durationMs: 0,
    path: typeof args.path === "string" ? args.path : typeof args.cwd === "string" ? args.cwd : undefined,
    paths: Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : undefined,
    command: typeof args.command === "string" ? args.command
      : tool === "git_commit" && typeof args.message === "string" ? `git commit -m ${args.message}` : undefined,
    clientId: dispatchOptions.caller?.clientId,
    workspaceRoot,
    ...(typeof args.idempotency_key === "string" ? { idempotencyKey: args.idempotency_key } : {}),
  };
  let auditModule: typeof import("./tool-audit.js") | null = null;
  let intentDurability: string | undefined;
  if (highRisk) {
    if (!profileDir) throw new Error("AUDIT_UNAVAILABLE：高风险操作缺少可用审计目录，未执行。");
    try {
      auditModule = await import("./tool-audit.js");
      const intent = await auditModule.appendToolAuditIntent(profileDir, workspaceId, auditInput, operationId);
      intentDurability = intent.durability;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as Error & { code?: unknown }).code) : "AUDIT_UNAVAILABLE";
      throw new Error(`AUDIT_UNAVAILABLE：高风险操作的审计意图未能持久化（${code}），未执行。`);
    }
  }
  const optionsWithAudit = highRisk ? { ...dispatchOptions, auditOperationId: operationId } : dispatchOptions;
  let result: unknown;
  try {
    result = await dispatchMcpInner(body, workspaceId, workspaceRoot, executionStorePath, optionsWithAudit);
  } catch (error) {
    if (profileDir) {
      try {
        auditModule ??= await import("./tool-audit.js");
        const failedInput = { ...auditInput, ok: false, durationMs: Date.now() - started, errorCode: auditErrorCode(error) };
        if (highRisk) await auditModule.appendToolAuditResult(profileDir, workspaceId, failedInput, operationId);
        else await auditModule.appendReadOnlyToolAudit(profileDir, workspaceId, failedInput, operationId);
      } catch {
        if (highRisk) throw new Error(`AUDIT_PENDING：操作 ${operationId} 的执行结果无法持久化；不得自动重放。`);
      }
    }
    throw error;
  }

  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const idempotentReuse = resultRecord.resumed === true;
  const completedInput = {
    ...auditInput,
    ok: true,
    durationMs: Date.now() - started,
    ...(typeof resultRecord.bytes === "number" ? { bytes: resultRecord.bytes } : {}),
    ...(typeof resultRecord.sha256 === "string" ? { sha256: resultRecord.sha256 } : {}),
  };
  if (!profileDir) return withAuditState(result, "PENDING", operationId);
  try {
    auditModule ??= await import("./tool-audit.js");
    if (!highRisk) {
      const receipt = await auditModule.appendReadOnlyToolAudit(profileDir, workspaceId, completedInput, operationId);
      return withAuditState(result, "PERSISTED", operationId, receipt.durability);
    }
    if (tool === "start_job" || tool === "job_resume") {
      if (idempotentReuse) {
        const receipt = await auditModule.appendToolAuditResult(profileDir, workspaceId, completedInput, operationId);
        return withAuditState(result, "PERSISTED", operationId, receipt.durability);
      }
      const state = resultRecord.auditState === "EXECUTION_STARTED_DURABLE" ? "EXECUTION_STARTED_DURABLE" : "PENDING";
      return withAuditState(result, state, operationId,
        typeof resultRecord.auditDurability === "string" ? resultRecord.auditDurability : intentDurability);
    }
    const receipt = await auditModule.appendToolAuditResult(profileDir, workspaceId, completedInput, operationId);
    return withAuditState(result, "PERSISTED", operationId, receipt.durability);
  } catch {
    return withAuditState(result, "PENDING", operationId, intentDurability);
  }
}

async function dispatchMcpInner(
  body: unknown,
  workspaceId: string,
  workspaceRoot: string,
  executionStorePath: string | null = null,
  dispatchOptions: McpDispatchOptions = {},
): Promise<unknown> {
  const profileDir = dispatchOptions.toolPolicyDir
    ?? (executionStorePath ? path.dirname(executionStorePath) : "");
  const boundary = await McpSecurityBoundary.create(workspaceRoot, {
    aclPath: profileDir ? path.join(profileDir, "folder-acl.json") : null,
    workspaceId,
    profileDir: profileDir || null,
  });
  const ws: WorkspaceContext = {
    workspaceRoot: boundary.rootReal,
    workspaceId,
    boundary,
    executionStore: new ExecutionRecordStore(executionStorePath),
    dispatchOptions,
  };
  const method = String((body as { method?: unknown })?.method ?? "");

  const params = ((body as { params?: Record<string, unknown> })?.params ?? {}) as Record<string, unknown>;
  const callName = method === "tools/call" ? String((body as { params?: { name?: unknown } })?.params?.name ?? "") : "";
  const callArgs = ((body as { params?: { arguments?: Record<string, unknown> } })?.params?.arguments ?? {}) as Record<string, unknown>;
  let result: unknown;

  // 写入类工具的执行必须带 workspace.write；工具清单可以展示，调用不放行。
  if (method === "tools/call" && WRITE_SCOPE_TOOL_NAMES.has(callName) && dispatchOptions.writeScopeGranted !== true) {
    throw new Error(`INSUFFICIENT_SCOPE：工具 ${callName} 需要 workspace.write 授权；请在控制中心重新授权连接器。`);
  }
  if (method === "tools/call" && SHELL_SCOPE_TOOL_NAMES.has(callName) && dispatchOptions.shellScopeGranted !== true) {
    throw new Error(`INSUFFICIENT_SCOPE：工具 ${callName} 需要 workspace.shell 授权；请在控制中心重新授权连接器。`);
  }

  // 工具级开关与审批：关闭即拒绝；人工审批必须由本机对话框确认，
  // 调用方自报的 local_approval_granted 一律不采信。
  if (method === "tools/call" && profileDir) {
    let policy: Awaited<ReturnType<typeof import("./tool-policy.js").loadToolPolicy>>;
    try {
      const { loadToolPolicy } = await import("./tool-policy.js");
      policy = await loadToolPolicy(profileDir, ws.workspaceId);
    } catch {
      throw new Error("TOOL_POLICY_UNAVAILABLE：工具策略读取失败，已按失败关闭处理。");
    }
    const entry = policy.tools[callName];
    if (entry && entry.enabled !== true) {
      throw new Error(`TOOL_DISABLED：工具 ${callName} 已在控制中心关闭，未执行。`);
    }
    if (entry && entry.approval === "manual") {
      await requestLocalApproval(profileDir, callName, callArgs, ws);
    }
  }

  // 直接文件能力（受策略开关与审批方式控制；路径必须落在工作区内）。
  if (method === "tools/call") {
    const toolName = callName;
    if (toolName === "write_file" || toolName === "create_file" || toolName === "update_file" || toolName === "list_roots") {
      const { local_approval_granted: _approved, ...rest } = callArgs;
      const mod = await import("./fs-tools.js");
      const data = toolName === "write_file"
        ? await mod.writeFileTool(ws.boundary, rest)
        : toolName === "create_file"
          ? await mod.createFileTool(ws.boundary, rest)
          : toolName === "update_file"
            ? await mod.updateFileTool(ws.boundary, rest)
            : await mod.listRoots(ws.boundary);
      return ws.boundary.redact(data);
    }
    if (toolName === "delete_file" || toolName === "move_file" || toolName === "apply_patch") {
      const { local_approval_granted: _approved, ...rest } = callArgs;
      const mod = await import("./fs-tools.js");
      const data = toolName === "delete_file"
        ? await mod.deleteFileTool(ws.boundary, rest)
        : toolName === "move_file"
          ? await mod.moveFileTool(ws.boundary, rest)
          : await mod.applyPatchTool(ws.boundary, rest);
      return ws.boundary.redact(data);
    }
  }

  // 后台长任务：start 立即返回 job_id；status/output/cancel/resume 轮询不断开连接。
  if (method === "tools/call" && JOB_TOOL_NAMES.has(callName)) {
    const { local_approval_granted: _approved, ...rest } = callArgs;
    if (!profileDir) throw new Error("JOB_STORE_UNAVAILABLE：缺少 profile 目录无法创建后台任务。");
    const { handleJobTool } = await import("./job-tools.js");
    const data = await handleJobTool(callName, rest, {
      boundary: ws.boundary,
      workspaceId: ws.workspaceId,
      workspaceRoot: ws.boundary.rootReal,
      profileDir,
      caller: ws.dispatchOptions.caller,
      shellScopeGranted: ws.dispatchOptions.shellScopeGranted,
      auditOperationId: ws.dispatchOptions.auditOperationId,
    });
    return ws.boundary.redact(data);
  }

  // 暂存-提交（prepare/commit）写入模型：草稿只存内存，提交时重新校验并读回复核。
  if (method === "tools/call" && STAGED_WRITE_TOOL_NAMES.has(callName)) {
    const { local_approval_granted: _approved, ...rest } = callArgs;
    const writeCtx = {
      boundary: ws.boundary,
      workspaceId: ws.workspaceId,
      clientId: credentialClientId(ws),
    };
    let data: unknown;
    try {
      switch (callName) {
        case "prepare_write":
          data = await prepareWrite(writeCtx, rest);
          break;
        case "batch_prepare_write":
          data = await prepareBatchWrite(writeCtx, rest);
          break;
        case "batch_replace_text":
          data = await prepareReplacements(writeCtx, rest);
          break;
        case "prepare_project_scaffold":
          data = await prepareScaffold(writeCtx, rest);
          break;
        case "list_pending_operations":
          data = listPendingOperations(writeCtx);
          break;
        case "cancel_pending_operation":
          data = cancelPendingOperation(writeCtx, rest.operation_id);
          break;
        case "commit_operation":
          data = await commitOperation(writeCtx, rest.operation_id);
          break;
        case "commit_operations":
          data = await commitOperations(writeCtx, rest.operation_ids, rest.continue_on_error === true);
          break;
        default:
          throw new WriteOperationError("UNKNOWN_STAGED_TOOL");
      }
    } catch (error: unknown) {
      if (error instanceof WriteOperationError) {
        throw new Error(`${error.code}：${writeOperationHint(error.code)}`);
      }
      throw error;
    }
    return ws.boundary.redact(data);
  }
  // 工作流台账：只记录计划与自报进度，不授予其它工具权限；commit 走本机审批门。
  if (method === "tools/call" && WORKFLOW_TOOL_NAMES.has(callName)) {
    const { local_approval_granted: _approved, ...rest } = callArgs;
    const workflowCtx: WorkflowContext = {
      clientId: credentialClientId(ws),
      workspaceId: ws.workspaceId,
      workspaceRoot: ws.boundary.rootReal,
    };
    let data: unknown;
    try {
      switch (callName) {
        case "workflow_prepare":
          data = prepareWorkflow(workflowCtx, rest);
          break;
        case "workflow_commit":
          data = commitWorkflow(workflowCtx, rest.workflow_id);
          break;
        case "workflow_status":
          data = statusWorkflow(workflowCtx, rest.workflow_id, rest.include_events === true);
          break;
        case "workflow_continue":
          data = continueWorkflow(workflowCtx, rest.workflow_id, rest);
          break;
        case "workflow_cancel":
          data = cancelWorkflow(workflowCtx, rest.workflow_id);
          break;
        case "workflow_run_step":
          data = await executeWorkflowStep(ws, workflowCtx, profileDir, rest);
          break;
        default:
          throw new WorkflowError("WORKFLOW_UNAVAILABLE");
      }
    } catch (error: unknown) {
      if (error instanceof WorkflowError) throw new Error(`${error.code}：${workflowHint(error.code)}`);
      throw error;
    }
    return ws.boundary.redact(data);
  }
  // 只读 MySQL 数据源：委托主进程（凭据留在 DPAPI）。
  if (method === "tools/call" && MYSQL_TOOL_NAMES.has(callName)) {
    const { local_approval_granted: _approved, ...rest } = callArgs;
    const mysqlContext = { profileDir, workspaceId: ws.workspaceId };
    let data: unknown;
    try {
      const datasourceId = typeof rest.datasource_id === "string" ? rest.datasource_id : "";
      if (!/^mysql_[a-f0-9]{12}$/.test(datasourceId)) throw new Error("DATASOURCE_ID_INVALID");
      switch (callName) {
        case "mysql_list_schemas":
          data = await mysqlListSchemas(mysqlContext, datasourceId);
          break;
        case "mysql_describe_table":
          data = await mysqlDescribeTable(mysqlContext, {
            datasource_id: datasourceId,
            table: typeof rest.table === "string" ? rest.table : "",
            database: typeof rest.database === "string" ? rest.database : undefined,
          });
          break;
        case "mysql_query":
          data = await mysqlQuery(mysqlContext, {
            datasource_id: datasourceId,
            sql: typeof rest.sql === "string" ? rest.sql : "",
            max_rows: typeof rest.max_rows === "number" ? rest.max_rows : undefined,
          });
          break;
        default:
          throw new Error("MYSQL_UNAVAILABLE");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const code = mysqlErrorCode(message);
      throw new Error(`${code}：${mysqlHint(code)}`);
    }
    return ws.boundary.redact(data);
  }
  // 屏幕类工具：委托主进程执行（runtime 是纯 Node，拿不到 Electron API）。
  if (method === "tools/call") {
    const toolName = callName;
    if (toolName.startsWith("screen_")) {
      const { callControl } = await import("./control-client.js");
      const dir = profileDir;
      const action = toolName.replace(/^screen_/, "screen.");
      const { local_approval_granted: _ignored, ...screenParams } = callArgs;
      const data = await callControl(dir, action, screenParams);
      return ws.boundary.redact(data);
    }
  }
  switch (method) {
    case "tools/list": {
      const tools = [
          {
            name: "workspace_info",
            description: "工作区身份、项目类型和 Git 状态",
            inputSchema: emptyObjectSchema(),
          },
          {
            name: "list_directory",
            description: "列出工作区内目录（敏感文件只显示名称和标记）",
            inputSchema: objectSchema({
              path: { type: "string", description: "工作区内的相对目录路径，默认为根目录" },
            }),
          },
          {
            name: "read_file",
            description: "分页读取工作区内文本文件（经过敏感数据保护）",
            inputSchema: objectSchema(
              {
                path: { type: "string", description: "工作区内的相对文本文件路径" },
                start_line: { type: "integer", minimum: 0, description: "起始行号，默认为 0" },
                limit: { type: "integer", minimum: 1, maximum: 400, description: "最多返回的行数" },
              },
              ["path"],
            ),
          },
          {
            name: "search_workspace",
            description: "使用 Windows 原生 Node 搜索工作区文本",
            inputSchema: objectSchema(
              {
                query: { type: "string", description: "要搜索的文本或正则表达式" },
                mode: { type: "string", enum: ["literal", "regex"], description: "搜索模式，默认为 literal" },
                flags: { type: "string", description: "正则表达式 flags" },
                glob: { type: "string", description: "可选的工作区相对 glob 过滤器" },
                limit: { type: "integer", minimum: 1, maximum: 100, description: "最多返回的匹配数" },
                offset: { type: "integer", minimum: 0, description: "跳过的匹配数" },
              },
              ["query"],
            ),
          },
          {
            name: "search_files",
            description: "只按文件名查找工作区文件，不读取正文；自动跳过敏感目录和链接，返回结果有数量上限。",
            inputSchema: objectSchema({
              query: { type: "string", description: "文件名包含的文字，最多 120 字符" },
              path: { type: "string", description: "搜索起点，默认工作区根目录" },
              limit: { type: "integer", minimum: 1, maximum: 100 },
            }, ["query"]),
          },
          {
            name: "file_metadata",
            description: "安全读取单个工作区文件或目录的大小、修改时间和类型，不读取正文。",
            inputSchema: objectSchema({ path: { type: "string", description: "工作区相对路径" } }, ["path"]),
          },
          {
            name: "directory_tree",
            description: "列出授权工作区目录树，限定深度与节点数量，跳过敏感目录与符号链接。",
            inputSchema: objectSchema({
              path: { type: "string", description: "相对起始目录，默认根目录" },
              max_depth: { type: "integer", minimum: 1, maximum: 5 },
              max_entries: { type: "integer", minimum: 1, maximum: 500 },
            }),
          },
          {
            name: "file_sha256",
            description: "计算授权文件的 SHA-256 指纹（Base64 编码），不返回正文，也不放宽敏感值保护。",
            inputSchema: objectSchema({ path: { type: "string", description: "工作区相对文件路径" } }, ["path"]),
          },
          {
            name: "compare_files",
            description: "比较两个授权文本文件，返回 Base64 编码的 SHA-256、大小和一致性，不返回正文。",
            inputSchema: objectSchema({
              left: { type: "string", description: "第一个相对路径" },
              right: { type: "string", description: "第二个相对路径" },
            }, ["left", "right"]),
          },
          {
            name: "csv_preview",
            description: "只读预览工作区 CSV 表头及最多 20 行，支持带引号的逗号/换行，原值只作文本展示，不执行公式，不修改 Excel。",
            inputSchema: objectSchema({
              path: { type: "string", description: "CSV 文件相对路径（.csv）" },
              limit: { type: "integer", minimum: 1, maximum: 20 },
            }, ["path"]),
          },
          {
            name: "csv_schema_diff",
            description: "同步前对比两个 CSV 的表头、列顺序和增删字段；只读，不写入数据。",
            inputSchema: objectSchema({
              left: { type: "string", description: "基准 CSV 相对路径" },
              right: { type: "string", description: "候选 CSV 相对路径" },
            }, ["left", "right"]),
          },
          {
            name: "batch_read_files",
            description: "批量读取最多 50 个工作区文本文件；沿用敏感路径拒绝、二进制拒绝和统一脱敏。",
            inputSchema: objectSchema(
              {
                paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
                max_chars_per_file: { type: "integer", minimum: 100, maximum: 100000 },
              },
              ["paths"],
            ),
          },
          {
            name: "batch_file_status",
            description: "批量读取最多 250 个路径的存在性、类型、大小、修改时间和文本候选状态，不读取文件正文。",
            inputSchema: objectSchema(
              { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 250 } },
              ["paths"],
            ),
          },
          {
            name: "prepare_batch_write_plan",
            description: "为最多 25 个文本文件生成 CREATE/UPDATE、当前/目标 SHA 和 no-op 计划；只做预检，绝不写盘。",
            inputSchema: objectSchema(
              {
                writes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 25,
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" },
                    },
                    required: ["path", "content"],
                    additionalProperties: false,
                  },
                },
              },
              ["writes"],
            ),
          },
          {
            name: "project_snapshot",
            description: "生成工作区项目树、扩展名统计、重要文件、大文件和归档候选快照。",
            inputSchema: objectSchema({
              path: { type: "string", description: "工作区内相对目录，默认根目录" },
              max_depth: { type: "integer", minimum: 1, maximum: 8 },
              max_files: { type: "integer", minimum: 50, maximum: 2000 },
            }),
          },
          {
            name: "batch_search_patterns",
            description: "一次搜索最多 20 个文本或正则模式，按模式分组返回匹配结果并执行敏感路径过滤。",
            inputSchema: objectSchema(
              {
                patterns: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
                path: { type: "string", description: "工作区内相对目录，默认根目录" },
                mode: { type: "string", enum: ["literal", "regex"] },
                case_sensitive: { type: "boolean" },
                max_results_per_pattern: { type: "integer", minimum: 1, maximum: 100 },
              },
              ["patterns"],
            ),
          },
          {
            name: "audit_project_structure",
            description: "确定性审计项目结构、测试目录、文档、构建标记和疑似敏感文件名；不读取敏感文件正文。",
            inputSchema: objectSchema({ path: { type: "string", description: "工作区内相对目录，默认根目录" } }),
          },
          {
            name: "generate_project_inventory",
            description: "生成顶层项目清单，识别项目标记、归档候选并给出下一步审计建议。",
            inputSchema: objectSchema({ path: { type: "string", description: "工作区内相对目录，默认根目录" } }),
          },
          {
            name: "detect_archive_candidates",
            description: "只读识别备份、归档、缓存和构建产物候选；绝不自动删除或移动。",
            inputSchema: objectSchema({
              path: { type: "string", description: "工作区内相对目录，默认根目录" },
              max_depth: { type: "integer", minimum: 1, maximum: 8 },
              limit: { type: "integer", minimum: 1, maximum: 500 },
            }),
          },
          {
            name: "list_artifacts",
            description: "列出最近的报告、诊断、测试、审计、验收和交接类产物，不读取正文。",
            inputSchema: objectSchema({
              path: { type: "string", description: "工作区内相对目录，默认根目录" },
              max_depth: { type: "integer", minimum: 1, maximum: 8 },
              limit: { type: "integer", minimum: 1, maximum: 500 },
            }),
          },
          {
            name: "read_latest_report",
            description: "读取最近一个匹配的文本报告；继续执行敏感路径、二进制和大小限制。",
            inputSchema: objectSchema({
              path: { type: "string", description: "工作区内相对目录，默认根目录" },
              filename_contains: { type: "string", description: "可选文件名关键词" },
              max_chars: { type: "integer", minimum: 500, maximum: 100000 },
            }),
          },
          {
            name: "shadcn_info",
            description: "安全解析本地 components.json/package.json，识别 shadcn、Tailwind、Radix 等配置；不执行 CLI、不联网安装。",
            inputSchema: objectSchema({ path: { type: "string", description: "项目相对目录，默认工作区根目录" } }),
          },
          {
            name: "shadcn_local_components",
            description: "盘点本地 shadcn 风格 UI 组件目录与组件文件；不搜索远程 registry、不修改项目。",
            inputSchema: objectSchema({ path: { type: "string", description: "项目相对目录，默认工作区根目录" } }),
          },
          { name: "git_status", description: "读取 Git 分支、提交和工作区状态", inputSchema: emptyObjectSchema() },
          {
            name: "git_diff",
            description: "分页读取经过脱敏和大小限制的 Git diff",
            inputSchema: objectSchema({
              scope: { type: "string", enum: ["unstaged", "staged", "head"], description: "diff 范围，默认为 unstaged" },
              max_bytes: { type: "integer", minimum: 1, maximum: 1000000, description: "最多返回的 UTF-8 字节数" },
              offset: { type: "integer", minimum: 0, description: "跳过的 UTF-8 字节数" },
            }),
          },
          {
            name: "git_recent_commits",
            description: "只读列出最近 Git 提交、日期与脱敏标题；最多 30 条，不执行任何写操作。",
            inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 30 } }),
          },
          {
            name: "git_changed_files",
            description: "只读列出暂存或未暂存的变更文件；过滤敏感路径、不返回文件正文。",
            inputSchema: objectSchema({ scope: { type: "string", enum: ["unstaged", "staged"] } }),
          },
          {
            name: "git_local_branches",
            description: "只读列出本地 Git 分支名，不修改当前分支，也不访问公网。",
            inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
          },
          {
            name: "test_inventory",
            description: "查找项目测试文件及 npm 测试脚本名称；只读清点，不执行测试。",
            inputSchema: objectSchema({ path: { type: "string", description: "项目相对目录，默认当前工作区" } }),
          },
          { name: "test_status", description: "读取 Execution Store 中最近测试状态", inputSchema: emptyObjectSchema() },
          {
            name: "execution_summary",
            description: "读取已登记的 Codex 执行摘要",
            inputSchema: objectSchema({
              limit: { type: "integer", minimum: 1, maximum: 20, description: "最多返回的执行记录数" },
            }),
          },
          {
            name: "execution_output",
            description: "读取已明确登记为可公开的执行输出",
            inputSchema: objectSchema(
              { id: { type: "string", description: "已登记的执行记录 ID" } },
              ["id"],
            ),
          },
          {
            name: "mcp_self_check",
            description: "自检当前 Runtime MCP 的工作区边界、只读工具注册和写入审批桥可用性，不读取敏感凭证。",
            inputSchema: emptyObjectSchema(),
          },
          {
            name: "capability_manifest",
            description: "返回 C2C 当前能力分层：只读工具、需审批写入、本机专用能力及安全未开放项。",
            inputSchema: emptyObjectSchema(),
          },
      ];
      // 暂存-提交写入：向已认证客户端展示（执行另需 workspace.write + 工具策略/本机审批）。
      if (dispatchOptions.caller) {
        tools.push(
          {
            name: "prepare_write",
            description: "暂存一次单文件写入：校验路径/扩展名/版本并返回 operation_id，不落盘。之后用 commit_operation 提交。",
            inputSchema: objectSchema(
              {
                path: { type: "string", description: "工作区内相对路径；必须是允许的文本扩展名" },
                content: { type: "string", description: "UTF-8 文本内容，最多 256 KB" },
                mode: { type: "string", enum: ["create", "overwrite"], description: "create=目标必须不存在；overwrite=目标必须已存在" },
              },
              ["path", "content"],
            ),
          },
          {
            name: "create_file",
            description: "新建文件（默认拒绝覆盖已存在文件）；可选 overwrite / createDirectories，写前自动备份。",
            inputSchema: objectSchema(
              {
                path: { type: "string", description: "主工作区相对路径，或已授权目录的绝对路径" },
                content: { type: "string" },
                overwrite: { type: "boolean", description: "目标已存在时是否允许覆盖（默认 false）" },
                createDirectories: { type: "boolean", description: "父目录不存在时是否自动创建" },
              },
              ["path", "content"],
            ),
          },
          {
            name: "update_file",
            description: "替换已有文件内容；可选 expected_sha256，写前自动备份。",
            inputSchema: objectSchema(
              {
                path: { type: "string" },
                content: { type: "string" },
                expected_sha256: { type: "string", description: "可选：当前文件 SHA-256；不匹配则拒绝" },
              },
              ["path", "content"],
            ),
          },
          {
            name: "delete_file",
            description: "删除一个文件：先备份到 profile 备份目录，校验 SHA 与硬链接，再删除。",
            inputSchema: objectSchema(
              {
                path: { type: "string", description: "主工作区相对路径，或已授权目录的绝对路径" },
                expected_sha256: { type: "string", description: "可选：文件当前 SHA-256；不匹配则拒绝" },
              },
              ["path"],
            ),
          },
          {
            name: "move_file",
            description: "移动/重命名一个文件：先备份，目标必须不存在，父目录必须已存在。",
            inputSchema: objectSchema(
              {
                source: { type: "string", description: "源文件路径（相对主工作区或授权目录绝对路径）" },
                destination: { type: "string", description: "目标路径；必须不存在" },
                expected_sha256: { type: "string", description: "可选：源文件 SHA-256" },
              },
              ["source", "destination"],
            ),
          },
          {
            name: "apply_patch",
            description: "对文件做精确文本替换：每个 old_text 必须恰好出现一次；写前备份。",
            inputSchema: objectSchema(
              {
                path: { type: "string", description: "文件路径" },
                edits: {
                  type: "array",
                  minItems: 1,
                  maxItems: 50,
                  items: {
                    type: "object",
                    properties: {
                      old_text: { type: "string" },
                      new_text: { type: "string" },
                    },
                    required: ["old_text", "new_text"],
                    additionalProperties: false,
                  },
                },
              },
              ["path", "edits"],
            ),
          },
          {
            name: "execute_command",
            description: "运行白名单内的项目命令（git status/diff/log、npm test/run build、python/pytest、node 脚本）；无 shell，120s 超时。",
            inputSchema: objectSchema(
              {
                command: {
                  oneOf: [
                    { type: "string", description: "命令字符串（不做 shell 解释）" },
                    { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
                  ],
                },
                cwd: { type: "string", description: "工作目录，默认主工作区" },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
              },
              ["command"],
            ),
          },
          {
            name: "run_command",
            description: "execute_command 的别名。",
            inputSchema: objectSchema(
              { command: { type: "string" }, cwd: { type: "string" }, timeout_ms: { type: "integer" } },
              ["command"],
            ),
          },
          {
            name: "run_powershell",
            description: "以当前用户权限运行 PowerShell（无沙箱、不提权）；需要 workspace.shell 与单独开关。",
            inputSchema: objectSchema(
              {
                command: { type: "string", description: "PowerShell 命令，最多 4000 字符" },
                cwd: { type: "string" },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
              },
              ["command"],
            ),
          },
          {
            name: "git_commit",
            description: "提交已暂存的 Git 改动（不 add、不 push）。",
            inputSchema: objectSchema(
              {
                cwd: { type: "string", description: "仓库内目录，默认主工作区" },
                message: { type: "string", description: "提交说明，最多 500 字符" },
                allow_empty: { type: "boolean" },
              },
              ["message"],
            ),
          },
          {
            name: "start_job",
            description: "异步启动后台任务并立即返回 job_id；支持 execute_command / run_powershell / git_commit，用于长任务轮询。",
            inputSchema: objectSchema(
              {
                action: { type: "string", enum: ["execute_command", "run_powershell", "git_commit"], description: "后台执行的已获批动作" },
                command: { type: "string", description: "execute_command/run_powershell 的命令；git_commit 不需要" },
                cwd: { type: "string", description: "工作目录，默认主工作区" },
                mode: { type: "string", enum: ["user", "constrained"], description: "仅 run_powershell 使用" },
                message: { type: "string", description: "仅 git_commit 使用" },
                allow_empty: { type: "boolean", description: "仅 git_commit 使用" },
                timeout_ms: { type: "integer", minimum: 1000, maximum: 14400000, description: "后台执行超时默认 30 分钟上限 4 小时" },
                idempotency_key: { type: "string", description: "幂等键避免重复提交" },
                label: { type: "string", description: "任务显示名最多 120 字符" },
              },
              ["action"],
            ),
          },
          {
            name: "job_status",
            description: "查询后台任务状态、进度与退出码；轮询不阻塞。",
            inputSchema: objectSchema({ job_id: { type: "string", description: "start_job 返回的任务编号" } }, ["job_id"]),
          },
          {
            name: "job_output",
            description: "分页读取后台任务的脱敏输出片段。",
            inputSchema: objectSchema(
              {
                job_id: { type: "string", description: "start_job 返回的任务编号" },
                offset: { type: "integer", minimum: 0, description: "字节偏移默认 0" },
                max_bytes: { type: "integer", minimum: 1, maximum: 32768, description: "最多返回字节默认 8192" },
              },
              ["job_id"],
            ),
          },
          {
            name: "job_list",
            description: "列出当前工作区的后台任务与最新状态；不返回输出正文。",
            inputSchema: objectSchema(
              { limit: { type: "integer", minimum: 1, maximum: 50, description: "最多返回任务数默认 20" } },
              [],
            ),
          },
          {
            name: "job_cancel",
            description: "请求取消一个运行中的后台任务；尽力终止进程。",
            inputSchema: objectSchema({ job_id: { type: "string", description: "start_job 返回的任务编号" } }, ["job_id"]),
          },
          {
            name: "job_resume",
            description: "用当前授权重新排队一个中断/失败/超时的后台任务；需要重新审批。",
            inputSchema: objectSchema({ job_id: { type: "string", description: "start_job 返回的任务编号" } }, ["job_id"]),
          },
          {
            name: "batch_prepare_write",
            description: "一次暂存多个文件写入（1–25 个），只做校验与预演，不落盘。",
            inputSchema: objectSchema(
              {
                files: {
                  type: "array",
                  minItems: 1,
                  maxItems: 25,
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" },
                      mode: { type: "string", enum: ["create", "overwrite"] },
                    },
                    required: ["path", "content", "mode"],
                    additionalProperties: false,
                  },
                },
              },
              ["files"],
            ),
          },
          {
            name: "batch_replace_text",
            description: "暂存批量精确替换：每个 find 必须恰好命中一次；只生成草稿，不落盘。",
            inputSchema: objectSchema(
              {
                replacements: {
                  type: "array",
                  minItems: 1,
                  maxItems: 25,
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      find: { type: "string" },
                      replace: { type: "string" },
                    },
                    required: ["path", "find", "replace"],
                    additionalProperties: false,
                  },
                },
              },
              ["replacements"],
            ),
          },
          {
            name: "prepare_project_scaffold",
            description: "暂存项目说明骨架（PROJECT.md / LLM.md / STATUS.md / .brainn/project.json）；项目目录与 .brainn 必须已存在。",
            inputSchema: objectSchema(
              {
                project_path: { type: "string", description: "工作区内的项目目录，默认为工作区根" },
                profile: { type: "string", enum: ["generic", "python", "node"] },
                overwrite: { type: "boolean", description: "目标已存在时是否允许覆盖（默认 false）" },
              },
            ),
          },
          {
            name: "list_pending_operations",
            description: "列出当前客户端未提交的写入草稿（仅元数据，无正文）。",
            inputSchema: emptyObjectSchema(),
          },
          {
            name: "cancel_pending_operation",
            description: "丢弃一笔尚未提交的写入草稿，不改动任何文件。",
            inputSchema: objectSchema({ operation_id: { type: "string", description: "32 位小写十六进制操作编号" } }, ["operation_id"]),
          },
          {
            name: "commit_operation",
            description: "提交一笔已暂存的写入：重新校验目标版本，经工具策略/本机确认后落盘并读回复核。",
            inputSchema: objectSchema({ operation_id: { type: "string", description: "32 位小写十六进制操作编号" } }, ["operation_id"]),
          },
          {
            name: "commit_operations",
            description: "按顺序提交多笔已暂存的写入；逐笔报告成功/阻塞，不承诺跨操作事务。",
            inputSchema: objectSchema(
              {
                operation_ids: { type: "array", minItems: 1, maxItems: 25, items: { type: "string", pattern: "^[0-9a-f]{32}$" } },
                continue_on_error: { type: "boolean" },
              },
              ["operation_ids"],
            ),
          },
          {
            name: "workflow_prepare",
            description: "登记一个有边界的只读工作流计划（名称、目标、允许动作、调用预算）；不执行工具，也不授予写/屏幕/命令权限。",
            inputSchema: objectSchema(
              {
                name: { type: "string", description: "2–100 个字符的计划名" },
                goal: { type: "string", description: "目标说明，最多 600 字符" },
                allowed_actions: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", description: "只读工具名" },
                  description: "允许在计划里报告的动作；默认 workspace_info/list_directory/read_file/git_status",
                },
                max_tool_calls: { type: "integer", minimum: 1, maximum: 250, description: "自报预算，默认 25" },
                stop_on_error: { type: "boolean", description: "出错是否停止计划，默认 true" },
              },
              ["name", "goal"],
            ),
          },
          {
            name: "workflow_commit",
            description: "本机确认后激活工作流计划；只开始记录进度，不自动执行工具、不授予其它权限。",
            inputSchema: objectSchema({ workflow_id: { type: "string", pattern: "^[0-9a-f]{32}$" } }, ["workflow_id"]),
          },
          {
            name: "workflow_status",
            description: "查看工作流阶段、预算使用与最近步骤（只返回摘要，不返回用户原文）。",
            inputSchema: objectSchema(
              {
                workflow_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
                include_events: { type: "boolean", description: "是否返回步骤摘要" },
              },
              ["workflow_id"],
            ),
          },
          {
            name: "workflow_continue",
            description: "在已激活的工作流上记录一步进度与预算消耗；超出预算或按 stop_on_error 出错即停止。",
            inputSchema: objectSchema(
              {
                workflow_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
                step_summary: { type: "string", description: "最多 240 字符，不要放凭据" },
                tool_calls_used: { type: "integer", minimum: 0, maximum: 250 },
                file_writes_used: { type: "integer", enum: [0] },
                observed_error: { type: "string", description: "可选错误摘要，最多 100 字符" },
                next_action: { type: "string", description: "下一步只读动作，必须在 allowed_actions 内" },
              },
              ["workflow_id", "step_summary", "next_action"],
            ),
          },
          {
            name: "workflow_cancel",
            description: "取消自己的一个工作流计划；不删除文件、不停止服务。",
            inputSchema: objectSchema({ workflow_id: { type: "string", pattern: "^[0-9a-f]{32}$" } }, ["workflow_id"]),
          },
          {
            name: "workflow_run_step",
            description: "在已激活的只读工作流里真正执行一步；动作必须在计划的 allowed_actions 内，并消耗 1 次预算。",
            inputSchema: objectSchema(
              {
                workflow_id: { type: "string", pattern: "^[0-9a-f]{32}$" },
                action: { type: "string", description: "只读工具名，如 list_directory / read_file / git_status" },
                arguments: { type: "object", additionalProperties: true, description: "传给该动作的参数，如 {path:'src'}" },
              },
              ["workflow_id", "action"],
            ),
          },
          {
            name: "shadcn_search",
            description: "只读检索官方 shadcn Registry 的组件元数据（固定官方地址，不执行 npx、不下载源码）。",
            inputSchema: objectSchema({
              query: { type: "string", description: "组件名/标题关键字，最多 60 字符" },
              limit: { type: "integer", minimum: 1, maximum: 50, description: "默认 20" },
              offset: { type: "integer", minimum: 0, description: "默认 0" },
            }),
          },
          {
            name: "shadcn_view",
            description: "查看指定官方组件的依赖、文件与文档链接；只返回元数据，不返回可执行源码。",
            inputSchema: objectSchema(
              { items: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" }, description: "组件名，如 button" } },
              ["items"],
            ),
          },
          {
            name: "shadcn_add",
            description: "添加 shadcn 组件：dry_run 只预演；dry_run:false 会把官方源码暂存为待本机批准的操作（commit_operation 落盘），不执行 npm install。",
            inputSchema: objectSchema(
              {
                components: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
                cwd: { type: "string", description: "工作区内的项目目录，默认根目录" },
                overwrite: { type: "boolean", description: "目标已存在时是否允许覆盖（默认 false）" },
                dry_run: { type: "boolean", description: "默认 true=只预演；false=暂存官方源码，需 commit_operation" },
              },
              ["components"],
            ),
          },
          {
            name: "shadcn_init",
            description: "初始化 shadcn：暂存 components.json 与 src/lib/utils.ts（commit_operation 落盘），不执行 npx/npm。",
            inputSchema: objectSchema({
              cwd: { type: "string", description: "工作区内的项目目录，默认根目录" },
              template: { type: "string", enum: ["next", "vite", "start", "react-router", "laravel", "astro"] },
              base: { type: "string", enum: ["radix", "base"] },
              style: { type: "string", description: "默认 new-york" },
              overwrite: { type: "boolean", description: "已存在 components.json 时是否覆盖" },
            }),
          },
          {
            name: "mysql_list_schemas",
            description: "列出只读 MySQL 数据源里可见的数据库（排除系统库）；需要先在控制中心配置数据源并开启该工具。",
            inputSchema: objectSchema(
              { datasource_id: { type: "string", description: "数据源 id，形如 mysql_xxxxxxxxxxxx" } },
              ["datasource_id"],
            ),
          },
          {
            name: "mysql_describe_table",
            description: "查看只读数据源中某张表的列、类型与键。",
            inputSchema: objectSchema(
              {
                datasource_id: { type: "string" },
                table: { type: "string", description: "表名" },
                database: { type: "string", description: "可选：库名，缺省用数据源的库" },
              },
              ["datasource_id", "table"],
            ),
          },
          {
            name: "mysql_query",
            description: "执行一条只读 SQL：单条 SELECT/SHOW/EXPLAIN，禁止写操作与多语句，自动限制行数并有超时；本机审批后执行。",
            inputSchema: objectSchema(
              {
                datasource_id: { type: "string" },
                sql: { type: "string", description: "只读 SQL，最多 4000 字符" },
                max_rows: { type: "integer", minimum: 1, maximum: 500 },
              },
              ["datasource_id", "sql"],
            ),
          },
          {
            name: "search",
            description: "按关键字搜索工作区内容（search_workspace 的兼容别名）。",
            inputSchema: objectSchema(
              {
                query: { type: "string", description: "要搜索的文本或正则" },
                mode: { type: "string", enum: ["literal", "regex"] },
                path: { type: "string", description: "可选：限定到某个子目录" },
                limit: { type: "integer", minimum: 1, maximum: 100 },
                max_results: { type: "integer", minimum: 1, maximum: 100 },
              },
              ["query"],
            ),
          },
          {
            name: "fetch",
            description: "只读 GET 一个白名单域名下的文本 URL；不支持自定义方法/请求头/端口，逐跳重新解析并固定 IP、禁止 https→http 降级、20s 总预算、1MB 上限。",
            inputSchema: objectSchema(
              {
                url: { type: "string", description: "https URL；域名必须已加入当前工作区的 fetch 白名单；端口只能是默认端口或在白名单 allow_ports 中授权" },
                max_bytes: { type: "integer", minimum: 1024, maximum: 1048576 },
              },
              ["url"],
            ),
          },
          {
            name: "get_mcp_app_settings",
            description: "返回这个 MCP 服务给 ChatGPT 用的连接器配置（名称、说明、URL、认证方式、工具数）。",
            inputSchema: emptyObjectSchema(),
          },
          {
            name: "verify_tool_registered",
            description: "核验某个工具是否注册、是否条件工具，以及当前开关与审批方式。",
            inputSchema: objectSchema(
              { name: { type: "string", description: "工具名" } },
              ["name"],
            ),
          },
        );
      }
      // 旧版 create_file/update_file 已从工具面移除：它们只创建审批请求，
      // 生产 Writer 未接，不能完成写入。写入请用 prepare_write + commit_operation。
      result = { tools };
      break;
    }
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      result = await callTool(name, args, ws);
      break;
    }
    case "initialize":
      result = {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "linos-c2c-runtime", version: "2.0.0" },
        capabilities: { tools: {} },
      };
      break;
    case "ping":
      result = {};
      break;
    default:
      throw new McpSecurityError("unknown_method", `unknown_method: ${method}`);
  }
  return ws.boundary.redact(result);
}

/** 执行前必须有 workspace.write 的工具（清单可见，调用不放行）。 */
const SHELL_SCOPE_TOOL_NAMES = new Set([
  "execute_command",
  "run_command",
  "run_powershell",
  "git_commit",
  "start_job",
  "job_resume",
]);

const WRITE_SCOPE_TOOL_NAMES = new Set([
  "write_file",
  "create_file",
  "update_file",
  "delete_file",
  "move_file",
  "apply_patch",
  "prepare_write",
  "batch_prepare_write",
  "batch_replace_text",
  "prepare_project_scaffold",
  "cancel_pending_operation",
  "commit_operation",
  "commit_operations",
]);

/** 走暂存-提交模型的工具。 */
const STAGED_WRITE_TOOL_NAMES = new Set([
  "prepare_write",
  "batch_prepare_write",
  "batch_replace_text",
  "prepare_project_scaffold",
  "list_pending_operations",
  "cancel_pending_operation",
  "commit_operation",
  "commit_operations",
]);

/** 工作流台账工具。 */
const WORKFLOW_TOOL_NAMES = new Set([
  "workflow_prepare",
  "workflow_commit",
  "workflow_status",
  "workflow_continue",
  "workflow_cancel",
  "workflow_run_step",
]);

const JOB_TOOL_NAMES = new Set([
  "start_job",
  "job_status",
  "job_output",
  "job_list",
  "job_cancel",
  "job_resume",
]);

/** 只读 MySQL 数据源工具（委托主进程）。 */
const MYSQL_TOOL_NAMES = new Set([
  "mysql_list_schemas",
  "mysql_describe_table",
  "mysql_query",
]);

function credentialClientId(ws: WorkspaceContext): string {
  const clientId = ws.dispatchOptions.caller?.clientId;
  if (!clientId || !/^[A-Za-z0-9._:-]{1,200}$/.test(clientId)) {
    throw new WriteOperationError("CLIENT_ID_REQUIRED");
  }
  return clientId;
}

function writeOperationHint(code: string): string {
  switch (code) {
    case "OPERATION_NOT_FOUND":
      return "草稿不存在、已过期，或不属于当前客户端。请重新 prepare。";
    case "OPERATION_EXPIRED":
      return "草稿已超过 10 分钟有效期，请重新 prepare。";
    case "VERSION_CHANGED":
      return "目标文件在暂存后被修改，已拒绝覆盖；请重新 prepare。";
    case "TARGET_EXISTS":
      return "目标已存在；如需覆盖请改用 overwrite 模式重新暂存。";
    case "TARGET_NOT_FOUND":
      return "目标不存在；如需新建请改用 create 模式重新暂存。";
    case "READBACK_MISMATCH":
      return "写入后读回校验不一致，已回滚。";
    case "WRITE_PARTIAL_RECOVERY_REQUIRED":
      return "部分文件已写入且回滚失败，请立即人工核对目标文件。";
    case "FILE_TYPE_WRITE_BLOCKED":
      return "该扩展名不在允许的文本写入范围内。";
    case "HIDDEN_TARGET_BLOCKED":
      return "不允许暂存写入隐藏文件。";
    case "SENSITIVE_PATH_DENIED":
      return "目标命中敏感文件规则，拒绝写入。";
    case "REPLACEMENT_NOT_UNIQUE":
      return "查找串在文件中必须恰好出现一次，否则拒绝替换。";
    case "INVALID_UTF8_TARGET":
      return "目标不是合法 UTF-8 文本，拒绝替换。";
    default:
      return "写入操作未执行。";
  }
}

/**
 * 本机人工审批：通过主进程控制端点弹出原生确认框。
 * 通道不可用、用户拒绝、超时都按失败关闭处理。
 */
async function requestLocalApproval(
  profileDir: string,
  toolName: string,
  args: Record<string, unknown>,
  ws: WorkspaceContext,
): Promise<void> {
  let described: { summary: string; details: string[] };
  try {
    described = await describeApproval(toolName, args, ws);
  } catch (error: unknown) {
    if (error instanceof WriteOperationError) {
      throw new Error(`${error.code}：${writeOperationHint(error.code)}`);
    }
    throw error;
  }
  const { callControl } = await import("./control-client.js");
  const decision = await callControl(profileDir, "approval.request", {
    tool: toolName,
    summary: described.summary,
    details: described.details,
    workspace_id: ws.workspaceId,
    workspace_root: ws.workspaceRoot,
  }, 90_000);
  const approved = Boolean(decision && typeof decision === "object"
    && (decision as { approved?: unknown }).approved === true);
  if (!approved) {
    const reason = decision && typeof decision === "object" && typeof (decision as { reason?: unknown }).reason === "string"
      ? (decision as { reason: string }).reason
      : "LOCAL_APPROVAL_DENIED";
    throw new Error(`LOCAL_APPROVAL_DENIED：本机拒绝了 ${toolName} 的调用（${reason}）。`);
  }
}

async function runShadcn<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof ShadcnError) throw new Error(`${error.code}：${shadcnHint(error.code)}`);
    throw error;
  }
}

function shadcnHint(code: string): string {
  switch (code) {
    case "OFFICIAL_REGISTRY_UNAVAILABLE":
      return "无法访问官方 shadcn Registry（网络/代理/超时），本工具不提供离线伪造结果。";
    case "OFFICIAL_REGISTRY_INVALID":
    case "OFFICIAL_REGISTRY_TOO_LARGE":
      return "官方 Registry 响应不符合预期，已拒绝使用。";
    case "OFFICIAL_REGISTRY_ITEM_NOT_FOUND":
      return "官方 Registry 中没有这些组件，请先用 shadcn_search 确认名称。";
    case "INVALID_SEARCH_QUERY":
    case "INVALID_SEARCH_LIMIT":
    case "INVALID_SEARCH_OFFSET":
    case "INVALID_REGISTRY_ITEMS":
      return "检索/查看参数不合法。";
    case "SHADCN_NOT_INITIALIZED":
      return "项目没有 components.json；请先人工初始化 shadcn。";
    case "PROJECT_PATH_NOT_ALLOWED":
      return "项目路径必须落在工作区内。";
    case "PROJECT_NOT_DIRECTORY":
      return "目标不是目录。";
    case "PROJECT_CONFIG_INVALID":
    case "PROJECT_CONFIG_TOO_LARGE":
    case "PROJECT_CONFIG_UNAVAILABLE":
      return "components.json 无法安全读取，请人工检查。";
    case "NODE_PROJECT_PACKAGE_JSON_REQUIRED":
      return "初始化预演要求项目里有可读的 package.json。";
    case "UNSUPPORTED_TEMPLATE":
    case "UNSUPPORTED_BASE":
      return "不支持的模板/基础库选项。";
    case "INVALID_COMPONENTS":
      return "组件名必须是小写字母/数字/连字符，最多 12 个且不能重复。";
    case "SHADCN_TARGET_EXISTS":
      return "目标组件文件已存在；确认要覆盖请传 overwrite:true。";
    case "SHADCN_ALREADY_INSTALLED":
      return "目标文件与官方源码一致，无需重复安装。";
    case "SHADCN_ALREADY_INITIALIZED":
      return "项目已有 components.json；确认要覆盖请传 overwrite:true。";
    case "SHADCN_FILE_CONFLICT":
    case "SHADCN_FILE_PATH_UNSUPPORTED":
      return "Registry 文件路径无法安全映射到项目目录。";
    case "SHADCN_TOO_MANY_FILES":
    case "SHADCN_TOO_MANY_ITEMS":
      return "一次安装的组件/文件太多，请分开执行。";
    case "LOCAL_APPROVAL_AND_SAFE_WRITER_REQUIRED":
      return "该操作需要在控制中心本机确认后执行。";
    default:
      return "shadcn 操作未执行。";
  }
}

function workflowHint(code: string): string {
  switch (code) {
    case "WORKFLOW_NOT_FOUND":
      return "工作流不存在、已过期，或不属于当前客户端。";
    case "WORKFLOW_NOT_ACTIVE":
      return "工作流还没在本机激活，或已经停止/取消。";
    case "WORKFLOW_NOT_CANCELLABLE":
      return "当前阶段不可取消。";
    case "WORKFLOW_BUDGET_EXCEEDED":
      return "本次进度会超出计划预算，工作流已停止。";
    case "WORKFLOW_SCOPE_DENIED":
      return "该动作不在计划允许的只读动作内。";
    case "WORKFLOW_ACTION_NOT_EXECUTABLE":
      return "该动作不能由工作流执行（只支持只读工具，且不能嵌套工作流）。";
    case "WORKFLOW_STEP_IN_PROGRESS":
      return "已有一步在执行，请等待它完成。";
    case "WORKFLOW_STEP_NOT_PENDING":
      return "没有待落账的工作流步骤。";
    case "UNSAFE_WORKFLOW_SCOPE":
      return "工作流不能包含写文件、删除、移动或命令权限。";
    case "UNSAFE_WORKFLOW_NOTES":
      return "文本里疑似包含凭据或控制字符，已拒绝。";
    case "INVALID_WORKFLOW_NAME":
    case "INVALID_WORKFLOW_GOAL":
    case "INVALID_WORKFLOW_BUDGET":
    case "INVALID_WORKFLOW_ID":
      return "工作流参数不合法。";
    case "WORKFLOW_CAPACITY_EXCEEDED":
      return "未完成的工作流太多，请先取消旧的。";
    default:
      return "工作流操作未执行。";
  }
}

function fetchHint(code: string): string {
  switch (code) {
    case "FETCH_DISABLED":
      return "当前工作区还没有配置 fetch 白名单（控制中心 → 工作区 → 联网白名单）。";
    case "FETCH_DOMAIN_NOT_ALLOWED":
      return "目标域名不在白名单里；请先在控制中心添加。";
    case "FETCH_HOST_NOT_ALLOWED":
      return "不允许 localhost/IP/内网域名。";
    case "FETCH_SCHEME_NOT_ALLOWED":
      return "只允许 https（除非白名单显式允许 http）。";
    case "FETCH_URL_INVALID":
      return "URL 不合法（不能带账号密码）。";
    case "FETCH_REDIRECT_INVALID":
    case "FETCH_REDIRECT_LIMIT":
      return "重定向目标不合法或跳转过多（每一跳都要在白名单内）。";
    case "FETCH_TOO_LARGE":
      return "响应超过大小上限（默认 1MB）。";
    case "FETCH_CONTENT_TYPE_REJECTED":
      return "只允许文本/JSON/XML 类响应。";
    case "FETCH_TIMEOUT":
      return "请求超时（总预算 20s，所有重定向共享）。";
    case "FETCH_CONNECT_TIMEOUT":
      return "建立连接超时（5s）。";
    case "FETCH_DNS_TIMEOUT":
      return "域名解析超时（3s）。";
    case "FETCH_DNS_EMPTY":
    case "FETCH_DNS_INVALID_ADDRESS":
    case "FETCH_DNS_FAILED":
      return "域名解析失败或返回了不可用的地址。";
    case "FETCH_TLS_FAILED":
      return "TLS 证书校验失败；不会降级为不校验连接。";
    case "FETCH_PEER_MISMATCH":
      return "实际连接的对端地址与校验通过的地址不一致，已中止（可能为 DNS 重绑定攻击）。";
    case "FETCH_LOOKUP_HOST_MISMATCH":
      return "底层解析请求了非预期域名，已中止。";
    case "FETCH_SCHEME_DOWNGRADE":
      return "禁止从 https 重定向降级到 http。";
    case "FETCH_PORT_NOT_ALLOWED":
      return "该端口未被授权；仅允许默认端口，其它端口需管理员在白名单中显式开启。";
    case "FETCH_REDIRECT_LOOP":
      return "检测到重定向环，已中止。";
    case "FETCH_CONTENT_ENCODING_REJECTED":
      return "不支持压缩响应（只接受 identity 编码）。";
    case "FETCH_HTTP_ERROR":
      return "目标返回了非 2xx 状态。";
    case "FETCH_ALLOWLIST_INVALID":
      return "白名单文件格式不合法。";
    default:
      return "网络读取未执行。";
  }
}

function mysqlErrorCode(message: string): string {  if (message.includes("CONTROL_BRIDGE_UNAVAILABLE")) return "CONTROL_BRIDGE_UNAVAILABLE";
  if (message.includes("CONTROL_BRIDGE_TIMEOUT")) return "MYSQL_TIMEOUT";
  const match = /((?:SQL|MYSQL|DATASOURCE)_[A-Z0-9_]+)/.exec(message);
  if (match) return match[1]!;
  if (message.includes("CONTROL_BRIDGE_FAILED")) return "MYSQL_QUERY_FAILED";
  return "MYSQL_UNAVAILABLE";
}

function mysqlHint(code: string): string {
  if (code.startsWith("SQL_")) return "SQL 守卫拒绝了这条语句（只允许单条只读 SELECT/SHOW/EXPLAIN，且受表白名单/行数限制）。";
  switch (code) {
    case "DATASOURCE_ID_INVALID":
      return "数据源 id 不合法（应为 mysql_ 加 12 位十六进制）。";
    case "DATASOURCE_NOT_FOUND":
      return "当前工作区没有这个数据源，请先在控制中心配置。";
    case "DATASOURCE_SECRET_UNAVAILABLE":
      return "数据源密码未保存或 DPAPI 不可用，请重新保存数据源。";
    case "MYSQL_ACCESS_DENIED":
      return "账号或密码错误（请确认用的是只读账号）。";
    case "MYSQL_DATABASE_ACCESS_DENIED":
      return "该账号没有这个数据库的权限。";
    case "MYSQL_TABLE_ACCESS_DENIED":
      return "该账号没有这张表的权限。";
    case "MYSQL_UNAVAILABLE":
      return "连不上 MySQL（服务未启动、端口/防火墙或主机不对）。";
    case "MYSQL_TIMEOUT":
      return "查询超时（已按数据源配置中断）。";
    case "MYSQL_TABLE_NOT_FOUND":
      return "表不存在，请先确认库/表名。";
    case "MYSQL_IDENTIFIER_INVALID":
      return "库名/表名不合法。";
    case "CONTROL_BRIDGE_UNAVAILABLE":
    case "CONTROL_BRIDGE_FAILED":
      return "控制中心未运行或数据源通道未就绪；请打开控制中心后重试。";
    default:
      return "只读查询未执行（检查 SQL、账号权限与数据源配置）。";
  }
}

async function executeWorkflowStep(
  ws: WorkspaceContext,
  ctx: WorkflowContext,
  profileDir: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = typeof args.action === "string" ? args.action : "";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(action)) throw new Error("WORKFLOW_ACTION_NOT_EXECUTABLE");
  const rawArguments = args.arguments;
  const stepArgs: Record<string, unknown> = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
    ? { ...(rawArguments as Record<string, unknown>) }
    : {};
  delete stepArgs.local_approval_granted;
  delete stepArgs.workflow_id;
  delete stepArgs.action;

  // 目标工具自身必须存在且处于开启状态；工作流不能绕过"关闭"。
  const { loadToolPolicy } = await import("./tool-policy.js");
  const policy = await loadToolPolicy(profileDir, ws.workspaceId);
  const target = policy.tools[action];
  if (!target) throw new Error(`WORKFLOW_ACTION_NOT_EXECUTABLE：未知动作 ${action}。`);
  if (target.enabled !== true) throw new Error(`TOOL_DISABLED：工作流步骤 ${action} 已在控制中心关闭。`);

  // 先检查（不扣预算），再占预算，最后执行并落账。
  assertWorkflowStepAllowed(ctx, args.workflow_id, action);
  const reserved = reserveWorkflowStep(ctx, args.workflow_id, action);
  try {
    const result = await callTool(action, stepArgs, ws);
    const after = finishWorkflowStep(ctx, args.workflow_id, action, true);
    return { ...after, step: { action, step_number: reserved.stepNumber, result } };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message.slice(0, 80) : "STEP_FAILED";
    try {
      finishWorkflowStep(ctx, args.workflow_id, action, false, code);
    } catch {
      /* 工作流可能已被取消；保留原始错误 */
    }
    throw error;
  }
}

async function describeApproval(
  toolName: string,
  args: Record<string, unknown>,
  ws: WorkspaceContext,
): Promise<{ summary: string; details: string[] }> {
  const writeCtx: WriteContext = {
    boundary: ws.boundary,
    workspaceId: ws.workspaceId,
    clientId: credentialClientId(ws),
  };
  const base = [`工作区：${ws.workspaceRoot}`];
  switch (toolName) {
    case "commit_operation":
      return describeOperationForApproval(writeCtx, args.operation_id);
    case "commit_operations":
      return describeOperationsForApproval(writeCtx, args.operation_ids);
    case "workflow_commit":
      return describeWorkflowForApproval({
        clientId: credentialClientId(ws),
        workspaceId: ws.workspaceId,
        workspaceRoot: ws.boundary.rootReal,
      }, args.workflow_id);
    case "mysql_query": {
      const sql = typeof args.sql === "string" ? args.sql.replace(/\s+/g, " ").slice(0, 300) : "(未提供)";
      return {
        summary: `执行只读 SQL（数据源 ${String(args.datasource_id ?? "?")}）`,
        details: [
          `数据源：${String(args.datasource_id ?? "?")}`,
          `SQL：${sql}`,
          "只允许单条 SELECT/SHOW/EXPLAIN；自动限制行数、超时与返回字节。",
          ...base,
        ],
      };
    }
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "(未提供)";
      const bytes = typeof args.content === "string" ? Buffer.byteLength(args.content, "utf8") : 0;
      return { summary: `直接写入文件 ${path}（${bytes} B）`, details: [`文件：${path}`, `大小：${bytes} B`, ...base] };
    }
    case "create_file":
    case "update_file": {
      const path = typeof args.path === "string" ? args.path : "(未提供)";
      const bytes = typeof args.content === "string" ? Buffer.byteLength(args.content, "utf8") : 0;
      return {
        summary: `${toolName === "create_file" ? "提交新建" : "提交覆盖"}审批请求 ${path}（${bytes} B）`,
        details: [`文件：${path}`, `大小：${bytes} B`, "这一步只创建审批请求，不会直接落盘。", ...base],
      };
    }
    case "prepare_write":
    case "batch_prepare_write":
    case "batch_replace_text":
    case "prepare_project_scaffold": {
      return {
        summary: "暂存写入预演（不落盘，提交时另需确认）",
        details: [`工具：${toolName}`, "预演阶段不修改任何文件。", ...base],
      };
    }
    default: {
      if (toolName.startsWith("screen_")) {
        const details = [`动作：${toolName}`, "将读取本机桌面/窗口内容。", ...base];
        for (const [key, value] of Object.entries(args)) {
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            details.push(`${key}：${String(value).slice(0, 120)}`);
          }
        }
        return { summary: `屏幕动作 ${toolName}`, details };
      }
      return { summary: `调用工具 ${toolName}`, details: [`工具：${toolName}`, ...base] };
    }
  }
}

type JsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
};

function emptyObjectSchema(): JsonSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

async function callTool(name: string, args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  switch (name) {
    case "workspace_info": {
      const git = await readGitSnapshot(ws.workspaceRoot);
      const workspace = await detectWorkspace(ws.workspaceRoot);
      return {
        workspaceId: ws.workspaceId,
        workspaceRoot: ws.workspaceRoot,
        exists: true,
        isGitRepo: git.isRepo,
        branch: git.branch,
        commit: git.commit,
        dirty: git.dirty,
        projectType: workspace.projectType,
        languages: workspace.languages,
        frameworks: workspace.frameworks,
      };
    }
    case "list_directory": {
      const resolved = await ws.boundary.resolveWorkspacePath(String(args.path ?? "."));
      ws.boundary.assertReadable(resolved);
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isDirectory()) throw new McpSecurityError("not_a_directory");
      const entries = (await fs.readdir(resolved.absolute, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : "file",
          sensitive: ws.boundary.sensitivePaths.isSensitive(entry.name),
        }));
      return { path: resolved.relative, entries, truncated: entries.length === MAX_DIRECTORY_ENTRIES };
    }
    case "read_file": {
      const resolved = await ws.boundary.resolveWorkspacePath(String(args.path ?? ""));
      ws.boundary.assertReadable(resolved);
      const stat = await fs.stat(resolved.absolute);
      if (!stat.isFile()) throw new McpSecurityError("not_a_file");
      if (stat.size > MAX_FILE_BYTES) throw new McpSecurityError("file_too_large");
      const bytes = await fs.readFile(resolved.absolute);
      if (isLikelyBinary(resolved.relative, bytes)) throw new McpSecurityError("binary_file_denied");
      const lines = bytes.toString("utf8").split(/\r?\n/);
      const startLine = ws.boundary.limit(args.start_line, 0, lines.length);
      const limit = ws.boundary.limit(args.limit, 400, 400);
      return {
        path: resolved.relative,
        totalLines: lines.length,
        startLine,
        lines: lines.slice(startLine, startLine + limit),
        truncated: startLine + limit < lines.length,
      };
    }
    case "search_workspace":
      return await searchWorkspace(args, ws);
    case "search_files":
      return await searchFileNames(args, ws);
    case "file_metadata": {
      if (typeof args.path !== "string" || !args.path.trim()) throw new McpSecurityError("path_required");
      const resolved = await ws.boundary.resolveWorkspacePath(args.path);
      ws.boundary.assertReadable(resolved);
      const stat = await fs.lstat(resolved.absolute);
      if (stat.isSymbolicLink()) throw new McpSecurityError("symlink_denied");
      return { path: resolved.relative, type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    }
    case "directory_tree":
      return await directoryTree(args, ws);
    case "file_sha256": {
      const file = await readBoundedOrdinaryFile(args.path, ws);
      return { path: file.relative, sizeBytes: file.bytes.length, sha256Base64: createHash("sha256").update(file.bytes).digest("base64") };
    }
    case "compare_files": {
      const [left, right] = await Promise.all([readBoundedOrdinaryFile(args.left, ws), readBoundedOrdinaryFile(args.right, ws)]);
      const leftHash = createHash("sha256").update(left.bytes).digest("base64");
      const rightHash = createHash("sha256").update(right.bytes).digest("base64");
      return { left: { path: left.relative, sizeBytes: left.bytes.length, sha256Base64: leftHash }, right: { path: right.relative, sizeBytes: right.bytes.length, sha256Base64: rightHash }, identical: left.bytes.equals(right.bytes) };
    }
    case "csv_preview": {
      if (typeof args.path !== "string" || !/\.csv$/i.test(args.path)) throw new McpSecurityError("csv_extension_required");
      const file = await readBoundedOrdinaryFile(args.path, ws);
      let decoded: string;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); }
      catch { throw new McpSecurityError("csv_invalid_utf8"); }
      try {
        return { path: file.relative, ...parseCsvPreview(decoded, ws.boundary.limit(args.limit, 10, 20)) };
      } catch { throw new McpSecurityError("csv_parse_failed"); }
    }
    case "csv_schema_diff": {
      if (typeof args.left !== "string" || typeof args.right !== "string"
        || !/\.csv$/i.test(args.left) || !/\.csv$/i.test(args.right)) {
        throw new McpSecurityError("csv_extension_required");
      }
      const [left, right] = await Promise.all([
        readBoundedOrdinaryFile(args.left, ws),
        readBoundedOrdinaryFile(args.right, ws),
      ]);
      let leftHeaders: string[];
      let rightHeaders: string[];
      try {
        leftHeaders = parseCsvPreview(new TextDecoder("utf-8", { fatal: true }).decode(left.bytes), 1).headers;
        rightHeaders = parseCsvPreview(new TextDecoder("utf-8", { fatal: true }).decode(right.bytes), 1).headers;
      } catch { throw new McpSecurityError("csv_parse_failed"); }
      return {
        left: left.relative, right: right.relative,
        sameOrder: leftHeaders.length === rightHeaders.length && leftHeaders.every((v, i) => v === rightHeaders[i]),
        addedColumns: rightHeaders.filter((v) => !leftHeaders.includes(v)),
        removedColumns: leftHeaders.filter((v) => !rightHeaders.includes(v)),
        duplicateLeft: leftHeaders.filter((v, i) => leftHeaders.indexOf(v) !== i),
        duplicateRight: rightHeaders.filter((v, i) => rightHeaders.indexOf(v) !== i),
        requiresReview: leftHeaders.length !== rightHeaders.length || leftHeaders.some((v, i) => v !== rightHeaders[i]),
      };
    }
    case "batch_read_files":
      return await batchReadFiles(args, ws);
    case "batch_file_status":
      return await batchFileStatus(args, ws);
    case "prepare_batch_write_plan":
      return await prepareBatchWritePlan(args, ws);
    case "project_snapshot":
      return await projectSnapshot(args, ws);
    case "batch_search_patterns":
      return await batchSearchPatterns(args, ws);
    case "audit_project_structure":
      return await auditProjectStructure(args, ws);
    case "generate_project_inventory":
      return await generateProjectInventory(args, ws);
    case "detect_archive_candidates":
      return await detectArchiveCandidates(args, ws);
    case "list_artifacts":
      return await listArtifacts(args, ws);
    case "read_latest_report":
      return await readLatestReport(args, ws);
    case "shadcn_info":
      return await shadcnProjectInfo(args, ws);
    case "shadcn_local_components":
      return await shadcnLocalComponents(args, ws);
    case "shadcn_search":
      return await runShadcn(() => getShadcnCatalog().search({
        query: args.query, limit: args.limit, offset: args.offset,
      }));
    case "shadcn_view":
      return await runShadcn(() => getShadcnCatalog().view(args.items));
    case "shadcn_add":
      return await runShadcn(() => planShadcnAdd({
        boundary: ws.boundary,
        workspaceId: ws.workspaceId,
        clientId: credentialClientId(ws),
      }, args));
    case "shadcn_init":
      return await runShadcn(() => planShadcnInit({
        boundary: ws.boundary,
        workspaceId: ws.workspaceId,
        clientId: credentialClientId(ws),
      }, args));
    case "search":
      return await callTool("search_workspace", {
        query: args.query,
        mode: args.mode,
        flags: args.flags,
        glob: args.glob ?? (typeof args.path === "string" && args.path !== "."
          ? `${args.path.replace(/[\\/]+$/, "")}/**`
          : undefined),
        limit: args.limit ?? args.max_results,
        offset: args.offset,
      }, ws);
    case "execute_command":
    case "run_command":
      return ws.boundary.redact(await executeCommand(ws.boundary, args as { command?: unknown; cwd?: unknown; timeout_ms?: unknown }));
    case "run_powershell":
      return ws.boundary.redact(await runPowerShell(ws.boundary, args as { command?: unknown; cwd?: unknown; timeout_ms?: unknown }));
    case "git_commit":
      return ws.boundary.redact(await gitCommit(ws.boundary, args as { cwd?: unknown; message?: unknown; allow_empty?: unknown }));
    case "fetch": {
      const profileDir = ws.dispatchOptions.toolPolicyDir ?? "";
      try {
        return await fetchUrl(profileDir, ws.workspaceId, {
          url: args.url,
          max_bytes: args.max_bytes,
        });
      } catch (error: unknown) {
        if (error instanceof FetchError) throw new Error(`${error.code}：${fetchHint(error.code)}`);
        throw error;
      }
    }
    case "get_mcp_app_settings": {
      const port = ws.dispatchOptions.localPort;
      const url = ws.dispatchOptions.publicMcpUrl
        || (port && port > 0 ? `http://127.0.0.1:${port}/mcp` : null);
      return {
        name: "LinOS C2C Runtime",
        description: "Local workspace MCP for ChatGPT：只读工具 + 暂存-提交写入 + 本机审批。",
        mcp_url: url,
        auth_mode: "oauth",
        workspace_id: ws.workspaceId,
        tool_count: TOOL_INVENTORY.length,
        scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "workspace.write", "workspace.shell", "offline_access"],
        security: {
          read_only_by_default: true,
          writes_require_local_approval: true,
          local_control_channel: Boolean(ws.dispatchOptions.toolPolicyDir),
        },
      };
    }
    case "verify_tool_registered": {
      const name = typeof args.name === "string" ? args.name : "";
      const entry = TOOL_INVENTORY.find((tool) => tool.name === name);
      if (!entry) return { name, registered: false };
      let enabled: boolean | null = null;
      let approval: "auto" | "manual" | null = null;
      if (ws.dispatchOptions.toolPolicyDir) {
        const { loadToolPolicy } = await import("./tool-policy.js");
        const policy = await loadToolPolicy(ws.dispatchOptions.toolPolicyDir, ws.workspaceId);
        enabled = policy.tools[name]?.enabled === true;
        approval = policy.tools[name]?.approval ?? null;
      }
      return {
        name,
        registered: true,
        group: entry.group,
        conditional: entry.conditional,
        enabled,
        approval,
      };
    }
    case "mcp_self_check":
      return await runtimeMcpSelfCheck(ws);
    case "capability_manifest":
      return capabilityManifest(ws);
    case "git_status": {
      const git = await readGitSnapshot(ws.workspaceRoot);
      if (!git.isRepo) return { isRepo: false };
      return { isRepo: true, branch: git.branch, commit: git.commit, dirty: git.dirty, porcelain: git.porcelain ?? "", remote: git.remote ?? null, upstream: git.upstream ?? null, ahead: git.ahead ?? null, behind: git.behind ?? null };
    }
    case "git_diff":
      return await readGitDiff(args, ws);
    case "git_recent_commits":
      return await readRecentCommits(args, ws);
    case "git_changed_files":
      return await readChangedFiles(args, ws);
    case "git_local_branches":
      return await readLocalBranches(args, ws);
    case "test_inventory":
      return await readTestInventory(args, ws);
    case "test_status":
      return await readTestStatus(ws.executionStore);
    case "execution_summary":
      return await readExecutionSummary(args, ws.executionStore);
    case "execution_output":
      return await readExecutionOutput(args, ws.executionStore);
    case "create_file":
      return await requestCreateIntent(args, ws);
    case "update_file":
      return await requestUpdateIntent(args, ws);
    default:
      throw new McpSecurityError("unknown_tool", `unknown_tool: ${name}`);
  }
}

async function runtimeMcpSelfCheck(ws: WorkspaceContext): Promise<unknown> {
  const rootStat = await fs.stat(ws.workspaceRoot).catch(() => null);
  const writeBridgeAvailable = Boolean(
    ws.dispatchOptions.caller
      && ws.dispatchOptions.writeScopeGranted
      && ws.dispatchOptions.createIntentBridge,
  );
  return {
    ok: Boolean(rootStat?.isDirectory()),
    workspace: {
      exists: Boolean(rootStat?.isDirectory()),
      workspaceId: ws.workspaceId,
      boundaryRealPathResolved: Boolean(ws.boundary.rootReal),
    },
    toolRegistry: {
      readOnlyToolCount: READ_ONLY_TOOL_NAMES.length,
      readOnlyTools: [...READ_ONLY_TOOL_NAMES],
      conditionalWriteTools: [],
      stagedWriteTools: [...STAGED_WRITE_TOOL_NAMES],
      legacyApprovalOnlyTools: ["create_file", "update_file"],
    },
    authorization: {
      callerBound: Boolean(ws.dispatchOptions.caller),
      workspaceWriteScope: ws.dispatchOptions.writeScopeGranted === true,
      createApprovalBridge: Boolean(ws.dispatchOptions.createIntentBridge),
      // 注意：这只表示"工具策略目录存在"，不代表控制通道真的连得上。
      // 真实连通性由写入时的 CONTROL_BRIDGE_UNAVAILABLE 暴露，这里不谎报为 true。
      localWriteApprovalBridgeConfigured: Boolean(ws.dispatchOptions.toolPolicyDir),
      directFilesystemWriterExposed: true,
    },
    safety: {
      sensitivePathBoundary: true,
      outputRedaction: true,
      createRequiresSupervisorApproval: true,
      arbitraryShellExposedByRuntime: false,
      screenRawImageExposedByRuntime: false,
    },
  };
}

function capabilityManifest(ws: WorkspaceContext): unknown {
  const writeBridgeAvailable = Boolean(
    ws.dispatchOptions.caller
      && ws.dispatchOptions.writeScopeGranted
      && ws.dispatchOptions.createIntentBridge,
  );
  return {
    runtimeTools: CAPABILITY_MANIFEST.map((item) => ({ ...item, availability: "AVAILABLE" })),
    conditional: [
      {
        name: "create_file",
        area: "files",
        risk: "LEGACY_APPROVAL_ONLY",
        availability: writeBridgeAvailable ? "APPROVAL_REQUEST_ONLY" : "NOT_AUTHORIZED_OR_NOT_CONNECTED",
        directWrite: false,
        note: "已从 MCP 工具面移除；生产 Writer 未接。写入请用 prepare_write + commit_operation。",
      },
      {
        name: "update_file",
        area: "files",
        risk: "LEGACY_APPROVAL_ONLY",
        availability: writeBridgeAvailable && typeof ws.dispatchOptions.createIntentBridge?.requestUpdateIntent === "function"
          ? "APPROVAL_REQUEST_ONLY"
          : "NOT_AUTHORIZED_OR_NOT_CONNECTED",
        directWrite: false,
        versionBinding: "SHA256",
        note: "已从 MCP 工具面移除；UPDATE Writer 明确未启用。写入请用 prepare_write + commit_operation。",
      },
      {
        name: "commit_operation",
        area: "files",
        risk: "LOCAL_APPROVAL_REQUIRED",
        availability: "AVAILABLE_STAGED_WRITE",
        directWrite: false,
        versionBinding: "SHA256",
        filesPerOperation: 25,
      },
      {
        name: "commit_operations",
        area: "files",
        risk: "LOCAL_APPROVAL_REQUIRED",
        availability: "AVAILABLE_STAGED_WRITE",
        directWrite: false,
        atomicAcrossOperations: false,
      },
    ],
    localDesktopOnly: [
      {
        name: "screen_window_capture_and_annotation",
        availability: "DESKTOP_ONLY",
        reason: "原始屏幕画面不直接暴露给远程 Runtime MCP；需本机逐次确认。",
      },
      {
        name: "fault_repair_actions",
        availability: "DESKTOP_SUPERVISOR_ONLY",
        reason: "修复动作经过 Safety Gate、验证和审计，不作为任意远程命令。",
      },
    ],
    intentionallyUnavailable: [
      {
        name: "shadcn_registry_search_add_init",
        availability: "SAFE_EXECUTOR_NOT_AVAILABLE",
        reason: "本地配置与组件盘点已开放；远程 registry 搜索、add/init 不通过 npx 自动下载或新增任意命令执行后门。",
      },
      {
        name: "atomic_cross_file_transaction",
        availability: "NOT_GUARANTEED",
        reason: "暂存提交逐文件落位并独立读回复核；中途失败尽力回滚，但不承诺跨文件/跨操作的原子事务。",
      },
      {
        name: "remote_mouse_keyboard_control",
        availability: "INTENTIONALLY_DISABLED",
        reason: "屏幕能力不授予远程鼠标键盘控制。",
      },
    ],
  };
}

async function requestUpdateIntent(args: Record<string, unknown>, ws: WorkspaceContext): Promise<McpCreateIntentResult> {
  const caller = ws.dispatchOptions.caller;
  const bridge = ws.dispatchOptions.createIntentBridge;
  if (!caller || !bridge || typeof bridge.requestUpdateIntent !== "function"
    || !isSafeCallerClientId(caller.clientId) || !isCorrelatedRequestId(caller.requestId)) {
    throw new McpSecurityError("write_disabled", "MCP UPDATE approval bridge is unavailable");
  }
  if (!ws.dispatchOptions.writeScopeGranted) {
    throw new McpSecurityError("insufficient_scope", "MCP UPDATE requires workspace.write");
  }
  if (typeof args.path !== "string" || typeof args.content !== "string") {
    throw new McpSecurityError("update_intent_invalid_argument");
  }
  const relativePath = args.path;
  if (!relativePath.trim() || relativePath !== relativePath.trim()
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new McpSecurityError("update_intent_path_invalid");
  }
  const resolved = await ws.boundary.resolveWorkspacePath(relativePath);
  ws.boundary.assertReadable(resolved);
  if (resolved.relative === ".") throw new McpSecurityError("update_intent_path_invalid");
  const stat = await fs.lstat(resolved.absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    throw new McpSecurityError("update_intent_target_unavailable");
  }
  const before = await fs.readFile(resolved.absolute);
  let expectedTargetSha256: string;
  try {
    if (isLikelyBinary(resolved.relative, before)) throw new McpSecurityError("binary_file_denied");
    expectedTargetSha256 = createHash("sha256").update(before).digest("hex");
    const next = Buffer.from(args.content, "utf8");
    try {
      if (args.content.includes("\0") || next.byteLength > MAX_FILE_BYTES || next.toString("utf8") !== args.content) {
        throw new McpSecurityError("update_intent_content_invalid");
      }
      if (createHash("sha256").update(next).digest("hex") === expectedTargetSha256) {
        throw new McpSecurityError("update_intent_no_op");
      }
    } finally {
      next.fill(0);
    }
  } finally {
    before.fill(0);
  }

  let result: McpCreateIntentResult;
  try {
    result = await bridge.requestUpdateIntent({
      caller: { clientId: caller.clientId, requestId: caller.requestId },
      intent: {
        operation: "UPDATE",
        relativePath: resolved.relative,
        content: args.content,
        expectedTargetSha256,
      },
    });
  } catch (error) {
    if (!ws.dispatchOptions.bridgeFailureDiagnostics) {
      throw new McpSecurityError("update_intent_bridge_failed");
    }
    throw new McpSecurityError(`update_intent_bridge_failed:${classifyCreateIntentBridgeFailure(error)}`);
  }
  if (!result || (result.status !== "PENDING" && result.status !== "REJECTED")) {
    throw new McpSecurityError("update_intent_bridge_response_invalid");
  }
  if (result.status === "REJECTED") return { status: "REJECTED" };
  if (typeof result.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(result.requestId)) {
    throw new McpSecurityError("update_intent_bridge_response_invalid");
  }
  return { status: "PENDING", requestId: result.requestId };
}

async function requestCreateIntent(args: Record<string, unknown>, ws: WorkspaceContext): Promise<McpCreateIntentResult> {
  const caller = ws.dispatchOptions.caller;
  const bridge = ws.dispatchOptions.createIntentBridge;
  if (!caller || !bridge || !isSafeCallerClientId(caller.clientId) || !isCorrelatedRequestId(caller.requestId)) {
    throw new McpSecurityError("write_disabled", "MCP CREATE approval bridge is unavailable");
  }
  if (!ws.dispatchOptions.writeScopeGranted) {
    throw new McpSecurityError("insufficient_scope", "MCP CREATE requires workspace.write");
  }
  if (typeof args.path !== "string" || typeof args.content !== "string") {
    throw new McpSecurityError("create_intent_invalid_argument");
  }
  const relativePath = args.path;
  if (!relativePath.trim() || relativePath !== relativePath.trim()
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
    throw new McpSecurityError("create_intent_path_invalid");
  }
  const resolved = await ws.boundary.resolveWorkspacePath(relativePath, { allowMissing: true });
  ws.boundary.assertReadable(resolved);
  if (resolved.relative === ".") throw new McpSecurityError("create_intent_path_invalid");
  if (resolved.exists) throw new McpSecurityError("create_intent_target_exists");
  const parent = await fs.stat(path.dirname(resolved.absolute)).catch(() => null);
  if (!parent?.isDirectory()) throw new McpSecurityError("create_intent_parent_unavailable");
  if (args.content.includes("\0") || Buffer.byteLength(args.content, "utf8") > MAX_FILE_BYTES) {
    throw new McpSecurityError("create_intent_content_invalid");
  }

  let result: McpCreateIntentResult;
  try {
    result = await bridge.requestCreateIntent({
      caller: { clientId: caller.clientId, requestId: caller.requestId },
      intent: { operation: "CREATE", relativePath: resolved.relative, content: args.content },
    });
  } catch (error) {
    if (!ws.dispatchOptions.bridgeFailureDiagnostics) {
      throw new McpSecurityError("create_intent_bridge_failed");
    }
    throw new McpSecurityError(`create_intent_bridge_failed:${classifyCreateIntentBridgeFailure(error)}`);
  }
  if (!result || (result.status !== "PENDING" && result.status !== "REJECTED")) {
    throw new McpSecurityError("create_intent_bridge_response_invalid");
  }
  if (result.status === "REJECTED") return { status: "REJECTED" };
  if (typeof result.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(result.requestId)) {
    throw new McpSecurityError("create_intent_bridge_response_invalid");
  }
  return { status: "PENDING", requestId: result.requestId };
}

function classifyCreateIntentBridgeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const rejected = /^runtime_supervisor_bridge_supervisor_rejected:([A-Z][A-Z0-9_]{1,79})$/.exec(message);
  if (rejected) return `SUPERVISOR_VALIDATION:${rejected[1]}`;
  if (message === "runtime_supervisor_bridge_timeout") return "TIMEOUT";
  if (/runtime_supervisor_bridge_(?:request_invalid|response_invalid|frame_too_large)/.test(message)) return "PROTOCOL";
  if (message === "runtime_supervisor_bridge_request_rejected") return "SUPERVISOR_REJECTED";
  return "TRANSPORT";
}

function isSafeCallerClientId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isCorrelatedRequestId(value: unknown): value is string | number {
  return typeof value === "string" ? value.length >= 1 && value.length <= 128
    : typeof value === "number" && Number.isSafeInteger(value);
}

async function directoryTree(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const start = await ws.boundary.resolveWorkspacePath(typeof args.path === "string" ? args.path : ".");
  ws.boundary.assertReadable(start);
  if (!(await fs.stat(start.absolute)).isDirectory()) throw new McpSecurityError("not_a_directory");
  const maxDepth = ws.boundary.limit(args.max_depth, 3, 5);
  const maxEntries = ws.boundary.limit(args.max_entries, 200, 500);
  const entries: Array<{ path: string; type: "directory" | "file"; depth: number }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || entries.length >= maxEntries) return;
    const found = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of found.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= maxEntries) break;
      if (item.isSymbolicLink() || isSkippableDirectory(item.name)) continue;
      const absolute = path.join(dir, item.name);
      const relative = path.relative(ws.boundary.rootReal, absolute).replaceAll("\\", "/");
      if (ws.boundary.sensitivePaths.isSensitive(relative)) continue;
      if (!item.isDirectory() && !item.isFile()) continue;
      entries.push({ path: relative, type: item.isDirectory() ? "directory" : "file", depth });
      if (item.isDirectory() && depth < maxDepth) await walk(absolute, depth + 1);
    }
  }
  await walk(start.absolute, 1);
  return { root: start.relative, entries, count: entries.length, truncated: entries.length >= maxEntries };
}

async function readBoundedOrdinaryFile(input: unknown, ws: WorkspaceContext): Promise<{ relative: string; bytes: Buffer }> {
  if (typeof input !== "string" || !input.trim()) throw new McpSecurityError("path_required");
  const resolved = await ws.boundary.resolveWorkspacePath(input);
  ws.boundary.assertReadable(resolved);
  const stat = await fs.lstat(resolved.absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new McpSecurityError("not_a_regular_file");
  if (stat.size > MAX_FILE_BYTES) throw new McpSecurityError("file_too_large");
  const bytes = await fs.readFile(resolved.absolute);
  if (bytes.length > MAX_FILE_BYTES || isLikelyBinary(resolved.relative, bytes)) throw new McpSecurityError("binary_file_denied");
  return { relative: resolved.relative, bytes };
}

async function searchFileNames(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 120) throw new McpSecurityError("invalid_filename_query");
  const start = await ws.boundary.resolveWorkspacePath(typeof args.path === "string" ? args.path : ".");
  ws.boundary.assertReadable(start);
  if (!(await fs.stat(start.absolute)).isDirectory()) throw new McpSecurityError("not_a_directory");
  const query = args.query.toLocaleLowerCase();
  const limit = ws.boundary.limit(args.limit, 50, 100);
  const matches: Array<{ path: string; type: "file" | "directory" }> = [];
  let visited = 0;
  async function walk(dir: string): Promise<void> {
    if (visited >= 3000 || matches.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (visited >= 3000 || matches.length >= limit) break;
      visited++;
      if (entry.isSymbolicLink() || isSkippableDirectory(entry.name)) continue;
      const candidate = path.join(dir, entry.name);
      const relative = path.relative(ws.boundary.rootReal, candidate).replaceAll("\\", "/");
      if (ws.boundary.sensitivePaths.isSensitive(relative)) continue;
      if (entry.name.toLocaleLowerCase().includes(query)) matches.push({ path: relative, type: entry.isDirectory() ? "directory" : "file" });
      if (entry.isDirectory()) await walk(candidate);
    }
  }
  await walk(start.absolute);
  return { query: args.query, matches, count: matches.length, scannedEntries: visited, truncated: visited >= 3000 || matches.length >= limit };
}

async function searchWorkspace(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const query = String(args.query ?? "");
  if (!query || query.length > 500) throw new McpSecurityError("missing_or_invalid_query");
  const mode = args.mode === "regex" ? "regex" : "literal";
  let matcher: RegExp | null = null;
  if (mode === "regex") {
    try { matcher = new RegExp(query, typeof args.flags === "string" ? args.flags : ""); }
    catch { throw new McpSecurityError("invalid_search_regex"); }
  }
  const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : null;
  const limit = ws.boundary.limit(args.limit, 50, MAX_SEARCH_RESULTS);
  const offset = ws.boundary.limit(args.offset, 0, Number.MAX_SAFE_INTEGER);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let matchedCount = 0;
  let visitedFiles = 0;

  async function walk(directory: string): Promise<void> {
    if (matches.length >= limit) return;
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (matches.length >= limit) return;
      if (entry.isDirectory() && isSkippableDirectory(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(ws.boundary.rootReal, candidate).replaceAll("\\", "/");
      if (glob && !matchesGlob(relative, glob)) {
        if (entry.isDirectory()) await walk(candidate);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(candidate);
        continue;
      }
      if (!entry.isFile() || ws.boundary.sensitivePaths.isSensitive(relative)) continue;
      const resolved = await ws.boundary.resolveWorkspacePath(relative);
      const stat = await fs.stat(resolved.absolute);
      if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
      visitedFiles += 1;
      const bytes = await fs.readFile(resolved.absolute);
      if (isLikelyBinary(relative, bytes)) continue;
      const lines = bytes.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const found = matcher ? (matcher.lastIndex = 0, matcher.test(line)) : line.toLocaleLowerCase().includes(query.toLocaleLowerCase());
        if (!found) continue;
        if (matchedCount >= offset) matches.push({ path: relative, line: index + 1, text: line });
        matchedCount += 1;
        if (matches.length >= limit) return;
      }
    }
  }

  await walk(ws.boundary.rootReal);
  return {
    query,
    mode,
    glob,
    count: matches.length,
    totalSeen: matchedCount,
    offset,
    nextOffset: matches.length === limit ? offset + matches.length : null,
    hasMore: matches.length === limit,
    visitedFiles,
    matches,
  };
}

function matchesGlob(value: string, glob: string): boolean {
  let pattern = "^";
  const normalized = glob.replaceAll("\\", "/");
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? "";
    if (char === "*" && normalized[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
    }
  }
  return new RegExp(`${pattern}$`, "i").test(value.replaceAll("\\", "/"));
}

async function readGitSnapshot(root: string): Promise<GitSnapshot> {
  const probe = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ok || probe.stdout.trim() !== "true") return { isRepo: false, branch: null, commit: null, dirty: null };
  const branch = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = await runGit(root, ["rev-parse", "HEAD"]);
  const status = await runGit(root, ["status", "--porcelain"]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() || null : null,
    commit: commit.ok ? commit.stdout.trim() || null : null,
    dirty: status.ok ? Boolean(status.stdout.trim()) : null,
    porcelain: status.ok ? status.stdout.slice(0, 20_000) : "",
  };
}

async function readLocalBranches(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const git = await readGitSnapshot(ws.workspaceRoot);
  if (!git.isRepo) return { isRepo: false, branches: [] };
  const limit = Math.max(1, ws.boundary.limit(args.limit, 50, 100));
  const output = await runGit(ws.workspaceRoot, ["branch", "--list", "--format=%(refname:short)", "--no-color"], 40_000);
  if (!output.ok) throw new McpSecurityError("git_branches_failed");
  const branches = output.stdout.split(/\r?\n/).filter(Boolean)
    .slice(0, limit).map((branch) => branch.slice(0, 150));
  return { isRepo: true, activeBranch: git.branch, branches, count: branches.length,
    truncated: output.stdout.split(/\r?\n/).filter(Boolean).length > limit };
}

async function readTestInventory(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const resolved = await ws.boundary.resolveWorkspacePath(typeof args.path === "string" ? args.path : ".");
  ws.boundary.assertReadable(resolved);
  if (!(await fs.stat(resolved.absolute)).isDirectory()) throw new McpSecurityError("not_a_directory");
  let scripts: string[] = [];
  const packageFile = path.join(resolved.absolute, "package.json");
  try {
    const packagePath = await ws.boundary.resolveWorkspacePath(path.relative(ws.workspaceRoot, packageFile));
    ws.boundary.assertReadable(packagePath);
    const stat = await fs.stat(packagePath.absolute);
    if (stat.isFile() && stat.size < 100_000) {
      const data: unknown = JSON.parse(await fs.readFile(packagePath.absolute, "utf8"));
      if (data && typeof data === "object" && "scripts" in data) {
        const map = (data as { scripts?: unknown }).scripts;
        if (map && typeof map === "object" && !Array.isArray(map)) {
          scripts = Object.keys(map).filter((name) => /^(test|lint|build|typecheck)(:|$)/.test(name)).slice(0, 50);
        }
      }
    }
  } catch { /* No package.json or unreadable: inventory remains empty. */ }
  const testFiles: string[] = [];
  let scanned = 0;
  const maxScanned = 2000;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 5 || scanned >= maxScanned || testFiles.length >= 100) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (scanned >= maxScanned || testFiles.length >= 100) break;
      scanned++;
      if (entry.isSymbolicLink() || isSkippableDirectory(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(ws.workspaceRoot, candidate).replaceAll("\\", "/");
      if (ws.boundary.sensitivePaths.isSensitive(relative)) continue;
      if (entry.isDirectory()) await walk(candidate, depth + 1);
      else if (entry.isFile() && /(?:^|[.\\/])(?:test|spec)(?:[.\\/]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        testFiles.push(relative);
      }
    }
  }
  await walk(resolved.absolute, 0);
  return { root: resolved.relative, npmScriptNames: scripts, testFiles,
    scannedEntries: scanned, truncated: scanned >= maxScanned || testFiles.length >= 100,
    execution: "NOT_EXECUTED" };
}

async function readRecentCommits(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const git = await readGitSnapshot(ws.workspaceRoot);
  if (!git.isRepo) return { isRepo: false, records: [] };
  const limit = Math.max(1, ws.boundary.limit(args.limit, 10, 30));
  const output = await runGit(ws.workspaceRoot, [
    "-c", "core.pager=cat", "log", "--no-show-signature", "--format=%H%x1f%cs%x1f%s%x1e",
    "-n", String(limit),
  ], 100_000);
  if (!output.ok) throw new McpSecurityError("git_log_failed");
  const records = output.stdout.split("\x1e").filter((item) => item.trim().length > 0).slice(0, limit).map((item) => {
    const [commit, date, ...subject] = item.trim().split("\x1f");
    return { commit: /^[a-f0-9]{40,64}$/.test(commit ?? "") ? commit : null, date: /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date : null, subject: subject.join(" ").slice(0, 300) };
  });
  return { isRepo: true, records };
}

async function readChangedFiles(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const git = await readGitSnapshot(ws.workspaceRoot);
  if (!git.isRepo) return { isRepo: false, scope: "unstaged", paths: [] };
  const scope = args.scope === "staged" ? "staged" : "unstaged";
  const commands = scope === "staged"
    ? ["diff", "--cached", "--name-only", "-z", "--no-ext-diff"]
    : ["diff", "--name-only", "-z", "--no-ext-diff"];
  const output = await runGit(ws.workspaceRoot, commands, 300_000);
  if (!output.ok) throw new McpSecurityError("git_changed_files_failed");
  const paths = output.stdout.split("\0")
    .filter((item) => item && !ws.boundary.sensitivePaths.isSensitive(item))
    .slice(0, 250);
  return { isRepo: true, scope, paths, count: paths.length, truncated: output.stdout.split("\0").length - 1 > 250 };
}

async function readGitDiff(args: Record<string, unknown>, ws: WorkspaceContext): Promise<unknown> {
  const git = await readGitSnapshot(ws.workspaceRoot);
  if (!git.isRepo) return { isRepo: false, scope: "unstaged", diff: "", offset: 0, nextOffset: null, truncated: false };
  const scope = args.scope === "staged" || args.scope === "head" ? args.scope : "unstaged";
  const gitArgs = scope === "staged"
    ? ["diff", "--cached", "--no-ext-diff", "--unified=3"]
    : scope === "head"
      ? ["diff", "HEAD", "--no-ext-diff", "--unified=3"]
      : ["diff", "--no-ext-diff", "--unified=3"];
  const output = await runGit(ws.workspaceRoot, gitArgs, MAX_DIFF_BYTES + 256_000);
  if (!output.ok) throw new McpSecurityError("git_diff_failed");
  const safeDiff = redactSensitiveDiff(output.stdout, ws.boundary);
  const bytes = Buffer.from(safeDiff, "utf8");
  const maxBytes = ws.boundary.limit(args.max_bytes, 200_000, MAX_DIFF_BYTES);
  const offset = ws.boundary.limit(args.offset, 0, bytes.length);
  const chunk = bytes.subarray(offset, offset + maxBytes).toString("utf8");
  const emittedBytes = Buffer.byteLength(chunk, "utf8");
  return {
    isRepo: true,
    scope,
    diff: chunk,
    offset,
    nextOffset: offset + emittedBytes < bytes.length ? offset + emittedBytes : null,
    truncated: offset + emittedBytes < bytes.length,
  };
}

function redactSensitiveDiff(diff: string, boundary: McpSecurityBoundary): string {
  const lines = diff.split(/\r?\n/);
  const output: string[] = [];
  let sensitive = false;
  let markerWritten = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const file = line.match(/ b\/(.+)$/)?.[1] ?? "";
      sensitive = boundary.sensitivePaths.isSensitive(file);
      markerWritten = false;
    }
    if (sensitive) {
      if (!markerWritten) {
        output.push("[REDACTED:sensitivePathDiff]");
        markerWritten = true;
      }
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

async function readTestStatus(store: ExecutionRecordStore): Promise<unknown> {
  const record = await store.latestTest();
  if (!record) return { available: true, status: "NO_RECORD", timestamp: null, tests: [], source: "execution-store" };
  const testCount = record.tests.reduce((sum, item) => sum + (item.testCount ?? 1), 0);
  const failedCount = record.tests.reduce((sum, item) => sum + (item.failedCount ?? (item.passed ? 0 : 1)), 0);
  return {
    available: true,
    status: record.status,
    timestamp: record.timestamp,
    commandCategory: record.tests.map((item) => item.category),
    testCount,
    failedCount,
    source: "execution-store",
  };
}

function summaryRecord(record: ExecutionRecord): Record<string, unknown> {
  return {
    id: record.id,
    taskId: record.taskId,
    iteration: record.iteration,
    timestamp: record.timestamp,
    changedFiles: record.changedFiles,
    tests: record.tests,
    status: record.status,
    summary: record.summary,
    // Public availability is metadata only. Never include allowedOutput here;
    // callers must still use execution_output for the bounded public payload.
    publicOutput: record.publicOutput && Boolean(record.allowedOutput),
  };
}

async function readExecutionSummary(args: Record<string, unknown>, store: ExecutionRecordStore): Promise<unknown> {
  const limit = Math.max(1, Math.min(20, typeof args.limit === "number" ? Math.floor(args.limit) : 10));
  const records = await store.recent(limit);
  return { available: true, source: "execution-store", records: records.map(summaryRecord) };
}

async function readExecutionOutput(args: Record<string, unknown>, store: ExecutionRecordStore): Promise<unknown> {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) throw new McpSecurityError("execution_id_required");
  const publicRecord = await store.publicOutput(id);
  if (!publicRecord) throw new McpSecurityError("execution_output_not_registered");
  return {
    available: true,
    source: "execution-store",
    id,
    output: publicRecord.output,
  };
}

async function runGit(root: string, args: string[], maxBuffer = 1_500_000): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer,
      windowsHide: true,
    });
    return { ok: true, stdout: String(result.stdout ?? "") };
  } catch {
    return { ok: false, stdout: "" };
  }
}


