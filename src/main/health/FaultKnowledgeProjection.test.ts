import { describe, expect, it } from "vitest";
import type { DiagnosticsReport } from "../../shared/types.js";
import type { AuditEntry } from "../audit/AuditChain.js";
import { observeFaults, projectFaultCases } from "./FaultKnowledgeProjection.js";

function report(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  const base = {
    generatedAt: new Date().toISOString(),
    appVersion: "2.0.0",
    osVersion: "test",
    profileMetadata: {
      profileId: "profile-test",
      profileName: "Test",
      profileType: "custom",
      createdAt: new Date().toISOString(),
      currentWorkspaceRoot: "C:\\workspace",
      currentWorkspaceId: "workspace-test",
      transportProvider: "LOCAL_ONLY",
      publicMcpUrl: null,
    },
    readiness: { state: "DEGRADED", layers: {} },
    runtime: { pid: null, port: 48766, identity: null, healthEndpointOk: true, workspaceIdMatches: true, portListening: true },
    transport: {
      provider: "LOCAL_ONLY",
      publicUrl: null,
      edgeConnected: false,
      publicHealthStatus: null,
      publicMcpAnonymous: null,
      oauthDiscoveryOk: false,
      processAlive: false,
      binaryFound: false,
    },
    workspace: { root: "C:\\workspace", workspaceId: "workspace-test", isGitRepo: false },
    repository: { isGitRepo: false, branch: null, dirty: null },
    secretStore: { dpapiOk: false },
    watchdog: { alive: false, lastHeartbeatAt: null },
    supervisor: { alive: false, lastHeartbeatAt: null },
    recentRecoveryActions: [],
    sanitizedLogsTail: [],
  };
  return { ...base, ...overrides } as unknown as DiagnosticsReport;
}

describe("FaultKnowledgeProjection", () => {
  it("records missing workspace identity as an observation, not a root-cause claim", () => {
    const observed = observeFaults(report({
      profileMetadata: {
        profileId: "profile-test",
        profileName: "Test",
        profileType: "custom",
        createdAt: new Date().toISOString(),
        currentWorkspaceRoot: null,
        currentWorkspaceId: null,
        transportProvider: "LOCAL_ONLY",
        publicMcpUrl: null,
      },
      workspace: { root: null, workspaceId: null, isGitRepo: false },
    }), "profile-test");
    const workspace = observed.find((item) => item.code === "WORKSPACE_IDENTITY_UNAVAILABLE");

    expect(workspace?.evidenceCodes).toContain("WORKSPACE_NOT_CONFIGURED");
    expect(workspace?.matchingLessonIds).toEqual(["L31"]);

    const entry = {
      sequence: 1,
      timestamp: new Date().toISOString(),
      previousHash: "0".repeat(64),
      payloadHash: "1".repeat(64),
      payload: { event: "FAULT_CASE_OBSERVED", ...workspace },
    } as AuditEntry;
    const [projected] = projectFaultCases([entry], "", 10).cases;
    expect(projected?.evidenceStatus).toBe("OBSERVED");
    expect(projected?.rootCauseStatus).toBe("CANDIDATE");
  });

  it("records a registered-client OAuth grant gap using only safe evidence codes", () => {
    const observed = observeFaults(report({
      oauthAuthorization: {
        state: "AUTH_REQUIRED",
        activeClientCount: 1,
        validWorkspaceGrant: false,
        observedAt: new Date().toISOString(),
      },
    }), "profile-test");
    const oauth = observed.find((item) => item.code === "OAUTH_AUTH_STATE_UNAVAILABLE");

    expect(oauth?.layer).toBe("connector");
    expect(oauth?.evidenceCodes).toEqual(["OAUTH_GRANT_REQUIRED"]);
    expect(JSON.stringify(oauth)).not.toContain("clientId");
  });
});
