import { createHash } from "node:crypto";
import { ExecutionRecordStore, type ExecutionRecord, type ExecutionStatus } from "./execution-store.js";

/**
 * Stable record id for the product-owned readiness evidence.
 *
 * The record is deliberately deterministic: Runtime restarts refresh the
 * same bounded evidence instead of appending duplicate startup records.
 */
export const RUNTIME_READY_RECORD_ID = "exec_runtime_ready";
export const RUNTIME_READY_TASK_ID = "linos-c2c-runtime";
export const RUNTIME_READY_PUBLIC_OUTPUT = "V2 Runtime readiness verified; no command output is exposed.";

export interface RuntimeReadyObservation {
  expectedPort: number;
  boundPort: number;
  workspaceExists: boolean;
  workspaceId: string;
}

export interface CodexTaskCompletionEvent {
  taskId: string;
  iteration: number;
  status: ExecutionStatus;
  changedFiles: string[];
  tests: Array<{ category: string; command?: string; passed: boolean; testCount?: number; failedCount?: number }>;
  summary: string;
  publicOutput: boolean;
  allowedOutput?: string;
}

/**
 * Product-owned producer for the read-only Execution Store.
 *
 * The MCP surface is intentionally read-only. This producer is the only
 * Runtime startup path that creates the built-in public readiness record; it
 * never copies command output, file contents, tokens, or credentials.
 */
export class ExecutionStoreProducer {
  constructor(private readonly store: ExecutionRecordStore) {}

  /** Bounded read-only projection for the admin (Supervisor) read surface. */
  async recent(limit: number): Promise<ExecutionRecord[]> {
    return this.store.recent(Math.max(1, Math.min(50, Math.floor(limit) || 20)));
  }

  async latestTest(): Promise<ExecutionRecord | null> {
    return this.store.latestTest();
  }

  async publicOutput(id: string): Promise<{ record: ExecutionRecord; output: string } | null> {
    return this.store.publicOutput(id);
  }

  async publishRuntimeReady(observation: RuntimeReadyObservation): Promise<ExecutionRecord | null> {
    // Fail-closed intent: a startup readiness record must never be written
    // unless the Runtime is actually serving on a valid, expected port AND
    // the workspace is real. An existing-but-stale `exec_runtime_ready`
    // record from a prior crash must NOT be reinterpreted as current health;
    // the list API exposes `timestamp` and the diagnostics record always
    // carries the fresh runtimeInstanceId so a UI can refuse records older
    // than the current Supervisor session.
    //
    // Two valid shapes:
    //   - Fixed port:   expectedPort > 0  AND  expectedPort === boundPort
    //   - Ephemeral:    expectedPort === 0 AND  1 <= boundPort <= 65535
    // 0/0 is explicitly rejected: boundPort=0 means nothing is bound.
    const validBoundPort = Number.isInteger(observation.boundPort)
      && observation.boundPort >= 1
      && observation.boundPort <= 65535;
    const ephemeral = observation.expectedPort === 0;
    const fixedMatch = observation.expectedPort > 0 && observation.expectedPort === observation.boundPort;
    const verified = (ephemeral ? validBoundPort : fixedMatch)
      && observation.workspaceExists
      && observation.workspaceId.length > 0;
    if (!verified) return null;

    return this.store.write({
      id: RUNTIME_READY_RECORD_ID,
      taskId: RUNTIME_READY_TASK_ID,
      iteration: 1,
      timestamp: new Date().toISOString(),
      changedFiles: [],
      tests: [{
        category: "runtime-readiness",
        command: "runtime startup",
        passed: true,
        testCount: 1,
        failedCount: 0,
      }],
      status: "PASS",
      summary: "V2 Runtime readiness verified",
      publicOutput: true,
      allowedOutput: RUNTIME_READY_PUBLIC_OUTPUT,
    });
  }

  async publishCodexTaskCompleted(event: CodexTaskCompletionEvent): Promise<ExecutionRecord> {
    validateCompletion(event);
    const id = `exec_codex_${createHash("sha256")
      .update(`${event.taskId}\u0000${event.iteration}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    return this.store.write({
      id,
      taskId: event.taskId,
      iteration: event.iteration,
      timestamp: new Date().toISOString(),
      changedFiles: event.changedFiles,
      tests: event.tests,
      status: event.status,
      summary: event.summary,
      publicOutput: event.publicOutput && Boolean(event.allowedOutput?.trim()),
      allowedOutput: event.publicOutput ? event.allowedOutput : undefined,
    });
  }
}

function validateCompletion(event: CodexTaskCompletionEvent): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(event.taskId)) throw new Error("execution_task_id_invalid");
  if (!Number.isInteger(event.iteration) || event.iteration < 1 || event.iteration > 1_000_000) throw new Error("execution_iteration_invalid");
  if (event.status !== "PASS" && event.status !== "FAIL" && event.status !== "UNKNOWN") throw new Error("execution_status_invalid");
  if (!Array.isArray(event.changedFiles) || event.changedFiles.length > 200 || event.changedFiles.some((item) => typeof item !== "string" || item.length > 500)) throw new Error("execution_changed_files_invalid");
  if (!Array.isArray(event.tests) || event.tests.length > 100 || event.tests.some((test) => !test || typeof test.category !== "string" || test.category.length > 200 || typeof test.passed !== "boolean")) throw new Error("execution_tests_invalid");
  if (typeof event.summary !== "string" || event.summary.length > 4000) throw new Error("execution_summary_invalid");
  if (typeof event.publicOutput !== "boolean") throw new Error("execution_public_output_invalid");
  if (event.allowedOutput !== undefined && (typeof event.allowedOutput !== "string" || event.allowedOutput.length > 32_000)) throw new Error("execution_allowed_output_invalid");
}
