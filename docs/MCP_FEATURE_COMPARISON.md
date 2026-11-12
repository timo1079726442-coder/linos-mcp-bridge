# MCP 竞品功能对比与借鉴记录（v0.1.2 方向）

目的：回答"GitHub 上有没有更好用的 MCP 工具、有没有值得复刻的能力"。
方法：用 GitHub 官方检索与仓库元数据（星数 / 许可证 / 语言）取真实数据，再逐项对照本项目的能力面。

**许可证前提**：下表均为宽松许可证（MIT / Apache-2.0 / 项目自带条款），本文只做**功能面的独立实现**，不复制对方源码；实现细节由本项目自行设计并用本项目测试覆盖。

---

## 1. 调研数据（2026-11-07，GitHub API）

| 项目 | 星数 | 许可证 | 语言 | 定位 |
|---|---|---|---|---|
| `modelcontextprotocol/servers` | 91,845 | 见各子目录 | TypeScript | 官方参考服务器集合（filesystem / git / fetch / memory…） |
| `punkpeye/awesome-mcp-servers` | 97,407 | MIT | — | 索引清单，非实现 |
| `microsoft/playwright-mcp` | 39,289 | Apache-2.0 | TypeScript | 浏览器自动化（可访问性快照驱动） |
| `github/github-mcp-server` | 34,296 | MIT | Go | GitHub 官方 MCP |
| `oraios/serena` | 31,170 | 见仓库 | Python | 语义代码检索/编辑（LSP 级） |
| `CursorTouch/Windows-MCP` | 11,219 | MIT | Python | Windows UI 自动化 |
| `wonderwhy-er/DesktopCommanderMCP` | 10,242 | MIT | JavaScript | 本机终端/文件/进程控制，**与本项目最接近** |
| `executeautomation/mcp-playwright` | 5,678 | MIT | TypeScript | 浏览器自动化（另一实现） |

> 结论：与本项目定位（本机文件 + 命令 + 审计 + 控制中心）最可比的是 **DesktopCommanderMCP**；`playwright-mcp` 是能力扩展方向而非竞品；`serena` 是代码语义方向。

---

## 2. 功能差距（DesktopCommanderMCP vs 本项目）

| 能力 | DesktopCommanderMCP | 本项目 v0.1.1 | 是否值得借鉴 |
|---|---|---|---|
| 一次性命令执行 | ✅ | ✅ `run_command` / `run_powershell` | — |
| **交互式进程（stdin 会话）** | ✅ `start_process` / `interact_with_process` | ❌ 只有一次性/后台任务 | **是（已实现）** |
| **输出分页 + 从末尾读取** | ✅ offset/length | ⚠️ 有正向分页，无 tail | **是（已实现）** |
| **文件尾部读取（负偏移）** | ✅ | ❌ | **是（已实现）** |
| 按行缓冲输出 | ✅ | ✅ 已有（避免半行粘连） | — |
| 进程列表/终止 | ✅ | ✅ `job_list` / `job_cancel` | — |
| 局部文本替换（surgical edit） | ✅ `edit_block`（模糊匹配 + diff） | ⚠️ 只有整文件两阶段写入 + 批量精确替换 | **是（下一优先级）** |
| 内存中执行代码（Python/Node/R） | ✅ | ❌ | 否：与"可审计、最小权限"冲突，需沙箱设计 |
| Excel/PDF/DOCX 读写 | ✅ | ❌ | 否：超出本项目边界（有独立 office 工具链） |
| 本地调用历史 | ✅ `get_recent_tool_calls` | ✅ 审计日志 + `/admin/tool-audit`（更强：哈希链） | — |
| 配置热更新 | ✅ | ⚠️ 部分（工具策略可改） | 暂不 |
| 符号链接穿越防护 | ✅ | ✅ 已有 | — |
| **写操作二阶段确认 + 哈希链审计** | ❌ | ✅ | 本项目优势，保持 |
| **失败关闭审计（审计不可写则拒绝执行）** | ❌ | ✅ | 本项目优势，保持 |
| **SSRF 地址绑定** | ❌ 无此工具 | ✅ | 本项目优势，保持 |

---

## 3. 本轮已复刻的功能（独立实现）

### 3.1 `job_input`：向交互式任务写入 stdin

对应 DesktopCommanderMCP 的 `interact_with_process`。本项目实现要点：

| 设计点 | 做法 | 理由 |
|---|---|---|
| 显式开启 | `start_job` 新增 `interactive: true` | 默认任务行为完全不变（不保持 stdin 语义） |
| 归属校验 | 校验 clientId + workspaceId | 与其它 job 工具一致，不能跨客户端/工作区写别人进程 |
| 状态校验 | 仅 `RUNNING` 可写 | 否则明确报 `JOB_NOT_RUNNING` |
| 非交互任务 | 明确拒绝 `JOB_NOT_INTERACTIVE` | 避免误以为写进了某个进程 |
| 字节上限 | 单次 8KB | 防止把整份文件塞进交互进程 |
| 审计 | 列入高风险审计集合（`job_input`） | 写 stdin 等于影响执行，需先落审计意图 |
| 审批 | `approval: "manual"` | 默认需要本机确认 |

### 3.2 负偏移读取（tail）

| 工具 | 参数 | 语义 |
|---|---|---|
| `read_file` | `start_line: -200` | 最后 200 行；超过总行数则从头开始，不报错；返回 `tail: true` |
| `job_output` | `offset: -4096` | 最后 4KB；返回 `tail: true` 与换算后的绝对 `offset` |

两者都保留原有正数语义，返回结构只新增字段，不破坏调用方。

---

### 3.3 `prepare_edit`：模糊块替换（对应 `edit_block`）

| 设计点 | 做法 | 理由 |
|---|---|---|
| 匹配粒度 | **行边界对齐**，不用任意子串模糊 | 避免改到不该改的位置 |
| 空白容忍 | 每行折叠为"去首尾空白 + 内部连续空白压成一个空格"再比较 | AI 给的块常与文件缩进/行尾不一致 |
| 唯一性 | 命中 0 → `EDIT_NOT_FOUND`；≥2 → `EDIT_NOT_UNIQUE` | 与既有 `batch_replace_text` 的"必须唯一"一致 |
| 缩进继承 | 替换内容首行无缩进时，继承被替换块首行缩进 | 避免"传入片段行导致代码顶格" |
| 换行保持 | 被替换块以换行结尾时，替换内容自动补回换行 | 避免下一行被拼接到替换内容后 |
| 二阶段 | 复用 `prepareFiles` 暂存，仍由 `commit_operation` 落盘 | 保留版本校验、本机确认、审计 |

返回 `preview`（被删块 + 新块，最多 20 行），供人工确认时直接看差异。

---

## 4. 测试

新增 `runtime/test/ux-parity.test.js`（7 项）：

| 用例 | 覆盖 |
|---|---|
| interactive 任务 `job_input` 回读输出 | 端到端 |
| 多轮输入驱动同一进程（REPL 语义） | 21 → 42、50 → 100 |
| `newline: false` 字节数精确 | 不追加换行 |
| 空输入拒绝 | `JOB_INPUT_EMPTY` |
| 非 interactive 拒绝 | `JOB_NOT_INTERACTIVE` |
| 结束后写入拒绝 | `JOB_NOT_RUNNING` |
| `job_output` 负 offset 尾部 | `row-199` 可见、`tail: true` |

回归：runtime 全量 **161/161 通过**；应用 415 passed / 4 skipped；typecheck 通过；lint 0 error。

因新增工具，`tools/list` 数量断言从 74 → **75**（4 个测试文件同步更新，属契约变更而非放宽断言）。

---

## 5. 明确不做的事

| 能力 | 不做的理由 |
|---|---|
| 内存中执行任意代码 | 与"审计可追溯 + 最小权限"冲突；若要做必须先设计沙箱与资源限额 |
| Office/PDF 读写 | 超出产品边界；另有成熟工具链，重复建设收益低 |
| 浏览器自动化（playwright-mcp 方向） | 属另一个产品形态；本项目是"本机能力桥"不是"浏览器代理" |
| 复制对方源码 | 许可证虽宽松，但独立实现更可控，也避免把对方的架构假设带进来 |

---

## 6. 下一优先级（建议）

1. **`edit_block` 式局部替换**：`prepare_edit` → `commit_operation`，带模糊匹配（容忍空白/缩进差异）与 unified diff 预览。这是 AI 改代码体验的最大短板——当前只能整文件重写，大文件既费 token 又易冲突。
2. **`read_multiple_files` 批量读取**：一次取多个小文件，减少往返。
3. **目录树带大小与忽略规则**：`directory_tree` 增加 `max_depth` / `max_entries` / `.gitignore` 支持。
