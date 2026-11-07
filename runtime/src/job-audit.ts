import type { JobRecord } from "./job-store.js";

export async function appendJobAudit(profileDir: string, record: JobRecord, operationId = record.spec.auditOperationId): Promise<void> {
  if (!operationId) return;
  const { appendToolAuditResult } = await import("./tool-audit.js");
  await appendToolAuditResult(profileDir, record.spec.workspaceId, {
    tool: "start_job",
    ok: record.state === "SUCCEEDED",
    durationMs: record.durationMs,
    path: record.id,
    bytes: record.outputBytes,
    errorCode: record.errorCode,
  }, operationId);
}
