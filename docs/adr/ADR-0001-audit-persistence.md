# ADR-0001：审计持久化方案（不使用 node:sqlite）

状态：已采纳（M7-1）
日期：2026-11-05

## 背景

M7 要求"高风险操作在执行前，审计意图必须获得**持久化确认**"。原计划用 SQLite WAL + 单写入者实现。

## 约束核实

| 事实 | 证据 |
|---|---|
| Electron `^33.0.0` | `package.json` |
| Electron 33 内嵌 **Node 20.18** | Electron 33 release notes |
| Runtime 由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 启动 | `RuntimeSpawner.ts`、`RuntimeResolver.ts` |
| `node:sqlite` 自 **Node 22.5** 起提供 | Node 官方文档 |

结论：**在当前发行形态下 `node:sqlite` 不可用**。即使开发机 Node 版本更高、测试通过，便携包里的 Runtime 仍会崩。

补充：Electron 33 已于 2025-04-28 结束支持，属于需要单独排期的升级项（见下）。

## 决策

**不引入 SQLite，也不用原生模块。** 采用 **追加写 + fsync 的持久化事件日志**（append-only journal），配合单写入者队列。

## 设计

```
MCP / Supervisor 入口
  └─ 生成 operation_id + 接收 idempotency_key（客户端提供）
       └─ 单写入者队列（每 workspace 一个日志文件、一个写者）
            ├─ 写 INTENT 行 → fs.write + fdatasync → 返回"已持久化"  ← 高风险操作在此之后才执行
            ├─ 写 EXECUTION_STARTED 行 → fsync
            └─ 写 RESULT 行 → fsync（异步补齐，不阻塞整个任务生命周期）
```

要点：

1. **每 workspace 独立日志**（`<profile>/audit/<workspaceId>.journal.jsonl`），避免多 Runtime 抢同一个文件；
2. **单写入者**：进程内一个串行队列；跨进程用 `proper-lockfile` 风格的独占锁文件（O_EXCL + pid + 心跳），锁超时返回 `AUDIT_UNAVAILABLE`；
3. **持久化确认**：写入后 `fs.fsync`（文件）与目录项 fsync，成功才算 `INTENT_DURABLE`；
4. **有界队列**：默认 1024 条，满则**拒绝**高风险请求（返回 `AUDIT_QUEUE_FULL`），不丢事件、不静默降级；
5. **超时**：单次写入 5s 超时；超时视为未持久化 → 拒绝执行；
6. **崩溃恢复**：启动时回放日志尾部，未闭合的记录标 `AUDIT_PENDING`（见状态机），**绝不自动重放**；
7. **去重**：`operation_id`（服务端生成，生命周期）+ `idempotency_key`（客户端提供，重试复用）。重复 `idempotency_key` 返回**原操作状态**，不重新执行；
8. **同步写不阻塞主循环**：fsync 在独立 Worker（`worker_threads`）中执行，主线程 await 一个 Promise。

## 状态机

| 状态 | 含义 | 恢复动作 |
|---|---|---|
| `INTENT_DURABLE` | 意图已落盘 | 副作用**尚未**开始：可安全重试/放弃 |
| `EXECUTION_STARTED_DURABLE` | 执行已开始（已落盘） | 结果未知：必须 `AUDIT_PENDING`，不得自动重跑 |
| `RESULT_DURABLE` | 结果已落盘 | 直接返回既有结果 |
| `AUDIT_PENDING` | 结果未落盘或崩溃在中间 | 只能读回核实（文件哈希/进程状态），**禁止**自动重放 |

## 分类策略

| 操作类型 | 要求 |
|---|---|
| 文件写入 / 删除 / Git 提交 | 意图持久化失败 → 拒绝执行 |
| Shell / PowerShell | 同上 |
| 权限变更 / 隧道配置 | 同上 |
| 只读查询 | 异步记录，响应里带 `auditState: "PERSISTED" \| "PENDING"` |
| 后台任务 | 先落意图，再启动；结果异步补齐 |

## 为什么不选其它方案

| 方案 | 否决理由 |
|---|---|
| `node:sqlite` | Node 20 不支持（见上） |
| `better-sqlite3` 原生模块 | 需为 Electron ABI 重编译，便携包体积/构建复杂度上升，且与"绿色免安装"冲突 |
| 直接升级 Electron 到 37+ | 可行但属独立升级项（ABI、原生依赖、打包、CI 全要重验），不应和 M7 混做 |
| 纯内存队列 | 不满足"持久化确认" |

## Electron 升级计划（独立跟踪）

建议在 M7 完成后单独立项：`33 → 37 (Node 22)`，届时若稳定，可把日志后端替换为 `node:sqlite`（接口不变，只换存储实现）。ADR 的队列/状态机/去重语义保持不变。

## 验收对应

- 高风险操作"意图落盘后才执行" → 由 `INTENT_DURABLE` + fsync 保证；
- "同幂等键不重复执行" → `idempotency_key` 索引；
- "队列满不误执行" → 满即拒绝；
- "崩溃不重放" → 回放只标 `AUDIT_PENDING`；
- 全部需在 M7-6 用故障注入验证（磁盘满、写入超时、kill -9、并发）。
