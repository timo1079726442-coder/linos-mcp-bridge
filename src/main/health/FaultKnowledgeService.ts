import { randomUUID } from "node:crypto";
import type { AuditChain, AuditEntry } from "../audit/AuditChain.js";
import {
  countRecentRepairAttempts,
  hasVerifiedRepair,
  observeFaults,
  projectFaultCases,
  projectRepairHistory,
} from "./FaultKnowledgeProjection.js";
import type {
  DiagnosticsReport,
  FaultCaseView,
  FaultCasesRequest,
  FaultCasesResponse,
  FaultResponseState,
  MatchRepairOptionsRequest,
  MatchRepairOptionsResponse,
  RepairAttemptView,
  RepairHistoryRequest,
  RepairHistoryResponse,
  RepairSuggestionView,
  RunRepairRequest,
  RunRepairResponse,
  SafeFaultCode,
  ProfileConfig,
} from "../../shared/types.js";
import { isRepairSuggestionId, isRunRepairRequest } from "../../shared/types.js";
import type { RecoveryResult } from "../recovery/RecoveryCoordinator.js";
import type { RecoverySignal } from "../recovery/RecoveryEngine.js";
import type { SupervisorProcess } from "../process/SupervisorProcess.js";
import type { TransportProvider } from "../transport/TransportProvider.js";

const SNAPSHOT_TTL_MS = 30_000;
const MAX_REPAIR_ATTEMPTS_PER_DAY = 3;
const REPAIR_COOLDOWN_MS = 60_000;
const PAGE_SIZE_MAX = 50;
const PROJECTION_LIMIT = 10_000;


type NativeConfirmation = "NOT_REQUIRED" | "LOCAL_CONFIRMED" | "LOCAL_CANCELLED";
type RepairRuntime = Pick<SupervisorProcess, "getState" | "isAlive" | "ownsLiveChild">;
type RepairTransport = Pick<TransportProvider, "id" | "getStatus">;

export interface FaultKnowledgeContext {
  /** The immutable Profile that owns this Supervisor and AuditChain instance. */
  boundProfileId: string;
  audit: AuditChain;
  currentProfile: () => Promise<ProfileConfig | null>;
  diagnostics: () => Promise<DiagnosticsReport>;
  supervisor: RepairRuntime;
  transport: RepairTransport;
  recover: (signal: RecoverySignal) => Promise<RecoveryResult> | null;
}

interface RepairDefinition {
  suggestionId: RepairSuggestionView["suggestionId"];
  title: string;
  requiresNativeConfirmation: boolean;
}

const definitionsByCode: Partial<Record<SafeFaultCode, readonly RepairDefinition[]>> = {
  LOCAL_RUNTIME_NOT_READY: [
    { suggestionId: "START_PROFILE_RUNTIME", title: "启动当前 Profile Runtime", requiresNativeConfirmation: false },
  ],
  TUNNEL_PROCESS_MISSING: [
    { suggestionId: "START_PROFILE_TUNNEL", title: "启动当前 Profile Tunnel", requiresNativeConfirmation: true },
  ],
  TUNNEL_EDGE_UNAVAILABLE: [
    { suggestionId: "RESTART_PROFILE_TUNNEL", title: "重启当前 Profile Tunnel", requiresNativeConfirmation: true },
  ],
  PUBLIC_530: [
    { suggestionId: "RETRY_PUBLIC_530", title: "有限重测公网 530", requiresNativeConfirmation: false },
  ],
};

export class FaultKnowledgeService {
  private repairInFlight = false;

  constructor(private readonly ctx: FaultKnowledgeContext) {}

  /** Persist only the fixed, allowlisted observation shape. */
  async recordDiagnostics(report: DiagnosticsReport): Promise<void> {
    const observations = observeFaults(report, this.ctx.boundProfileId);
    for (const observation of observations) {
      await this.ctx.audit.append({
        schemaVersion: 1,
        event: "FAULT_CASE_OBSERVED",
        signature: observation.signature,
        code: observation.code,
        layer: observation.layer,
        evidenceCodes: observation.evidenceCodes,
        matchingLessonIds: observation.matchingLessonIds,
      });
    }
  }

  async listFaultCases(request: FaultCasesRequest): Promise<FaultCasesResponse> {
    const observedAt = new Date().toISOString();
    const profile = await this.safeCurrentProfile();
    if (!profile) return this.emptyCases("UNAVAILABLE", null, observedAt, "ACTIVE_PROFILE_UNAVAILABLE");
    if (request.expectedProfileId && request.expectedProfileId !== profile.profileId) {
      return this.emptyCases("STALE", profile.profileId, observedAt, "PROFILE_CHANGED");
    }

    try {
      const entries = await this.ctx.audit.readVerifiedEntries();
      const page = projectFaultCases(
        entries,
        safeQuery(request.query),
        safeLimit(request.limit),
        parseCursor(request.cursor),
      );
      return {
        state: page.cases.length ? "OK" : "NO_DATA",
        activeProfileId: profile.profileId,
        observedAt,
        staleAfterMs: SNAPSHOT_TTL_MS,
        source: "audit-chain-projection",
        cases: page.cases,
        nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
      };
    } catch {
      return this.emptyCases("UNAVAILABLE", profile.profileId, observedAt, "AUDIT_PROJECTION_UNAVAILABLE");
    }
  }

  async matchRepairOptions(request: MatchRepairOptionsRequest): Promise<MatchRepairOptionsResponse> {
    const observedAt = new Date().toISOString();
    const profile = await this.safeCurrentProfile();
    if (!profile) return this.emptyOptions(request.signature, null, observedAt, "UNAVAILABLE", "ACTIVE_PROFILE_UNAVAILABLE");
    if (!this.requestIdentityMatches(profile, request)) {
      return this.emptyOptions(request.signature, profile.profileId, observedAt, "STALE", "PROFILE_OR_WORKSPACE_CHANGED");
    }
    if (!isFreshTimestamp(request.diagnosisObservedAt, Date.now())) {
      return this.emptyOptions(request.signature, profile.profileId, observedAt, "STALE", "DIAGNOSIS_EXPIRED");
    }

    try {
      const report = await this.ctx.diagnostics();
      await this.recordDiagnostics(report);
      if (!this.reportIdentityMatches(report, profile)) {
        return this.emptyOptions(request.signature, profile.profileId, observedAt, "STALE", "DIAGNOSIS_IDENTITY_MISMATCH");
      }

      const entries = await this.ctx.audit.readVerifiedEntries();
      const currentCase = projectFaultCases(entries, "", PROJECTION_LIMIT).cases
        .find((item) => item.signature === request.signature && item.state === "OPEN");
      if (!currentCase) {
        return this.emptyOptions("", profile.profileId, observedAt, "NO_MATCH", "FAULT_NOT_CURRENT");
      }
      if (!isFreshTimestamp(currentCase.lastSeenAt, Date.now())) {
        return this.emptyOptions(currentCase.signature, profile.profileId, observedAt, "STALE", "FAULT_OBSERVATION_EXPIRED");
      }

      const suggestions = this.buildSuggestions(currentCase, report, profile, entries);
      const executable = suggestions.some((suggestion) => suggestion.executable);
      return {
        state: executable ? "OK" : suggestions.length ? "CANDIDATE_ONLY" : "NO_MATCH",
        signature: currentCase.signature,
        activeProfileId: profile.profileId,
        observedAt,
        staleAfterMs: SNAPSHOT_TTL_MS,
        suggestions,
        ...(suggestions.length ? {} : { reasonCode: "NO_SAFE_REPAIR" }),
      };
    } catch {
      return this.emptyOptions(request.signature, profile.profileId, observedAt, "UNAVAILABLE", "AUDIT_OR_DIAGNOSTICS_UNAVAILABLE");
    }
  }

  async runRepair(request: RunRepairRequest, nativeConfirmation: NativeConfirmation): Promise<RunRepairResponse> {
    if (!isRunRepairRequest(request)) return this.invalidRequestAttempt(request);
    if (this.repairInFlight) {
      return this.transientAttempt(request, "REJECTED", "NOT_STARTED", "REPAIR_ALREADY_RUNNING");
    }
    this.repairInFlight = true;
    try {
      return await this.runRepairLocked(request, nativeConfirmation);
    } finally {
      this.repairInFlight = false;
    }
  }

  async listRepairHistory(request: RepairHistoryRequest): Promise<RepairHistoryResponse> {
    const observedAt = new Date().toISOString();
    const profile = await this.safeCurrentProfile();
    if (!profile) return this.emptyHistory("UNAVAILABLE", null, observedAt, "ACTIVE_PROFILE_UNAVAILABLE");
    if (request.expectedProfileId && request.expectedProfileId !== profile.profileId) {
      return this.emptyHistory("STALE", profile.profileId, observedAt, "PROFILE_CHANGED");
    }

    try {
      const entries = await this.ctx.audit.readVerifiedEntries();
      const page = projectRepairHistory(
        entries,
        safeQuery(request.query),
        safeLimit(request.limit),
        parseCursor(request.cursor),
      );
      return {
        state: page.entries.length ? "OK" : "NO_DATA",
        activeProfileId: profile.profileId,
        observedAt,
        staleAfterMs: SNAPSHOT_TTL_MS,
        source: "audit-chain-projection",
        entries: page.entries,
        nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
      };
    } catch {
      return this.emptyHistory("UNAVAILABLE", profile.profileId, observedAt, "AUDIT_PROJECTION_UNAVAILABLE");
    }
  }

  private async runRepairLocked(request: RunRepairRequest, nativeConfirmation: NativeConfirmation): Promise<RunRepairResponse> {
    const profile = await this.safeCurrentProfile();
    if (!profile) return this.transientAttempt(request, "STALE", "NOT_STARTED", "ACTIVE_PROFILE_UNAVAILABLE");
    if (!this.requestIdentityMatches(profile, request)) {
      return await this.rejectIfKnown(request, profile, "STALE", "PROFILE_OR_WORKSPACE_CHANGED");
    }
    if (!isFreshTimestamp(request.diagnosisObservedAt, Date.now())) {
      return await this.rejectIfKnown(request, profile, "STALE", "DIAGNOSIS_EXPIRED");
    }

    let report: DiagnosticsReport;
    let entries: AuditEntry[];
    let currentCase: FaultCaseView | undefined;
    try {
      report = await this.ctx.diagnostics();
      await this.recordDiagnostics(report);
      entries = await this.ctx.audit.readVerifiedEntries();
      currentCase = projectFaultCases(entries, "", PROJECTION_LIMIT).cases
        .find((item) => item.signature === request.signature && item.state === "OPEN");
    } catch {
      return await this.rejectIfKnown(request, profile, "UNVERIFIED", "DIAGNOSTICS_OR_AUDIT_UNAVAILABLE");
    }
    if (!this.reportIdentityMatches(report, profile) || !currentCase || !isFreshTimestamp(currentCase.lastSeenAt, Date.now())) {
      return await this.rejectIfKnown(request, profile, "STALE", "FAULT_NO_LONGER_CURRENT");
    }

    const suggestion = this.buildSuggestions(currentCase, report, profile, entries)
      .find((item) => item.suggestionId === request.suggestionId);
    if (!suggestion?.executable) {
      return await this.rejectKnown(currentCase, request.suggestionId, "REJECTED", "NOT_STARTED", suggestion?.reasonCode ?? "REPAIR_NOT_ALLOWED");
    }
    if (suggestion.requiresNativeConfirmation && nativeConfirmation !== "LOCAL_CONFIRMED") {
      const result = nativeConfirmation === "LOCAL_CANCELLED" ? "CANCELLED" : "REJECTED";
      return await this.rejectKnown(currentCase, suggestion.suggestionId, result, "NOT_STARTED", "LOCAL_CONFIRMATION_REQUIRED");
    }

    const attemptStats = countRecentRepairAttempts(entries, currentCase.signature, suggestion.suggestionId);
    const now = Date.now();
    if (attemptStats.count >= MAX_REPAIR_ATTEMPTS_PER_DAY) {
      return await this.rejectKnown(currentCase, suggestion.suggestionId, "REJECTED", "NOT_STARTED", "REPAIR_BUDGET_EXHAUSTED");
    }
    if (attemptStats.lastAttemptMs !== null && now - attemptStats.lastAttemptMs < REPAIR_COOLDOWN_MS) {
      return await this.rejectKnown(currentCase, suggestion.suggestionId, "REJECTED", "NOT_STARTED", "RETRY_COOLDOWN_ACTIVE");
    }

    const attemptId = randomUUID();
    let startedAt = new Date().toISOString();
    const evidenceStatus = hasVerifiedRepair(entries, currentCase.signature, suggestion.suggestionId)
      ? "HIGH_CONFIDENCE" as const
      : "CANDIDATE" as const;
    try {
      const started = await this.ctx.audit.append({
        schemaVersion: 1,
        event: "FAULT_REPAIR_ATTEMPT_STARTED",
        attemptId,
        signature: currentCase.signature,
        code: currentCase.code,
        suggestionId: suggestion.suggestionId,
        evidenceStatus,
      });
      startedAt = started.timestamp;
    } catch {
      return this.transientAttempt(request, "UNVERIFIED", "NOT_STARTED", "AUDIT_START_NOT_PERSISTED");
    }

    const signal = recoverySignalFor(suggestion.suggestionId, profile.currentWorkspace.workspaceId);
    let recovery: RecoveryResult | null = null;
    let recoveryUnverified = false;
    try {
      recovery = await this.ctx.recover(signal);
    } catch {
      // Never persist an exception string; the projection stores only a safe reason code.
      recoveryUnverified = true;
    }

    const completedAt = new Date().toISOString();
    const expectedAction = recoveryActionFor(suggestion.suggestionId);
    const actionAttempted = recovery?.actionAttempted === true;
    const actionSucceeded = recovery?.actionSucceeded === true;
    const postCheckPassed = recovery?.postCheckPassed === true;
    const succeeded = recovery?.verified === true && recovery.action === expectedAction && actionAttempted && actionSucceeded && postCheckPassed;
    const result = succeeded ? "SUCCEEDED" : recoveryUnverified ? "UNVERIFIED" : actionAttempted ? "FAILED" : "REJECTED";
    const postCheckState = succeeded ? "PASS" : actionAttempted && actionSucceeded ? "FAIL" : "NOT_RUN";
    const postCheckReason = succeeded
      ? "POST_CHECK_PASSED"
      : recoveryUnverified
        ? "RECOVERY_RESULT_UNVERIFIED"
        : actionAttempted && actionSucceeded
          ? "POST_CHECK_FAILED"
          : actionAttempted
            ? "ACTION_FAILED_BEFORE_POSTCHECK"
            : "ACTION_NOT_STARTED";
    const rollbackState = !succeeded && (actionAttempted || recoveryUnverified) && suggestion.suggestionId === "RESTART_PROFILE_TUNNEL"
      ? "MANUAL_REQUIRED"
      : "NOT_REQUIRED";
    const rollbackReason = rollbackState === "MANUAL_REQUIRED" ? "TUNNEL_RESTART_MAY_REQUIRE_MANUAL_START" : null;

    try {
      await this.ctx.audit.append({
        schemaVersion: 1,
        event: "FAULT_REPAIR_ATTEMPT_COMPLETED",
        attemptId,
        signature: currentCase.signature,
        code: currentCase.code,
        suggestionId: suggestion.suggestionId,
        evidenceStatus,
        result,
        actionState: actionAttempted ? "COMPLETED" : recoveryUnverified ? "STARTED" : "NOT_STARTED",
        reasonCode: postCheckReason,
        postCheckState,
        postCheckAt: completedAt,
        postCheckReason,
        rollbackState,
        rollbackReason,
      });
    } catch {
      return this.transientAttempt(request, "UNVERIFIED", actionAttempted ? "COMPLETED" : "NOT_STARTED", "AUDIT_COMPLETION_NOT_PERSISTED", {
        attemptId,
        signature: currentCase.signature,
        code: currentCase.code,
        evidenceStatus,
        startedAt,
        rollback: { state: "UNKNOWN", reasonCode: "AUDIT_COMPLETION_NOT_PERSISTED" },
      });
    }

    const finalEntries = await this.ctx.audit.readVerifiedEntries().catch(() => []);
    const projected = projectRepairHistory(finalEntries, "", PROJECTION_LIMIT).entries
      .find((item) => item.attemptId === attemptId);
    if (projected) return { ...projected, source: "audit-chain" };

    return this.transientAttempt(request, "UNVERIFIED", actionAttempted ? "COMPLETED" : "NOT_STARTED", "AUDIT_PROJECTION_UNAVAILABLE", {
      attemptId,
      signature: currentCase.signature,
      code: currentCase.code,
      evidenceStatus,
      startedAt: completedAt,
    });
  }

  private buildSuggestions(
    fault: FaultCaseView,
    report: DiagnosticsReport,
    profile: ProfileConfig,
    entries: readonly AuditEntry[],
  ): RepairSuggestionView[] {
    const definitions = definitionsByCode[fault.code] ?? [];
    return definitions.map((definition) => {
      const evidenceStatus = hasVerifiedRepair(entries, fault.signature, definition.suggestionId)
        ? "HIGH_CONFIDENCE" as const
        : "CANDIDATE" as const;
      const safety = this.canRun(definition, fault, report, profile);
      const attempts = countRecentRepairAttempts(entries, fault.signature, definition.suggestionId);
      let reasonCode = safety.reasonCode;
      if (!reasonCode && attempts.count >= MAX_REPAIR_ATTEMPTS_PER_DAY) reasonCode = "REPAIR_BUDGET_EXHAUSTED";
      if (!reasonCode && attempts.lastAttemptMs !== null && Date.now() - attempts.lastAttemptMs < REPAIR_COOLDOWN_MS) {
        reasonCode = "RETRY_COOLDOWN_ACTIVE";
      }
      return {
        suggestionId: definition.suggestionId,
        title: definition.title,
        evidenceStatus,
        matchBasis: evidenceStatus === "HIGH_CONFIDENCE"
          ? ["FAULT_SIGNATURE_MATCH", "PRIOR_POST_CHECK_PASS"]
          : ["FAULT_SIGNATURE_MATCH", "LESSON_REFERENCE"],
        sourceLessonIds: fault.matchingLessonIds,
        risk: definition.requiresNativeConfirmation ? "MANUAL_ONLY" : "LOW",
        executable: reasonCode === null && fault.state === "OPEN",
        reasonCode: reasonCode ?? (fault.state === "OPEN" ? null : "FAULT_ALREADY_RESOLVED"),
        requiresNativeConfirmation: definition.requiresNativeConfirmation,
      };
    });
  }

  private canRun(
    definition: RepairDefinition,
    fault: FaultCaseView,
    report: DiagnosticsReport,
    profile: ProfileConfig,
  ): { reasonCode: string | null } {
    if (profile.profileType === "company") return { reasonCode: "COMPANY_PROFILE_REPAIR_DISABLED" };
    if (!profile.currentWorkspace.root || !profile.currentWorkspace.workspaceId) return { reasonCode: "WORKSPACE_REQUIRED" };
    if (fault.code === "WORKSPACE_IDENTITY_MISMATCH" || fault.code === "PROFILE_IDENTITY_MISMATCH" || fault.code === "ACTIVE_PROFILE_UNRESOLVED") {
      return { reasonCode: "IDENTITY_MISMATCH_REQUIRES_MANUAL_REVIEW" };
    }
    if (report.runtime.workspaceIdMatches === false || report.workspace.workspaceId !== profile.currentWorkspace.workspaceId) {
      return { reasonCode: "WORKSPACE_IDENTITY_MISMATCH" };
    }
    if (report.runtime.identity?.profileId && report.runtime.identity.profileId !== profile.profileId) {
      return { reasonCode: "PROFILE_IDENTITY_MISMATCH" };
    }

    switch (definition.suggestionId) {
      case "START_PROFILE_RUNTIME": {
        const state = this.ctx.supervisor.getState();
        if (report.runtime.port !== profile.transport.expectedLocalPort) {
          return { reasonCode: "PROFILE_PORT_NOT_ALLOWED" };
        }
        if (state.pid !== null || this.ctx.supervisor.isAlive() || this.ctx.supervisor.ownsLiveChild()) {
          return { reasonCode: "RUNTIME_ALREADY_PRESENT" };
        }
        if (report.runtime.portListening !== false) return { reasonCode: "RUNTIME_PORT_OWNER_UNKNOWN" };
        if (report.runtime.healthEndpointOk) return { reasonCode: "RUNTIME_ALREADY_HEALTHY" };
        return { reasonCode: null };
      }
      case "START_PROFILE_TUNNEL": {
        if (!this.isSafeRemoteProfile(profile)) return { reasonCode: "TRANSPORT_PROFILE_NOT_ALLOWED" };
        if (report.runtime.healthEndpointOk !== true) return { reasonCode: "RUNTIME_NOT_READY" };
        if (this.ctx.transport.id === "local-only" || this.ctx.transport.getStatus().running) return { reasonCode: "TRANSPORT_ALREADY_PRESENT" };
        if (report.transport.processAlive !== false || report.transport.binaryFound !== true) return { reasonCode: "TRANSPORT_OWNERSHIP_OR_BINARY_UNVERIFIED" };
        return { reasonCode: null };
      }
      case "RESTART_PROFILE_TUNNEL": {
        if (!this.isSafeRemoteProfile(profile)) return { reasonCode: "TRANSPORT_PROFILE_NOT_ALLOWED" };
        if (report.runtime.healthEndpointOk !== true) return { reasonCode: "RUNTIME_NOT_READY" };
        if (this.ctx.transport.id === "local-only" || !this.ctx.transport.getStatus().running || report.transport.processAlive !== true) {
          return { reasonCode: "TRANSPORT_PROCESS_NOT_OWNED" };
        }
        if (report.transport.edgeConnected) return { reasonCode: "TRANSPORT_EDGE_RECOVERED" };
        return { reasonCode: null };
      }
      case "RETRY_PUBLIC_530": {
        if (!this.isSafeRemoteProfile(profile)) return { reasonCode: "TRANSPORT_PROFILE_NOT_ALLOWED" };
        if (report.runtime.healthEndpointOk !== true) return { reasonCode: "RUNTIME_NOT_READY" };
        if (this.ctx.transport.id === "local-only" || !this.ctx.transport.getStatus().running || report.transport.processAlive !== true) {
          return { reasonCode: "TRANSPORT_PROCESS_NOT_OWNED" };
        }
        if (report.transport.publicHealthStatus !== 530) return { reasonCode: "PUBLIC_530_NO_LONGER_PRESENT" };
        return { reasonCode: null };
      }
      case "INVALID_REQUEST":
        return { reasonCode: "INVALID_REQUEST" };
      default: {
        const exhaustive: never = definition.suggestionId;
        void exhaustive;
        return { reasonCode: "REPAIR_NOT_SUPPORTED" };
      }
    }
  }

  private isSafeRemoteProfile(profile: ProfileConfig): boolean {
    const provider = (profile.transport.provider ?? "").replace(/[-\s]/g, "_").toUpperCase();
    const hostname = (profile.transport.hostname ?? "").toLowerCase();
    const url = (profile.transport.publicMcpUrl ?? "").toLowerCase();
    const tunnel = (profile.transport.tunnelName ?? "").toLowerCase();
    return provider === "CLOUDFLARE_NAMED" &&
      !hostname.includes("mcp-legacy.example.com") &&
      !url.includes("mcp-legacy.example.com") &&
      !tunnel.includes("mcpbridge-tunnel");
  }

  private async rejectIfKnown(
    request: RunRepairRequest,
    profile: ProfileConfig,
    result: "REJECTED" | "CANCELLED" | "STALE" | "UNVERIFIED",
    reasonCode: string,
  ): Promise<RunRepairResponse> {
    if (result === "UNVERIFIED") {
      return this.transientAttempt(request, "UNVERIFIED", "NOT_STARTED", reasonCode);
    }
    try {
      const entries = await this.ctx.audit.readVerifiedEntries();
      const fault = projectFaultCases(entries, "", PROJECTION_LIMIT).cases
        .find((item) => item.signature === request.signature);
      if (!fault) return this.transientAttempt(request, result, "NOT_STARTED", reasonCode);
      return await this.rejectKnown(fault, request.suggestionId, result, "NOT_STARTED", reasonCode);
    } catch {
      return this.transientAttempt(request, "UNVERIFIED", "NOT_STARTED", "AUDIT_PROJECTION_UNAVAILABLE");
    }
  }

  private async rejectKnown(
    fault: FaultCaseView,
    suggestionId: RepairAttemptView["suggestionId"],
    result: "REJECTED" | "CANCELLED" | "STALE" | "UNVERIFIED",
    actionState: RepairAttemptView["actionState"],
    reasonCode: string,
  ): Promise<RunRepairResponse> {
    const attemptId = randomUUID();
    const now = new Date().toISOString();
    const evidenceStatus = "CANDIDATE" as const;
    const safeSuggestionId = isRepairSuggestionId(suggestionId) ? suggestionId : "INVALID_REQUEST";
    try {
      await this.ctx.audit.append({
        schemaVersion: 1,
        event: "FAULT_REPAIR_ATTEMPT_REJECTED",
        attemptId,
        signature: fault.signature,
        code: fault.code,
        suggestionId: safeSuggestionId,
        evidenceStatus,
        result,
        reasonCode: safeReasonCode(reasonCode),
      });
      const entries = await this.ctx.audit.readVerifiedEntries();
      const projected = projectRepairHistory(entries, "", PROJECTION_LIMIT).entries
        .find((item) => item.attemptId === attemptId);
      if (projected) return { ...projected, source: "audit-chain" };
    } catch {
      // Fall through to an explicit unverified response.
    }
    return {
      attemptId,
      signature: fault.signature,
      code: fault.code,
      suggestionId,
      result: "UNVERIFIED",
      actionState,
      evidenceStatus,
      startedAt: now,
      completedAt: now,
      postCheck: { state: "NOT_RUN", observedAt: null, reasonCode: "AUDIT_WRITE_UNVERIFIED" },
      rollback: { state: "UNKNOWN", reasonCode: "AUDIT_WRITE_UNVERIFIED" },
      source: "audit-chain",
    };
  }

  private transientAttempt(
    request: RunRepairRequest,
    result: RepairAttemptView["result"],
    actionState: RepairAttemptView["actionState"],
    reasonCode: string,
    override?: Partial<RepairAttemptView>,
  ): RunRepairResponse {
    const now = new Date().toISOString();
    return {
      attemptId: override?.attemptId ?? randomUUID(),
      signature: override?.signature ?? "",
      code: override?.code ?? "ACTIVE_PROFILE_UNRESOLVED",
      suggestionId: isRepairSuggestionId(request?.suggestionId) ? request.suggestionId : "INVALID_REQUEST",
      result,
      actionState,
      evidenceStatus: override?.evidenceStatus ?? "CANDIDATE",
      startedAt: override?.startedAt ?? now,
      completedAt: now,
      postCheck: { state: "NOT_RUN", observedAt: null, reasonCode: safeReasonCode(reasonCode) },
      rollback: override?.rollback ?? { state: "UNKNOWN", reasonCode: safeReasonCode(reasonCode) },
      source: "audit-chain",
    };
  }

  private invalidRequestAttempt(value: unknown): RunRepairResponse {
    const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const suggestionId = isRepairSuggestionId(candidate.suggestionId) && candidate.suggestionId !== "INVALID_REQUEST"
      ? candidate.suggestionId
      : "INVALID_REQUEST";
    return this.transientAttempt({
      signature: "",
      expectedProfileId: "",
      expectedWorkspaceId: null,
      diagnosisObservedAt: "",
      suggestionId,
    }, "REJECTED", "NOT_STARTED", "INVALID_REPAIR_REQUEST");
  }

  private async safeCurrentProfile(): Promise<ProfileConfig | null> {
    try {
      return await this.ctx.currentProfile();
    } catch {
      return null;
    }
  }

  private requestIdentityMatches(profile: ProfileConfig, request: MatchRepairOptionsRequest): boolean {
    return profile.profileId === request.expectedProfileId &&
      profile.profileId === this.ctx.boundProfileId &&
      profile.currentWorkspace.workspaceId === request.expectedWorkspaceId;
  }

  private reportIdentityMatches(report: DiagnosticsReport, profile: ProfileConfig): boolean {
    return report.profileMetadata?.profileId === profile.profileId &&
      report.workspace.workspaceId === profile.currentWorkspace.workspaceId &&
      report.runtime.workspaceIdMatches !== false &&
      (!report.runtime.identity?.profileId || report.runtime.identity.profileId === profile.profileId);
  }

  private emptyCases(
    state: FaultResponseState,
    activeProfileId: string | null,
    observedAt: string,
    reasonCode: string,
  ): FaultCasesResponse {
    return {
      state,
      activeProfileId,
      observedAt,
      staleAfterMs: SNAPSHOT_TTL_MS,
      source: "audit-chain-projection",
      cases: [],
      nextCursor: null,
      reasonCode,
    };
  }

  private emptyOptions(
    signature: string,
    activeProfileId: string | null,
    observedAt: string,
    state: MatchRepairOptionsResponse["state"],
    reasonCode: string,
  ): MatchRepairOptionsResponse {
    return {
      state,
      signature: safeEchoSignature(signature),
      activeProfileId,
      observedAt,
      staleAfterMs: SNAPSHOT_TTL_MS,
      suggestions: [],
      reasonCode,
    };
  }

  private emptyHistory(
    state: FaultResponseState,
    activeProfileId: string | null,
    observedAt: string,
    reasonCode: string,
  ): RepairHistoryResponse {
    return {
      state,
      activeProfileId,
      observedAt,
      staleAfterMs: SNAPSHOT_TTL_MS,
      source: "audit-chain-projection",
      entries: [],
      nextCursor: null,
      reasonCode,
    };
  }
}

function recoverySignalFor(suggestionId: RepairSuggestionView["suggestionId"], workspaceId: string | null): RecoverySignal {
  switch (suggestionId) {
    case "START_PROFILE_RUNTIME":
      return { signal: "RuntimePIDMissing", layer: "runtime", severity: "high", evidence: { workspaceId } };
    case "START_PROFILE_TUNNEL":
      return { signal: "TunnelProcessMissing", layer: "transport", severity: "high", evidence: { workspaceId } };
    case "RESTART_PROFILE_TUNNEL":
      return { signal: "TunnelEdgeUnhealthy", layer: "transport", severity: "high", evidence: { workspaceId } };
    case "RETRY_PUBLIC_530":
      return { signal: "Public530", layer: "transport", severity: "high", evidence: { workspaceId } };
    case "INVALID_REQUEST":
      return { signal: "Unsupported", layer: "supervisor", severity: "critical", evidence: {} };
    default: {
      const exhaustive: never = suggestionId;
      void exhaustive;
      return { signal: "Unsupported", layer: "supervisor", severity: "critical", evidence: {} };
    }
  }
}

function recoveryActionFor(suggestionId: RepairSuggestionView["suggestionId"]): RecoveryResult["action"] {
  switch (suggestionId) {
    case "START_PROFILE_RUNTIME": return "SPAWN_RUNTIME";
    case "START_PROFILE_TUNNEL": return "SPAWN_TRANSPORT";
    case "RESTART_PROFILE_TUNNEL": return "RESTART_TRANSPORT";
    case "RETRY_PUBLIC_530": return "NETWORK_RETRY";
    case "INVALID_REQUEST": return null;
    default: {
      const exhaustive: never = suggestionId;
      void exhaustive;
      return null;
    }
  }
}

function safeReasonCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : "UNAVAILABLE";
}
function safeQuery(value: string | undefined): string { return typeof value === "string" ? value.trim().slice(0, 80) : ""; }
function safeLimit(value: number | undefined): number { return Number.isInteger(value) ? Math.min(PAGE_SIZE_MAX, Math.max(1, value!)) : 20; }
function parseCursor(value: string | undefined): number {
  if (typeof value !== "string" || !/^\d{1,8}$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}
function isFreshTimestamp(value: string, now: number): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + 5_000 && now - parsed <= SNAPSHOT_TTL_MS;
}
function safeEchoSignature(value: string): string {
  return /^fault:v1:[a-f0-9]{16}(?:\.[a-f0-9]{16}){3}$/.test(value) ? value : "";
}


