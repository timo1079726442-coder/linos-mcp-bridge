# M7-5 Timeline 诊断与修复记录

## 边界与基线

- 分支：`m7-5-wip`；诊断基线 `78332a8`。
- `main` 保持 `737ce86`，本次未合并、不推送；M7-0-2 继续暂停。
- Timeline 仅在测试构造的 `ws.timeline` 注入内存 sink；JSONL 在测试退出时写入临时目录，不增加生产环境持久化、配置或 MCP 参数。

## 诊断证据（修复前）

测试 `runtime/test/job-timeline.test.js` 与 `job-tools.test.js` 观察到：

1. 两个并发任务均完成，但同一 attempt 可出现交叠的 `STORE_SAVE_BEGIN` / `STORE_ATOMIC_WRITE_BEGIN`，因为多个 `JobStore` 实例对同一 job 文件执行未串行化的 read-modify-atomic-write。
2. 取消时间线在 controller settle 后仍有 24 个 `STORE_*` 事件，说明 stdout/stderr data handler 发起的异步输出落盘没有被 runner 等待。
3. 取消工具的 store 事件此前归入 fallback attempt ID `1`，不能与该 job 的实际 attempt 对齐。
4. Runner 在 `Promise.race(exitPromise, cancelWatcher)` 返回后无条件发出 `PROCESS_EXITED`；若 cancel/state watcher 先结束，事件不一定代表底层 child 的 `close` 已到达。

## 修复

- `JobStore.save` 增加进程内按 job 文件路径串行化的 keyed queue，覆盖不同 `JobStore` 实例的取消、runner 与输出更新。
- job runner 将 stdout/stderr chunk 写入单一 promise queue；等 child `close` 后 drain 输出并 flush 残行，才持久化终态并 settle controller。
- cancel watcher 先结束时，runner 继续等待真实 child close；`PROCESS_EXITED` 只在 close promise resolve 后记录。
- cancel path 显式登记实际 `attempt_id`，Timeline 增加 `LAUNCH_RESERVED`、`CANCEL_REQUESTED`、`CANCEL_PERSISTED`、`CANCEL_SIGNAL_SENT`、`OUTPUT_DRAINED`。
- Timeline 测试断言每个 attempt 的 save 串行、取消持久化/信号/真实进程关闭/输出 drain/settle 顺序，以及 settle 后无存储写入。

## 验收

- `npm --prefix runtime test`：111 passed；包含 TypeScript build 和 runtime 全量测试。
- 使用 `MCP_TIMELINE_DIR=<临时目录>` 对 job-tools 测试执行完整注入：并发/取消 Timeline 导出为临时 JSONL；汇总 11 个 attempt group，`store_events_after_settle=0`、`max_concurrent_save_per_attempt=1`、取消事件顺序违规数为 0。
- `npm test`：76 个测试文件 passed、2 skipped；415 tests passed、4 skipped。
- `npm run typecheck`：通过（main、preload、renderer）。
- 本轮仅本地验证；未 push。远程 CI 未触发，M7-0-2 仍暂停。
