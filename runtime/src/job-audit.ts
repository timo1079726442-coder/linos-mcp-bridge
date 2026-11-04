/**
 * Job audit bridge for background execution.
 *
 * start_job itself is policy- and approval-gated like any sensitive tool.
 * Worker transitions are recorded as metadata only: no file contents, no
 * command bodies, no secrets. Full output stays in the capped per-job log.
 */
import type { JobRecord, JobState } from "./job-store.js";

export interface JobAuditEvent {
  jobId: string;
  state: JobState;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  errorCode?: string;
  outputBytes: number;
}

export async function appendJobAudit(profileDir: string, record: JobRecord): Promise<void> {
  const { appendToolAudit } = await import("./tool-audit.js");
  await appendToolAudit(profileDir, {
    tool: "start_job",
    ok: record.state === "SUCCEEDED",
    durationMs: record.durationMs,
    command: `job ${record.id} ${record.state}`,
    bytes: record.outputBytes,
  });
}
