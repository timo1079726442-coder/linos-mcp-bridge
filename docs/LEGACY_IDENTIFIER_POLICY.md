# 遗留标识符处理策略（v0.1.1 公开产品清理）

本文回答一个发布门禁问题：**仓库里还剩下的 "C2C / Company / Codex" 字样，哪些必须改、哪些必须保留、哪些要迁移。**
判定标准只有两条：

1. **外部用户能否看到**——能看到就必须中性化；
2. **改了会不会让已装机用户失效**——会失效就必须保留，或提供兼容期。

状态：`release/v0.1.1-hardening` 分支，未推送。

---

## 1. 分类总览

| 类别 | 典型形态 | 是否对外可见 | 处理 | 状态 |
|---|---|---|---|---|
| A. 产品名（文档/界面文案） | `LinOS C2C 工具箱`、`C2C 本地运行时服务` | 是 | 改为 `LinOS MCP 工具箱` / `LinOS MCP Bridge` | ✅ 已完成 |
| B. 安装文档占位符 | `git clone <this-repo>` | 是 | 替换为真实仓库地址 | ✅ 已完成 |
| C. 示例域名 | `c2c-v2-preview.example.com` | 是（输入框 placeholder / 帮助文案） | 改为 `mcp-preview.example.com` | ✅ 已完成（UI）；测试夹具保留 |
| D. 令牌前缀 | `c2c_api_...`、`c2c_client_...`、`c2c_ri_...`、`c2c_dev_...` | 是（用户复制粘贴） | **保留**：这是已签发令牌的真实格式，改动会让所有现存令牌失效 | 🔒 保留 |
| E. 环境变量 | `C2C_*` | 否（仅本机进程） | 分两步：先支持 `LINOS_*` 优先、`C2C_*` 回退；下个大版本移除旧名 | ⏳ 待迁移 |
| F. 工作区数据目录 | `.c2c/`（看板 `projects/*.json` 等） | 是（工作区内可见） | 需要**双读迁移**：优先 `.linos/`，不存在时读 `.c2c/` 并提示可迁移；不得静默丢失已有看板 | ⏳ 待迁移 |
| G. DOM / CSS 类名 | `c2c-domain-card`、`linos-c2c-host`、`window.__linosC2CPanelLoaded` | 否 | 保留（纯内部标识；重命名只增加回归面，无用户价值） | 🔒 保留 |
| H. preload 桥 API | `window.c2c.*` | 否（渲染层内部契约） | 保留；若未来重命名需同步全部渲染层与测试 | 🔒 保留 |
| I. 运行时可执行名 | `c2c-runtime-v2`（`bin`） | 否（内部调用） | 保留（进程启动路径与既有安装脚本引用） | 🔒 保留 |
| J. 旧服务探测标识 | `company-bridge`（ServiceKind）、`c2c-bridge`（握手 `service` 字段） | 否 | **必须保留**：用于识别 48765 上的既有 Company 服务，避免误接管 | 🔒 保留（安全相关） |
| K. 内部错误码 | `COMPANY_PROFILE_REPAIR_DISABLED` | 否 | 可改但收益低；改需同步测试与诊断文档 | ⏳ 可选 |
| L. 第三方客户端名 | README 中的 `Codex`（作为可接入的客户端之一） | 是 | **保留**：指外部产品，不是本项目旧名 | ✅ 无动作 |

---

## 2. 已完成（本轮）

- `README.md` / `README.en.md`：`git clone <this-repo>` → 真实地址；
- `extension/README.md`、`extension/content.js`：面板标题与按钮 `LinOS C2C 工具箱` → `LinOS MCP 工具箱`（按钮文字 `C2C` → `MCP`）；
- `src/renderer/components/MetricHelp.tsx`：7 条帮助文案中的 `C2C` → `LinOS MCP Bridge`；
- `MetricHelp.tsx` 与 `Connections.tsx` 的示例域名 → `mcp-preview.example.com`。

---

## 3. 待迁移项的技术方案（尚未实施）

### 3.1 `C2C_*` 环境变量 → `LINOS_*`

- 读取顺序：`LINOS_<NAME>` 优先，为空则回退 `C2C_<NAME>`；两者同时存在且值不同时以 `LINOS_` 为准并在诊断里报一条 `DEPRECATED_ENV_IN_USE`；
- 写入侧（启动子进程）只写 `LINOS_*`，同时继续接受旧名，保证外部脚本不炸；
- 移除旧名需要**大版本**，并在 CHANGELOG 标注。

### 3.2 `.c2c/` → `.linos/`

- 读取：`<workspace>/.linos/` 存在则用之；否则回退 `.c2c/`（只读兼容）；
- 写入：新数据一律写 `.linos/`；首次写入时若检测到 `.c2c/` 有历史数据，返回明确提示（不自动删除、不自动搬移）；
- 迁移：提供显式动作（控制中心或 CLI），执行前生成 `.c2c.bak` 副本；
- 禁止：静默双写导致两份数据分叉。

### 3.3 风险

- 这两项都会触碰"用户已有数据/已有部署"，必须配套：迁移测试、回滚路径、CHANGELOG 说明；
- 任何一项未完成前，文档不得声称"已完成品牌清理"。

---

## 4. 验收口径

| 检查 | 通过标准 |
|---|---|
| 外部可见文案 | 仓库内 `README*.md`、`docs/*.md`、`extension/*`、渲染层界面文案中不再出现 `C2C` / `Company` 作为**本项目**名称 |
| 协议标识 | `c2c_*` 前缀、`window.c2c`、`.c2c/`、`C2C_*` 允许存在，但必须在本文档登记原因 |
| 误接管防护 | `48765` 始终在 `RESERVED_RUNTIME_PORTS`，`company-bridge` 探测逻辑不得删除 |
| 文档一致性 | README 中的端口（48766）、工具数、命令与实际行为一致 |

> 当前状态：A–C 完成；D、G–J、L 为"刻意保留"；E、F、K 未完成，因此在全部门禁通过前**不得发布 v0.1.1**。
