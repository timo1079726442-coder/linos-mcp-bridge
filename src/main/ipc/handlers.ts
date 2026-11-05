/**
 * IPC Handlers — capability-based IPC.
 *
 * Per CP1 SECURITY_MODEL_V2 §3, /admin/* endpoints require Capability MAC.
 * The same model is applied here to IPC: each IPC channel requires a capability.
 * Renderer cannot bypass capability to read secret / mutate runtime.json.
 */
import { readToolAuditStatus } from "../audit/ToolAuditStatus.js";
import { boardHandoff, listBoards, readBoard, slugifyProject, templateBoard, writeBoard } from "../board/TaskBoard.js";
import { approveRequest, listRequests, rejectRequest } from "../requests/RequestInbox.js";
import { buildHandoffCard, readProgressSessions } from "../mcp/ProgressIndex.js";
import { getJobConsoleRecord, listJobConsoleRecords, readJobConsoleOutput, requestJobCancel } from "../jobs/JobReader.js";
import { ipcMain, dialog, shell, BrowserWindow, app } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ProfileSummary,
  ProfileType,
  WorkspaceInfo,
  WorkspaceCandidate,
  ReadinessSnapshot,
  DiagnosticsReport,
  ConnectionIntent,
  IpcCapability,
  OrdinarySettingsPatch,
  ServiceConnectionSettingsPatch,
  ServiceConnectionSettingsUpdateResult,
  ServiceConnectionSettingsView,
  ServiceCredentialImportResult,
  FaultCasesRequest,
  FaultCasesResponse,
  MatchRepairOptionsRequest,
  MatchRepairOptionsResponse,
  RunRepairRequest,
  RunRepairResponse,
  RepairHistoryRequest,
  RepairHistoryResponse,
  WritePolicy,
  WritePolicyUpdate,
  WritePolicyUpdateResult,
  WriteAuditEntry,
  WriteToolId,
  ScreenAccessSnapshot,
} from "../../shared/types.js";
import { isRunRepairRequest } from "../../shared/types.js";
import {
  getLocalTunnelStatus,
  startLocalTunnel,
  stopLocalTunnel,
} from "../tunnel/LocalTunnelManager.js";
import { diagnoseLocalMcp, repairLocalMcp } from "../mcp/ConnectionDoctor.js";
import { inspectPeerService, openPeerPanel, setPeerDangerousMode } from "../mcp/PeerServiceInspector.js";
import { discoverServices } from "../mcp/ServiceDiscovery.js";
import { namedTunnelStatus, loginNamedTunnel, provisionNamedTunnel, installCloudflared } from "../tunnel/NamedTunnelProvisioner.js";
import { pinCloudflaredPath } from "../tunnel/LocalTunnelManager.js";
import { readLogs } from "../logs/LogsService.js";import type {
  ApprovalDecisionInput,
  ApprovalRecordView,
  ApprovalQueueActionRef,
  ConfirmedFolderAclAddInput,
  ConfirmedFolderAclRemoveInput,
  FolderAccessCheckInput,
  FolderAccessEntry,
  FolderAclAddInput,
  FolderAclRemoveInput,
  FolderAclRuleConfirmationInput,
} from "../../shared/security.js";
import type { IpcSupervisor } from "../../shared/IpcSupervisor.js";
import { WritePolicyStore } from "../profile/WritePolicyStore.js";
import { SecretStore } from "../security/SecretStore.js";
import { DataSourceStore } from "../datasources/DataSourceStore.js";
import { MysqlBridge } from "../datasources/MysqlBridge.js";
import { appendDatasourceAudit } from "../datasources/MysqlControlBridge.js";
import { captureWindowWithLocalConfirmation, listWindowsWithLocalConfirmation } from "../screen/ScreenCaptureService.js";

export interface IpcContext {
  supervisor: IpcSupervisor;
  getMainWindow(): BrowserWindow | null;
  getStateRoot(): string;
  multiService?: import("../multi/MultiServiceManager.js").MultiServiceManager;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  // ===== Profile =====
  ipcMain.handle("profile:list", async (_event, capability: IpcCapability) => {
    requireCap(capability, "profile:list");
    return ctx.supervisor.listProfiles();
  });

  ipcMain.handle(
    "profile:create",
    async (
      _event,
      capability: IpcCapability,
      params: { profileName: string; profileType: ProfileType; initialWorkspaceRoot?: string | null },
    ) => {
      requireCap(capability, "profile:create");
      return ctx.supervisor.createProfile(params);
    },
  );

  ipcMain.handle(
    "profile:set-active",
    async (_event, capability: IpcCapability, profileId: string) => {
      requireCap(capability, "profile:set-active");
      await ctx.supervisor.setActiveProfile(profileId);
      return ctx.supervisor.getActiveProfile();
    },
  );

  ipcMain.handle("profile:get-active", async (_event, capability: IpcCapability) => {
    requireCap(capability, "profile:get-active");
    return ctx.supervisor.getActiveProfile();
  });

  ipcMain.handle("profile:service-get", async (_event, capability: IpcCapability): Promise<ServiceConnectionSettingsView> => {
    requireCap(capability, "profile:read");
    return ctx.supervisor.getServiceConnectionSettings();
  });

  ipcMain.handle(
    "profile:service-import-credential",
    async (_event, capability: IpcCapability): Promise<ServiceCredentialImportResult> => {
      requireCap(capability, "profile:update");
      const before = await ctx.supervisor.getActiveProfile();
      const win = ctx.getMainWindow();
      if (!before || !win) throw new Error("SERVICE_CREDENTIAL_PROFILE_OR_WINDOW_UNAVAILABLE");

      const picked = await dialog.showOpenDialog(win, {
        title: "选择 Cloudflare Tunnel 凭证 JSON",
        properties: ["openFile"],
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true, profileId: before.profileId, fileName: null, storedPath: null };
      }

      const sourcePath = picked.filePaths[0];
      const confirmation = await dialog.showMessageBox(win, {
        type: "warning",
        title: "本机确认导入 Tunnel 凭证",
        message: "将所选 JSON 复制到当前 Profile 的私有 transport 目录？",
        detail: [
          `Profile: ${before.profileName} (${before.profileId})`,
          `文件名: ${path.basename(sourcePath)}`,
          "文件内容不会显示在界面、日志或审计中。Supervisor 只校验 JSON 结构、大小并复制到当前 Profile。",
        ].join("\n"),
        buttons: ["确认导入", "取消"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) {
        return { canceled: true, profileId: before.profileId, fileName: null, storedPath: null };
      }

      const after = await ctx.supervisor.getActiveProfile();
      if (!after || after.profileId !== before.profileId) throw new Error("SERVICE_CREDENTIAL_PROFILE_CHANGED");
      return ctx.supervisor.importServiceCredential(sourcePath);
    },
  );

  ipcMain.handle(
    "profile:service-update",
    async (
      _event,
      capability: IpcCapability,
      patch: ServiceConnectionSettingsPatch,
    ): Promise<ServiceConnectionSettingsUpdateResult> => {
      requireCap(capability, "profile:update");
      const active = await ctx.supervisor.getActiveProfile();
      if (!active || active.profileId !== patch.expectedProfileId) throw new Error("SERVICE_CONFIG_PROFILE_MISMATCH");
      const win = ctx.getMainWindow();
      if (!win) throw new Error("SERVICE_CONFIG_CONFIRMATION_WINDOW_UNAVAILABLE");

      const remote = patch.provider === "CLOUDFLARE_NAMED";
      const detail = [
        `Profile: ${active.profileName} (${active.profileId})`,
        `本地端口: ${active.transport.expectedLocalPort}（固定，不允许改为生产 48765）`,
        `Transport: ${patch.provider}`,
        ...(remote ? [
          `Hostname: ${patch.hostname ?? "未填写"}`,
          `Tunnel: ${patch.tunnelName ?? "未填写"}`,
          `Tunnel ID: ${patch.tunnelId ?? "未填写"}`,
          `Credential: ${patch.credentialPath ? "已指定本机凭证文件" : active.transport.credentialPath ? "沿用当前 Profile 凭证" : "未配置"}`,
        ] : ["远程 Tunnel 配置将被清空，Profile 返回 LOCAL_ONLY。"]),
        "",
        "保存前 Supervisor 会再次执行 V2 隔离校验。生产 48765、mcp-legacy.example.com 和生产 Tunnel 始终禁止绑定。",
        "若配置发生变化，旧的本 Profile Transport 会先安全停止；新配置需重启 Supervisor 后生效。",
      ].join("\n");
      const confirmed = await dialog.showMessageBox(win, {
        type: "warning",
        title: "本机确认服务连接配置",
        message: "确认修改当前 Profile 的 OAuth / Tunnel 服务配置？",
        detail,
        buttons: ["确认保存", "取消"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmed.response !== 0) throw new Error("SERVICE_CONFIG_CONFIRMATION_CANCELLED");

      const current = await ctx.supervisor.getActiveProfile();
      if (!current || current.profileId !== patch.expectedProfileId) throw new Error("SERVICE_CONFIG_PROFILE_CHANGED");
      return ctx.supervisor.updateServiceConnectionSettings({ ...patch, expectedProfileId: current.profileId });
    },
  );

  // ===== Screen (local UI only; not remotely exposed through Runtime MCP) =====
  ipcMain.handle("screen:windows-list", async (_event, capability: IpcCapability): Promise<ScreenAccessSnapshot> => {
    requireCap(capability, "screen:windows:read");
    const before = await ctx.supervisor.getActiveProfile();
    const win = ctx.getMainWindow();
    if (!before || !win) throw new Error("SCREEN_PROFILE_OR_WINDOW_UNAVAILABLE");
    const snapshot = await listWindowsWithLocalConfirmation(win, before.profileName);
    const after = await ctx.supervisor.getActiveProfile();
    if (!after || after.profileId !== before.profileId) throw new Error("SCREEN_PROFILE_CHANGED");
    return snapshot;
  });

  ipcMain.handle(
    "screen:capture-window",
    async (_event, capability: IpcCapability, params: { windowId: string }): Promise<ScreenAccessSnapshot> => {
      requireCap(capability, "screen:capture");
      const before = await ctx.supervisor.getActiveProfile();
      const win = ctx.getMainWindow();
      if (!before || !win) throw new Error("SCREEN_PROFILE_OR_WINDOW_UNAVAILABLE");
      const snapshot = await captureWindowWithLocalConfirmation(win, before.profileName, String(params?.windowId ?? ""));
      const after = await ctx.supervisor.getActiveProfile();
      if (!after || after.profileId !== before.profileId) throw new Error("SCREEN_PROFILE_CHANGED");
      return snapshot;
    },
  );

  // ===== Workspace =====
  ipcMain.handle(
    "workspace:pick",
    async (_event, capability: IpcCapability): Promise<string | null> => {
      requireCap(capability, "workspace:pick");
      const win = ctx.getMainWindow();
      if (!win) throw new Error("No main window available");
      const result = await dialog.showOpenDialog(win, {
        title: "Select Workspace Directory",
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(
    "workspace:validate",
    async (_event, capability: IpcCapability, root: string): Promise<WorkspaceInfo> => {
      requireCap(capability, "workspace:validate");
      return ctx.supervisor.validateWorkspace(root);
    },
  );

  ipcMain.handle(
    "workspace:detect",
    async (_event, capability: IpcCapability, root: string): Promise<WorkspaceCandidate> => {
      requireCap(capability, "workspace:detect");
      return ctx.supervisor.detectWorkspace(root);
    },
  );

  ipcMain.handle(
    "workspace:git-changes",
    async (_event, capability: IpcCapability, root: string) => {
      requireCap(capability, "workspace:git-changes");
      return ctx.supervisor.gitChanges(root);
    },
  );

  ipcMain.handle(
    "workspace:change-prepare",
    async (_event, capability: IpcCapability, params: { profileId: string; newWorkspaceRoot: string }) => {
      requireCap(capability, "workspace:change-prepare");
      return ctx.supervisor.prepareWorkspaceChange(params);
    },
  );

  ipcMain.handle(
    "workspace:change-commit",
    async (_event, capability: IpcCapability, params: { profileId: string }) => {
      requireCap(capability, "workspace:change-commit");
      return ctx.supervisor.commitWorkspaceChange(params);
    },
  );

  // ===== Connection Intent =====
  ipcMain.handle("intent:create", async (_event, capability: IpcCapability, params: { grantAllScopes?: boolean } = {}): Promise<ConnectionIntent> => {
    requireCap(capability, "intent:create");
    return ctx.supervisor.createIntent({ grantAllScopes: params.grantAllScopes === true });
  });

  ipcMain.handle(
    "intent:open-chatgpt",
    async (_event, capability: IpcCapability): Promise<{ url: string }> => {
      requireCap(capability, "intent:open-chatgpt");
      const active = await ctx.supervisor.getActiveProfile();
      const url = active?.chatgptLaunchUrl ?? "https://chatgpt.com";
      await shell.openExternal(url);
      return { url };
    },
  );

  ipcMain.handle(
    "tunnel:local:status",
    async (_event, capability: IpcCapability) => {
      requireCap(capability, "tunnel:local:manage");
      return getLocalTunnelStatus();
    },
  );

  ipcMain.handle(
    "tunnel:local:start",
    async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
      requireCap(capability, "tunnel:local:manage");
      const port = params.port;
      if (typeof port !== "number") throw new Error("TUNNEL_PORT_REQUIRED");
      return startLocalTunnel({ port });
    },
  );

  ipcMain.handle(
    "tunnel:local:stop",
    async (_event, capability: IpcCapability) => {
      requireCap(capability, "tunnel:local:manage");
      return stopLocalTunnel();
    },
  );

  // ===== 检测并修复：五级链路 =====
  ipcMain.handle(
    "connection:diagnose",
    async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
      requireCap(capability, "connection:diagnose");
      const port = params.port;
      if (typeof port !== "number") throw new Error("DIAGNOSE_PORT_REQUIRED");
      return diagnoseLocalMcp(port);
    },
  );

  ipcMain.handle(
    "connection:repair",
    async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
      requireCap(capability, "connection:repair");
      const port = params.port;
      if (typeof port !== "number") throw new Error("REPAIR_PORT_REQUIRED");
      return repairLocalMcp(port);
    },
  );

  // ===== 我们自己的服务：重启 Runtime / 重启隧道（绝不触碰 legacy 48765）=====
  ipcMain.handle("service:runtime:restart", async (_event, capability: IpcCapability) => {
    requireCap(capability, "service:runtime:restart");
    return ctx.supervisor.restartRuntime();
  });

  ipcMain.handle("runtime:port:check", async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
    requireCap(capability, "runtime:port:check");
    const port = params.port;
    if (!Number.isInteger(port) || port === undefined || port < 1024 || port > 65535) {
      return { available: false, reason: "PORT_INVALID" };
    }
    const net = await import("node:net");
    return await new Promise<{ available: boolean; reason?: string }>((resolve) => {
      const server = net.createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        server.close();
        resolve({ available: false, reason: error.code ?? "PORT_ERROR" });
      });
      server.listen({ host: "127.0.0.1", port }, () => {
        server.close(() => resolve({ available: true }));
      });
    });
  });
  ipcMain.handle("audit:tool:status", async (_event, capability: IpcCapability) => {
    requireCap(capability, "audit:tool:status");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active) return { ok: true, entries: 0, path: "" };
    return readToolAuditStatus(path.join(ctx.getStateRoot(), "profiles", active.profileId));
  });
  ipcMain.handle("jobs:list", async (_event, capability: IpcCapability, params: { limit?: number } = {}) => {
    requireCap(capability, "jobs:read");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active?.currentWorkspace?.workspaceId) return [];
    return listJobConsoleRecords(ctx.getStateRoot(), active.profileId, active.currentWorkspace.workspaceId, params.limit ?? 50);
  });
  ipcMain.handle("jobs:get", async (_event, capability: IpcCapability, params: { id?: string } = {}) => {
    requireCap(capability, "jobs:read");
    if (!params.id) throw new Error("JOB_ID_REQUIRED");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active?.currentWorkspace?.workspaceId) throw new Error("JOB_WORKSPACE_UNAVAILABLE");
    return getJobConsoleRecord(ctx.getStateRoot(), active.profileId, active.currentWorkspace.workspaceId, params.id);
  });
  ipcMain.handle("jobs:output", async (_event, capability: IpcCapability, params: { id?: string; offset?: number; maxBytes?: number } = {}) => {
    requireCap(capability, "jobs:read");
    if (!params.id) throw new Error("JOB_ID_REQUIRED");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active?.currentWorkspace?.workspaceId) throw new Error("JOB_WORKSPACE_UNAVAILABLE");
    return readJobConsoleOutput(ctx.getStateRoot(), active.profileId, active.currentWorkspace.workspaceId, params.id, params.offset ?? 0, params.maxBytes ?? 8192);
  });
  ipcMain.handle("jobs:cancel", async (_event, capability: IpcCapability, params: { id?: string } = {}) => {
    requireCap(capability, "jobs:manage");
    if (!params.id) throw new Error("JOB_ID_REQUIRED");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active?.currentWorkspace?.workspaceId) throw new Error("JOB_WORKSPACE_UNAVAILABLE");
    return requestJobCancel(ctx.getStateRoot(), active.profileId, active.currentWorkspace.workspaceId, params.id);
  });
  ipcMain.handle("service:multi:list", async (_event, capability: IpcCapability) => {
    requireCap(capability, "service:multi:list");
    if (!ctx.multiService) throw new Error("MULTI_SERVICE_UNAVAILABLE");
    return ctx.multiService.list();
  });

  ipcMain.handle("service:multi:create", async (_event, capability: IpcCapability, params: import("../../shared/multiService.js").ManagedServiceCreateInput) => {
    requireCap(capability, "service:multi:create");
    if (!ctx.multiService) throw new Error("MULTI_SERVICE_UNAVAILABLE");
    return ctx.multiService.create(params);
  });

  ipcMain.handle("service:multi:start", async (_event, capability: IpcCapability, params: { id?: string } = {}) => {
    requireCap(capability, "service:multi:start");
    if (!ctx.multiService) throw new Error("MULTI_SERVICE_UNAVAILABLE");
    if (!params.id) throw new Error("SERVICE_ID_REQUIRED");
    await ctx.multiService.start(params.id);
    return { ok: true };
  });

  ipcMain.handle("service:multi:stop", async (_event, capability: IpcCapability, params: { id?: string } = {}) => {
    requireCap(capability, "service:multi:stop");
    if (!ctx.multiService) throw new Error("MULTI_SERVICE_UNAVAILABLE");
    if (!params.id) throw new Error("SERVICE_ID_REQUIRED");
    await ctx.multiService.stop(params.id);
    return { ok: true };
  });

  ipcMain.handle("service:transport:restart", async (_event, capability: IpcCapability) => {
    requireCap(capability, "service:transport:restart");
    return ctx.supervisor.restartTransport();
  });
  ipcMain.handle(
    "service:pairing:create",
    async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
      requireCap(capability, "service:pairing:create");
      const port = typeof params.port === "number" ? params.port : 48766;
      const res = await fetch(`http://127.0.0.1:${port}/oauth/pairing`, { method: "POST" });
      if (!res.ok) throw new Error(`PAIRING_CREATE_FAILED_${res.status}`);
      return (await res.json()) as { ok: boolean; code: string; expiresAt: number };
    },
  );

  ipcMain.handle(
    "service:pairing:clear",
    async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
      requireCap(capability, "service:pairing:clear");
      const port = typeof params.port === "number" ? params.port : 48766;
      const res = await fetch(`http://127.0.0.1:${port}/oauth/pairing`, { method: "DELETE" });
      if (!res.ok) throw new Error(`PAIRING_CLEAR_FAILED_${res.status}`);
      return (await res.json()) as { ok: boolean; cleared: boolean };
    },
  );
  ipcMain.handle(
    "peer:set-dangerous",
    async (_event, capability: IpcCapability, params: Record<string, unknown> = {}) => {
      requireCap(capability, "peer:set-dangerous");
      return setPeerDangerousMode(params as Parameters<typeof setPeerDangerousMode>[0]);
    },
  );
  ipcMain.handle("services:discover", async (_event, capability: IpcCapability) => {
    requireCap(capability, "services:discover");
    return discoverServices(ctx.getStateRoot());
  });
  // ===== 命名隧道自助配置（用户自己的 Cloudflare 域名）=====
  ipcMain.handle("tunnel:named:status", async (_event, capability: IpcCapability) => {
    requireCap(capability, "tunnel:named:manage");
    return namedTunnelStatus();
  });

  ipcMain.handle("tunnel:named:pick", async (_event, capability: IpcCapability) => {
    requireCap(capability, "tunnel:named:manage");
    const win = BrowserWindow.getAllWindows()[0] ?? null;
    const picked = await dialog.showOpenDialog(win as BrowserWindow, {
      title: "选择 cloudflared.exe",
      properties: ["openFile"],
      filters: [{ name: "cloudflared", extensions: ["exe"] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, path: null };
    const chosen = picked.filePaths[0];
    const chosenPath = chosen ?? "";
    if (!/cloudflared.*\.exe$/i.test(path.basename(chosenPath))) {
      return { ok: false, path: null, reason: "选中的文件不像是 cloudflared.exe" };
    }
    await pinCloudflaredPath(chosenPath);
    return { ok: true, path: chosenPath };
  });

  ipcMain.handle("tunnel:named:install", async (_event, capability: IpcCapability) => {
    requireCap(capability, "tunnel:named:manage");
    return installCloudflared();
  });

  ipcMain.handle("tunnel:named:login", async (_event, capability: IpcCapability) => {
    requireCap(capability, "tunnel:named:manage");
    return loginNamedTunnel();
  });

  ipcMain.handle(
    "tunnel:named:provision",
    async (_event, capability: IpcCapability, params: { hostname: string; tunnelName: string; port?: number }) => {
      requireCap(capability, "tunnel:named:manage");
      return provisionNamedTunnel({
        hostname: params.hostname,
        tunnelName: params.tunnelName,
        port: typeof params.port === "number" ? params.port : 48766,
      });
    },
  );
  // ===== 工具策略（逐工具开关 + 审批方式），按工作区写 tool-policy.json =====
  // 解析顺序：<profile>/workspaces/<workspaceId>/tool-policy.json →
  //           <profile>/tool-policy.json（旧版）→ 内置默认。
  ipcMain.handle("tools:policy:get", async (_event, capability: IpcCapability) => {
    requireCap(capability, "tools:policy:manage");
    const dir = ctx.getStateRoot();
    const out: Record<string, { enabled: boolean; approval: "auto" | "manual" }> = {};
    const active = await ctx.supervisor.getActiveProfile().catch(() => null);
    if (!active?.profileId) {
      return { tools: out, profileDir: null, workspaceId: null, source: "default", file: null };
    }
    const profileDir = path.join(dir, "profiles", active.profileId);
    const workspaceId = typeof active.currentWorkspace?.workspaceId === "string"
      && /^[A-Za-z0-9_-]{1,64}$/.test(active.currentWorkspace.workspaceId)
      ? active.currentWorkspace.workspaceId : null;
    const workspaceFile = workspaceId ? path.join(profileDir, "workspaces", workspaceId, "tool-policy.json") : null;
    const profileFile = path.join(profileDir, "tool-policy.json");
    let source: "workspace" | "profile" | "default" = "default";
    let file: string | null = null;
    for (const candidate of [workspaceFile, profileFile]) {
      if (!candidate) continue;
      const raw = await fs.readFile(candidate, "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { tools?: typeof out };
        Object.assign(out, parsed.tools ?? {});
        file = candidate;
        source = candidate === workspaceFile ? "workspace" : "profile";
        break;
      } catch {
        /* 当前层损坏：继续往下一层找 */
      }
    }
    return { tools: out, profileDir: path.dirname(file ?? profileFile), workspaceId, source, file };
  });

  ipcMain.handle(
    "tools:policy:set",
    async (_event, capability: IpcCapability, params: { tools: Record<string, { enabled: boolean; approval: "auto" | "manual" }> }) => {
      requireCap(capability, "tools:policy:manage");
      const dir = ctx.getStateRoot();
      const active = await ctx.supervisor.getActiveProfile().catch(() => null);
      if (!active?.profileId) throw new Error("NO_ACTIVE_PROFILE");
      const profileDir = path.join(dir, "profiles", active.profileId);
      const workspaceId = typeof active.currentWorkspace?.workspaceId === "string"
        && /^[A-Za-z0-9_-]{1,64}$/.test(active.currentWorkspace.workspaceId)
        ? active.currentWorkspace.workspaceId : null;
      // 有工作区就写到工作区级；没有才退回 Profile 级（旧结构）。
      const file = workspaceId
        ? path.join(profileDir, "workspaces", workspaceId, "tool-policy.json")
        : path.join(profileDir, "tool-policy.json");
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, tools: params.tools }, null, 2), "utf8");
      await fs.rename(tmp, file);
      return { ok: true, file, workspaceId, source: workspaceId ? "workspace" : "profile" };
    },
  );
  // ===== 数据源（只读 MySQL）：元数据按工作区，密码在 DPAPI =====
  const dataSourceContext = async () => {
    const active = await ctx.supervisor.getActiveProfile().catch(() => null);
    if (!active?.profileId) throw new Error("NO_ACTIVE_PROFILE");
    const rawWorkspaceId = active.currentWorkspace?.workspaceId;
    const workspaceId = typeof rawWorkspaceId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawWorkspaceId)
      ? rawWorkspaceId : null;
    return { profileId: active.profileId, workspaceId, stateRoot: ctx.getStateRoot(), workspaceRoot: active.currentWorkspace?.root ?? null };
  };
  const dataSourceStore = async () => {
    const context = await dataSourceContext();
    return {
      context,
      store: new DataSourceStore(
        context.stateRoot,
        context.profileId,
        context.workspaceId,
        new SecretStore(context.stateRoot, context.profileId),
      ),
    };
  };

  ipcMain.handle("datasources:list", async (_event, capability: IpcCapability) => {
    requireCap(capability, "datasources:manage");
    const { context, store } = await dataSourceStore();
    const secrets = new SecretStore(context.stateRoot, context.profileId);
    const health = await secrets.health().catch(() => null);
    return {
      datasources: await store.list(),
      workspaceId: context.workspaceId,
      workspaceRoot: context.workspaceRoot,
      secretBackend: health?.backend ?? "unknown",
      productionSafe: health?.productionSafe === true,
    };
  });

  ipcMain.handle("datasources:save", async (_event, capability: IpcCapability, input: Record<string, unknown>) => {
    requireCap(capability, "datasources:manage");
    const { store } = await dataSourceStore();
    return await store.save(input);
  });

  ipcMain.handle("datasources:remove", async (_event, capability: IpcCapability, params: { id?: unknown }) => {
    requireCap(capability, "datasources:manage");
    const { store } = await dataSourceStore();
    return await store.remove(params?.id);
  });

  ipcMain.handle("datasources:test", async (_event, capability: IpcCapability, params: { id?: unknown }) => {
    requireCap(capability, "datasources:manage");
    const { context, store } = await dataSourceStore();
    const bridge = new MysqlBridge({
      store,
      audit: (event) => appendDatasourceAudit(context.stateRoot, context.profileId, event),
    });
    if (typeof params?.id !== "string") throw new Error("DATASOURCE_ID_INVALID");
    return await bridge.test(params.id);
  });

  ipcMain.handle("datasources:generate-sql", async (_event, capability: IpcCapability, params: { user?: unknown; database?: unknown }) => {
    requireCap(capability, "datasources:manage");
    const user = typeof params?.user === "string" ? params.user : "";
    const database = typeof params?.database === "string" ? params.database : "";
    if (!/^[A-Za-z0-9_$-]{1,64}$/.test(user)) throw new Error("DATASOURCE_USER_INVALID");
    if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) throw new Error("DATASOURCE_DATABASE_INVALID");
    const password = randomBytes(18).toString("base64url");
    const quote = (value: string): string => value.replace(/'/g, "''");
    const sql = [
      `-- LinOS 只读账号（只给 SELECT / SHOW VIEW；请用管理员账号执行）`,
      `CREATE USER IF NOT EXISTS '${quote(user)}'@'localhost' IDENTIFIED BY '${password}';`,
      `ALTER USER '${quote(user)}'@'localhost' IDENTIFIED BY '${password}';`,
      `CREATE USER IF NOT EXISTS '${quote(user)}'@'127.0.0.1' IDENTIFIED BY '${password}';`,
      `ALTER USER '${quote(user)}'@'127.0.0.1' IDENTIFIED BY '${password}';`,
      `GRANT SELECT, SHOW VIEW ON \`${database}\`.* TO '${quote(user)}'@'localhost';`,
      `GRANT SELECT, SHOW VIEW ON \`${database}\`.* TO '${quote(user)}'@'127.0.0.1';`,
      `FLUSH PRIVILEGES;`,
      `SHOW GRANTS FOR '${quote(user)}'@'localhost';`,
    ].join("\n");
    return {
      user,
      database,
      password,
      sql,
      note: "密码只会显示这一次；请先执行 SQL，再把同一密码填入数据源表单并保存。",
    };
  });

  // ===== 联网白名单（fetch 用）：按工作区保存 =====
  const fetchAllowlistPaths = async () => {
    const active = await ctx.supervisor.getActiveProfile().catch(() => null);
    if (!active?.profileId) throw new Error("NO_ACTIVE_PROFILE");
    const rawWorkspaceId = active.currentWorkspace?.workspaceId;
    const workspaceId = typeof rawWorkspaceId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawWorkspaceId)
      ? rawWorkspaceId : null;
    const profileDir = path.join(ctx.getStateRoot(), "profiles", active.profileId);
    const workspaceFile = workspaceId
      ? path.join(profileDir, "workspaces", workspaceId, "fetch-allowlist.json")
      : null;
    return { profileDir, workspaceId, workspaceFile, profileFile: path.join(profileDir, "fetch-allowlist.json") };
  };

  ipcMain.handle("network:allowlist:get", async (_event, capability: IpcCapability) => {
    requireCap(capability, "network:manage");
    const { workspaceId, workspaceFile, profileFile } = await fetchAllowlistPaths();
    for (const [file, source] of [[workspaceFile, "workspace"], [profileFile, "profile"]] as const) {
      if (!file) continue;
      const raw = await fs.readFile(file, "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { domains?: unknown; allow_http?: unknown };
        const domains = Array.isArray(parsed.domains)
          ? parsed.domains.filter((value): value is string => typeof value === "string")
          : [];
        return { domains, allowHttp: parsed.allow_http === true, workspaceId, source, file };
      } catch {
        /* 损坏则继续下一层 */
      }
    }
    return { domains: [], allowHttp: false, workspaceId, source: "default" as const, file: workspaceFile ?? profileFile };
  });

  ipcMain.handle(
    "network:allowlist:set",
    async (_event, capability: IpcCapability, params: { domains?: unknown; allowHttp?: unknown }) => {
      requireCap(capability, "network:manage");
      if (!Array.isArray(params?.domains) || params.domains.length > 50
        || params.domains.some((value) => typeof value !== "string")) {
        throw new Error("NETWORK_ALLOWLIST_INVALID");
      }
      const domainPattern = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
      const domains = [...new Set(params.domains.map((value) => (value as string).trim().toLowerCase()))];
      if (domains.some((domain) => domain.length > 253 || !domainPattern.test(domain)
        || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) || domain === "localhost")) {
        throw new Error("NETWORK_ALLOWLIST_INVALID");
      }
      const { workspaceFile, profileFile } = await fetchAllowlistPaths();
      const file = workspaceFile ?? profileFile;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify({ domains, allow_http: params.allowHttp === true }, null, 2), "utf8");
      await fs.rename(tmp, file);
      return { ok: true, file, domains: domains.length, allowHttp: params.allowHttp === true };
    },
  );

  // ===== 日志（真实读取本机审计链/执行记录）=====
  ipcMain.handle(
    "logs:read",
    async (_event, capability: IpcCapability, params: { limit?: number } = {}) => {
      requireCap(capability, "logs:read");
      const limit = typeof params.limit === "number" ? params.limit : 200;
      return readLogs(ctx.getStateRoot(), limit);
    },
  );
  // ===== 对方服务的只读实时状态（工具清单/危险模式/授权目录/会话）=====
  ipcMain.handle(
    "peer:inspect",
    async (_event, capability: IpcCapability, params: { port?: number } = {}) => {
      requireCap(capability, "peer:inspect");
      const port = params.port;
      if (typeof port !== "number") throw new Error("INSPECT_PORT_REQUIRED");
      return inspectPeerService(port);
    },
  );

  ipcMain.handle(
    "peer:open-panel",
    async (_event, capability: IpcCapability) => {
      requireCap(capability, "peer:open-panel");
      return openPeerPanel();
    },
  );

  // ===== Readiness =====
  ipcMain.handle("readiness:get", async (_event, capability: IpcCapability): Promise<ReadinessSnapshot> => {
    requireCap(capability, "readiness:get");
    return ctx.supervisor.getReadiness();
  });

  // 会话命名：网页版不传会话 ID，用户给某一轮起的名字存本地，优先于自动识别。
  const sessionLabelsFile = (): string => path.join(ctx.getStateRoot(), "session-labels.json");
  const readSessionLabels = async (): Promise<Record<string, string>> => {
    const raw = await fs.readFile(sessionLabelsFile(), "utf8").catch(() => null);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 60);
      }
      return out;
    } catch {
      return {};
    }
  };

  ipcMain.handle("progress:label", async (_event, capability: IpcCapability, sessionId: string, name: string | null) => {
    requireCap(capability, "diagnostics:run");
    const labels = await readSessionLabels();
    if (name && name.trim()) labels[sessionId] = name.trim().slice(0, 60);
    else delete labels[sessionId];
    await fs.mkdir(path.dirname(sessionLabelsFile()), { recursive: true });
    await fs.writeFile(sessionLabelsFile(), JSON.stringify(labels, null, 2), "utf8");
    return { labels };
  });
  // ===== 浏览器扩展导出（给网页版 AI 用）=====
  ipcMain.handle("extension:export", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    const source = path.join(app.getAppPath(), "extension");
    const exists = await fs.stat(source).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) throw new Error("EXTENSION_BUNDLE_MISSING");
    const picked = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: "选择保存位置（会在此目录下创建 LinOS-C2C-Extension 文件夹）",
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) throw new Error("Cancelled");
    const target = path.join(picked.filePaths[0] ?? "", "LinOS-C2C-Extension");
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    await fs.cp(source, target, { recursive: true });
    return { path: target };
  });
  // ===== OAuth 重连策略（已授权客户端重连是否免配对码）=====
  const oauthSettingsFile = (): string => path.join(ctx.getStateRoot(), "oauth-settings.json");
  ipcMain.handle("oauth:reconnect-policy:get", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    const raw = await fs.readFile(oauthSettingsFile(), "utf8").catch(() => null);
    if (!raw) return { allowReconnectWithoutIntent: false, file: oauthSettingsFile() };
    try {
      const parsed = JSON.parse(raw) as { allowReconnectWithoutIntent?: unknown };
      return { allowReconnectWithoutIntent: parsed.allowReconnectWithoutIntent === true, file: oauthSettingsFile() };
    } catch {
      return { allowReconnectWithoutIntent: false, file: oauthSettingsFile() };
    }
  });

  ipcMain.handle("oauth:reconnect-policy:set", async (_event, capability: IpcCapability, allow: boolean) => {
    requireCap(capability, "diagnostics:run");
    await fs.mkdir(path.dirname(oauthSettingsFile()), { recursive: true });
    await fs.writeFile(
      oauthSettingsFile(),
      JSON.stringify({ allowReconnectWithoutIntent: allow === true, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return { allowReconnectWithoutIntent: allow === true, file: oauthSettingsFile() };
  });
  // ===== 一键修复（只做可逆、低风险的动作）=====
  ipcMain.handle("fixes:run", async (_event, capability: IpcCapability, action: string) => {
    requireCap(capability, "diagnostics:run");
    const root = await activeWorkspaceRoot();
    if (action === "git_init") {
      const output = await new Promise<string>((resolve) => {
        execFile("git", ["init"], { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
          resolve(error ? `失败：${(stderr || error.message).trim().slice(0, 400)}` : (stdout || stderr || "git init 完成").trim().slice(0, 400));
        });
      });
      return { action, output };
    }
    if (action === "enable_dev_tools") {
      const active = await ctx.supervisor.getActiveProfile().catch(() => null);
      const workspaceId = active?.currentWorkspace?.workspaceId ?? null;
      if (!active?.profileId || !workspaceId) throw new Error("NO_ACTIVE_WORKSPACE");
      const file = path.join(ctx.getStateRoot(), "profiles", active.profileId, "workspaces", workspaceId, "tool-policy.json");
      const tools = ["execute_command", "run_command", "run_powershell", "git_commit", "start_job", "job_resume"];
      const current = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as { version?: number; tools?: Record<string, unknown> }).catch(() => ({ version: 1, tools: {} }));
      const next = { version: 1, tools: { ...(current.tools ?? {}) } } as { version: number; tools: Record<string, { enabled: boolean; approval: string }> };
      for (const name of tools) next.tools[name] = { enabled: true, approval: "auto" };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
      return { action, output: `已开启 ${tools.length} 个开发工具（免确认）` };
    }
    throw new Error("UNKNOWN_ACTION");
  });
  // ===== 本机服务自身状态（最后调用时间等；不要拿旧 POC 的 audit.jsonl 冒充）=====
  ipcMain.handle("service:self-lastcall", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    const profilesDir = path.join(ctx.getStateRoot(), "profiles");
    const profiles = await fs.readdir(profilesDir, { withFileTypes: true }).catch(() => []);
    let newest = 0;
    for (const entry of profiles) {
      if (!entry.isDirectory()) continue;
      for (const name of ["tool-calls.jsonl", "active.log"]) {
        const stat = await fs.stat(path.join(profilesDir, entry.name, "audit", name)).catch(() => null);
        if (stat && stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
    return {
      lastCallAt: newest > 0 ? new Date(newest).toISOString() : null,
      minutesSinceLastCall: newest > 0 ? Math.floor((Date.now() - newest) / 60_000) : null,
    };
  });
  // ===== AI 请求（AI 通过写文件申请，控制中心批准后执行低风险动作）=====
  ipcMain.handle("requests:list", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    return listRequests(await activeWorkspaceRoot());
  });

  ipcMain.handle("requests:approve", async (_event, capability: IpcCapability, file: string) => {
    requireCap(capability, "diagnostics:run");
    return approveRequest(await activeWorkspaceRoot(), String(file));
  });

  ipcMain.handle("requests:reject", async (_event, capability: IpcCapability, file: string) => {
    requireCap(capability, "diagnostics:run");
    await rejectRequest(await activeWorkspaceRoot(), String(file));
    return { rejected: true };
  });
  // ===== MCP 调用进度（会话聚合 + 交接卡）=====
  const activeWorkspaceRoot = async (): Promise<string> => {
    const profile = await ctx.supervisor.getActiveProfile().catch(() => null);
    const root = profile?.currentWorkspace?.root;
    if (!root) throw new Error("NO_ACTIVE_WORKSPACE");
    return root;
  };

  ipcMain.handle("board:read", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    return readBoard(await activeWorkspaceRoot());
  });

  ipcMain.handle("board:write", async (_event, capability: IpcCapability, board: unknown) => {
    requireCap(capability, "diagnostics:run");
    return writeBoard(await activeWorkspaceRoot(), board);
  });

  ipcMain.handle("board:create", async (_event, capability: IpcCapability, input: { project?: string; goal?: string }) => {
    requireCap(capability, "diagnostics:run");
    const root = await activeWorkspaceRoot();
    const existing = await readBoard(root);
    if (existing.exists && existing.board) return existing;
    const board = templateBoard(input?.project?.trim() || path.basename(root), input?.goal?.trim() || "写下这个项目的总目标");
    await writeBoard(root, board);
    return readBoard(root);
  });

  ipcMain.handle("board:handoff", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    const snapshot = await readBoard(await activeWorkspaceRoot());
    if (!snapshot.board) throw new Error("BOARD_MISSING");
    let markdown = boardHandoff(snapshot.board);
    // 自动附上最近失败调用，避免"上次为什么失败"只能靠人回忆。
    try {
      const sessions = await readProgressSessions(ctx.getStateRoot());
      const failures = sessions.flatMap((session) => session.recent).filter((call) => !call.ok).slice(-10);
      if (failures.length > 0) {
        markdown += "\n\n## 最近的失败调用（自动采集）\n";
        for (const call of failures) {
          markdown += `- ${call.at} ${call.tool}${call.target ? `：${call.target}` : ""}｜${call.errorCode ?? "未记录错误码"}\n`;
        }
      }
    } catch {
      // 采集失败不影响交接卡主体
    }
    return { markdown };
  });

  ipcMain.handle("progress:sessions", async (_event, capability: IpcCapability) => {
    requireCap(capability, "diagnostics:run");
    return { sessions: await readProgressSessions(ctx.getStateRoot()) };
  });

  ipcMain.handle("progress:handoff", async (_event, capability: IpcCapability, sessionId: string, options?: { full?: boolean }) => {
    requireCap(capability, "diagnostics:run");
    const sessions = await readProgressSessions(ctx.getStateRoot());
    const found = sessions.find((s) => s.id === sessionId);
    if (!found) throw new Error("SESSION_NOT_FOUND");
    return { markdown: buildHandoffCard(found, { full: options?.full === true }) };
  });

  // ===== 其他 AI 客户端的长期令牌（非 OAuth 客户端）=====
  const mcpTokenFile = async (): Promise<{ file: string; profileId: string } | null> => {
    const active = await ctx.supervisor.getActiveProfile().catch(() => null);
    if (!active?.profileId) return null;
    const dir = path.join(ctx.getStateRoot(), "profiles", active.profileId);
    await fs.mkdir(dir, { recursive: true });
    return { file: path.join(dir, "mcp-token.json"), profileId: active.profileId };
  };

  ipcMain.handle("mcp:token:status", async (_event, capability: IpcCapability) => {
    requireCap(capability, "settings:ordinary:update");
    const target = await mcpTokenFile();
    if (!target) return { configured: false };
    const raw = await fs.readFile(target.file, "utf8").catch(() => null);
    if (!raw) return { configured: false };
    try {
      const parsed = JSON.parse(raw) as { createdAt?: string; scopes?: string[] };
      return { configured: true, createdAt: parsed.createdAt ?? null, scopes: parsed.scopes ?? [], path: target.file };
    } catch {
      return { configured: false };
    }
  });

  ipcMain.handle("mcp:token:generate", async (_event, capability: IpcCapability, params?: { scopes?: string[] }) => {
    requireCap(capability, "settings:ordinary:update");
    const target = await mcpTokenFile();
    if (!target) throw new Error("NO_ACTIVE_PROFILE");
    // 默认最小权限：只读 + 离线刷新。写入/命令需要调用方显式申请（见 scopes 参数）。
    const requested = Array.isArray(params?.scopes) && params.scopes.length > 0
      ? params.scopes.filter((s): s is string => typeof s === "string")
      : ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"];
    const allowed = new Set(["workspace.read","workspace.search","git.read","execution.read","workspace.write","workspace.shell","offline_access"]);
    const scopes = requested.filter((s) => allowed.has(s));
    if (scopes.length === 0) scopes.push("workspace.read");
    const token = `c2c_api_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token, "utf8").digest("base64url");
    await fs.writeFile(target.file, JSON.stringify({ hash, scopes, createdAt: new Date().toISOString() }, null, 2), "utf8");
    const active = await ctx.supervisor.getActiveProfile().catch(() => null);
    const url = active?.transport?.publicMcpUrl ?? `http://127.0.0.1:${active?.transport?.expectedLocalPort ?? 48766}/mcp`;
    return { token, url, scopes };
  });

  ipcMain.handle("mcp:token:revoke", async (_event, capability: IpcCapability) => {
    requireCap(capability, "settings:ordinary:update");
    const target = await mcpTokenFile();
    if (target) await fs.rm(target.file, { force: true }).catch(() => undefined);
    return { revoked: true };
  });

  // ===== Diagnostics =====
  ipcMain.handle("diagnostics:run", async (_event, capability: IpcCapability): Promise<DiagnosticsReport> => {
    requireCap(capability, "diagnostics:run");
    return ctx.supervisor.runDiagnostics();
  });

  ipcMain.handle("diagnostics:fault-cases:list", async (_event, capability: IpcCapability, params: FaultCasesRequest): Promise<FaultCasesResponse> => {
    requireCap(capability, "diagnostics:cases:read");
    return ctx.supervisor.listFaultCases(params ?? {});
  });

  ipcMain.handle("diagnostics:repair-options:match", async (_event, capability: IpcCapability, params: MatchRepairOptionsRequest): Promise<MatchRepairOptionsResponse> => {
    requireCap(capability, "diagnostics:repairs:read");
    return ctx.supervisor.matchRepairOptions(params);
  });

  ipcMain.handle("diagnostics:repair:run", async (_event, capability: IpcCapability, params: RunRepairRequest): Promise<RunRepairResponse> => {
    requireCap(capability, "diagnostics:repair:execute");
    if (!isRunRepairRequest(params)) throw new Error("repair_request_invalid");
    const options = await ctx.supervisor.matchRepairOptions({
      signature: params.signature,
      expectedProfileId: params.expectedProfileId,
      expectedWorkspaceId: params.expectedWorkspaceId,
      diagnosisObservedAt: params.diagnosisObservedAt,
    });
    const selected = options.suggestions.find((item) => item.suggestionId === params.suggestionId);
    let nativeConfirmation: "NOT_REQUIRED" | "LOCAL_CONFIRMED" | "LOCAL_CANCELLED" = "NOT_REQUIRED";
    if (selected?.requiresNativeConfirmation) {
      const win = ctx.getMainWindow();
      if (!win) {
        nativeConfirmation = "LOCAL_CANCELLED";
      } else {
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          title: "确认本机修复",
          message: `是否执行“${selected.title}”？`,
          detail: "此确认仅授权当前活动 Profile 的本机受控操作。修复后仍会重新诊断；未恢复将记录为失败。",
          buttons: ["取消", "确认执行"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        nativeConfirmation = result.response === 1 ? "LOCAL_CONFIRMED" : "LOCAL_CANCELLED";
      }
    }
    return ctx.supervisor.runRepair(params, nativeConfirmation);
  });

  ipcMain.handle("diagnostics:repair-history:list", async (_event, capability: IpcCapability, params: RepairHistoryRequest): Promise<RepairHistoryResponse> => {
    requireCap(capability, "diagnostics:history:read");
    return ctx.supervisor.listRepairHistory(params ?? {});
  });

  // ===== Collaboration: execution records (read-only projection) =====
  ipcMain.handle("collaboration:executions:list", async (_event, capability: IpcCapability, params?: { limit?: number }) => {
    requireCap(capability, "collaboration:executions:read");
    return ctx.supervisor.listExecutionRecords(params?.limit);
  });

  ipcMain.handle("collaboration:executions:output", async (_event, capability: IpcCapability, params: { id: string }) => {
    requireCap(capability, "collaboration:executions:read");
    return ctx.supervisor.getExecutionOutput(params?.id ?? "");
  });

  // ===== Workspace ACL and write approvals =====
  ipcMain.handle("security:folder-acl:get", async (_event, capability: IpcCapability) => {
    requireCap(capability, "security:folder-acl:read");
    return ctx.supervisor.getFolderAcl();
  });
  ipcMain.handle("security:folder-acl:add", async (_event, capability: IpcCapability, input: FolderAclAddInput) => {
    requireCap(capability, "security:folder-acl:add");
    return addFolderAclRuleWithLocalConfirmation(ctx, input);
  });
  ipcMain.handle("security:folder-acl:remove", async (_event, capability: IpcCapability, input: FolderAclRemoveInput) => {
    requireCap(capability, "security:folder-acl:remove");
    return removeFolderAclRuleWithLocalConfirmation(ctx, input);
  });
  ipcMain.handle("security:folder-acl:check", async (_event, capability: IpcCapability, input: FolderAccessCheckInput) => {
    requireCap(capability, "security:folder-acl:check");
    return ctx.supervisor.checkFolderAccess(input);
  });
  ipcMain.handle("security:folder-acl:pick", async (_event, capability: IpcCapability) => {
    requireCap(capability, "security:folder-acl:pick");
    const result = await dialog.showOpenDialog({
      title: "选择允许访问的文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("security:approvals:list", async (_event, capability: IpcCapability) => {
    requireCap(capability, "security:approvals:read");
    return ctx.supervisor.listApprovals();
  });
  ipcMain.handle("security:approvals:get", async (_event, capability: IpcCapability, input: { requestId: string }) => {
    requireCap(capability, "security:approvals:read");
    return ctx.supervisor.getApproval(input?.requestId ?? "");
  });
  ipcMain.handle("security:approvals:decide", async (_event, capability: IpcCapability, input: ApprovalDecisionInput) => {
    requireCap(capability, "security:approvals:decide");
    return decideApprovalWithLocalConfirmation(ctx, input);
  });
  ipcMain.handle("security:approvals:revoke", async (_event, capability: IpcCapability, input: ApprovalQueueActionRef) => {
    requireCap(capability, "security:approvals:revoke");
    return ctx.supervisor.revokeApproval(input);
  });
  ipcMain.handle("security:approvals:execute", async (_event, capability: IpcCapability, input: ApprovalQueueActionRef) => {
    requireCap(capability, "security:approvals:execute");
    return executeApprovedWriteWithLocalConfirmation(ctx, input);
  });

  ipcMain.handle(
    "diagnostics:export-bundle",
    async (_event, capability: IpcCapability): Promise<{ path: string }> => {
      requireCap(capability, "diagnostics:export-bundle");
      const report = await ctx.supervisor.runDiagnostics();
      const win = ctx.getMainWindow();
      const dir = await dialog.showOpenDialog(win!, {
        title: "Save Diagnostic Bundle",
        properties: ["openDirectory", "createDirectory"],
      });
      if (dir.canceled || dir.filePaths.length === 0) throw new Error("Cancelled");
      // 诊断包 = 诊断报告 + 审计日志尾部 + 版本信息，放在同一个时间戳目录里。
      // 之前只导出 report，验收第 4 项还得手工比对审计文件。
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const outDir = path.join(dir.filePaths[0] ?? "", `c2c-diagnostic-${stamp}`);
      await fs.mkdir(outDir, { recursive: true });
      const out = path.join(outDir, "diagnostics.json");
      await fs.writeFile(out, JSON.stringify(report, null, 2), "utf8");
      await fs.writeFile(
        path.join(outDir, "versions.json"),
        JSON.stringify({ appVersion: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform }, null, 2),
        "utf8",
      );
      const auditRoot = path.join(ctx.getStateRoot(), "profiles");
      const profileDirs = await fs.readdir(auditRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of profileDirs) {
        if (!entry.isDirectory()) continue;
        for (const name of ["active.log", "tool-calls.jsonl"]) {
          const source = path.join(auditRoot, entry.name, "audit", name);
          const raw = await fs.readFile(source).catch(() => null);
          if (!raw) continue;
          const tail = raw.byteLength > 2 * 1024 * 1024 ? raw.subarray(raw.byteLength - 2 * 1024 * 1024) : raw;
          await fs.writeFile(path.join(outDir, `${entry.name}-${name}`), tail);
        }
      }
      return { path: outDir };
    },
  );

  // ===== Settings: ordinary profile fields and backup/restore =====
  ipcMain.handle(
    "settings:ordinary:update",
    async (_event, capability: IpcCapability, patch: OrdinarySettingsPatch) => {
      requireCap(capability, "settings:ordinary:update");
      const result = await ctx.supervisor.updateOrdinarySettings(patch);
      // 只写配置不会真的开机自启——必须同时注册到 Windows 登录项。
      // 之前 UI 只显示"是/否"，开关点了也没用，就是因为缺这一步。
      if (patch.autoStart?.atLogin !== undefined || patch.autoStart?.minimized !== undefined) {
        try {
          const values = result.values.autoStart;
          app.setLoginItemSettings({
            openAtLogin: values.atLogin === true,
            openAsHidden: values.minimized === true,
            path: process.execPath,
            args: values.minimized === true ? ["--hidden"] : [],
          });
        } catch {
          // 注册失败不阻断配置保存，UI 会显示实际登录项状态
        }
      }
      return result;
    },
  );

  ipcMain.handle("profile:port:change", async (_event, capability: IpcCapability, port: number) => {
    requireCap(capability, "settings:ordinary:update");
    return ctx.supervisor.changeRuntimePort(Number(port));
  });
  ipcMain.handle("app:autostart:status", async (_event, capability: IpcCapability) => {
    requireCap(capability, "settings:ordinary:update");
    try {
      const s = app.getLoginItemSettings({ path: process.execPath });
      return {
        openAtLogin: s.openAtLogin === true,
        openAsHidden: (s as { openAsHidden?: boolean }).openAsHidden === true,
        executable: process.execPath,
      };
    } catch {
      return { openAtLogin: false, openAsHidden: false, executable: process.execPath };
    }
  });

  // ===== Settings: backup & restore (config only; secrets stay in DPAPI) =====
  ipcMain.handle("settings:backup:export", async (_event, capability: IpcCapability): Promise<{ path: string; canceled: boolean }> => {
    requireCap(capability, "settings:backup:export");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active) throw new Error("ACTIVE_PROFILE_UNAVAILABLE");
    if (active.profileType === "remote") throw new Error("PROTECTED_PROFILE");
    const win = ctx.getMainWindow();
    if (!win) throw new Error("BACKUP_WINDOW_UNAVAILABLE");
    const result = await dialog.showSaveDialog(win, {
      title: "导出 Profile 配置备份",
      defaultPath: `c2c-profile-backup-${active.profileId}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { path: "", canceled: true };
    // The config payload contains no secret material (keys live in DPAPI);
    // still strip any nullable transport credential path to avoid leaking an
    // absolute credential file location into the export.
    const exportable = {
      ...active,
      transport: { ...active.transport, credentialPath: null },
    };
    await fs.writeFile(result.filePath, JSON.stringify(exportable, null, 2), "utf8");
    return { path: result.filePath, canceled: false };
  });

  ipcMain.handle("settings:backup:import", async (_event, capability: IpcCapability): Promise<{ restored: boolean; profileId: string }> => {
    requireCap(capability, "settings:backup:import");
    const active = await ctx.supervisor.getActiveProfile();
    if (!active) throw new Error("ACTIVE_PROFILE_UNAVAILABLE");
    if (active.profileType === "remote") throw new Error("PROTECTED_PROFILE");
    const win = ctx.getMainWindow();
    if (!win) throw new Error("BACKUP_WINDOW_UNAVAILABLE");
    const picked = await dialog.showOpenDialog(win, {
      title: "选择 Profile 配置备份文件",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { restored: false, profileId: active.profileId };
    const raw = await fs.readFile(picked.filePaths[0]!, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("BACKUP_JSON_INVALID");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BACKUP_SHAPE_INVALID");
    const config = parsed as Record<string, unknown>;
    if (config.schemaVersion !== "v2.0") throw new Error("BACKUP_SCHEMA_UNSUPPORTED");
    if (typeof config.profileId !== "string" || config.profileId !== active.profileId) {
      throw new Error("BACKUP_PROFILE_MISMATCH");
    }
    const confirmed = await dialog.showMessageBox(win, {
      type: "warning",
      title: "确认恢复配置备份",
      message: "用所选备份覆盖当前 Profile 配置？",
      detail: [
        `Profile: ${active.profileName} (${active.profileId})`,
        "恢复只覆盖配置（不含密钥/授权）。",
        "导入的配置必须通过隔离校验，任何保留实例残留都会被拒绝。",
      ].join("\n"),
      buttons: ["取消", "确认恢复"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmed.response !== 1) return { restored: false, profileId: active.profileId };
    const summary = await ctx.supervisor.restoreProfile(parsed as Parameters<IpcSupervisor["restoreProfile"]>[0]);
    return { restored: true, profileId: summary.profileId };
  });

  // ===== Write Policy (owner-authorized local writes) =====
  ipcMain.handle("write-policy:get", async (_event, capability: IpcCapability): Promise<WritePolicy> => {
    requireCap(capability, "write-policy:get");
    return new WritePolicyStore(ctx.getStateRoot()).load();
  });

  ipcMain.handle(
    "write-policy:set",
    async (
      _event,
      capability: IpcCapability,
      params: { update: WritePolicyUpdate; actor: string; requireConfirmation?: boolean },
    ): Promise<WritePolicyUpdateResult> => {
      requireCap(capability, "write-policy:set");
      const store = new WritePolicyStore(ctx.getStateRoot());
      const current = await store.load();
      let update: WritePolicyUpdate = { ...params.update };
      const nextEnabled = update.enabled ?? current.enabled;
      const willFlipOn = !current.enabled && nextEnabled === true;
      const nextDirs = update.allowedDirectories ?? current.allowedDirectories;
      const newDirs = nextDirs.filter((d) => !current.allowedDirectories.includes(d));
      const nextFiles = update.allowedFiles ?? current.allowedFiles;
      const newFiles = nextFiles.filter((file) => !current.allowedFiles.includes(file));
      const willAddPaths = newDirs.length > 0 || newFiles.length > 0;
      const willEnablePowerShell = !current.powershellEnabled && update.powershellEnabled === true;
      const nextTools = { ...current.tools, ...(update.tools ?? {}) };
      const newlyEnabledTools = (Object.keys(nextTools) as WriteToolId[])
        .filter((key) => nextTools[key] === true && current.tools[key] !== true);
      const clearingToEmpty = !nextEnabled && current.powershellEnabled !== true
        && nextDirs.length === 0 && nextFiles.length === 0
        && (current.deviceId !== null || current.profileId !== null || current.workspaceId !== null || current.workspaceRoot !== null);
      if (clearingToEmpty) {
        // Clearing a disabled policy is safe and deliberately removes stale bindings.
        update = { ...update, deviceId: null, profileId: null, workspaceId: null, workspaceRoot: null };
      } else if (willFlipOn || willAddPaths || willEnablePowerShell || newlyEnabledTools.length > 0) {
        const active = await ctx.supervisor.getActiveProfile();
        if (!active?.currentWorkspace?.root || !active.currentWorkspace.workspaceId) {
          throw new Error("WRITE_POLICY_WORKSPACE_UNAVAILABLE");
        }
        const bridge = { workspaceId: active.currentWorkspace.workspaceId, workspaceRoot: active.currentWorkspace.root };
        let deviceId = current.deviceId ?? active?.deviceId ?? null;
        try {
          deviceId = (await fs.readFile(path.join(ctx.getStateRoot(), "device.dpapi"), "utf8")).trim() || deviceId;
        } catch {
          // Existing local device identity or null remains authoritative.
        }
        const workspaceRoot = path.resolve(bridge.workspaceRoot);
        const bindingMismatch = (current.deviceId !== null && deviceId !== current.deviceId)
          || current.profileId !== null
          || (current.workspaceId !== null && current.workspaceId !== bridge.workspaceId)
          || (current.workspaceRoot !== null && path.resolve(current.workspaceRoot) !== workspaceRoot);
        if (bindingMismatch) throw new Error("WRITE_POLICY_BINDING_MISMATCH");
        update = {
          ...update,
          deviceId,
          profileId: null,
          workspaceId: bridge.workspaceId,
          workspaceRoot,
        };
      }
      // Main always performs the owner confirmation for privilege grants; the renderer cannot suppress it.
      const needsConfirmation = willEnablePowerShell || willFlipOn || willAddPaths || newlyEnabledTools.length > 0;
      if (needsConfirmation) {
        const win = ctx.getMainWindow();
        if (!win) throw new Error("WRITE_POLICY_CONFIRMATION_WINDOW_UNAVAILABLE");
        const lines: string[] = [];
        if (willFlipOn) {
          lines.push("• 启用【本地写入】开关：AI 客户端可向白名单目录写入文件。");
        }
        if (willAddPaths) {
          if (newDirs.length > 0) {
            lines.push(`• 新增 ${newDirs.length} 个允许写入目录：`);
            for (const directory of newDirs) lines.push(`  - ${directory}`);
          }
          if (newFiles.length > 0) {
            lines.push(`• 新增 ${newFiles.length} 个精确允许写入文件：`);
            for (const file of newFiles) lines.push(`  - ${file}`);
          }
        }
        if (willEnablePowerShell) {
          lines.push("• 启用完整 PowerShell：仅放行 run_powershell；受限命令与 Git commit 仍由各自独立工具开关控制。");
          lines.push("  完整 PowerShell 以当前 Windows 用户权限运行任意命令，不受文件白名单限制。这不是 OS 沙箱，不会自动提升为管理员；默认保持关闭。");
        }
        if (newlyEnabledTools.length > 0) {
          const names: Record<WriteToolId, string> = {
            createFile: "新建文件",
            updateFile: "修改已有文件",
            deleteFile: "删除文件",
            executeCommand: "受限命令执行",
            gitCommit: "Git 提交",
            powershell: "完整 PowerShell",
          };
          lines.push(`• 新增功能开关：${newlyEnabledTools.map((tool) => names[tool]).join("、")}。`);
          if (newlyEnabledTools.includes("deleteFile")) {
            lines.push("  删除前会自动备份，可凭审计中的备份编号恢复。");
          }
          if (newlyEnabledTools.includes("executeCommand")) {
            lines.push("  受限命令只允许白名单程序与参数规则，但仍可能执行项目代码；不自动获得完整 PowerShell 权限。");
          }
          if (newlyEnabledTools.includes("gitCommit")) {
            lines.push("  Git 提交只允许提交已经暂存的变更，不自动暂存，也不允许 push。");
          }
          if (newlyEnabledTools.includes("powershell")) {
            lines.push("  完整 PowerShell 以当前 Windows 用户权限运行，不受文件白名单限制；不是 OS 沙箱。");
          }
        }
        lines.push("");
        lines.push("审计链仍会记录每一次操作（客户端、时间、目标及结果）。");
        lines.push("OAuth 鉴权仍生效（仅已认证的客户端能写入）。");
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          title: "本机确认写入授权",
          message: "确认应用这次写入授权变更？",
          detail: lines.join("\n"),
          buttons: ["确认授权", "取消"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (result.response !== 0) {
          return { policy: current, changed: false };
        }
      }
      return store.update(update, params.actor);
    },
  );

  ipcMain.handle(
    "write-policy:add-dir",
    async (
      _event,
      capability: IpcCapability,
      params: { path: string; actor: string },
    ): Promise<{ policy: WritePolicy; added: boolean; reason?: "duplicate" | "cap_exceeded" }> => {
      requireCap(capability, "write-policy:add-dir");
      const store = new WritePolicyStore(ctx.getStateRoot());
      return store.addAllowedDirectory(params.path, params.actor);
    },
  );

  ipcMain.handle(
    "write-policy:remove-dir",
    async (
      _event,
      capability: IpcCapability,
      params: { path: string; actor: string },
    ): Promise<{ policy: WritePolicy; removed: boolean }> => {
      requireCap(capability, "write-policy:remove-dir");
      const store = new WritePolicyStore(ctx.getStateRoot());
      return store.removeAllowedDirectory(params.path, params.actor);
    },
  );

  ipcMain.handle(
    "write-policy:audit",
    async (
      _event,
      capability: IpcCapability,
      params: { limit?: number } = {},
    ): Promise<WriteAuditEntry[]> => {
      requireCap(capability, "write-policy:audit");
      const active = await ctx.supervisor.getActiveProfile();
      const c2cEntries = active
        ? await readWriteAuditEntries(
          path.join(ctx.getStateRoot(), "profiles", active.profileId, "audit", "active.log"),
          params.limit ?? 20,
        )
        : [];
      return [...c2cEntries]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, Math.max(1, Math.min(100, Math.floor(params.limit ?? 20))));
    },
  );
}

function requireCap(provided: IpcCapability, expected: IpcCapability): void {
  if (provided !== expected) {
    throw new Error(`Capability mismatch: expected ${expected}, got ${provided}`);
  }
}

interface AclConfirmationContext {
  window: BrowserWindow;
  profileId: string;
  profileName: string;
  workspaceId: string;
  workspaceRoot: string;
}

/** Renderer inputs are copied from an allowlist before confirmation and signing. */
export async function addFolderAclRuleWithLocalConfirmation(ctx: IpcContext, rawInput: FolderAclAddInput): Promise<FolderAccessEntry> {
  const input = captureFolderAclAddInput(rawInput);
  const context = await requireAclConfirmationContext(ctx);
  const confirmed = await showAclMutationConfirmation(context, {
    title: "本机确认文件夹授权",
    message: "确认添加这条文件夹授权规则？",
    details: [
      `Profile: ${JSON.stringify(context.profileName)} (${context.profileId})`,
      `Workspace: ${context.workspaceId}`,
      `目录: ${JSON.stringify(input.path)}`,
      `权限: ${formatAclAccess(input.access)}`,
      `扩展名范围: ${formatExtensionPolicy(input.extensionPolicy)}`,
      `授权名称: ${JSON.stringify(input.label ?? "")}`,
      "确认后只提交以上精确规则；Supervisor 仍会校验规范路径、当前 Workspace 和 ACL 范围。",
    ],
    buttons: ["确认授权", "取消"],
  });
  if (!confirmed) throw new Error("ACL_CONFIRMATION_CANCELLED");

  await assertSameAclConfirmationContext(ctx, context);
  const confirmedInput: ConfirmedFolderAclAddInput = {
    ...input,
    nativeConfirmation: "LOCAL_CONFIRMED",
    confirmedProfileId: context.profileId,
    confirmedWorkspaceId: context.workspaceId,
    confirmedWorkspaceRoot: context.workspaceRoot,
  };
  // SupervisorClient signs this exact method+params object. The marker and scope
  // are created only after the native Main dialog has returned affirmative.
  return ctx.supervisor.addFolderAclRule(confirmedInput);
}

export async function removeFolderAclRuleWithLocalConfirmation(ctx: IpcContext, rawInput: FolderAclRemoveInput): Promise<{ removed: boolean; revision: number }> {
  const input = captureFolderAclRemoveInput(rawInput);
  const context = await requireAclConfirmationContext(ctx);
  const confirmationRef = toAclRuleConfirmationRef(input, context);
  const rule = await ctx.supervisor.getFolderAclRuleForConfirmation(confirmationRef);
  if (!rule) throw new Error("ACL_RULE_NOT_FOUND");
  assertAclRuleScope(rule, context, input.expectedRevision);

  const broadensAccess = rule.access === "DENY" || rule.inheritance === "INHERITED";
  const confirmed = await showAclMutationConfirmation(context, {
    title: "本机确认移除文件夹规则",
    message: "确认移除这条文件夹授权规则？",
    details: [
      `Profile: ${JSON.stringify(context.profileName)} (${context.profileId})`,
      `Workspace: ${context.workspaceId}`,
      `规则: ${rule.ruleId} · revision ${rule.revision}`,
      `目录: ${JSON.stringify(rule.folderPath)}`,
      `权限: ${formatAclAccess(rule.access)}`,
      `扩展名范围: ${formatExtensionPolicy(rule.extensionPolicy)}`,
      `继承: ${rule.inheritance}`,
      ...(broadensAccess ? ["警告：移除 DENY 或继承规则可能扩大有效访问范围。"] : []),
      "确认后只移除以上 ruleId/revision；规则或工作区发生变化时 Supervisor 会拒绝操作。",
    ],
    buttons: ["确认移除", "取消"],
  });
  if (!confirmed) throw new Error("ACL_CONFIRMATION_CANCELLED");

  await assertSameAclConfirmationContext(ctx, context);
  const currentRule = await ctx.supervisor.getFolderAclRuleForConfirmation(confirmationRef);
  if (!currentRule || !sameAclRule(rule, currentRule)) throw new Error("ACL_RULE_CHANGED_DURING_CONFIRMATION");
  const confirmedInput: ConfirmedFolderAclRemoveInput = {
    ...input,
    nativeConfirmation: "LOCAL_CONFIRMED",
    confirmedProfileId: context.profileId,
    confirmedWorkspaceId: context.workspaceId,
    confirmedWorkspaceRoot: context.workspaceRoot,
  };
  return ctx.supervisor.removeFolderAclRule(confirmedInput);
}

function captureFolderAclAddInput(input: FolderAclAddInput): FolderAclAddInput {
  if (!isPlainObject(input)) throw new Error("ACL_BAD_REQUEST");
  const allowedKeys = new Set(["path", "access", "label", "extensionPolicy"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error("ACL_BAD_REQUEST");
  if (typeof input.path !== "string" || !input.path.trim()) throw new Error("ACL_BAD_REQUEST");
  if (input.access !== "READ_ONLY" && input.access !== "READ_WRITE" && input.access !== "DENY") throw new Error("ACL_BAD_REQUEST");
  if (input.label !== undefined && typeof input.label !== "string") throw new Error("ACL_BAD_REQUEST");
  if (!isPlainObject(input.extensionPolicy)) throw new Error("ACL_BAD_REQUEST");
  if (input.extensionPolicy.mode === "ALLOW_ALL") {
    if (Object.keys(input.extensionPolicy).some((key) => key !== "mode")) throw new Error("ACL_BAD_REQUEST");
    return { path: input.path, access: input.access, label: input.label, extensionPolicy: { mode: "ALLOW_ALL" } };
  }
  if (input.extensionPolicy.mode !== "ALLOW_LIST"
    || Object.keys(input.extensionPolicy).some((key) => key !== "mode" && key !== "allowedExtensions")
    || !Array.isArray(input.extensionPolicy.allowedExtensions)
    || input.extensionPolicy.allowedExtensions.some((extension) => typeof extension !== "string")) {
    throw new Error("ACL_BAD_REQUEST");
  }
  return {
    path: input.path,
    access: input.access,
    label: input.label,
    extensionPolicy: { mode: "ALLOW_LIST", allowedExtensions: [...input.extensionPolicy.allowedExtensions] },
  };
}

function captureFolderAclRemoveInput(input: FolderAclRemoveInput): FolderAclRemoveInput {
  if (!isPlainObject(input)
    || Object.keys(input).some((key) => key !== "ruleId" && key !== "expectedRevision")
    || typeof input.ruleId !== "string"
    || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1) {
    throw new Error("ACL_BAD_REQUEST");
  }
  return { ruleId: input.ruleId, expectedRevision: input.expectedRevision };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function requireAclConfirmationContext(ctx: IpcContext): Promise<AclConfirmationContext> {
  const active = await ctx.supervisor.getActiveProfile();
  if (!active) throw new Error("SECURITY_ACTIVE_PROFILE_UNAVAILABLE");
  if (active.profileType === "remote") throw new Error("PROTECTED_PROFILE");
  if (!active.currentWorkspace.workspaceId || !active.currentWorkspace.root) throw new Error("SECURITY_WORKSPACE_REQUIRED");
  const window = ctx.getMainWindow();
  if (!window || window.isDestroyed()) throw new Error("ACL_CONFIRMATION_WINDOW_UNAVAILABLE");
  return {
    window,
    profileId: active.profileId,
    profileName: active.profileName,
    workspaceId: active.currentWorkspace.workspaceId,
    workspaceRoot: active.currentWorkspace.root,
  };
}

async function assertSameAclConfirmationContext(ctx: IpcContext, expected: AclConfirmationContext): Promise<void> {
  const active = await ctx.supervisor.getActiveProfile();
  if (!active || active.profileType === "remote"
    || active.profileId !== expected.profileId
    || active.currentWorkspace.workspaceId !== expected.workspaceId
    || active.currentWorkspace.root !== expected.workspaceRoot) {
    throw new Error("ACL_PROFILE_OR_WORKSPACE_CHANGED");
  }
}

function toAclRuleConfirmationRef(input: FolderAclRemoveInput, context: AclConfirmationContext): FolderAclRuleConfirmationInput {
  return {
    ruleId: input.ruleId,
    expectedRevision: input.expectedRevision,
    expectedProfileId: context.profileId,
    expectedWorkspaceId: context.workspaceId,
    expectedWorkspaceRoot: context.workspaceRoot,
  };
}

function assertAclRuleScope(rule: FolderAccessEntry, context: AclConfirmationContext, expectedRevision: number): void {
  if (rule.profileId !== context.profileId || rule.workspaceId !== context.workspaceId) throw new Error("ACL_PROFILE_OR_WORKSPACE_CHANGED");
  if (rule.revision !== expectedRevision) throw new Error("ACL_STALE_REVISION");
}

function sameAclRule(left: FolderAccessEntry, right: FolderAccessEntry): boolean {
  return left.ruleId === right.ruleId
    && left.profileId === right.profileId
    && left.workspaceId === right.workspaceId
    && left.folderPath === right.folderPath
    && left.access === right.access
    && left.inheritance === right.inheritance
    && left.revision === right.revision
    && left.updatedAt === right.updatedAt
    && JSON.stringify(left.extensionPolicy) === JSON.stringify(right.extensionPolicy);
}

function formatAclAccess(access: FolderAccessEntry["access"] | FolderAclAddInput["access"]): string {
  switch (access) {
    case "READ_ONLY": return "只读";
    case "READ_WRITE": return "读写";
    case "DENY": return "禁止";
  }
}

function formatExtensionPolicy(policy: FolderAccessEntry["extensionPolicy"] | FolderAclAddInput["extensionPolicy"]): string {
  if (policy.mode === "ALLOW_ALL") {
    const deniedExtensions = "deniedExtensions" in policy ? policy.deniedExtensions : [];
    return `允许所有扩展名；拒绝列表：${JSON.stringify(deniedExtensions)}`;
  }
  return `仅允许扩展名：${JSON.stringify(policy.allowedExtensions)}`;
}

async function showAclMutationConfirmation(
  context: AclConfirmationContext,
  input: { title: string; message: string; details: string[]; buttons: [string, string] },
): Promise<boolean> {
  const result = await dialog.showMessageBox(context.window, {
    type: "warning",
    title: input.title,
    message: input.message,
    detail: input.details.join("\n"),
    buttons: input.buttons,
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

export async function decideApprovalWithLocalConfirmation(ctx: IpcContext, input: ApprovalDecisionInput): Promise<ApprovalRecordView> {
  if (!input || (input.decision !== "APPROVE" && input.decision !== "REJECT")) throw new Error("APPROVAL_BAD_REQUEST");
  if (input.decision === "APPROVE") {
    const record = await requireCurrentApproval(ctx.supervisor, input);
    const active = await ctx.supervisor.getActiveProfile();
    if (active?.profileType === "remote") throw new Error("PROTECTED_PROFILE");
    const confirmed = await confirmLocalApproval(ctx, record);
    if (!confirmed) return record;
  }
  return ctx.supervisor.decideApproval(input);
}

export async function executeApprovedWriteWithLocalConfirmation(ctx: IpcContext, input: ApprovalQueueActionRef) {
  const active = await ctx.supervisor.getActiveProfile();
  if (active?.profileType === "remote") throw new Error("PROTECTED_PROFILE");
  const record = await requireCurrentApproval(ctx.supervisor, input);
  if (record.decision !== "APPROVED") throw new Error("APPROVAL_NOT_EXECUTABLE");
  const queue = await ctx.supervisor.listApprovals();
  if (queue.executionAvailability === "AVAILABLE") {
    const confirmed = await confirmLocalExecution(ctx, record);
    if (!confirmed) {
      return {
        status: "UNAVAILABLE" as const,
        code: "APPROVAL_NOT_EXECUTABLE" as const,
        record,
      };
    }
  }
  // The Supervisor enforces the one-shot approved CREATE permit and the exact isolated test root.
  // This route accepts no content or caller-supplied target path.
  return ctx.supervisor.executeApprovedWrite(input);
}

async function requireCurrentApproval(
  supervisor: IpcSupervisor,
  input: Pick<ApprovalDecisionInput, "requestId" | "expectedRevision">,
) {
  const record = await supervisor.getApproval(input.requestId);
  if (!record) throw new Error("APPROVAL_NOT_FOUND");
  if (record.revision !== input.expectedRevision) throw new Error("APPROVAL_STALE_REVISION");
  return record;
}

async function confirmLocalApproval(ctx: IpcContext, record: ApprovalRecordView): Promise<boolean> {
  const win = ctx.getMainWindow();
  if (!win) throw new Error("APPROVAL_CONFIRMATION_WINDOW_UNAVAILABLE");
  const active = await ctx.supervisor.getActiveProfile();
  if (!active || active.profileId !== record.profileId || active.currentWorkspace.workspaceId !== record.workspaceId) {
    throw new Error("APPROVAL_PROFILE_OR_WORKSPACE_CHANGED");
  }
  if (record.requester?.kind === "MCP" && record.diff.state !== "AVAILABLE") {
    throw new Error("APPROVAL_PREVIEW_UNAVAILABLE");
  }
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    title: "本机确认写入审批",
    message: "批准这项绑定到当前工作区的文件操作？",
    detail: [
      `Profile: ${record.profileName} (${record.profileId})`,
      `Workspace: ${record.workspaceId}`,
      `请求身份: ${record.requester ? `${record.requester.clientId} / ${String(record.requester.requestId)} / ${record.requester.runtimeInstanceId}` : "本地/旧请求"}`,
      `目标: ${record.targetPath}`,
      `操作: ${record.operation} · ${record.summary}`,
      ...(record.requester?.kind === "MCP" ? [`待写入内容（与摘要绑定）:\n${record.diff.lines.map((line) => line.text).join("\n")}`] : []),
      `内容 SHA-256: ${record.binding.contentDigest}`,
      `目标版本: ${record.binding.expectedTargetVersion}`,
      "批准只记录审批决定，不代表文件已写入。执行需要单独的本机受控动作。",
    ].join("\n"),
    buttons: ["批准", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function confirmLocalExecution(ctx: IpcContext, record: ApprovalRecordView): Promise<boolean> {
  const win = ctx.getMainWindow();
  if (!win) throw new Error("APPROVAL_CONFIRMATION_WINDOW_UNAVAILABLE");
  const active = await ctx.supervisor.getActiveProfile();
  if (!active || active.profileId !== record.profileId || active.currentWorkspace.workspaceId !== record.workspaceId) {
    throw new Error("APPROVAL_PROFILE_OR_WORKSPACE_CHANGED");
  }
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    title: "本机确认执行写入",
    message: "执行这项已批准的文件操作？",
    detail: [
      `Profile: ${record.profileName} (${record.profileId})`,
      `Workspace: ${record.workspaceId}`,
      `请求身份: ${record.requester ? `${record.requester.clientId} / ${String(record.requester.requestId)} / ${record.requester.runtimeInstanceId}` : "本地/旧请求"}`,
      `目标: ${record.targetPath}`,
      `操作: ${record.operation} · ${record.summary}`,
      ...(record.requester?.kind === "MCP" ? [`待写入内容（与摘要绑定）:\n${record.diff.lines.map((line) => line.text).join("\n")}`] : []),
      `内容 SHA-256: ${record.binding.contentDigest}`,
      `目标版本: ${record.binding.expectedTargetVersion}`,
      "Supervisor 将再次校验 Profile、Workspace、ACL、目标路径和文件版本；只有写后复读验证通过才会标记成功。",
    ].join("\n"),
    buttons: ["执行", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function readWriteAuditEntries(
  logPath: string,
  limit: number,
): Promise<WriteAuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const out: WriteAuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as Record<string, unknown>;
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (!payload || payload.event !== "WRITE_RECORD") continue;
    const actor = (payload.actor as Record<string, unknown> | undefined) ?? {};
    out.push({
      sequence: typeof entry.sequence === "number" ? entry.sequence : 0,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      actor: {
        clientId: typeof actor.clientId === "string" ? actor.clientId : "unknown",
        requestId: typeof actor.requestId === "string" ? actor.requestId : null,
      },
      workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : "unknown",
      relativePath: typeof payload.relativePath === "string" ? payload.relativePath : "",
      operation: payload.operation === "OVERWRITE" || payload.operation === "UPDATE" || payload.operation === "DELETE"
        || payload.operation === "PATCH" || payload.operation === "POWERSHELL"
        || payload.operation === "EXECUTE_COMMAND" || payload.operation === "GIT_COMMIT"
        ? payload.operation
        : "CREATE",
      bytesWritten: typeof payload.bytesWritten === "number" ? payload.bytesWritten : 0,
      beforeSha256: typeof payload.beforeSha256 === "string" ? payload.beforeSha256 : null,
      afterSha256: typeof payload.afterSha256 === "string" ? payload.afterSha256 : null,
      outcome: payload.outcome === "STARTED" || payload.outcome === "COMPLETED"
        || payload.outcome === "DENIED" || payload.outcome === "FAILED"
        ? payload.outcome
        : "WRITTEN",
      source: payload.source === "legacy" ? "legacy" : "runtime",
      ...(typeof payload.reasonCode === "string" ? { reasonCode: payload.reasonCode } : {}),
    });
  }
  return out;
}



interface PositionedAuditLine {
  text: string;
  start: number;
}

function splitAuditLinesWithOffsets(raw: string): PositionedAuditLine[] {
  const lines: PositionedAuditLine[] = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf("\n", start);
    const end = newline < 0 ? raw.length : newline;
    const rawLine = raw.slice(start, end);
    lines.push({ text: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, start });
    start = newline < 0 ? raw.length : newline + 1;
  }
  return lines;
}

function isLegacyAgentAuditRecord(record: Record<string, unknown>): boolean {
  if ("sequence" in record || "previousHash" in record || "recordHash" in record) return false;
  const actor = record.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) return false;
  const actorRecord = actor as Record<string, unknown>;
  const outcome = typeof record.outcome === "string" ? record.outcome.toLowerCase() : "";
  return typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
    && typeof record.relativePath === "string"
    && typeof record.bytesWritten === "number" && Number.isFinite(record.bytesWritten) && record.bytesWritten >= 0
    && ["written", "completed", "failed", "denied"].includes(outcome)
    && record.source === "codex-bridge"
    && typeof actorRecord.clientId === "string"
    && (actorRecord.requestId === null || typeof actorRecord.requestId === "string");
}



