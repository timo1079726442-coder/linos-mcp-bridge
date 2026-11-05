/**
 * 任务生命周期时间线（诊断用）。
 *
 * 生产代码只使用 `TimelineSink` 类型（type-only import，编译后不存在）。
 * 真正的写文件实现 `createTimelineSink()` 只在测试里被 import，
 * 因此不会进入生产运行时依赖图，也不会写用户目录。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface TimelineEvent {
  job_id: string;
  attempt_id: string;
  event:
    | "LAUNCH_RESERVED"
    | "STORE_SAVE_BEGIN"
    | "STORE_ATOMIC_WRITE_BEGIN"
    | "STORE_ATOMIC_WRITE_END"
    | "STORE_SAVE_END"
    | "STORE_SAVE_ERROR"
    | "TERMINAL_PERSISTED"
    | "CONTROLLER_SETTLED"
    | "LAUNCH_REJECTED"
    | "STORE_SAVE_BEGIN"
    | "STORE_SAVE_END"
    | "WAIT_EXIT_ATTACHED"
    | "PROCESS_EXITED"
    | "TERMINAL_PERSISTED"
    | "CONTROLLER_SETTLED";
  pid?: number | null;
  exit_code?: number | null;
  duration_ms?: number;
}

export type TimelineSink = (event: TimelineEvent) => void;

/** 仅测试使用：把事件写成 JSONL 到指定目录（每次测试独立目录）。 */
export function createTimelineSink(dir: string, fileName = "job-events.jsonl"): TimelineSink {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  return (event) => {
    appendFileSync(file, `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`, "utf8");
  };
}
