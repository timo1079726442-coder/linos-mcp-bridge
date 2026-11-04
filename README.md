# LinOS MCP Bridge

[English](README.en.md) · **中文**

![CI](https://github.com/timo1079726442-coder/linos-mcp-bridge/actions/workflows/ci.yml/badge.svg) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

让你的本地机器成为 AI 可以安全使用的“双手”：一个自托管的 **MCP（Model Context Protocol）服务器**，把文件读写、命令执行、Git、后台长任务暴露给 ChatGPT 以及任意 MCP 客户端（Cursor / Claude / Codex / VS Code…），并带桌面控制中心、审计链和断点交接。

> ⚠️ **安全前提**：这个程序会让 AI 以**你当前 Windows 用户**的身份操作这台机器。默认只开只读工具；写文件、执行命令、PowerShell、屏幕等能力必须你显式开启。不要在不受信任的环境里开“全权模式”。

---

## 它解决什么问题

| 痛点 | 这个项目怎么做 |
|---|---|
| ChatGPT 网页版无法直接读写本机文件 | 本地 MCP 服务器 + 可选 Cloudflare 隧道，公网 HTTPS 入口 |
| OAuth 客户端接入麻烦、易误配 | 内置 OAuth 2.1 + PKCE + 动态注册 + 8 位配对码 |
| AI 改文件不可信 | 两阶段写入：`prepare_write`（预演/算哈希/不落盘）→ `commit_operation`（复核后落盘并读回） |
| 长任务一断线就丢 | 后台任务（`start_job`/`job_status`/`job_resume`）+ 断点与恢复 |
| 换 AI / 上下文满了就不知道做到哪 | 项目看板（`.c2c/projects/*.json`）+ 一键交接卡（任何 agent 可读） |
| 不知道 AI 到底干了什么 | 逐次工具调用的哈希链审计（工具、路径、结果、文件 SHA256、调用方） |
| 想接非 MCP 的网页版 AI | 自带浏览器扩展（Chrome/Edge），网页内直接调用本机工具 |

## 架构

```
Electron 主进程（窗口 / 托盘 / IPC）
 ├─ Supervisor 子进程        命名管道 + Capability-MAC
 │   └─ Runtime 子进程      HTTP 127.0.0.1:48766/mcp（JSON-RPC 2.0）
 └─ cloudflared 子进程（可选）公网命名隧道
```

- 渲染层无 Node 权限，只能通过 preload 暴露的白名单 IPC；
- 每个 IPC 通道要求调用方提交预期 capability 字符串；
- Runtime 的所有路径必须落在工作区内（越界即拒绝）；
- 命令执行有白名单（git / npm / python / pytest / node），禁止 shell 元字符与 `-c/--exec`；
- 审计日志逐条 `prevHash + hash` 链式，可校验是否被改。

## 快速开始

需要 Windows 10/11、Node.js ≥ 20。

```powershell
git clone <this-repo>
cd linos-mcp-bridge
npm ci
npm run build:runtime
npm run build
npm start
```

**一键安装（推荐）**：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

它会检查 Node 版本、安装依赖、构建 runtime 与界面，并打印后续步骤。

首次启动会进入「快速设置」：选工作区目录 → 选端口（默认 48766）→ 生成配对码。

## 公网访问：三选一

| 方式 | 适合 | 怎么做 |
|---|---|---|
| **只在本机**（默认） | 先试用、重隐私 | 不用配；MCP URL = `http://127.0.0.1:48766/mcp`（ChatGPT 网页版访问不到） |
| **临时隧道**（quick tunnel） | 当天验证 | `powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-quick.ps1` → 输出 `https://<随机>.trycloudflare.com`，**每次重启都变** |
| **自有域名**（named tunnel） | 长期日常用 | `powershell -ExecutionPolicy Bypass -File .\scripts\tunnel-named.ps1 -Domain mcp.example.com` → 域名固定，`https://mcp.example.com/mcp` |

完整步骤与排错见 **[docs/INSTALL.md](docs/INSTALL.md)**。

## 接入 ChatGPT

1. 控制中心「连接授权」→ 生成配对码；
2. ChatGPT → 设置 → 连接器 → 新建，URL 填 `https://<你的域名>/mcp`；
3. OAuth 页面输入配对码 → 允许。

## 接入其他客户端

- **Cursor / Claude Desktop / Codex / VS Code**：设置页「其他 AI 接入」生成长期令牌，复制现成配置片段；
- **网页版 AI（DeepSeek / Gemini / 千问）**：装 `extension/` 里的浏览器扩展，页面右下角出现面板。

## 安全模型（务必读）

| 能力 | 默认 | 说明 |
|---|---|---|
| 读文件 / 搜索 / Git 只读 | ✅ 开 | 只读，风险低 |
| 写文件 | ⚠️ 需确认 | `prepare_write` → `commit_operation` 两阶段 |
| 执行命令（git/npm/pytest） | ❌ 关 | 需显式开启；白名单之外一律拒绝 |
| PowerShell | ❌ 关 | 开启等于“以你的用户身份执行任意命令”，仅在你完全信任客户端时使用 |
| 屏幕截图 | ❌ 关 | 接口尚未实现，调用会返回未接入 |
| 公网隧道 | ❌ 关 | 开启后公网可访问 `/mcp`，依赖 OAuth/令牌保护 |

建议：先只用只读；确认工作流后，再按需开启写入；命令与 PowerShell 最后开。

## 目录结构

```
src/main          Electron 主进程（IPC、Supervisor 适配、托盘、健康探测）
src/preload       暴露给渲染层的白名单 API
src/renderer      React 界面（总览、连接、工作区、诊断、项目看板、MCP 进度）
runtime/src       MCP 服务器（HTTP/OAuth、工具实现、审计、任务引擎）
extension/        Chrome/Edge 浏览器扩展
scripts/          安装与隧道脚本（setup.ps1 / tunnel-quick.ps1 / tunnel-named.ps1）
docs/             安装说明、故障经验库
```

## 测试

```powershell
npm test                 # 主包（约 420 项）
cd runtime; npm test     # runtime（约 109 项）
```

## 状态

早期可用版本（`0.1.0`）。接口与配置可能变化；生产使用前请自评估安全边界。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 参与共建

这个项目从第一天就是按"能被别人接手"来写的，欢迎任何人参与：

| 想做什么 | 从这里开始 |
|---|---|
| 报 Bug / 提需求 | [Issues](../../issues)（模板已备好；漏洞请走私密渠道，见 [SECURITY.md](SECURITY.md)） |
| 认领任务 | [ROADMAP.md](ROADMAP.md)，带 `good first issue` 标签的适合第一次参与 |
| 提交代码 | [CONTRIBUTING.md](CONTRIBUTING.md)：`npm run typecheck` + 双测试套件必须过 |
| 讨论设计 | 开 Issue 说清"要解决的问题 + 你的方案 + 取舍"，别直接甩一大坨代码 |
| 写文档 / 翻译 | 英文 README、英文 INSTALL、更多客户端接入示例都缺人 |

**共建原则**：安全默认优先（新能力默认关闭）、可验证优先（说修好了就给复现步骤）、可撤销优先（破坏性动作要有备份与回滚）。

## 一键上手（不想看文档的话）

1. 双击 `install.cmd`（装依赖 + 构建 + 启动）
2. 之后双击 `start.cmd`
3. 要在公网给 ChatGPT 用：`scripts\tunnel-quick.ps1`（当天试用）或 `scripts\tunnel-named.ps1 -Domain 你的域名`（长期固定）