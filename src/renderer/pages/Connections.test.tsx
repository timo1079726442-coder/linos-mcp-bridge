import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "./Connections.tsx";
import type {
  DiagnosticsReport,
  MatchRepairOptionsResponse,
  ProfileConfig,
  RunRepairResponse,
} from "../../shared/types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

async function mount(element: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return host;
}

async function clickButton(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  if (!button) throw new Error(`BUTTON_NOT_FOUND:${testId}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => {
    for (const item of mounted) item.root.unmount();
  });
  for (const item of mounted) mounted.shift();
  mounted.length = 0;
  vi.restoreAllMocks();
  delete (globalThis as { c2c?: unknown }).c2c;
});

function setC2C(impl: {
  profile: { getActive: () => Promise<ProfileConfig> };
  diagnostics: {
    run: () => Promise<DiagnosticsReport>;
    matchRepairOptions: (params: unknown) => Promise<MatchRepairOptionsResponse>;
    runRepair: (params: unknown) => Promise<RunRepairResponse>;
  };
  intent: { create: () => Promise<unknown>; openChatgpt: () => Promise<unknown> };
}): void {
  const previous = ((globalThis as unknown as { c2c?: { [k: string]: unknown } }).c2c) ?? {};
  (globalThis as unknown as { c2c: { [k: string]: unknown } }).c2c = { ...previous, ...impl };
}

function profile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    schemaVersion: "2",
    profileId: "profile-a",
    profileName: "Synthetic",
    profileType: "custom",
    createdAt: "2026-10-14T00:00:00.000Z",
    deviceId: "device-a",
    runtimeId: "runtime-a",
    currentWorkspace: { root: "C:/workspace-a", workspaceId: "workspace-a" },
    transport: {
      transportId: null,
      provider: "CLOUDFLARE_NAMED",
      tunnelName: "c2c-v2-preview",
      tunnelId: "10f40b43-8ab0-4b2c-b68f-2c2dea48b866",
      hostname: "c2c-v2-preview.example.com",
      zone: null,
      publicMcpUrl: "https://c2c-v2-preview.example.com/mcp",
      expectedLocalPort: 48766,
    },
    expectedLocalHost: "127.0.0.1",
    runtime: { source: "PACKAGED_V2", binaryPath: null, entryPath: null },
    trustedRedirectPolicy: { source: "builtin", builtinOrigins: [], userApprovedOrigins: [], signedPolicyUpdates: [] },
    chatgptLaunchUrl: "https://chatgpt.com",
    healthCheckIntervalSec: 30,
    autoStart: { atLogin: false, minimized: true },
    autoRepair: { policy: "STRICT_FAIL_CLOSED", maxRetriesPerDay: 2, cooldownSec: 60 },
    ...overrides,
  };
}

function report(overrides: Partial<DiagnosticsReport["transport"]> = {}): DiagnosticsReport {
  return {
    generatedAt: new Date().toISOString(),
    appVersion: "test",
    osVersion: "test",
    profileMetadata: {
      profileId: "profile-a",
      profileName: "Synthetic",
      profileType: "custom",
      createdAt: "2026-10-14T00:00:00.000Z",
      currentWorkspaceRoot: "C:/workspace-a",
      currentWorkspaceId: "workspace-a",
      transportProvider: "CLOUDFLARE_NAMED",
      publicMcpUrl: "https://c2c-v2-preview.example.com/mcp",
    },
    transport: {
      provider: "CLOUDFLARE_NAMED",
      publicUrl: "https://c2c-v2-preview.example.com",
      edgeConnected: false,
      publicHealthStatus: 530,
      publicMcpAnonymous: 401,
      oauthDiscoveryOk: true,
      processAlive: true,
      binaryFound: true,
      binaryPath: "C:/tools/cloudflared.exe",
      ...overrides,
    } as DiagnosticsReport["transport"],
    readiness: {
      overall: "YELLOW",
      lastStateCheckAt: new Date().toISOString(),
      lastFullVerification: null,
      lastError: null,
      layers: {
        runtime: "PASS",
        transport: "FAIL",
        connector: "UNKNOWN",
        conversation: "UNKNOWN",
        workspace: "UNKNOWN",
        repository: "UNKNOWN",
      },
      c2cFullReady: false,
    },
    runtime: {
      pid: null,
      port: 48766,
      identity: null,
      healthEndpointOk: false,
    },
    oauthAuthorization: {
      state: "AUTH_REQUIRED",
      activeClientCount: 0,
      validWorkspaceGrant: false,
      observedAt: new Date().toISOString(),
    },
    workspace: { root: "C:/workspace-a", workspaceId: "workspace-a", isGitRepo: false },
    repository: { isGitRepo: false, branch: null, dirty: null },
    secretStore: { dpapiOk: false, encryptionBackend: "aes-gcm-fallback" },
    watchdog: { alive: false, lastHeartbeatAt: null, status: "NOT_STARTED" },
    supervisor: { alive: false, lastHeartbeatAt: null, pid: null, startedAt: null, commandImage: null },
    recentRecoveryActions: [],
    sanitizedLogsTail: [],
  };
}

function emptyMatchResponse(): MatchRepairOptionsResponse {
  return {
    state: "OK",
    signature: "fault:v1:" + "0".repeat(64),
    activeProfileId: "profile-a",
    observedAt: new Date().toISOString(),
    staleAfterMs: 60_000,
    suggestions: [],
  };
}

function restartMatchResponse(): MatchRepairOptionsResponse {
  return {
    state: "OK",
    signature: "fault:v1:" + "0".repeat(64),
    activeProfileId: "profile-a",
    observedAt: new Date().toISOString(),
    staleAfterMs: 60_000,
    suggestions: [
      {
        suggestionId: "RESTART_PROFILE_TUNNEL",
        title: "重启当前 Profile Tunnel",
        evidenceStatus: "HIGH_CONFIDENCE",
        matchBasis: [],
        sourceLessonIds: [],
        risk: "LOW",
        executable: true,
        reasonCode: null,
        requiresNativeConfirmation: true,
      },
    ],
  };
}

describe("ConnectionsPage tunnel self-heal button", () => {
  beforeEach(() => {
    delete (globalThis as { c2c?: unknown }).c2c;
  });

  it("renders the button on the tunnel view when the remote transport is unhealthy", async () => {
    setC2C({
      profile: { getActive: () => Promise.resolve(profile()) },
      diagnostics: {
        run: () => Promise.resolve(report()),
        matchRepairOptions: () => Promise.resolve(emptyMatchResponse()),
        runRepair: () => Promise.resolve({} as unknown as RunRepairResponse),
      },
      intent: { create: () => Promise.resolve({}), openChatgpt: () => Promise.resolve({}) },
    });
    const host = await mount(<ConnectionsPage view="tunnel" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="btn-tunnel-self-heal"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="btn-refresh-connections"]')).toBeTruthy();
  });

  it("hides the button for company profiles", async () => {
    setC2C({
      profile: { getActive: () => Promise.resolve(profile({ profileType: "remote" })) },
      diagnostics: {
        run: () => Promise.resolve(report()),
        matchRepairOptions: () => Promise.resolve(emptyMatchResponse()),
        runRepair: () => Promise.resolve({} as unknown as RunRepairResponse),
      },
      intent: { create: () => Promise.resolve({}), openChatgpt: () => Promise.resolve({}) },
    });
    const host = await mount(<ConnectionsPage view="tunnel" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="btn-refresh-connections"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="btn-tunnel-self-heal"]')).toBeNull();
  });

  it("hides the button for local-only transport profiles", async () => {
    setC2C({
      profile: {
        getActive: () => Promise.resolve(
          profile({
            transport: {
              transportId: null,
              provider: "LOCAL_ONLY",
              tunnelName: null,
              tunnelId: null,
              hostname: null,
              zone: null,
              publicMcpUrl: null,
              expectedLocalPort: 48766,
            },
          }),
        ),
      },
      diagnostics: {
        run: () => Promise.resolve(report({ provider: "LOCAL_ONLY" })),
        matchRepairOptions: () => Promise.resolve(emptyMatchResponse()),
        runRepair: () => Promise.resolve({} as unknown as RunRepairResponse),
      },
      intent: { create: () => Promise.resolve({}), openChatgpt: () => Promise.resolve({}) },
    });
    const host = await mount(<ConnectionsPage view="tunnel" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="btn-tunnel-self-heal"]')).toBeNull();
  });

  it("invokes runRepair with RESTART_PROFILE_TUNNEL and reports REJECTED gracefully", async () => {
    const run = vi.fn(async () => Promise.resolve(report()));
    const match = vi.fn(async () => Promise.resolve(restartMatchResponse()));
    const repair = vi.fn(async (): Promise<RunRepairResponse> => ({
      attemptId: "att-1",
      signature: "fault:v1:" + "0".repeat(64),
      code: "TUNNEL_EDGE_UNAVAILABLE",
      suggestionId: "RESTART_PROFILE_TUNNEL",
      result: "REJECTED",
      actionState: "NOT_STARTED",
      evidenceStatus: "CANDIDATE",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      postCheck: { state: "NOT_RUN", observedAt: null, reasonCode: "REPAIR_REJECTED" },
      rollback: { state: "NOT_REQUIRED", reasonCode: null },
      source: "audit-chain",
    }));
    setC2C({
      profile: { getActive: () => Promise.resolve(profile()) },
      diagnostics: { run, matchRepairOptions: match, runRepair: repair },
      intent: { create: () => Promise.resolve({}), openChatgpt: () => Promise.resolve({}) },
    });
    const host = await mount(<ConnectionsPage view="tunnel" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await clickButton(host, "btn-tunnel-self-heal");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(match).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
    const call = (repair.mock.calls[0] as unknown[])?.[0] as { suggestionId: string } | undefined;
    expect(call?.suggestionId).toBe("RESTART_PROFILE_TUNNEL");
    expect(host.textContent).toMatch(/取消自修/);
  });

  it("surfaces the friendly REPAIR_DAILY_BUDGET_EXHAUSTED reason when the supervisor rejects the repair", async () => {
    setC2C({
      profile: { getActive: () => Promise.resolve(profile()) },
      diagnostics: {
        run: () => Promise.resolve(report()),
        matchRepairOptions: async () => restartMatchResponse(),
        runRepair: async (): Promise<RunRepairResponse> => ({
          attemptId: "att-2",
          signature: "fault:v1:" + "0".repeat(64),
          code: "TUNNEL_EDGE_UNAVAILABLE",
          suggestionId: "RESTART_PROFILE_TUNNEL",
          result: "FAILED",
          actionState: "NOT_STARTED",
          evidenceStatus: "CANDIDATE",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          postCheck: { state: "NOT_RUN", observedAt: null, reasonCode: "REPAIR_BUDGET_EXHAUSTED" },
          rollback: { state: "NOT_REQUIRED", reasonCode: null },
          source: "audit-chain",
        }),
      },
      intent: { create: () => Promise.resolve({}), openChatgpt: () => Promise.resolve({}) },
    });
    const host = await mount(<ConnectionsPage view="tunnel" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await clickButton(host, "btn-tunnel-self-heal");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toMatch(/今日自修次数已用完/);
  });
});
