# 更新记录

本文件只记录**已发布或已具备发布条件**的版本。格式参考 Keep a Changelog。

---

## v0.1.1 — 待发布（分支 `release/v0.1.1-hardening`）

发布日期：待定（发布门禁见文末）。

### 安全

- **SSRF / DNS 重绑定（P1）**：`fetch` 工具此前在"校验解析结果"之后由 `fetch()` 再次解析域名，两次解析之间存在时间窗。现改为**每跳只解析一次**，并把解析结果直接绑定到实际 TCP 连接：
  - 校验结果通过自定义 `lookup` 交给 socket，底层不再二次解析；
  - 连接建立后比较 `socket.remoteAddress` 与已校验地址（规范化比较），不一致立即中止（`FETCH_PEER_MISMATCH`）；
  - 地址判定改为"仅全局单播"（默认拒绝），覆盖 IPv4/IPv6/mapped/链路本地/多播/文档段/CGNAT/云元数据/6to4/Teredo/NAT64；
  - 任一条 DNS 答案不合规即整体拒绝，空答案拒绝；
  - `agent: false` 禁用连接复用；禁止 `https → http` 降级；端口只允许默认端口或管理员在白名单中显式授权；拒绝压缩响应；全局 20s 预算（不按跳重置）。
- **审计持久化（P0）**：新增按工作区追加写的审计日志（`<profile>/audit/<workspaceId>.journal.jsonl`），`seq + length + CRC32 + SHA-256` 链式校验、`O_EXCL` 锁、跨进程串行、崩溃后失效锁回收、撕裂尾检测（`AUDIT_PENDING`）。
  - 高风险操作（写入/命令/Git/后台任务）在**审计意图落盘之前不产生副作用**；审计不可写时直接 `AUDIT_UNAVAILABLE` 拒绝执行（fail-closed）。
  - 只读调用返回 `_meta.auditState = PERSISTED | PENDING`。
  - 审计内容脱敏：只记录可执行文件名与 SHA-256，不保存完整命令；路径中的用户名、clientId、幂等键均脱敏或哈希。
  - `GET /admin/tool-audit` 公开 `durability` 与 `platform`：Windows 为 `FILE_SYNC_ONLY`，POSIX 为 `FILE_AND_DIRECTORY_SYNC`。
- **依赖**：移除声明但从未使用的 `@modelcontextprotocol/sdk` 与 `zod`，runtime 依赖漏洞 8 → **0**；根工程移除未使用的 `express`/`commander`/`zustand`。

### 修复（后台任务）

- `start_job` 的幂等检查、并发槽检查、创建与启动改为按工作区串行，消除并发重复创建；
- `job_cancel` 等待 controller 真正 settle 后再返回，消除"取消后仍写状态"；
- `job_resume` 与 cancel/start 共用生命周期锁，`CANCELLED → QUEUED` 需显式允许；
- `JobStore` 按 job 串行化保存并做字段级合并：终态不可被陈旧快照复活，`lastHeartbeatAt`/`lastOutputAt` 不倒退；
- 心跳任务纳入 settle 屏障，settle 之后不再有任何状态写入；
- 修复孤立任务误判：新建且尚未写心跳的任务不再被当作中断任务。

### 变更（使用方式）

- `fetch` 工具：非默认端口默认拒绝（可在白名单 `allow_ports` 中授权）；`https → http` 降级一律拒绝；只接受未压缩响应；超时改为 20s 全局预算。
- Electron 33 → **45.2.3**（内嵌 Node 24.22），移除已被删除的 `openAsHidden` 设置（原本仅 macOS 生效）。
- 便携包只保留 `zh-CN`/`en-US` 语言包，zip 体积 147.33 → **136.36 MB**。
- 打包不再包含：`react` 系渲染层依赖（已由 Vite 打包）、`runtime/node_modules/typescript`（构建期依赖）。第三方 LICENSE 完整保留（65 个）。

### 文档

- 新增 `docs/P1_SSRF_DNS_PINNING_DESIGN.md`（方案与验收不变量）、`docs/DEPENDENCY_AUDIT.md`、`docs/CI.md`、`docs/RELEASE_ENGINEERING.md`、`docs/CLEAN_WINDOWS_ACCEPTANCE.md`、`docs/ELECTRON_UPGRADE_ASSESSMENT.md`、`docs/LEGACY_IDENTIFIER_POLICY.md`；
- `SECURITY.md` 补充 fetch 加固、审计 fail-closed 与 Windows 持久性取舍；
- README 修正 `<this-repo>` 占位符；扩展面板与界面文案统一为 "LinOS MCP"。

### 已知限制（发布时随 Release 说明一并给出）

| 限制 | 说明 |
|---|---|
| Windows 审计持久性 | 目录项 `fsync` 在 Windows 不可用，报告 `FILE_SYNC_ONLY`；不影响"篡改可发现"与"审计不可写时拒绝执行" |
| 未做代码签名 | 首次运行会出现 SmartScreen"未知发布者"；请用 Release 页的 SHA256 校验 |
| 无构建来源证明 | 未接入 sigstore/SLSA attestation |
| 界面无自动化像素校验 | GUI 无法在无桌面会话中启动；渲染层由 415 项测试覆盖，另提供 `scripts/gui-smoke.mjs` 供有桌面环境时一键复验 |

### 验证证据

| 项 | 结果 |
|---|---|
| runtime 全量测试 | 154/154，**连续 10 轮**全绿（失败即停、无重试） |
| 应用测试 | 76 文件 / 415 passed / 4 skipped |
| 类型检查 | main + preload + renderer 全通过 |
| Lint | 0 error（275 warning 为基线债务） |
| 依赖漏洞 | runtime 0；根工程生产依赖 0 |
| 密钥扫描 | 9 refs / 33 commits，真实命中 0（7 条为测试夹具） |
| 打包静态门禁 | `STATIC-CHECK=PASS`（662 文件，无禁止项，渲染层资源引用完整） |
| 包内 runtime 冒烟 | `/health` 200，state 落盘，端口正常释放 |

### 发布前仍待完成

1. 在**有交互桌面**的 Windows 上运行一次 `node scripts/gui-smoke.mjs`（或人工过一遍界面）；
2. 在一台**未装 Node、未装过本项目**的机器上按 `docs/CLEAN_WINDOWS_ACCEPTANCE.md` 走完 15 项；
3. 推送分支、合并到 `main`、打 tag 并创建 Release（当前全部为本地提交）。

---

## v0.1.0

首个公开版本：本地 MCP 服务器 + Electron 控制中心，只读工具默认开启、写入需两阶段确认、OAuth 2.1 + PKCE、Cloudflare 隧道、浏览器扩展。
