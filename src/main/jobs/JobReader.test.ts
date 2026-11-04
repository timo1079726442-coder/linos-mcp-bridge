import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJobConsoleRecord, listJobConsoleRecords, readJobConsoleOutput, requestJobCancel } from "./JobReader.js";

function jobFile(root: string, id: string): string {
  return join(root, "profiles", "mb_pf_jobs", "jobs", "ws_jobs", `${id}.json`);
}

function writeJob(root: string, record: Record<string, unknown>): void {
  const dir = join(root, "profiles", "mb_pf_jobs", "jobs", "ws_jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(jobFile(root, String(record.id)), JSON.stringify(record), "utf8");
}

function baseRecord(id: string, state: string): Record<string, unknown> {
  return {
    id,
    spec: {
      kind: "execute_command",
      label: "smoke",
      argv: ["node", "--version"],
      display: "node --version",
      cwdInput: ".",
      cwdAbsolute: "/tmp",
      cwdDisplay: ".",
      timeoutMs: 30000,
      clientId: "client-jobs",
      workspaceId: "ws_jobs",
    },
    state,
    attempts: 1,
    history: [],
    pid: state === "RUNNING" ? 4242 : null,
    runnerPid: process.pid,
    exitCode: state === "SUCCEEDED" ? 0 : null,
    durationMs: 12,
    timedOut: false,
    cancelRequested: false,
    outputBytes: 4,
    truncatedOutput: false,
    lastHeartbeatAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
    checkpoints: [{ at: new Date().toISOString(), message: "started" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: state === "RUNNING" ? null : new Date().toISOString(),
  };
}

describe("job console reader", () => {
  it("lists metadata without command bodies or secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2c-jobs-reader-"));
    writeJob(root, baseRecord("job_0123456789abcdef01234567", "SUCCEEDED"));
    const rows = await listJobConsoleRecords(root, "mb_pf_jobs", "ws_jobs", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "job_0123456789abcdef01234567", state: "SUCCEEDED", kind: "execute_command" });
    expect(JSON.stringify(rows[0])).not.toContain("node --version");
  });

  it("reads bounded output and requests cancellation through durable state", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2c-jobs-cancel-"));
    writeJob(root, baseRecord("job_0123456789abcdef01234568", "RUNNING"));
    const dir = join(root, "profiles", "mb_pf_jobs", "jobs", "ws_jobs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "job_0123456789abcdef01234568.log"), "partial-output", "utf8");
    const output = await readJobConsoleOutput(root, "mb_pf_jobs", "ws_jobs", "job_0123456789abcdef01234568", 0, 8);
    expect(output).toMatchObject({ nextOffset: 8, eof: false });
    expect(output.output).toBe("partial-");
    const cancelled = await requestJobCancel(root, "mb_pf_jobs", "ws_jobs", "job_0123456789abcdef01234568");
    expect(cancelled.cancelRequested).toBe(true);
  });

  it("rejects invalid identities and terminal jobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "c2c-jobs-invalid-"));
    await expect(listJobConsoleRecords(root, "mb_pf_jobs", "../escape", 10)).rejects.toThrow("JOB_WORKSPACE_INVALID");
    await expect(getJobConsoleRecord(root, "mb_pf_jobs", "ws_jobs", "nope")).rejects.toThrow("JOB_ID_INVALID");
    writeJob(root, baseRecord("job_0123456789abcdef01234569", "SUCCEEDED"));
    await expect(requestJobCancel(root, "mb_pf_jobs", "ws_jobs", "job_0123456789abcdef01234569")).rejects.toThrow("JOB_NOT_RUNNING");
  });
});
