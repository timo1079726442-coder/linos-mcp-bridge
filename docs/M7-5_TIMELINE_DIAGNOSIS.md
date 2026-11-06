# M7-5 Timeline 诊断与 v0.1.1 P0 后台任务修复

## 边界与基线

- 当前工作分支：`release/v0.1.1-hardening`，从已含 M7-5 修复的本地 commit `48df409` 建立。
- `main` 保持 `737ce86`，`m7-5-wip` 的远程基线为 `78332a8`；本次未合并、不推送、不 force push；M7-0-2 继续暂停。
- 改动前已建立 `backup/main-737ce86-before-v011`、`backup/m7-5-wip-48df409-before-v011`，并验证 bundle `D:\CODE\worktrees\linos-mcp-bridge-pre-v011-20261106.bundle` 完整。
- Timeline 仅由测试构造的 `ws.timeline` 注入内存 sink；测试退出后可写临时 JSONL，不增加生产环境持久化、配置或 MCP 参数。

## 诊断证据（M7-5 修复前）

测试 `runtime/test/job-timeline.test.js` 与 `job-tools.test.js` 观察到：

1. 并发任务的同一 job 可出现交叠 `STORE_SAVE_BEGIN` / `STORE_ATOMIC_WRITE_BEGIN`：多个 `JobStore` 实例对同一 job 执行未串行化的 read-modify-atomic-write。
2. 取消时间线在 controller settle 后仍有 24 个 `STORE_*` 事件：stdout/stderr data handler 发起的异步输出落盘未被 runner 等待。
3. 取消工具的 store 事件归入 fallback attempt ID `1`，无法与实际 attempt 对齐。
4. `Promise.race(exitPromise, cancelWatcher)` 任一分支获胜后都会发 `PROCESS_EXITED`，因此 state watcher 先结束时不代表 child `close` 已到达。

## 修复

- `JobStore.save` 增加进程内按 job 文件路径串行化的 keyed queue；记录合并逻辑保留终态、单调 heartbeat/output 元数据，避免 stale output/heartbeat 快照回退状态。
- stdout/stderr 写入同一 promise queue；runner 等待真实 child `close`、drain 输出和在途 heartbeat save 后才 settle controller。
- launch 错误持久化完成后才发 `CONTROLLER_SETTLED`；`job_cancel` 等待 controller settle 再返回，避免测试/调用方清理时仍有后台写入。
- `start_job` 按 profile/workspace 串行化幂等检查、并发槽检查、创建与 launch；槽位同时计入存储中的任务和仍活跃的 controller。
- `job_cancel` 与 `job_resume` 按 workspace 串行化；resume 对 `CANCELLED` / 其它终态只通过显式 `allowTerminalResume` 转到 `QUEUED`，普通 stale save 仍不得覆盖取消终态。
- `recoverInterruptedJobs` 在并发槽检查前运行，防止过期 RUNNING 快照永久占槽。
- 增加的 P0 测试覆盖：子进程异常退出后的持久记录恢复、新调用上下文重连、8 路同幂等键启动、workspace 活跃槽上限、cancel 后并发 resume、heartbeat 推进并在 settle 后停止。
- M7 Timeline 仍断言取消持久化/信号/真实进程关闭/输出 drain/settle 顺序，以及 settle 后无存储写入。

## 验收

- `npm --prefix runtime test` 连续 **10 轮**：每轮 **116/116 passed、0 failed**；执行器首失败即停，没有自动重试掩盖问题。
- `job-tools.test.js` 定向新增用例：**11/11 passed**。
- `npm test`：76 个测试文件 passed、2 skipped；**415 passed、4 skipped**。
- `npm run typecheck`：通过（main、preload、renderer）；runtime 每轮测试均执行 TypeScript build。
- 本地验证，不 push；远程 CI 未触发，M7-0-2 仍暂停。后续 P0 审计系统与 P1 SSRF 仍未完成，不得发布 v0.1.1。
