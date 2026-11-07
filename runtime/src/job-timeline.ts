/**
 * 任务生命周期时间线（诊断用）。
 *
 * 设计约束：
 * - 生产代码只 `import type`（类型被擦除），不进入运行时依赖图；
 * - 只有测试用 `createMemoryTimeline()`，测试结束后（含失败）再导出 JSONL；
 * - 不使用同步磁盘写入，避免诊断本身改变被测时序。
 */

type Base = { job_id: string; attempt_id: string };

export type TimelineEvent =
  | (Base & { event: "LAUNCH_RESERVED"; pid?: null })
  | (Base & { event: "LAUNCH_REJECTED" })
  | (Base & { event: "CANCEL_REQUESTED"; pid: number | null })
  | (Base & { event: "CANCEL_PERSISTED"; pid: number | null })
  | (Base & { event: "CANCEL_SIGNAL_SENT"; pid: number | null })
  | (Base & { event: "OUTPUT_DRAINED" })
  | (Base & { event: "WAIT_EXIT_ATTACHED"; pid: number | null })
  | (Base & { event: "PROCESS_EXITED"; pid: number | null; exit_code: number | null })
  | (Base & { event: "STORE_SAVE_BEGIN" })
  | (Base & { event: "STORE_READ_BEGIN" })
  | (Base & { event: "STORE_READ_END" })
  | (Base & { event: "STORE_READ_ERROR" })
  | (Base & { event: "STORE_ATOMIC_WRITE_BEGIN" })
  | (Base & { event: "STORE_ATOMIC_WRITE_END" })
  | (Base & { event: "STORE_SAVE_END" })
  | (Base & { event: "STORE_SAVE_ERROR" })
  | (Base & { event: "TERMINAL_PERSISTED"; pid: number | null; exit_code: number | null })
  | (Base & { event: "CONTROLLER_SETTLED" });

export type TimelineSink = (event: TimelineEvent) => void;

export interface MemoryTimeline {
  sink: TimelineSink;
  events: () => Array<TimelineEvent & { timestamp: string }>;
  toJsonl: () => string;
  byAttempt: () => Map<string, Array<TimelineEvent & { timestamp: string }>>;
}

/** 仅测试使用：内存收集，测试结束（含失败）再统一导出。 */
export function createMemoryTimeline(): MemoryTimeline {
  const buffer: Array<TimelineEvent & { timestamp: string }> = [];
  return {
    sink: (event) => {
      buffer.push({ ...event, timestamp: new Date().toISOString() });
    },
    events: () => [...buffer],
    toJsonl: () => buffer.map((event) => JSON.stringify(event)).join("\n") + (buffer.length ? "\n" : ""),
    byAttempt: () => {
      const groups = new Map<string, Array<TimelineEvent & { timestamp: string }>>();
      for (const event of buffer) {
        const key = `${event.job_id}#${event.attempt_id}`;
        const list = groups.get(key) ?? [];
        list.push(event);
        groups.set(key, list);
      }
      return groups;
    },
  };
}
