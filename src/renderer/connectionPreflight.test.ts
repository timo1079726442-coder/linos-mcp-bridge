import { describe, expect, it } from "vitest";
import type { ProfileConfig, ReadinessSnapshot } from "../shared/types.js";
import { checkConnectionPreflight, checkLocalIntentPreflight } from "./connectionPreflight.ts";

const readiness: ReadinessSnapshot = {
  overall: "YELLOW",
  lastStateCheckAt: new Date().toISOString(),
  lastFullVerification: null,
  lastError: null,
  layers: {
    runtime: "PASS",
    transport: "NOT_APPLICABLE",
    connector: "UNKNOWN",
    conversation: "UNKNOWN",
    workspace: "PASS",
    repository: "NOT_APPLICABLE",
  },
  c2cFullReady: false,
};

function profile(transport: "LOCAL_ONLY" | "REMOTE"): ProfileConfig {
  return {
    schemaVersion: "2.0.0",
    profileId: "profile-test",
    profileName: "测试配置",
    profileType: "custom",
    createdAt: new Date().toISOString(),
    deviceId: "device-test",
    runtimeId: "runtime-test",
    currentWorkspace: { root: "C:\workspace", workspaceId: "workspace-test" },
    transport: {
      transportId: transport === "REMOTE" ? "transport-test" : null,
      provider: transport === "REMOTE" ? "SECURE_TEST" : "LOCAL_ONLY",
      tunnelName: null,
      tunnelId: null,
      hostname: null,
      zone: null,
      publicMcpUrl: transport === "REMOTE" ? "https://preview.example.test/mcp" : null,
      expectedLocalPort: 48766,
    },
    expectedLocalHost: "127.0.0.1",
    runtime: { source: "PACKAGED_V2", binaryPath: null, entryPath: null },
    trustedRedirectPolicy: { source: "builtin", builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] },
    chatgptLaunchUrl: "https://chatgpt.com",
    healthCheckIntervalSec: 30,
    autoStart: { atLogin: false, minimized: false },
    autoRepair: { policy: "STRICT_FAIL_CLOSED", maxRetriesPerDay: 3, cooldownSec: 300 },
  };
}

describe("connection preflight", () => {
  it("allows a local ConnectionIntent without pretending a public ChatGPT endpoint exists", () => {
    expect(checkLocalIntentPreflight(profile("LOCAL_ONLY"), readiness)).toEqual({ allowed: true, reason: null });
    expect(checkConnectionPreflight(profile("LOCAL_ONLY"), readiness).allowed).toBe(false);
  });

  it("blocks local intent when Runtime health is not fresh and passing", () => {
    const result = checkLocalIntentPreflight(profile("LOCAL_ONLY"), {
      ...readiness,
      layers: { ...readiness.layers, runtime: "FAIL" },
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Runtime");
  });
  it("blocks without a workspace", () => {
    const result = checkConnectionPreflight({ ...profile("LOCAL_ONLY"), currentWorkspace: { root: null, workspaceId: null } }, readiness);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("选择工作区");
  });

  it("explains that LOCAL_ONLY is a Profile configuration, not a Runtime state", () => {
    const result = checkConnectionPreflight(profile("LOCAL_ONLY"), readiness);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Profile 的 Transport 配置");
    expect(result.reason).toContain("本地 Runtime 状态仍需独立判断");
  });

  it("allows the OAuth flow only after a remote transport is verified", () => {
    const result = checkConnectionPreflight(
      profile("REMOTE"),
      { ...readiness, layers: { ...readiness.layers, transport: "PASS" } },
    );
    expect(result).toEqual({ allowed: true, reason: null });
  });

  it("blocks OAuth when the last readiness observation is stale", () => {
    const result = checkConnectionPreflight(
      profile("REMOTE"),
      { ...readiness, lastStateCheckAt: new Date(Date.now() - 61_000).toISOString(), layers: { ...readiness.layers, transport: "PASS" } },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("新鲜检查");
  });
});
