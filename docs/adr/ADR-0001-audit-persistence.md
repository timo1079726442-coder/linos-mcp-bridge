# ADR-0001：审计持久化方案（不用 node:sqlite）

状态：已采纳（M7-1）· 2026-11-05

## 背景

M7 要求：高风险操作在执行前，审计意图必须获得**持久化确认**。原计划用 SQLite WAL + 单写入者。

## 约束核实

| 事实 | 证据 |
|---|---|
| Electron `^33.0.0` | `package.json` |
| Electron 33 内嵌 Node 20.18 | Electron 33 release notes |
| Runtime 由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动 | `RuntimeSpawner.ts` / `RuntimeResolver.ts` |
| `node:sqlite` 自 Node 22.5 起提供 | Node 官方文档 |

结论：当前发行形态下 **`node:sqlite` 不可用**；开发机测试通过不代表便携包能跑。

## 决策

**不引入 SQLite，也不用原生模块**。采用 **追加写 + fsync 的持久化事件日志** + 单写入者队列。

## 设计要点

1. **每 workspace 独立日志**：`<profile>/audit/<workspaceId>.journal.jsonl`，避免多 Runtime 抢同一文件；
2. **跨进程互斥**：独占锁文件（`O_EXCL` 创建，内含 pid + 启动时间 + 心跳），锁超时（默认 5s）返回 `AUDIT_UNAVAILABLE`；持锁进程崩溃由下一次启动按"心跳过期"接管；
3. **完整性**：每条记录含 `seq`、`length`、`crc32`、`operation_id`、`kind`；回放时遇到长度/校验不匹配即停止，尾部不完整记录标记 `AUDIT_PENDING`，**不重放**；
4. **持久化确认**：写入后对文件 `fsync`（并在新建文件时对目录 fsync），成功才返回 `INTENT_DURABLE`；
5. **有界队列**：默认 1024 条，满则**拒绝**高风险请求（`AUDIT_QUEUE_FULL`），不丢事件、不静默降级；
6. **超时**：单次写入 5s；超时视为未持久化 → 拒绝执行；
7. **Worker 隔离**：fsync 在 `worker_threads` 中执行，主线程 await Promise，不阻塞事件循环；
8. **去重**：`operation_id`（服务端生成，串起生命周期）+ `idempotency_key`（客户端提供，重试复用）。同一 `idempotency_key` 返回**原操作状态**；**不允许**用命令文本/文件路径代替幂等键。

## 状态机

| 状态 | 含义 | 恢复动作 |
|---|---|---|
| `INTENT_DURABLE` | 意图已落盘 | 副作用尚未开始：可安全放弃或按幂等键重试 |
| `EXECUTION_STARTED_DURABLE` | 已开始执行 | 结果未知：标 `AUDIT_PENDING`，不得自动重跑 |
| `RESULT_DURABLE` | 结果已落盘 | 返回既有结果 |
| `AUDIT_PENDING` | 结果缺失或崩溃在中间 | 只能读回核实（文件哈希/进程状态），**禁止**自动重放 |

## 分类策略

| 操作 | 要求 |
|---|---|
| 文件写入 / 删除 / Git 提交 | 意图持久化失败 → 拒绝执行 |
| Shell / PowerShell | 同上 |
| 权限变更 / 隧道配置 | 同上 |
| 只读查询 | 异步记录，响应带 `auditState: PERSISTED \| PENDING` |
| 后台任务 | 先落意图，再启动；结果异步补齐 |

## 不承诺 Exactly-once

外部副作用（文件/Shell/Git）无法做到"恰好执行一次"。本方案保证的是：
- **不自动重复执行**；
- **保留结果核验能力**（读回、哈希、进程状态）。

## 不选其它方案的理由

| 方案 | 否决理由 |
|---|---|
| `node:sqlite` | Node 20 不支持 |
| `better-sqlite3` | 需按 Electron ABI 重编译，体积与构建复杂度上升，与绿色免安装冲突 |
| 直接升级 Electron 到 37+ | 属独立升级项（ABI/原生依赖/打包/CI 全需重验），不与 M7 混做 |
| 纯内存队列 | 不满足持久化确认 |

## v0.1.1 implementation status (2026-11-06)

- Runtime audit writes now use a Worker-backed per-workspace journal, an `O_EXCL` lock with stale-owner recovery, contiguous `seq`, record length + CRC32 + SHA-256 chain validation, and file `sync()` before acknowledging persistence.
- High-risk MCP calls persist `INTENT_DURABLE` before dispatch; command/write/Git/job failures before intent return `AUDIT_UNAVAILABLE` without running the effect. Read-only calls expose `_meta.auditState` as `PERSISTED` or `PENDING`. Background job attempts link their terminal `RESULT_DURABLE` to the persisted operation ID. Legacy `tool-calls.jsonl` is left untouched and verified read-only.
- **Windows durability limitation — 已达成的决定（B 方案，2026-11-07）：** 在 Windows/Node 20.18.3 与 24.x 上实测：`fsync(file)` 成功，`fsync(directory)` 返回 `EPERM`。按"不引入原生模块、保持绿色免安装"的既有决策，**不引入 Win32 辅助**；Windows 如实报告 `FILE_SYNC_ONLY`，POSIX 报告 `FILE_AND_DIRECTORY_SYNC`。
  - 该边界**已机器校验**：`verifyToolAudit()` 返回 `durability` 与 `platform`，`GET /admin/tool-audit` 可直接查询；`runtime/test/tool-audit.test.js` 断言追加回执与 verify 输出都等于平台实测等级（Windows 上必须是 `FILE_SYNC_ONLY`），任何人都无法把它改成"完整持久化"。
  - 对外口径：`SECURITY.md`「已知的设计取舍」第 6 条、`docs/INSTALL.md` 审计一节均写明降级事实；发布说明不得声称 Windows 具备目录项持久性。
  - 若将来要求与 POSIX 同等持久性，唯一路径是引入最小 Win32 辅助（`FlushFileBuffers` 目录项），届时需要重新验证 ABI、构建、代码签名与免安装形态，因此作为**独立大版本议题**，不阻塞本次发布。
  - 审计的核心保证（哈希链可校验、失败关闭、无重放）**不依赖**目录项 fsync，因此该降级不削弱"能否发现篡改/是否拒绝无审计执行"这两项。
- Targeted audit suite: 12 passed (含 Windows 持久化等级断言). Full runtime suite after integration: 154 passed. Clean-package/Windows release verification remains pending.

## Electron 升级（独立跟踪）

M7 完成后单独立项 `33 → 37 (Node 22)`；届时可把日志后端换成 `node:sqlite`，队列/状态机/去重语义不变。
