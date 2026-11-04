import { describe, expect, it, vi } from "vitest";
import type { AuditChain, AuditEntry } from "../audit/AuditChain.js";
import type { RecoveryResult } from "../recovery/RecoveryCoordinator.js";
import type { DiagnosticsReport, MatchRepairOptionsRequest, ProfileConfig, RunRepairRequest, SafeFaultCode } from "../../shared/types.js";
import { FaultKnowledgeService, type FaultKnowledgeContext } from "./FaultKnowledgeService.js";
import { faultSignature } from "./FaultKnowledgeProjection.js";

const PROFILE_ID = "profile-v2-test";
const WORKSPACE_ID = "workspace-v2-test";

function makeProfile(profileType: "company" | "custom" = "custom"): ProfileConfig {
  return {
    schemaVersion: "2",
    profileId: PROFILE_ID,
    profileName: "Test Profile",
    profileType,
    createdAt: new Date().toISOString(),
    deviceId: "device-test",
    runtimeId: "runtime-test",
    currentWorkspace: { root: "C:\\workspace-test", workspaceId: WORKSPACE_ID },
    transport: {
      transportId: "transport-test",
      provider: "CLOUDFLARE_NAMED",
      tunnelName: "v2-preview-test",
      tunnelId: "tunnel-test",
      hostname: "c2c-v2-preview.example.com",
      zone: "example.com",
      publicMcpUrl: "https://c2c-v2-preview.example.com/mcp",
      expectedLocalPort: 48766,
      binaryPath: "C:\\V2\\cloudflared.exe",
      credentialPath: "C:\\V2\\tunnel-credentials.json",
    },
    expectedLocalHost: "127.0.0.1",
    runtime: { source: "PACKAGED_V2", binaryPath: null, entryPath: null },
    trustedRedirectPolicy: { source: "test", builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] },
    chatgptLaunchUrl: "https://chatgpt.com",
    healthCheckIntervalSec: 30,
    autoStart: { atLogin: true, minimized: false },
    autoRepair: { policy: "STRICT_FAIL_CLOSED", maxRetriesPerDay: 3, cooldownSec: 300 },
  } as unknown as ProfileConfig;
}

function makeReport(profile: ProfileConfig, code: SafeFaultCode): DiagnosticsReport {
  const runtimeFailed = code === "LOCAL_RUNTIME_NOT_READY";
  return {
    generatedAt: new Date().toISOString(),
    appVersion: "2.0.0",
    osVersion: "test",
    profileMetadata: {
      profileId: profile.profileId,
      profileName: profile.profileName,
      profileType: profile.profileType,
      createdAt: profile.createdAt,
      currentWorkspaceRoot: profile.currentWorkspace.root,
      currentWorkspaceId: profile.currentWorkspace.workspaceId,
      transportProvider: profile.transport.provider,
      publicMcpUrl: profile.transport.publicMcpUrl,
    } as DiagnosticsReport["profileMetadata"],
    readiness: { state: "DEGRADED", layers: {} },
    runtime: {
      pid: null,
      port: 48766,
      identity: { deviceId: "device-test", profileId: PROFILE_ID, runtimeId: "runtime-test", runtimeInstanceId: "instance-test", workspaceId: WORKSPACE_ID },
      healthEndpointOk: !runtimeFailed,
      workspaceIdMatches: true,
      portListening: runtimeFailed ? false : true,
    },
    transport: {
      provider: profile.transport.provider,
      publicUrl: profile.transport.publicMcpUrl,
      edgeConnected: false,
      publicHealthStatus: code === "PUBLIC_530" ? 530 : null,
      publicMcpAnonymous: null,
      oauthDiscoveryOk: false,
      processAlive: true,
      binaryFound: true,
    },
    workspace: { root: profile.currentWorkspace.root, workspaceId: profile.currentWorkspace.workspaceId, isGitRepo: false },
    repository: { isGitRepo: false, branch: null, dirty: null },
    secretStore: { dpapiOk: true },
    watchdog: { alive: false, lastHeartbeatAt: null },
    supervisor: { alive: true, lastHeartbeatAt: null },
    recentRecoveryActions: [],
    sanitizedLogsTail: [],
  } as unknown as DiagnosticsReport;
}

function memoryAudit(seed: AuditEntry[] = []): { api: AuditChain; entries: AuditEntry[] } {
  const entries = [...seed];
  let sequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const api = {
    append: async (payload: Record<string, unknown>): Promise<AuditEntry> => {
      const entry: AuditEntry = {
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        previousHash: "0".repeat(64),
        payloadHash: "1".repeat(64),
        payload,
      };
      entries.push(entry);
      return entry;
    },
    readVerifiedEntries: async (): Promise<AuditEntry[]> => [...entries],
  } as unknown as AuditChain;
  return { api, entries };
}

function createService(options: {
  profile?: ProfileConfig;
  code?: SafeFaultCode;
  recover?: FaultKnowledgeContext["recover"];
  seededEntries?: AuditEntry[];
} = {}) {
  const profile = options.profile ?? makeProfile();
  const code = options.code ?? "PUBLIC_530";
  const report = makeReport(profile, code);
  const { api: audit, entries } = memoryAudit(options.seededEntries);
  const recover = options.recover ?? vi.fn((): Promise<RecoveryResult> | null => null);
  const context: FaultKnowledgeContext = {
    boundProfileId: profile.profileId,
    audit,
    currentProfile: async () => profile,
    diagnostics: async () => report,
    supervisor: {
      getState: () => ({ pid: null }),
      isAlive: () => false,
      ownsLiveChild: () => false,
    } as unknown as FaultKnowledgeContext["supervisor"],
    transport: {
      id: profile.transport.provider === "LOCAL_ONLY" ? "local-only" : "cloudflare-named",
      getStatus: () => ({ running: true }),
    } as unknown as FaultKnowledgeContext["transport"],
    recover,
  };
  return { service: new FaultKnowledgeService(context), profile, report, entries, recover };
}

function signatureFor(profile: ProfileConfig, code: SafeFaultCode): string {
  return faultSignature(profile.profileId, profile.currentWorkspace.workspaceId ?? "no-workspace", code);
}

function repairRequest(profile: ProfileConfig, code: SafeFaultCode, suggestionId: RunRepairRequest["suggestionId"]): RunRepairRequest {
  return {
    signature: signatureFor(profile, code),
    expectedProfileId: profile.profileId,
    expectedWorkspaceId: profile.currentWorkspace.workspaceId,
    diagnosisObservedAt: new Date().toISOString(),
    suggestionId,
  };
}

function matchOptionsRequest(request: RunRepairRequest): MatchRepairOptionsRequest {
  return {
    signature: request.signature,
    expectedProfileId: request.expectedProfileId,
    expectedWorkspaceId: request.expectedWorkspaceId,
    diagnosisObservedAt: request.diagnosisObservedAt,
  };
}

describe("FaultKnowledgeService", () => {
  it("rejects Legacy Profile repair before invoking Recovery", async () => {
    const profile = makeProfile("company");
    const recovery = vi.fn((): Promise<RecoveryResult> | null => null);
    const { service } = createService({ profile, code: "LOCAL_RUNTIME_NOT_READY", recover: recovery });
    const request = repairRequest(profile, "LOCAL_RUNTIME_NOT_READY", "START_PROFILE_RUNTIME");
    const options = await service.matchRepairOptions(matchOptionsRequest(request));

    expect(options.suggestions[0]).toMatchObject({ executable: false, reasonCode: "COMPANY_PROFILE_REPAIR_DISABLED" });
    const result = await service.runRepair(request, "NOT_REQUIRED");
    expect(result.result).toBe("REJECTED");
    expect(recovery).not.toHaveBeenCalled();
  });

  it.each([
    { verified: false, postCheckPassed: false, expectedResult: "FAILED", expectedCheck: "FAIL" },
    { verified: true, postCheckPassed: true, expectedResult: "SUCCEEDED", expectedCheck: "PASS" },
  ] as const)("records repair as $expectedResult only when Recovery verifies the post-check", async ({ verified, postCheckPassed, expectedResult, expectedCheck }) => {
    const recovery = vi.fn(async () => ({
      signal: "Public530",
      action: "NETWORK_RETRY",
      state: verified ? "RECOVERED" : "MANUAL_ACTION_REQUIRED",
      verified,
      reason: "safe-test-result",
      actionAttempted: true,
      actionSucceeded: true,
      postCheckPassed,
    } as RecoveryResult));
    const { service, profile } = createService({ recover: recovery });
    const request = repairRequest(profile, "PUBLIC_530", "RETRY_PUBLIC_530");
    const options = await service.matchRepairOptions(matchOptionsRequest(request));
    expect(options.suggestions[0]?.executable).toBe(true);

    const result = await service.runRepair(request, "NOT_REQUIRED");

    expect(result.result).toBe(expectedResult);
    expect(result.postCheck.state).toBe(expectedCheck);
    expect(recovery).toHaveBeenCalledTimes(1);
    const history = await service.listRepairHistory({ expectedProfileId: profile.profileId });
    expect(history.entries[0]).toMatchObject({ result: expectedResult, postCheck: { state: expectedCheck } });
  });

  it("rejects malformed repair payloads without persisting attacker-controlled text", async () => {
    const { service, entries } = createService();
    const secretLikeValue = "token=must-never-enter-audit";
    const invalid = {
      signature: "fault:v1:" + "a".repeat(64),
      expectedProfileId: PROFILE_ID,
      expectedWorkspaceId: WORKSPACE_ID,
      diagnosisObservedAt: new Date().toISOString(),
      suggestionId: secretLikeValue,
    } as unknown as RunRepairRequest;

    const result = await service.runRepair(invalid, "LOCAL_CONFIRMED");

    expect(result).toMatchObject({ suggestionId: "INVALID_REQUEST", result: "REJECTED", postCheck: { reasonCode: "INVALID_REPAIR_REQUEST" } });
    expect(entries).toHaveLength(0);
    expect(JSON.stringify(entries)).not.toContain(secretLikeValue);
  });

  it("limits each signature and action to three attempts per rolling day", async () => {
    const profile = makeProfile();
    const signature = signatureFor(profile, "PUBLIC_530");
    const now = Date.now();
    const seededEntries: AuditEntry[] = [70_000, 140_000, 210_000].map((age, index) => ({
      sequence: index + 1,
      timestamp: new Date(now - age).toISOString(),
      previousHash: "0".repeat(64),
      payloadHash: "1".repeat(64),
      payload: {
        event: "FAULT_REPAIR_ATTEMPT_STARTED",
        attemptId: `attempt-${index + 1}`,
        signature,
        code: "PUBLIC_530",
        suggestionId: "RETRY_PUBLIC_530",
        evidenceStatus: "CANDIDATE",
      },
    }));
    const { service } = createService({ profile, seededEntries });
    const request = repairRequest(profile, "PUBLIC_530", "RETRY_PUBLIC_530");

    const options = await service.matchRepairOptions(matchOptionsRequest(request));

    expect(options.suggestions[0]).toMatchObject({ executable: false, reasonCode: "REPAIR_BUDGET_EXHAUSTED" });
  });
});
