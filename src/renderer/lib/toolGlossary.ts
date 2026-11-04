/**
 * 工具中文注解表
 *
 * 我们自己的 36 个工具在 /tools 里已带中文 description；
 * 但 Legacy MCP（对方产品）的 51 个工具只有英文描述。
 * 为了保证界面上"每个工具都看得懂在干什么"，这里做一份中文对照。
 *
 * 命中则用中文，未命中回退到服务自带的英文描述。
 */
export interface ToolGlossaryEntry {
  zh: string;
  group: string;
}

export const TOOL_GLOSSARY: Record<string, ToolGlossaryEntry> = {
  // ---- 设置 / 发现 ----
  get_mcp_app_settings: { zh: "返回这个 MCP 服务给 ChatGPT 用的连接器配置（名称、说明、URL、认证方式）。", group: "设置" },
  list_roots: { zh: "列出已授权可访问的文件夹及其读写级别。", group: "设置" },
  mcp_self_check: { zh: "自检：确认服务自身的关键开关与能力边界。", group: "自检" },
  verify_tool_registered: { zh: "核验某个工具是否真的注册在服务里。", group: "自检" },

  // ---- 读取 ----
  list_directory: { zh: "列出某个目录下的文件与子目录，不返回文件内容。", group: "读取" },
  read_file: { zh: "读取单个文本文件的内容（有大小上限）。", group: "读取" },
  search_files: { zh: "按文件名或通配符查找文件。", group: "读取" },
  search: { zh: "在授权目录内按关键字搜索文件内容。", group: "读取" },
  fetch: { zh: "只读抓取白名单域名下的文本 URL（https、限额、逐跳校验）。", group: "联网" },
  batch_read_files: { zh: "一次读取多个文件，减少往返次数。", group: "读取" },
  batch_file_status: { zh: "批量查询多个文件是否存在、大小与修改时间。", group: "读取" },

  // ---- 写入 / 审批 ----
  prepare_write: { zh: "预演一次写入：先算好差异与校验值，不真正落盘。", group: "写入" },
  batch_prepare_write: { zh: "批量写入预演：一次准备多个文件的改动计划。", group: "写入" },
  list_pending_operations: { zh: "列出还没提交的写入草稿（只有路径与哈希，没有正文）。", group: "写入" },
  cancel_pending_operation: { zh: "丢弃一笔还没提交的写入草稿，不改动任何文件。", group: "写入" },
  commit_operation: { zh: "提交并真正写入某一笔已暂存的操作（本机确认后落盘并读回校验）。", group: "写入" },
  commit_operations: { zh: "按顺序提交多笔已暂存的操作，逐笔报告成功或阻塞。", group: "写入" },
  write_file: { zh: "直接写入文件内容（危险模式下免逐次确认）。", group: "写入" },
  batch_replace_text: { zh: "暂存批量精确替换：每个查找串必须只命中一次，预演不落盘。", group: "写入" },
  prepare_project_scaffold: { zh: "暂存项目骨架（PROJECT/LLM/STATUS/.brainn），预演不落盘。", group: "写入" },

  // ---- 项目 / 产物 ----
  project_snapshot: { zh: "生成项目快照：目录结构、关键文件、体积概览。", group: "项目" },
  batch_search_patterns: { zh: "用多个搜索模式一次性搜索并汇总命中。", group: "项目" },
  audit_project_structure: { zh: "审计项目结构是否规范（入口、配置、测试等）。", group: "项目" },
  generate_project_inventory: { zh: "生成项目清单：文件分类与数量统计。", group: "项目" },
  detect_archive_candidates: { zh: "找出可以归档的临时文件与构建残留。", group: "项目" },
  list_artifacts: { zh: "列出已产出的报告、日志等产物文件。", group: "产物" },
  read_latest_report: { zh: "读取最近一次生成的报告内容。", group: "产物" },

  // ---- Git ----
  git_status: { zh: "显示 git 状态：当前分支与改动文件。", group: "Git" },
  git_diff: { zh: "查看未提交改动的 diff 内容。", group: "Git" },
  git_recent_commits: { zh: "列出最近若干条提交记录。", group: "Git" },
  git_changed_files: { zh: "列出相对某个基线发生变化的文件。", group: "Git" },
  git_local_branches: { zh: "列出本地分支。", group: "Git" },

  // ---- 测试 ----
  test_inventory: { zh: "盘点项目里的测试文件与用例数量。", group: "测试" },
  test_status: { zh: "读取最近一次测试状态（只读，不执行测试）。", group: "测试" },

  // ---- 执行 ----
  execution_summary: { zh: "汇总本机记录的执行结果。", group: "执行" },
  execution_output: { zh: "按编号读取某次执行的脱敏输出。", group: "执行" },

  // ---- 工作流 ----
  workflow_prepare: { zh: "登记只读工作流计划（名称/目标/动作/预算），不执行工具。", group: "工作流" },
  workflow_commit: { zh: "本机确认后激活计划，只开始记录进度，不授予其它权限。", group: "工作流" },
  workflow_status: { zh: "查看工作流阶段、预算使用与步骤摘要。", group: "工作流" },
  workflow_cancel: { zh: "取消自己的计划；不删除文件、不停止服务。", group: "工作流" },
  workflow_continue: { zh: "记录一步进度与预算消耗，超预算或出错即停止。", group: "工作流" },
  workflow_run_step: { zh: "在已激活的只读计划里真正执行一步，并消耗一次预算。", group: "工作流" },

  // ---- 屏幕 ----
  screen_list_windows: { zh: "列出当前桌面上的可见窗口（标题与句柄）。", group: "屏幕" },
  screen_capture_once: { zh: "截取一次屏幕（单次，不持续）。", group: "屏幕" },
  screen_capture_active_window: { zh: "截取当前活动窗口。", group: "屏幕" },
  screen_capture_window: { zh: "截取指定的某一个窗口。", group: "屏幕" },
  screen_capture_windows: { zh: "一次截取多个指定窗口。", group: "屏幕" },
  screen_select_latest: { zh: "把最近一次截图标记为当前使用的那张。", group: "屏幕" },
  screen_get_latest_frame: { zh: "取回最近一次截图的画面数据。", group: "屏幕" },
  screen_export_latest_image: { zh: "把最近一次截图导出成图片文件。", group: "屏幕" },
  screen_export_latest_artifact_code: { zh: "把最近截图导出成便于嵌入的代码片段。", group: "屏幕" },
  screen_latest_image_url: { zh: "给出最近一次截图的访问地址。", group: "屏幕" },
  delete_file: { zh: "删除文件：先备份、校验 SHA 与硬链接。", group: "写入" },
  move_file: { zh: "移动/重命名文件：先备份，目标必须不存在。", group: "写入" },
  apply_patch: { zh: "精确文本替换：每个查找串必须唯一命中，写前备份。", group: "写入" },
  execute_command: { zh: "运行白名单项目命令，无 shell，超时/输出受限。", group: "命令" },
  run_command: { zh: "execute_command 的别名。", group: "命令" },
  run_powershell: { zh: "当前用户权限的 PowerShell，无沙箱、单独开关。", group: "命令" },
  git_commit: { zh: "提交已暂存改动，不 add、不 push。", group: "命令" },
  screen_annotate_latest_image: { zh: "在最近一次截图上添加标注（框、箭头、文字）。", group: "屏幕" },
  screen_export_annotated_image: { zh: "把标注后的截图导出成图片文件。", group: "屏幕" },
  screen_export_annotated_artifact_code: { zh: "把标注后的截图导出成便于嵌入的代码片段。", group: "屏幕" },
  screen_annotated_image_url: { zh: "给出标注后截图的访问地址。", group: "屏幕" },

  // ---- 组件（shadcn）----
  shadcn_info: { zh: "查看本项目是否使用 shadcn/ui 及版本信息。", group: "组件" },
  shadcn_search: { zh: "只读检索官方 shadcn Registry 的组件元数据。", group: "组件" },
  shadcn_view: { zh: "查看组件的依赖、文件与文档链接；不返回源码。", group: "组件" },
  shadcn_add: { zh: "安装组件：预演候选文件；dry_run:false 暂存官方源码，commit 后落盘。", group: "组件" },
  shadcn_init: { zh: "暂存 components.json 与 utils.ts，commit 后落盘（不执行 CLI）。", group: "组件" },
  shadcn_local_components: { zh: "列出本地已安装的 shadcn 组件。", group: "组件" },

  // ---- 我们自己的补充（同名时保持中文一致）----
  workspace_info: { zh: "返回当前工作区身份、根目录与边界是否已解析。", group: "工作区" },
  search_workspace: { zh: "在工作区内按关键字搜索文件名与内容。", group: "搜索" },
  file_metadata: { zh: "查看文件大小、修改时间等元数据。", group: "文件" },
  directory_tree: { zh: "输出目录树结构，便于把握项目骨架。", group: "文件" },
  file_sha256: { zh: "计算文件 SHA256，用于校验内容是否变化。", group: "文件" },
  compare_files: { zh: "比较两个文件是否相同（按哈希或内容）。", group: "文件" },
  csv_preview: { zh: "预览 CSV 前若干行，识别分隔符与表头。", group: "数据" },
  csv_schema_diff: { zh: "比较两个 CSV 的列结构差异。", group: "数据" },
  prepare_batch_write_plan: { zh: "为批量写入生成计划与 SHA 预检，不直接落盘。", group: "批量" },
  capability_manifest: { zh: "返回能力分层：只读、需审批写入、不可用项。", group: "自检" },
  create_file: { zh: "已从工具面移除；请改用 prepare_write + commit_operation。", group: "写入" },
  update_file: { zh: "已从工具面移除；请改用 prepare_write + commit_operation。", group: "写入" },
};

export function annotateTool(
  name: string,
  fallbackDescription: string,
  fallbackGroup: string,
): { zh: string; group: string; isFallback: boolean } {
  const hit = TOOL_GLOSSARY[name];
  if (hit) return { zh: hit.zh, group: hit.group, isFallback: false };
  return { zh: fallbackDescription, group: fallbackGroup, isFallback: true };
}

