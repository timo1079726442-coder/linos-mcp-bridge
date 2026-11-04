import { createHash } from "node:crypto";
import type { AuditEntry } from "../audit/AuditChain.js";
import type {
  DiagnosticsReport,
  FaultCaseView,
  RepairAttemptView,
  SafeFaultCode,
} from "../../shared/types.js";

export interface FaultObservation {
  signature: string;
  code: SafeFaultCode;
  layer: FaultCaseView["layer"];
  evidenceCodes: string[];
  matchingLessonIds: string[];
}

export const lessonIdsByFault: Readonly<Record<SafeFaultCode, readonly string[]>> = {
  ACTIVE_PROFILE_UNRESOLVED: ["L31"],
  PROFILE_IDENTITY_MISMATCH: ["L05", "L31"],
  LOCAL_RUNTIME_NOT_READY: ["L03", "L21", "L23"],
  PORT_LISTENER_OWNER_UNKNOWN: ["L09", "L12"],
  TUNNEL_PROCESS_MISSING: ["L02", "L32"],
  TUNNEL_EDGE_UNAVAILABLE: ["L02", "L22", "L32"],
  PUBLIC_530: ["L22", "L25", "L26"],
  PUBLIC_OAUTH_DISCOVERY_UNVERIFIED: ["L25", "L26"],
  WORKSPACE_IDENTITY_UNAVAILABLE: ["L31"],
  WORKSPACE_IDENTITY_MISMATCH: ["L05", "L31"],
  OAUTH_AUTH_STATE_UNAVAILABLE: ["L07", "L17", "L18"],
};

const safeFaultCodes = new Set<SafeFaultCode>([
  "ACTIVE_PROFILE_UNRESOLVED",
  "PROFILE_IDENTITY_MISMATCH",
  "LOCAL_RUNTIME_NOT_READY",
  "PORT_LISTENER_OWNER_UNKNOWN",
  "TUNNEL_PROCESS_MISSING",
  "TUNNEL_EDGE_UNAVAILABLE",
  "PUBLIC_530",
  "PUBLIC_OAUTH_DISCOVERY_UNVERIFIED",
  "WORKSPACE_IDENTITY_UNAVAILABLE",
  "WORKSPACE_IDENTITY_MISMATCH",
  "OAUTH_AUTH_STATE_UNAVAILABLE",
]);

const safeEvidenceCodes = new Set([
  "PROFILE_NOT_RESOLVED",
  "PROFILE_IDENTITY_MISMATCH",
  "RUNTIME_HEALTH_FAILED",
  "RUNTIME_PID_MISSING",
  "PORT_LISTENER_PRESENT",
  "PORT_LISTENER_ABSENT",
  "PORT_LISTENER_UNKNOWN",
  "TUNNEL_PROCESS_MISSING",
  "TUNNEL_EDGE_DISCONNECTED",
  "HTTP_530",
  "OAUTH_DISCOVERY_FAILED",
  "OAUTH_STATE_UNAVAILABLE",
  "OAUTH_GRANT_REQUIRED",
  "OAUTH_GRANT_REVOKED",
  "OAUTH_GRANT_EXPIRED",
  "WORKSPACE_NOT_CONFIGURED",
  "WORKSPACE_IDENTITY_UNAVAILABLE",
  "WORKSPACE_IDENTITY_MISMATCH",
]);

const safeSuggestionIds = new Set<RepairAttemptView["suggestionId"]>([
  "START_PROFILE_RUNTIME",
  "START_PROFILE_TUNNEL",
  "RESTART_PROFILE_TUNNEL",
  "RETRY_PUBLIC_530",
  "INVALID_REQUEST",
]);

export function normalizeProvider(provider: string | null | undefined): string {
  return (provider ?? "").replace(/[-\s]/g, "_").toUpperCase();
}

export function observeFaults(report: DiagnosticsReport, profileId: string): FaultObservation[] {
  const result: FaultObservation[] = [];
  const profile = report.profileMetadata;
  const expectedWorkspaceId = profile?.currentWorkspaceId ?? null;
  const observedWorkspaceId = report.workspace.workspaceId;
  const workspaceScope = expectedWorkspaceId ?? observedWorkspaceId ?? "no-workspace";
  const add = (code: SafeFaultCode, layer: FaultCaseView["layer"], evidenceCodes: string[]): void => {
    result.push({
      signature: faultSignature(profileId, workspaceScope, code),
      code,
      layer,
      evidenceCodes: evidenceCodes.filter((value) => safeEvidenceCodes.has(value)),
      matchingLessonIds: [...lessonIdsByFault[code]],
    });
  };

  if (!profile) {
    add("ACTIVE_PROFILE_UNRESOLVED", "profile", ["PROFILE_NOT_RESOLVED"]);
    return result;
  }
  if (profile.profileId !== profileId || (report.runtime.identity?.profileId && report.runtime.identity.profileId !== profileId)) {
    add("PROFILE_IDENTITY_MISMATCH", "profile", ["PROFILE_IDENTITY_MISMATCH"]);
  }

  const workspaceConfigured = Boolean(profile.currentWorkspaceRoot && expectedWorkspaceId);
  const workspaceObserved = Boolean(report.workspace.root && observedWorkspaceId);
  if (!workspaceConfigured || !workspaceObserved) {
    add("WORKSPACE_IDENTITY_UNAVAILABLE", "workspace", [
      workspaceConfigured ? "WORKSPACE_IDENTITY_UNAVAILABLE" : "WORKSPACE_NOT_CONFIGURED",
    ]);
  } else if (expectedWorkspaceId !== observedWorkspaceId || report.runtime.workspaceIdMatches === false) {
    add("WORKSPACE_IDENTITY_MISMATCH", "workspace", ["WORKSPACE_IDENTITY_MISMATCH"]);
  }

  const oauthState = report.oauthAuthorization?.state;
  const oauthEvidenceCode = oauthState === "AUTH_REQUIRED"
    ? "OAUTH_GRANT_REQUIRED"
    : oauthState === "REVOKED"
      ? "OAUTH_GRANT_REVOKED"
      : oauthState === "EXPIRED"
        ? "OAUTH_GRANT_EXPIRED"
        : oauthState === "UNKNOWN"
          ? "OAUTH_STATE_UNAVAILABLE"
          : null;
  if (oauthEvidenceCode) add("OAUTH_AUTH_STATE_UNAVAILABLE", "connector", [oauthEvidenceCode]);

  if (report.runtime.port !== null && !report.runtime.healthEndpointOk) {
    if (report.runtime.portListening === true) {
      add("PORT_LISTENER_OWNER_UNKNOWN", "runtime", ["RUNTIME_HEALTH_FAILED", "PORT_LISTENER_PRESENT"]);
    } else {
      add("LOCAL_RUNTIME_NOT_READY", "runtime", [
        "RUNTIME_HEALTH_FAILED",
        report.runtime.pid === null ? "RUNTIME_PID_MISSING" : "PORT_LISTENER_UNKNOWN",
        report.runtime.portListening === false ? "PORT_LISTENER_ABSENT" : "PORT_LISTENER_UNKNOWN",
      ]);
    }
  }

  const remote = normalizeProvider(profile.transportProvider ?? report.transport.provider) === "CLOUDFLARE_NAMED";
  if (remote) {
    if (report.transport.processAlive === false) {
      add("TUNNEL_PROCESS_MISSING", "transport", ["TUNNEL_PROCESS_MISSING"]);
    } else if (!report.transport.edgeConnected) {
      add("TUNNEL_EDGE_UNAVAILABLE", "transport", ["TUNNEL_EDGE_DISCONNECTED"]);
    }
    if (report.transport.publicHealthStatus === 530) add("PUBLIC_530", "transport", ["HTTP_530"]);
    if (report.transport.publicHealthStatus === 200 && !report.transport.oauthDiscoveryOk) {
      add("PUBLIC_OAUTH_DISCOVERY_UNVERIFIED", "connector", ["OAUTH_DISCOVERY_FAILED"]);
    }
  }

  return result;
}

export function faultSignature(profileId: string, workspaceId: string, code: SafeFaultCode): string {
  const digest = createHash("sha256")
    .update(`fault-signature:v1\0${profileId}\0${workspaceId}\0${code}`)
    .digest("hex");
  return `fault:v1:${digest}`;
}

export function projectFaultCases(
  entries: readonly AuditEntry[],
  query: string,
  limit: number,
  offset = 0,
): { cases: FaultCaseView[]; nextOffset: number | null } {
  const grouped = new Map<string, FaultCaseView & { lastSequence: number; lastRepairSequence: number }>();

  for (const entry of entries) {
    const payload = entry.payload;
    const event = safeString(payload.event);
    if (event === "FAULT_CASE_OBSERVED") {
      const signature = safeSignature(payload.signature);
      const code = safeFaultCode(payload.code);
      if (!signature || !code) continue;
      const layer = safeLayer(payload.layer);
      const evidenceCodes = safeStringArray(payload.evidenceCodes, safeEvidenceCodes);
      const matchingLessonIds = safeLessonIds(payload.matchingLessonIds);
      const current = grouped.get(signature);
      if (current) {
        current.lastSeenAt = entry.timestamp;
        current.occurrenceCount += 1;
        current.evidenceCodes = evidenceCodes;
        current.matchingLessonIds = matchingLessonIds;
        current.state = "OPEN";
        current.lastSequence = entry.sequence;
      } else {
        grouped.set(signature, {
          signature,
          code,
          layer,
          state: "OPEN",
          evidenceStatus: "OBSERVED",
          rootCauseStatus: "CANDIDATE",
          firstSeenAt: entry.timestamp,
          lastSeenAt: entry.timestamp,
          occurrenceCount: 1,
          evidenceCodes,
          matchingLessonIds,
          latestRepairAttemptId: null,
          lastSequence: entry.sequence,
          lastRepairSequence: 0,
        });
      }
    } else if (event === "FAULT_REPAIR_ATTEMPT_STARTED" || event === "FAULT_REPAIR_ATTEMPT_REJECTED" || event === "FAULT_REPAIR_ATTEMPT_COMPLETED") {
      const signature = safeSignature(payload.signature);
      const attemptId = safeId(payload.attemptId);
      if (!signature || !attemptId) continue;
      const current = grouped.get(signature);
      if (current && entry.sequence >= current.lastRepairSequence) {
        current.latestRepairAttemptId = attemptId;
        current.lastRepairSequence = entry.sequence;
        if (event === "FAULT_REPAIR_ATTEMPT_COMPLETED" && payload.result === "SUCCEEDED" && payload.postCheckState === "PASS" && entry.sequence >= current.lastSequence) {
          current.state = "RESOLVED";
        }
      }
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase().slice(0, 80);
  const all = [...grouped.values()]
    .filter((item) => !normalizedQuery || [item.code, ...item.evidenceCodes, ...item.matchingLessonIds].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .map(({ lastSequence: _lastSequence, lastRepairSequence: _lastRepairSequence, ...item }) => item);
  const page = all.slice(offset, offset + limit);
  return { cases: page, nextOffset: offset + limit < all.length ? offset + limit : null };
}

export function projectRepairHistory(entries: readonly AuditEntry[], query: string, limit: number, offset = 0): { entries: RepairAttemptView[]; nextOffset: number | null } {
  const attempts = new Map<string, RepairAttemptView>();
  for (const entry of entries) {
    const payload = entry.payload;
    const event = safeString(payload.event);
    if (event !== "FAULT_REPAIR_ATTEMPT_STARTED" && event !== "FAULT_REPAIR_ATTEMPT_REJECTED" && event !== "FAULT_REPAIR_ATTEMPT_COMPLETED") continue;
    const attemptId = safeId(payload.attemptId);
    const signature = safeSignature(payload.signature);
    const code = safeFaultCode(payload.code);
    const suggestionId = safeSuggestionId(payload.suggestionId);
    if (!attemptId || !signature || !code || !suggestionId) continue;

    const previous = attempts.get(attemptId);
    const startedAt = previous?.startedAt ?? (event === "FAULT_REPAIR_ATTEMPT_STARTED" ? entry.timestamp : entry.timestamp);
    const result = event === "FAULT_REPAIR_ATTEMPT_COMPLETED"
      ? safeRepairResult(payload.result)
      : event === "FAULT_REPAIR_ATTEMPT_REJECTED" ? safeRejectedResult(payload.result) : "STARTED";
    attempts.set(attemptId, {
      attemptId,
      signature,
      code,
      suggestionId,
      result,
      actionState: event === "FAULT_REPAIR_ATTEMPT_COMPLETED"
        ? safeActionState(payload.actionState)
        : event === "FAULT_REPAIR_ATTEMPT_STARTED" ? "STARTED" : "NOT_STARTED",
      evidenceStatus: safeEvidenceStatus(payload.evidenceStatus) ?? previous?.evidenceStatus ?? "CANDIDATE",
      startedAt,
      completedAt: event === "FAULT_REPAIR_ATTEMPT_COMPLETED" || event === "FAULT_REPAIR_ATTEMPT_REJECTED" ? entry.timestamp : null,
      postCheck: event === "FAULT_REPAIR_ATTEMPT_COMPLETED"
        ? { state: safePostCheckState(payload.postCheckState), observedAt: safeIso(payload.postCheckAt), reasonCode: safeCode(payload.postCheckReason) }
        : previous?.postCheck ?? { state: "NOT_RUN", observedAt: null, reasonCode: event === "FAULT_REPAIR_ATTEMPT_STARTED" ? "AWAITING_POST_CHECK" : "NOT_STARTED" },
      rollback: event === "FAULT_REPAIR_ATTEMPT_COMPLETED"
        ? { state: safeRollbackState(payload.rollbackState), reasonCode: safeCode(payload.rollbackReason) || null }
        : previous?.rollback ?? { state: event === "FAULT_REPAIR_ATTEMPT_STARTED" ? "UNKNOWN" : "NOT_REQUIRED", reasonCode: event === "FAULT_REPAIR_ATTEMPT_STARTED" ? "ATTEMPT_INCOMPLETE" : null },
    });
  }

  const normalizedQuery = query.trim().toLocaleLowerCase().slice(0, 80);
  const all = [...attempts.values()]
    .filter((item) => !normalizedQuery || [item.code, item.suggestionId, item.result, item.postCheck.reasonCode].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const page = all.slice(offset, offset + limit);
  return { entries: page, nextOffset: offset + limit < all.length ? offset + limit : null };
}

export function hasVerifiedRepair(entries: readonly AuditEntry[], signature: string, suggestionId: RepairAttemptView["suggestionId"]): boolean {
  return entries.some(({ payload }) => payload.event === "FAULT_REPAIR_ATTEMPT_COMPLETED" && payload.signature === signature && payload.suggestionId === suggestionId && payload.result === "SUCCEEDED" && payload.postCheckState === "PASS");
}

export function countRecentRepairAttempts(entries: readonly AuditEntry[], signature: string, suggestionId: RepairAttemptView["suggestionId"], nowMs = Date.now()): { count: number; lastAttemptMs: number | null } {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  const times = entries
    .filter(({ payload }) => payload.event === "FAULT_REPAIR_ATTEMPT_STARTED" && payload.signature === signature && payload.suggestionId === suggestionId)
    .map(({ timestamp }) => Date.parse(timestamp))
    .filter((value) => Number.isFinite(value) && value >= cutoff && value <= nowMs)
    .sort((a, b) => a - b);
  return { count: times.length, lastAttemptMs: times.at(-1) ?? null };
}

function safeString(value: unknown): string { return typeof value === "string" ? value : ""; }
function safeSignature(value: unknown): string | null { return typeof value === "string" && /^fault:v1:[a-f0-9]{64}$/.test(value) ? value : null; }
function safeId(value: unknown): string | null { return typeof value === "string" && /^[a-z0-9_-]{8,80}$/i.test(value) ? value : null; }
function safeFaultCode(value: unknown): SafeFaultCode | null { return typeof value === "string" && safeFaultCodes.has(value as SafeFaultCode) ? value as SafeFaultCode : null; }
function safeLayer(value: unknown): FaultCaseView["layer"] { return value === "runtime" || value === "transport" || value === "connector" || value === "workspace" || value === "profile" ? value : "runtime"; }
function safeSuggestionId(value: unknown): RepairAttemptView["suggestionId"] | null { return typeof value === "string" && safeSuggestionIds.has(value as RepairAttemptView["suggestionId"]) ? value as RepairAttemptView["suggestionId"] : null; }
function safeStringArray(value: unknown, allowlist: ReadonlySet<string>): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && allowlist.has(item)))] : []; }
function safeLessonIds(value: unknown): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^L\d{2}$/.test(item)))].slice(0, 8) : []; }
function safeEvidenceStatus(value: unknown): RepairAttemptView["evidenceStatus"] | null { return value === "CANDIDATE" || value === "HIGH_CONFIDENCE" ? value : null; }
function safeRepairResult(value: unknown): RepairAttemptView["result"] { return value === "SUCCEEDED" || value === "FAILED" || value === "REJECTED" || value === "CANCELLED" || value === "STALE" ? value : "FAILED"; }
function safeRejectedResult(value: unknown): RepairAttemptView["result"] { return value === "CANCELLED" || value === "STALE" ? value : "REJECTED"; }
function safeActionState(value: unknown): RepairAttemptView["actionState"] { return value === "NOT_STARTED" || value === "STARTED" ? value : "COMPLETED"; }
function safePostCheckState(value: unknown): RepairAttemptView["postCheck"]["state"] { return value === "PASS" || value === "FAIL" ? value : "NOT_RUN"; }
function safeRollbackState(value: unknown): RepairAttemptView["rollback"]["state"] { return value === "COMPLETED" || value === "FAILED" || value === "MANUAL_REQUIRED" || value === "UNKNOWN" ? value : "NOT_REQUIRED"; }
function safeCode(value: unknown): string { return typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value) ? value : "unavailable"; }
function safeIso(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null; }
