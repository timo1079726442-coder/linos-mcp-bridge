/**
 * Preload — the only bridge between Renderer and Main.
 *
 * Per CP1 SECURITY_MODEL_V2 §3, every IPC call carries a capability token.
 * Renderer cannot directly call ipcRenderer.invoke with arbitrary channels;
 * it must use the typed wrappers exported as `c2c`.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  ProfileSummary,
  ProfileType,
  ProfileConfig,
  OrdinarySettingsPatch,
  OrdinarySettingsUpdateResult,
  ServiceConnectionSettingsPatch,
  ServiceConnectionSettingsUpdateResult,
  ServiceConnectionSettingsView,
  ServiceCredentialImportResult,
  WorkspaceInfo,
  WorkspaceCandidate,
  ReadinessSnapshot,
  DiagnosticsReport,
  ConnectionIntent,
  FaultCasesRequest,
  FaultCasesResponse,
  MatchRepairOptionsRequest,
  MatchRepairOptionsResponse,
  RunRepairRequest,
  RunRepairResponse,
  RepairHistoryRequest,
  RepairHistoryResponse,
  ExecutionListResponse,
  ExecutionOutputResponse,
  GitChangeSummary,
  WritePolicy,
  WritePolicyUpdate,
  WritePolicyUpdateResult,
  WriteAuditEntry,
  ScreenAccessSnapshot,
} from "../shared/types.js";

import type {
  ApprovalDecisionInput,
  ApprovalExecutionActionResult,
  ApprovalQueueSnapshot,
  ApprovalRecordRef,
  ApprovalRecordView,
  FolderAccessCheckInput,
  FolderAccessEntry,
  FolderAccessVerdict,
  FolderAclAddInput,
  FolderAclRemoveInput,
  FolderAclSnapshot,
} from "../shared/security.js";

type Ipc<TParams, TResult> = (params: TParams) => Promise<TResult>;

const c2c = {
  profile: {
    list: (): Promise<ProfileSummary[]> =>
      ipcRenderer.invoke("profile:list", "profile:list"),
    create: (params: { profileName: string; profileType: ProfileType; initialWorkspaceRoot?: string | null; expectedLocalPort?: number }): Promise<ProfileSummary> =>
      ipcRenderer.invoke("profile:create", "profile:create", params),
    setActive: (profileId: string): Promise<ProfileConfig | null> =>
      ipcRenderer.invoke("profile:set-active", "profile:set-active", profileId),
    getActive: (): Promise<ProfileConfig | null> =>
      ipcRenderer.invoke("profile:get-active", "profile:get-active"),
    getServiceSettings: (): Promise<ServiceConnectionSettingsView> =>
      ipcRenderer.invoke("profile:service-get", "profile:read"),
    updateServiceSettings: (patch: ServiceConnectionSettingsPatch): Promise<ServiceConnectionSettingsUpdateResult> =>
      ipcRenderer.invoke("profile:service-update", "profile:update", patch),
    importServiceCredential: (): Promise<ServiceCredentialImportResult> =>
      ipcRenderer.invoke("profile:service-import-credential", "profile:update"),
  },
  workspace: {
    pick: (): Promise<string | null> =>
      ipcRenderer.invoke("workspace:pick", "workspace:pick"),
    validate: (root: string): Promise<WorkspaceInfo> =>
      ipcRenderer.invoke("workspace:validate", "workspace:validate", root),
    detect: (root: string): Promise<WorkspaceCandidate> =>
      ipcRenderer.invoke("workspace:detect", "workspace:detect", root),
    gitChanges: (root: string): Promise<GitChangeSummary> =>
      ipcRenderer.invoke("workspace:git-changes", "workspace:git-changes", root),
    changePrepare: (params: { profileId: string; newWorkspaceRoot: string }) =>
      ipcRenderer.invoke("workspace:change-prepare", "workspace:change-prepare", params),
    changeCommit: (params: { profileId: string }): Promise<{ action: "commit" | "noop" }> =>
      ipcRenderer.invoke("workspace:change-commit", "workspace:change-commit", params),
  },
  intent: {
    /** grantAllScopes=true：全权模式，让 ChatGPT 获得全部工具权限（含写入/命令）。 */
    create: (params?: { grantAllScopes?: boolean }): Promise<ConnectionIntent> =>
      ipcRenderer.invoke("intent:create", "intent:create", params ?? {}),
    openChatgpt: (): Promise<{ url: string }> =>
      ipcRenderer.invoke("intent:open-chatgpt", "intent:open-chatgpt"),
  },
  tunnel: {
    status: (): Promise<{
      running: boolean;
      url: string | null;
      port: number | null;
      pid: number | null;
      cloudflaredPath: string | null;
      error: string | null;
      startedAt: number | null;
    }> => ipcRenderer.invoke("tunnel:local:status", "tunnel:local:manage"),
    start: (port: number): Promise<{
      running: boolean;
      url: string | null;
      port: number | null;
      pid: number | null;
      cloudflaredPath: string | null;
      error: string | null;
      startedAt: number | null;
    }> => ipcRenderer.invoke("tunnel:local:start", "tunnel:local:manage", { port }),
    stop: (): Promise<{
      running: boolean;
      url: string | null;
      port: number | null;
      pid: number | null;
      cloudflaredPath: string | null;
      error: string | null;
      startedAt: number | null;
    }> => ipcRenderer.invoke("tunnel:local:stop", "tunnel:local:manage"),
  },
  connection: {
    diagnose: (port: number): Promise<{
      port: number;
      stages: Array<{
        stage: string;
        label: string;
        status: "PASS" | "FAIL" | "SKIP";
        detail: string;
        fixable: boolean;
      }>;
      overall: "PASS" | "FAIL";
      suggestion: string;
      checkedAt: number;
    }> => ipcRenderer.invoke("connection:diagnose", "connection:diagnose", { port }),
    repair: (port: number): Promise<{
      actions: Array<{ stage: string; action: string; ok: boolean; detail: string }>;
      report: {
        port: number;
        stages: Array<{
          stage: string;
          label: string;
          status: "PASS" | "FAIL" | "SKIP";
          detail: string;
          fixable: boolean;
        }>;
        overall: "PASS" | "FAIL";
        suggestion: string;
        checkedAt: number;
      };
    }> => ipcRenderer.invoke("connection:repair", "connection:repair", { port }),
  },
  service: {
    restartRuntime: (): Promise<{ ok: boolean; previousPid: number | null; state: unknown }> =>
      ipcRenderer.invoke("service:runtime:restart", "service:runtime:restart"),
    createPairing: (port?: number): Promise<{ ok: boolean; code: string; expiresAt: number }> =>
      ipcRenderer.invoke("service:pairing:create", "service:pairing:create", { port }),
    clearPairing: (port?: number): Promise<{ ok: boolean; cleared: boolean }> =>
      ipcRenderer.invoke("service:pairing:clear", "service:pairing:clear", { port }),
    portAvailable: (port: number): Promise<{ available: boolean; reason?: string }> =>
      ipcRenderer.invoke("runtime:port:check", "runtime:port:check", { port }),
    restartTransport: (): Promise<{ ok: boolean; provider: string; port: number }> =>
      ipcRenderer.invoke("service:transport:restart", "service:transport:restart"),
  },
  audit: {
    toolStatus: (): Promise<{ ok: boolean; entries: number; brokenAt?: number; path: string; latestSuccessfulTool?: string | null; latestSuccessfulToolCallAt?: string | null }> =>
      ipcRenderer.invoke("audit:tool:status", "audit:tool:status"),
  },
  jobs: {
    list: (limit?: number): Promise<Array<{ job_id?: string; id?: string; state: string; kind: string; attempts: number; duration_ms?: number; durationMs?: number; output_bytes?: number; outputBytes?: number; progress: string; error_code?: string; errorCode?: string; finished_at?: string | null; finishedAt?: string | null; display: string }>> =>
      ipcRenderer.invoke("jobs:list", "jobs:read", { limit }),
    get: (id: string): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("jobs:get", "jobs:read", { id }),
    output: (params: { id: string; offset?: number; maxBytes?: number }): Promise<{ jobId: string; state: string; output: string; nextOffset: number; next_offset?: number; eof: boolean; truncated: boolean }> =>
      ipcRenderer.invoke("jobs:output", "jobs:read", params),
    cancel: (id: string): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("jobs:cancel", "jobs:manage", { id }),
  },
  multiService: {
    list: (): Promise<import("../shared/multiService.js").ManagedServiceView[]> =>
      ipcRenderer.invoke("service:multi:list", "service:multi:list"),
    create: (params: import("../shared/multiService.js").ManagedServiceCreateInput): Promise<import("../shared/multiService.js").ManagedServiceCreateResult> =>
      ipcRenderer.invoke("service:multi:create", "service:multi:create", params),
    stop: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("service:multi:stop", "service:multi:stop", { id }),
    start: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("service:multi:start", "service:multi:start", { id }),
  },
  namedTunnel: {
    status: (): Promise<{
      cloudflaredPath: string | null;
      loggedIn: boolean;
      certPath: string;
      tunnels: Array<{ id: string; name: string }>;
      detail: string;
    }> => ipcRenderer.invoke("tunnel:named:status", "tunnel:named:manage"),
    pick: (): Promise<{ ok: boolean; path: string | null; reason?: string }> =>
      ipcRenderer.invoke("tunnel:named:pick", "tunnel:named:manage"),
    install: (): Promise<{ ok: boolean; path: string; detail: string }> =>
      ipcRenderer.invoke("tunnel:named:install", "tunnel:named:manage"),
    login: (): Promise<{ ok: boolean; detail: string }> =>
      ipcRenderer.invoke("tunnel:named:login", "tunnel:named:manage"),
    provision: (params: { hostname: string; tunnelName: string; port?: number }): Promise<{
      ok: boolean;
      tunnelId: string;
      tunnelName: string;
      hostname: string;
      zone: string;
      credentialPath: string;
      configPath: string;
      binaryPath: string;
      publicMcpUrl: string;
      steps: Array<{ step: string; ok: boolean; detail: string }>;
    }> => ipcRenderer.invoke("tunnel:named:provision", "tunnel:named:manage", params),
  },  toolPolicy: {
    get: (): Promise<{
      tools: Record<string, { enabled: boolean; approval: "auto" | "manual" }>;
      profileDir: string | null;
      workspaceId: string | null;
      source: "workspace" | "profile" | "default";
      file: string | null;
    }> => ipcRenderer.invoke("tools:policy:get", "tools:policy:manage"),
    set: (tools: Record<string, { enabled: boolean; approval: "auto" | "manual" }>): Promise<{
      ok: boolean;
      file: string;
      workspaceId: string | null;
      source: "workspace" | "profile";
    }> => ipcRenderer.invoke("tools:policy:set", "tools:policy:manage", { tools }),
  },  datasources: {
    list: (): Promise<{
      datasources: Array<{
        id: string;
        kind: "mysql";
        name: string;
        host: string;
        port: number;
        database: string;
        user: string;
        options: { maxRows: number; timeoutMs: number; allowedTables?: string[] };
        hasSecret: boolean;
        createdAt: string;
        updatedAt: string;
      }>;
      workspaceId: string | null;
      workspaceRoot: string | null;
      secretBackend: string;
      productionSafe: boolean;
    }> => ipcRenderer.invoke("datasources:list", "datasources:manage"),
    save: (input: Record<string, unknown>): Promise<{ id: string }> =>
      ipcRenderer.invoke("datasources:save", "datasources:manage", input),
    remove: (id: string): Promise<{ ok: boolean; id: string }> =>
      ipcRenderer.invoke("datasources:remove", "datasources:manage", { id }),
    test: (id: string): Promise<{
      ok: boolean;
      server_version: string | null;
      current_user: string | null;
      grants: string[];
      write_privileges: string[];
      read_only_account: boolean;
      warnings: string[];
    }> => ipcRenderer.invoke("datasources:test", "datasources:manage", { id }),
    generateSql: (params: { user: string; database: string }): Promise<{
      user: string;
      database: string;
      password: string;
      sql: string;
      note: string;
    }> => ipcRenderer.invoke("datasources:generate-sql", "datasources:manage", params),
  },  network: {
    getAllowlist: (): Promise<{
      domains: string[];
      allowHttp: boolean;
      workspaceId: string | null;
      source: "workspace" | "profile" | "default";
      file: string | null;
    }> => ipcRenderer.invoke("network:allowlist:get", "network:manage"),
    setAllowlist: (params: { domains: string[]; allowHttp: boolean }): Promise<{
      ok: boolean;
      file: string;
      domains: number;
      allowHttp: boolean;
    }> => ipcRenderer.invoke("network:allowlist:set", "network:manage", params),
  },  services: {
    discover: (): Promise<{
      services: Array<{
        port: number;
        reachable: boolean;
        kind: string;
        name: string | null;
        version: string | null;
        source: string;
        hasTools: boolean | null;
      }>;
      expected: Array<{ kind: string; label: string; present: boolean; port: number | null }>;
      checkedPorts: number[];
      checkedAt: number;
    }> => ipcRenderer.invoke("services:discover", "services:discover"),
  },  logs: {
    read: (limit?: number): Promise<{
      entries: Array<{ ts: string; source: string; event: string; detail: string }>;
      sources: Array<{ name: string; path: string; bytes: number; lastWriteAt: string | null }>;
      truncated: boolean;
      stateRoot: string;
    }> => ipcRenderer.invoke("logs:read", "logs:read", { limit }),
  },  peer: {
    inspect: (port: number): Promise<{
      port: number;
      reachable: boolean;
      name: string | null;
      version: string | null;
      authMode: string | null;
      mcpPath: string | null;
      toolCount: number | null;
      tools: Array<{ name: string; registered: boolean; description: string; group: string; conditional: boolean; risk?: string; enabled?: boolean; approval?: string }>;
      dangerousMode: {
        enabled: boolean;
        autoApprovePreparedWrites: boolean;
        exposeDirectWriteFile: boolean;
        allowCreate: boolean;
        allowOverwrite: boolean;
        allowDelete: boolean;
        allowMove: boolean;
        allowShell: boolean;
      } | null;
      roots: Array<{ id: string; path: string; access: string }>;
      chatgptConnectorUrl: string | null;
      publicBaseUrl: string | null;
      session: {
        expired: boolean | null;
        createdAt: string | null;
        expiresAt: string | null;
        pairingCreatedAt: string | null;
        hasAccessToken: boolean;
        hasRefreshToken: boolean;
        clientCount: number;
      } | null;
      audit: {
        exists: boolean;
        lastWriteAt: string | null;
        sizeBytes: number | null;
        minutesSinceLastCall: number | null;
      } | null;
      findings: string[];
      checkedAt: number;
    }> => ipcRenderer.invoke("peer:inspect", "peer:inspect", { port }),
    setDangerous: (patch: {
      enabled?: boolean;
      autoApprovePreparedWrites?: boolean;
      exposeDirectWriteFile?: boolean;
      allowCreate?: boolean;
      allowOverwrite?: boolean;
      allowDelete?: boolean;
      allowMove?: boolean;
      allowShell?: boolean;
    }): Promise<{ ok: boolean; backup: string | null; file: string; dangerousMode: unknown }> =>
      ipcRenderer.invoke("peer:set-dangerous", "peer:set-dangerous", patch),    openPanel: (): Promise<{ launched: boolean; path: string | null; reason: string | null }> =>
      ipcRenderer.invoke("peer:open-panel", "peer:open-panel"),
  },
  screen: {
    listWindows: (): Promise<ScreenAccessSnapshot> =>
      ipcRenderer.invoke("screen:windows-list", "screen:windows:read"),
    captureWindow: (windowId: string): Promise<ScreenAccessSnapshot> =>
      ipcRenderer.invoke("screen:capture-window", "screen:capture", { windowId }),
  },
  readiness: {
    get: (): Promise<ReadinessSnapshot> =>
      ipcRenderer.invoke("readiness:get", "readiness:get"),
  },
  /** 项目看板：总目标/里程碑/支线/进度，存在 <工作区>\.c2c\taskboard.json。 */
  board: {
    list: (): Promise<unknown> => ipcRenderer.invoke("board:list", "diagnostics:run"),
    read: (file?: string): Promise<unknown> => ipcRenderer.invoke("board:read", "diagnostics:run", file),
    write: (board: unknown, file?: string): Promise<{ path: string; file: string }> =>
      ipcRenderer.invoke("board:write", "diagnostics:run", board, file),
    create: (input?: { project?: string; goal?: string }): Promise<unknown> =>
      ipcRenderer.invoke("board:create", "diagnostics:run", input ?? {}),
    handoff: (file?: string): Promise<{ markdown: string }> => ipcRenderer.invoke("board:handoff", "diagnostics:run", file),
  },  /** MCP 调用进度：按时间间隔聚合的会话 + 交接卡。 */
  /** OAuth 重连策略：已授权客户端重连是否免配对码。 */
  oauthReconnect: {
    get: (): Promise<{ allowReconnectWithoutIntent: boolean; file: string }> =>
      ipcRenderer.invoke("oauth:reconnect-policy:get", "diagnostics:run"),
    set: (allow: boolean): Promise<{ allowReconnectWithoutIntent: boolean; file: string }> =>
      ipcRenderer.invoke("oauth:reconnect-policy:set", "diagnostics:run", allow),
  },
  /** 一键修复（低风险动作：git init / 开启开发工具）。 */
  fixes: {
    run: (action: string, targetPath?: string): Promise<{ action: string; output: string }> =>
      ipcRenderer.invoke("fixes:run", "diagnostics:run", action, targetPath ?? ""),
  },
  /** 本机服务自身状态（最后调用时间）。 */
  serviceSelf: {
    lastCall: (): Promise<{ lastCallAt: string | null; minutesSinceLastCall: number | null }> =>
      ipcRenderer.invoke("service:self-lastcall", "diagnostics:run"),
  },
  /** 导出浏览器扩展（给网页版 AI 用）。 */
  extension: {
    exportBundle: (): Promise<{ path: string }> => ipcRenderer.invoke("extension:export", "diagnostics:run"),
  },
  /** AI 请求：AI 写 <工作区>\.c2c\requests\*.json，控制中心批准后执行低风险动作。 */
  requests: {
    list: (): Promise<unknown> => ipcRenderer.invoke("requests:list", "diagnostics:run"),
    approve: (file: string): Promise<unknown> => ipcRenderer.invoke("requests:approve", "diagnostics:run", file),
    reject: (file: string): Promise<unknown> => ipcRenderer.invoke("requests:reject", "diagnostics:run", file),
  },
  progress: {
    sessions: (): Promise<unknown> => ipcRenderer.invoke("progress:sessions", "diagnostics:run"),
    handoff: (sessionId: string, options?: { full?: boolean }): Promise<{ markdown: string }> =>
      ipcRenderer.invoke("progress:handoff", "diagnostics:run", sessionId, options ?? {}),
    label: (sessionId: string, name: string | null): Promise<{ labels: Record<string, string> }> =>
      ipcRenderer.invoke("progress:label", "diagnostics:run", sessionId, name),
  },  /** 其他 AI 客户端的长期令牌（Bearer）。非 OAuth 客户端用这个接入。 */
  mcpToken: {
    status: (): Promise<{ configured: boolean; createdAt?: string | null; scopes?: string[]; path?: string }> =>
      ipcRenderer.invoke("mcp:token:status", "settings:ordinary:update"),
    generate: (scopes?: string[]): Promise<{ token: string; url: string; scopes: string[] }> =>
      ipcRenderer.invoke("mcp:token:generate", "settings:ordinary:update", { scopes }),
    revoke: (): Promise<{ revoked: boolean }> =>
      ipcRenderer.invoke("mcp:token:revoke", "settings:ordinary:update"),
  },  diagnostics: {
    run: (): Promise<DiagnosticsReport> =>
      ipcRenderer.invoke("diagnostics:run", "diagnostics:run"),
    exportBundle: (): Promise<{ path: string }> =>
      ipcRenderer.invoke("diagnostics:export-bundle", "diagnostics:export-bundle"),
    listFaultCases: (params: FaultCasesRequest = {}): Promise<FaultCasesResponse> =>
      ipcRenderer.invoke("diagnostics:fault-cases:list", "diagnostics:cases:read", params),
    matchRepairOptions: (params: MatchRepairOptionsRequest): Promise<MatchRepairOptionsResponse> =>
      ipcRenderer.invoke("diagnostics:repair-options:match", "diagnostics:repairs:read", params),
    runRepair: (params: RunRepairRequest): Promise<RunRepairResponse> =>
      ipcRenderer.invoke("diagnostics:repair:run", "diagnostics:repair:execute", params),
    listRepairHistory: (params: RepairHistoryRequest = {}): Promise<RepairHistoryResponse> =>
      ipcRenderer.invoke("diagnostics:repair-history:list", "diagnostics:history:read", params),
  },
  collaboration: {
    listExecutions: (limit?: number): Promise<ExecutionListResponse> =>
      ipcRenderer.invoke("collaboration:executions:list", "collaboration:executions:read", { limit }),
    getExecutionOutput: (id: string): Promise<ExecutionOutputResponse | null> =>
      ipcRenderer.invoke("collaboration:executions:output", "collaboration:executions:read", { id }),
  },
  /** 更换本机端口（需重启 Runtime；48766 可用，48765 禁止）。 */
  changePort: (port: number): Promise<{ ok: boolean; changed: boolean; port: number }> =>
    ipcRenderer.invoke("profile:port:change", "settings:ordinary:update", port),
  settings: {
    updateOrdinary: (patch: OrdinarySettingsPatch): Promise<OrdinarySettingsUpdateResult> =>
      ipcRenderer.invoke("settings:ordinary:update", "settings:ordinary:update", patch),
    /** 读取 Windows 登录项的真实状态（不只是配置文件里的值）。 */
    autostartStatus: (): Promise<{ openAtLogin: boolean; openAsHidden: boolean; executable: string }> =>
      ipcRenderer.invoke("app:autostart:status", "settings:ordinary:update"),
    backupExport: (): Promise<{ path: string; canceled: boolean }> =>
      ipcRenderer.invoke("settings:backup:export", "settings:backup:export"),
    backupImport: (): Promise<{ restored: boolean; profileId: string }> =>
      ipcRenderer.invoke("settings:backup:import", "settings:backup:import"),
  },
  security: {
    folderAcl: {
      get: (): Promise<FolderAclSnapshot> => ipcRenderer.invoke("security:folder-acl:get", "security:folder-acl:read"),
      add: (input: FolderAclAddInput): Promise<FolderAccessEntry> => ipcRenderer.invoke("security:folder-acl:add", "security:folder-acl:add", input),
      remove: (input: FolderAclRemoveInput): Promise<{ removed: boolean; revision: number }> => ipcRenderer.invoke("security:folder-acl:remove", "security:folder-acl:remove", input),
      check: (input: FolderAccessCheckInput): Promise<FolderAccessVerdict> => ipcRenderer.invoke("security:folder-acl:check", "security:folder-acl:check", input),
      pick: (): Promise<string | null> => ipcRenderer.invoke("security:folder-acl:pick", "security:folder-acl:pick"),
    },
    approvals: {
      list: (): Promise<ApprovalQueueSnapshot> => ipcRenderer.invoke("security:approvals:list", "security:approvals:read"),
      get: (requestId: string): Promise<ApprovalRecordView | null> => ipcRenderer.invoke("security:approvals:get", "security:approvals:read", { requestId }),
      decide: (request: ApprovalRecordRef, decision: ApprovalDecisionInput["decision"]): Promise<ApprovalRecordView> => ipcRenderer.invoke("security:approvals:decide", "security:approvals:decide", { requestId: request.requestId, expectedRevision: request.revision, decision }),
      execute: (request: ApprovalRecordRef): Promise<ApprovalExecutionActionResult> => ipcRenderer.invoke("security:approvals:execute", "security:approvals:execute", { requestId: request.requestId, expectedRevision: request.revision }),
      revoke: (request: ApprovalRecordRef): Promise<ApprovalRecordView> => ipcRenderer.invoke("security:approvals:revoke", "security:approvals:revoke", { requestId: request.requestId, expectedRevision: request.revision }),
    },
  },
  writePolicy: {
    get: (): Promise<WritePolicy> => ipcRenderer.invoke("write-policy:get", "write-policy:get"),
    set: (params: { update: WritePolicyUpdate; actor: string; requireConfirmation?: boolean }): Promise<WritePolicyUpdateResult> =>
      ipcRenderer.invoke("write-policy:set", "write-policy:set", params),
    addDirectory: (params: { path: string; actor: string }): Promise<{ policy: WritePolicy; added: boolean; reason?: "duplicate" | "cap_exceeded" }> =>
      ipcRenderer.invoke("write-policy:add-dir", "write-policy:add-dir", params),
    removeDirectory: (params: { path: string; actor: string }): Promise<{ policy: WritePolicy; removed: boolean }> =>
      ipcRenderer.invoke("write-policy:remove-dir", "write-policy:remove-dir", params),
    audit: (params?: { limit?: number }): Promise<WriteAuditEntry[]> =>
      ipcRenderer.invoke("write-policy:audit", "write-policy:audit", params ?? {}),
  },
};

contextBridge.exposeInMainWorld("c2c", c2c);

// Strongly-typed global window.c2c
export type C2CApi = typeof c2c;



