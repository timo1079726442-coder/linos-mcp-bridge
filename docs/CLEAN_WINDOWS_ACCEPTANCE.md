# 干净 Windows 验收清单（v0.1.1 发布前必做）

这是**最后一个发布门禁**。目的：证明"一个没有开发环境的 Windows 用户，能下载、解压、启动、接入、使用、卸载"。

能自动化的已写成脚本；GUI 与客户端交互必须人工执行并记录证据（截图或命令输出）。

---

## 0. 准备

| 项 | 要求 |
|---|---|
| 机器 | 干净 Windows 10/11（虚拟机或新装系统），**未安装 Node.js**、未装过本项目 |
| 账号 | 普通用户（非必须管理员），用于验证"不需要管理员权限" |
| 产物 | `release-portable\LinOS-MCP-Portable-<version>-x64.zip` + `SHA256SUMS.txt` + `sbom.json` |
| 记录 | 全程保留命令输出；每步填写 §9 结果表 |

> 关键：这台机器上**不要**先装 Node、不要先跑 `npm`。如果装了，就不能证明"免安装运行"。

---

## 1. 自动部分（一条命令跑完）

在**打包机**上执行（生成基线证据）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-portable-assets.ps1 `
  -ZipPath .\release-portable\LinOS-MCP-Portable-<version>-x64.zip `
  -DestDir $env:TEMP\linos-acceptance `
  -ExpectedHash <SHA256SUMS.txt 里的值>
```

期望：`STATIC-CHECK=PASS`。

在**干净机**上执行（验证包自包含）：

```powershell
# 1) 校验哈希（与 Release 页一致）
Get-FileHash .\LinOS-MCP-Portable-<version>-x64.zip -Algorithm SHA256

# 2) 解压到普通目录（不要放 Program Files）
Expand-Archive .\LinOS-MCP-Portable-<version>-x64.zip -DestinationPath D:\LinOS-MCP

# 3) 确认没有依赖本机 Node
where.exe node     # 期望：找不到
```

期望：`where node` 无输出（本机无 Node），而后续程序仍能启动。

---

## 2. 首次启动

| 步骤 | 操作 | 期望 |
|---|---|---|
| 2.1 | 双击 `D:\LinOS-MCP\LinOS MCP.exe` | 出现主窗口，无崩溃、无"缺少模块"对话框 |
| 2.2 | 观察首次引导 | 进入「快速设置」：选工作区目录、端口默认 **48766**、生成配对码 |
| 2.3 | 检查 SmartScreen | 首次运行应出现"未知发布者"提示（未签名）；选择"更多信息 → 仍要运行" |
| 2.4 | 打开诊断/自检页 | Runtime 与 Supervisor 状态为正常；PID 有值 |

记录：端口实际值、是否出现 SmartScreen、窗口标题。

**反例验证（重要）**：本机如果已装过旧版本或另一款 `LinOS Handoff Hub`，确认端口 **48765** 不会被本程序占用（该端口为保留端口，填 48765 应被拒绝并给出 `RUNTIME_PORT_INVALID`）。

---

## 3. 接入 MCP 客户端（至少两个不同客户端）

| 步骤 | 操作 | 期望 |
|---|---|---|
| 3.1 | 客户端 A（如 ChatGPT 连接器/自定义 MCP 客户端）用本机 `http://127.0.0.1:48766/mcp` + 配对码接入 | 授权成功，`tools/list` 返回工具列表 |
| 3.2 | 客户端 B（另一款 MCP 客户端）同样接入 | 两个客户端可**同时**连接，互不影响 |
| 3.3 | 在 A 上调用 `workspace_info` | 返回当前工作区路径与 Git 状态 |
| 3.4 | 在 B 上调用 `read_file` 读一个文本文件 | 正常返回内容；敏感文件被脱敏 |

记录：两个客户端名称与版本、工具数量。

---

## 4. 只读与写入边界

| 步骤 | 操作 | 期望 |
|---|---|---|
| 4.1 | 未开启写入时调用 `prepare_write` | 被拒绝，提示需要审批或工具未开启 |
| 4.2 | 控制中心开启写入 → 客户端调用 `prepare_write` | 返回预演结果 + 内容哈希，**磁盘未变** |
| 4.3 | 客户端调用 `commit_operation` | 落盘成功并读回校验；文件内容与哈希一致 |
| 4.4 | 故意用过期哈希 `commit_operation` | 失败（`CONTENT_MISMATCH` 类错误），文件未被覆盖 |
| 4.5 | 调用 `run_command`（默认关闭） | 被拒绝，提示工具未启用 |

---

## 5. 联网工具（fetch）的加固行为

| 步骤 | 操作 | 期望 |
|---|---|---|
| 5.1 | 未配置白名单时调用 `fetch` | `FETCH_DISABLED` |
| 5.2 | 白名单加入一个公网域名后调用 | 成功返回文本；`final_url` 正确 |
| 5.3 | 白名单加入 `127.0.0.1` 或 `localhost` | 仍被拒绝（`FETCH_HOST_NOT_ALLOWED`） |
| 5.4 | 访问非默认端口（如 `https://example.com:8443/`） | `FETCH_PORT_NOT_ALLOWED` |
| 5.5 | 访问会重定向到 `http://` 的地址 | `FETCH_SCHEME_DOWNGRADE` |

---

## 6. 审计可查

| 步骤 | 操作 | 期望 |
|---|---|---|
| 6.1 | 控制中心打开审计/自检页，或调用 `GET /admin/tool-audit` | `ok=true`，`entries>0` |
| 6.2 | 检查返回的 `durability` | Windows 上必须是 **`FILE_SYNC_ONLY`**（若显示 `FILE_AND_DIRECTORY_SYNC` 说明实现被改坏） |
| 6.3 | 手工改动 `audit/*.journal.jsonl` 中一行内容后再校验 | 校验失败，报告断链位置（能发现篡改） |
| 6.4 | 把 `audit` 目录设为只读后执行一次高风险操作 | 操作被**拒绝执行**（fail-closed），不是"执行了但没记审计" |

---

## 7. 后台任务与断点

| 步骤 | 操作 | 期望 |
|---|---|---|
| 7.1 | `start_job` 起一个长任务 | 返回 job id；`job_status` 可查到运行中 |
| 7.2 | 断开客户端再重连 | 仍能查到同一 job 状态（不丢） |
| 7.3 | `job_cancel` | 返回后状态为 CANCELLED，进程已结束 |
| 7.4 | 强制杀掉 Runtime 进程再启动应用 | 未完成任务标为 INTERRUPTED，`job_resume` 可继续或明确失败 |

---

## 8. 升级与卸载

| 步骤 | 操作 | 期望 |
|---|---|---|
| 8.1 | 关闭程序，用新版本 zip 覆盖解压到同一目录 | 启动后 Profile、工作区、白名单、审计链**全部保留** |
| 8.2 | 检查旧版本目录残留 | 无 `*.old`、无重复 exe |
| 8.3 | 关闭程序，确认托盘图标消失 | 托盘退出后进程结束 |
| 8.4 | 删除整个 `D:\LinOS-MCP` 目录 | 可正常删除（无文件占用） |
| 8.5 | 检查注册表 `HKCU\Software`、`HKLM\Software` 下与 `com.linos.mcp.portable` / `LinOS MCP` 相关项 | 不存在 |
| 8.6 | 检查「应用和功能」列表 | 无本程序条目 |
| 8.7 | 检查计划任务与开机启动项 | 无残留（若曾开启自启，需确认关闭后移除） |

---

## 9. 结果记录表（复制到验收单据）

| # | 项目 | 结果 | 证据（命令输出/截图路径） |
|---|---|---|---|
| 1 | 哈希与静态门禁 | | |
| 2 | 干净机无 Node 仍能启动 | | |
| 3 | 首次引导（端口 48766） | | |
| 4 | 48765 被拒绝 | | |
| 5 | 客户端 A 接入 | | |
| 6 | 客户端 B 同时接入 | | |
| 7 | 只读工具 | | |
| 8 | 写入两阶段 + 过期哈希拒绝 | | |
| 9 | fetch 五项加固行为 | | |
| 10 | 审计 ok + `FILE_SYNC_ONLY` | | |
| 11 | 审计篡改可发现 | | |
| 12 | 审计不可写时拒绝执行 | | |
| 13 | 后台任务 4 项 | | |
| 14 | 升级保留数据 | | |
| 15 | 卸载无残留 | | |

全部 15 项通过后，才可以发布 v0.1.1 并创建 Release。

---

## 10. 已知会在干净机上出现的现象（不是缺陷）

| 现象 | 原因 | 处理 |
|---|---|---|
| SmartScreen"未知发布者" | 未做代码签名（见 `docs/RELEASE_ENGINEERING.md` §5） | 记录并说明校验 SHA256 的方法 |
| 防火墙提示 | Runtime 监听 `127.0.0.1`；只在本机回环时通常不触发 | 若弹出，仅允许专用网络 |
| 首次启动稍慢 | 生成 Profile 与密钥材料 | 正常 |
| `durability=FILE_SYNC_ONLY` | Windows 目录 fsync 不可用（`docs/adr/ADR-0001`） | 属预期，不得宣称完整持久化 |
