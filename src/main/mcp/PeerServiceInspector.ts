/**
 * PeerServiceInspector — 只读读取"另一个 MCP 服务"的真实状态。
 *
 * 目的：我们的控制中心过去只探 /health，界面显示"工具数未核实"，
 * 与实际能力严重脱节。本模块把对方的真实信息读出来：
 *   - GET /tools（该实现无鉴权）→ 工具清单、dangerous_mode、chatgpt_settings
 *   - %USERPROFILE%\.local-files-mcp\config.json → 开关、roots、safety、tools
 *   - session.json → 配对/会话是否过期（**只读摘要，绝不返回任何令牌或哈希**）
 *   - audit.jsonl → 最后一次工具调用的时间
 *
 * 严格只读：本模块不写任何文件、不启动/停止任何进程、不改对方配置。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface PeerToolInfo {
  name: string;
  registered: boolean;
  description: string;
  group: string;
  conditional: boolean;
}

export interface PeerDangerousMode {
  enabled: boolean;
  autoApprovePreparedWrites: boolean;
  exposeDirectWriteFile: boolean;
  allowCreate: boolean;
  allowOverwrite: boolean;
  allowDelete: boolean;
  allowMove: boolean;
  allowShell: boolean;
}

export interface PeerRootInfo {
  id: string;
  path: string;
  access: string;
}

export interface PeerSessionInfo {
  /** 会话/配对码是否已过期（相对当前时间） */
  expired: boolean | null;
  createdAt: string | null;
  expiresAt: string | null;
  pairingCreatedAt: string | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  clientCount: number;
}

export interface PeerAuditInfo {
  exists: boolean;
  lastWriteAt: string | null;
  sizeBytes: number | null;
  minutesSinceLastCall: number | null;
}

export interface PeerInspection {
  port: number;
  reachable: boolean;
  name: string | null;
  version: string | null;
  authMode: string | null;
  mcpPath: string | null;
  toolCount: number | null;
  tools: PeerToolInfo[];
  dangerousMode: PeerDangerousMode | null;
  roots: PeerRootInfo[];
  chatgptConnectorUrl: string | null;
  publicBaseUrl: string | null;
  session: PeerSessionInfo | null;
  audit: PeerAuditInfo | null;
  /** 面向用户的、可执行的结论 */
  findings: string[];
  checkedAt: number;
}

const HOME_CFG_DIRS = (): string[] => [
  path.join(os.homedir(), ".local-files-mcp"),
  path.join(process.env.LOCALAPPDATA ?? "", "local-files-mcp"),
];

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readFirstJson<T>(fileNames: string[]): Promise<{ value: T | null; file: string | null }> {
  for (const dir of HOME_CFG_DIRS()) {
    for (const name of fileNames) {
      const file = path.join(dir, name);
      const value = await readJson<T>(file);
      if (value) return { value, file };
    }
  }
  return { value: null, file: null };
}

async function fetchJson(
  url: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "error" });
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text };
  } catch {
    return { ok: false, status: 0, body: null, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

function isoFromUnix(sec: unknown): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  try {
    return new Date(sec * 1000).toISOString();
  } catch {
    return null;
  }
}

interface RawConfig {
  server?: {
    host?: string;
    port?: number;
    name?: string;
    description?: string;
    public_url?: string;
    auth_mode?: string;
  };
  dangerous_mode?: Record<string, unknown>;
  roots?: Array<Record<string, unknown>>;
  tools?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

interface RawSession {
  active?: boolean;
  created_at?: number;
  expires_at?: number;
  pairing_created_at?: number;
  access_tokens?: Record<string, unknown>;
  refresh_tokens?: Record<string, unknown>;
  clients?: Record<string, unknown>;
}

interface RawToolsResponse {
  ok?: boolean;
  version?: string;
  mcp_path?: string;
  auth_mode?: string;
  dangerous_mode?: Record<string, unknown>;
  chatgpt_settings?: { connector_url?: string; authentication?: string };
  tools?: Array<{ name?: string; description?: string; group?: string; conditional?: boolean; risk?: string; enabled?: boolean; approval?: string } | string>;
}

export async function inspectPeerService(port = 48766): Promise<PeerInspection> {
  const findings: string[] = [];

  // ---------- 1. 运行时：/health + /tools ----------
  const health = await fetchJson(`http://127.0.0.1:${port}/health`);
  const reachable = health.ok;
  const toolsRes = reachable ? await fetchJson(`http://127.0.0.1:${port}/tools`, 8000) : null;

  let name: string | null = null;
  let version: string | null = null;
  let authMode: string | null = null;
  let mcpPath: string | null = null;
  let toolNames: string[] = [];
  let toolDetails: PeerToolInfo[] = [];
  let dangerousMode: PeerDangerousMode | null = null;
  let chatgptConnectorUrl: string | null = null;

  if (reachable && health.body && typeof health.body === "object") {
    const h = health.body as Record<string, unknown>;
    name =
      typeof h.name === "string"
        ? h.name
        : typeof h.service === "string"
          ? h.service
          : null;
    version = typeof h.version === "string" ? h.version : null;
    authMode = typeof h.auth_mode === "string" ? h.auth_mode : null;
    mcpPath = typeof h.mcp_path === "string" ? h.mcp_path : null;
  }

  if (toolsRes?.ok && toolsRes.body && typeof toolsRes.body === "object") {
    const t = toolsRes.body as RawToolsResponse;
    if (Array.isArray(t.tools)) {
      toolDetails = t.tools
        .map((item) => {
          if (typeof item === "string") {
            return { name: item, registered: true, description: "", group: "", conditional: false };
          }
          if (!item || typeof item.name !== "string") return null;
          return {
            name: item.name,
            registered: true,
            description: typeof item.description === "string" ? item.description : "",
            group: typeof item.group === "string" ? item.group : "",
            conditional: item.conditional === true,
            risk: typeof item.risk === "string" ? item.risk : undefined,
            enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
            approval: typeof item.approval === "string" ? item.approval : undefined,
          };
        })
        .filter((v): v is PeerToolInfo => v !== null);
      toolNames = toolDetails.map((d) => d.name);
    }
    if (t.mcp_path) mcpPath = t.mcp_path;
    if (t.auth_mode) authMode = t.auth_mode;
    if (t.version) version = t.version;
    if (t.chatgpt_settings?.connector_url) chatgptConnectorUrl = t.chatgpt_settings.connector_url;
    const dm = t.dangerous_mode;
    if (dm && typeof dm === "object") {
      dangerousMode = {
        enabled: dm.enabled === true,
        autoApprovePreparedWrites: dm.auto_approve_prepared_writes === true,
        exposeDirectWriteFile: dm.expose_direct_write_file === true,
        allowCreate: dm.allow_create === true,
        allowOverwrite: dm.allow_overwrite === true,
        allowDelete: dm.allow_delete === true,
        allowMove: dm.allow_move === true,
        allowShell: dm.allow_shell === true,
      };
    }
  }

  // ---------- 2. 配置文件（只读） ----------
  // 重要：config.json / session.json 属于「Legacy MCP」这一个服务。
  // 只有当目标端口确实回应了它的 /tools（即确认就是它）时才套用这些配置，
  // 否则会把一个服务的配置错安到另一个进程身上。
  const ownsPeerConfig = toolsRes?.ok === true;
  const { value: cfg } = ownsPeerConfig
    ? await readFirstJson<RawConfig>(["config.json"])
    : { value: null };
  if (!dangerousMode && cfg?.dangerous_mode) {
    const dm = cfg.dangerous_mode;
    dangerousMode = {
      enabled: dm.enabled === true,
      autoApprovePreparedWrites: dm.auto_approve_prepared_writes === true,
      exposeDirectWriteFile: dm.expose_direct_write_file === true,
      allowCreate: dm.allow_create === true,
      allowOverwrite: dm.allow_overwrite === true,
      allowDelete: dm.allow_delete === true,
      allowMove: dm.allow_move === true,
      allowShell: dm.allow_shell === true,
    };
  }
  const roots: PeerRootInfo[] = (cfg?.roots ?? []).map((r) => ({
    id: typeof r.id === "string" ? r.id : "(未命名)",
    path: typeof r.path === "string" ? r.path : "",
    access: typeof r.access === "string" ? r.access : "read",
  }));
  const publicBaseUrl =
    typeof cfg?.server?.public_url === "string" ? cfg.server.public_url.replace(/\/$/, "") : null;

  // ---------- 3. 会话（只读摘要，不含任何令牌） ----------
  const { value: session } = ownsPeerConfig
    ? await readFirstJson<RawSession>(["session.json"])
    : { value: null };
  let sessionInfo: PeerSessionInfo | null = null;
  if (session) {
    const expires = typeof session.expires_at === "number" ? session.expires_at : null;
    const nowSec = Math.floor(Date.now() / 1000);
    sessionInfo = {
      expired: expires === null ? null : nowSec > expires,
      createdAt: isoFromUnix(session.created_at),
      expiresAt: isoFromUnix(expires),
      pairingCreatedAt: isoFromUnix(session.pairing_created_at),
      hasAccessToken: Object.keys(session.access_tokens ?? {}).length > 0,
      hasRefreshToken: Object.keys(session.refresh_tokens ?? {}).length > 0,
      clientCount: Object.keys(session.clients ?? {}).length,
    };
  }

  // ---------- 4. 审计日志最后活动 ----------
  let audit: PeerAuditInfo | null = null;
  if (ownsPeerConfig) for (const dir of HOME_CFG_DIRS()) {
    const file = path.join(dir, "audit.jsonl");
    try {
      const st = await fs.stat(file);
      const minutes = Math.floor((Date.now() - st.mtimeMs) / 60000);
      audit = {
        exists: true,
        lastWriteAt: new Date(st.mtimeMs).toISOString(),
        sizeBytes: st.size,
        minutesSinceLastCall: minutes,
      };
      break;
    } catch {
      /* next */
    }
  }

  // ---------- 5. 结论 ----------
  if (!reachable) {
    findings.push(`端口 ${port} 上没有服务在监听，ChatGPT 调用必然失败。`);
  } else {
    if (toolNames.length > 0) {
      findings.push(`在线工具 ${toolNames.length} 个（数据来自该服务 /tools，非本地推断）。`);
    }
    if (dangerousMode?.enabled) {
      const on: string[] = [];
      if (dangerousMode.autoApprovePreparedWrites) on.push("自动批准");
      if (dangerousMode.allowCreate) on.push("新建");
      if (dangerousMode.allowOverwrite) on.push("覆盖");
      if (dangerousMode.allowDelete) on.push("删除");
      if (dangerousMode.allowMove) on.push("移动");
      if (dangerousMode.allowShell) on.push("Shell");
      findings.push(`危险模式已开启：${on.length ? on.join("、") : "无具体项"}。`);
    }
    if (roots.length === 0) {
      if (ownsPeerConfig) {
        findings.push("没有任何已授权文件夹，所有文件类调用都会失败。");
      }
    } else {
      const writable = roots.filter((r) => r.access === "write").length;
      findings.push(`已授权文件夹 ${roots.length} 个（其中可写 ${writable} 个）。`);
    }
    if (!ownsPeerConfig) {
      findings.push(
        `端口 ${port} 上的服务没有提供 /tools 诊断接口（不是 Legacy MCP），` +
          `因此危险模式、授权目录、会话等配置项对它不适用。`,
      );
    }
  }
  if (sessionInfo?.expired === true) {
    findings.push(
      `配对/会话已于 ${sessionInfo.expiresAt ?? "此前"} 过期；若 ChatGPT 仍报错，需要重新生成配对码。`,
    );
  }
  if (audit?.minutesSinceLastCall != null && audit.minutesSinceLastCall > 24 * 60) {
    findings.push(
      `审计日志已 ${Math.floor(audit.minutesSinceLastCall / 1440)} 天没有新记录，说明近期没有成功到达工具层的调用。`,
    );
  }
  if (publicBaseUrl) {
    const pub = await fetchJson(`${publicBaseUrl}/health`);
    if (pub.status === 530 || pub.status === 502) {
      findings.push(`公网地址 ${publicBaseUrl} 返回 HTTP ${pub.status}（隧道断开），ChatGPT 无法连进来。`);
    } else if (pub.status === 0) {
      findings.push(`公网地址 ${publicBaseUrl} 无法访问（网络或隧道问题）。`);
    } else if (pub.ok) {
      findings.push(`公网地址 ${publicBaseUrl} 可达。`);
    } else {
      findings.push(`公网地址 ${publicBaseUrl} 返回 HTTP ${pub.status}。`);
    }
  }

  return {
    port,
    reachable,
    name,
    version,
    authMode,
    mcpPath,
    toolCount: toolNames.length > 0 ? toolNames.length : null,
    tools: toolDetails,
    dangerousMode,
    roots,
    chatgptConnectorUrl,
    publicBaseUrl,
    session: sessionInfo,
    audit,
    findings,
    checkedAt: Date.now(),
  };
}

/** 启动对方自己的控制面板（若已在运行则不重复启动）。只用于让用户在里面生成配对码。 */
export async function openPeerPanel(): Promise<{ launched: boolean; path: string | null; reason: string | null }> {
  const candidates: string[] = [];
  const explicit = process.env.C2C_PEER_PANEL_PATH?.trim();
  if (explicit) candidates.push(explicit);
  const bases = [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Legacy MCP"),
    path.join(process.env.ProgramFiles ?? "", "Legacy MCP"),
    path.join(process.env.ProgramFiles ?? "", "LocalFilesMCP"),
  ].filter(Boolean);
  for (const base of bases) {
    candidates.push(path.join(base, "LocalFilesMCP-ThisPC.exe"));
    candidates.push(path.join(base, "LocalFilesMCP.exe"));
  }
  for (const exe of candidates) {
    try {
      await fs.access(exe);
    } catch {
      continue;
    }
    try {
      const proc = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
      proc.unref();
      return { launched: true, path: exe, reason: null };
    } catch (e) {
      return { launched: false, path: exe, reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return {
    launched: false,
    path: null,
    reason: "PEER_PANEL_NOT_FOUND: 未在常见安装目录找到 LocalFilesMCP-ThisPC.exe，请从右下角托盘打开。",
  };
}

export interface DangerousModePatch {
  enabled?: boolean;
  autoApprovePreparedWrites?: boolean;
  exposeDirectWriteFile?: boolean;
  allowCreate?: boolean;
  allowOverwrite?: boolean;
  allowDelete?: boolean;
  allowMove?: boolean;
  allowShell?: boolean;
}

/**
 * 修改对方服务（Legacy MCP）的 dangerous_mode 开关。
 *
 * 安全约束：
 * - 只改 config.json 里的 dangerous_mode 字段，其他字段原样保留；
 * - 写前先复制 config.json.bak-<时间戳>；
 * - 先写临时文件再 rename，避免半截文件；
 * - 写后立即复读校验，返回真实生效值。
 *
 * 注意：对方面板也在写同一个文件，本函数为"最后写入者生效"，
 * 且多数实现需要重启服务才会应用新设置。
 */
export async function setPeerDangerousMode(
  patch: DangerousModePatch,
): Promise<{ ok: boolean; backup: string | null; file: string; dangerousMode: PeerDangerousMode | null }> {
  const { value: cfg, file } = await readFirstJson<RawConfig>(["config.json"]);
  if (!cfg || !file) throw new Error("PEER_CONFIG_NOT_FOUND");

  const current = (cfg.dangerous_mode ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  const map: Array<[keyof DangerousModePatch, string]> = [
    ["enabled", "enabled"],
    ["autoApprovePreparedWrites", "auto_approve_prepared_writes"],
    ["exposeDirectWriteFile", "expose_direct_write_file"],
    ["allowCreate", "allow_create"],
    ["allowOverwrite", "allow_overwrite"],
    ["allowDelete", "allow_delete"],
    ["allowMove", "allow_move"],
    ["allowShell", "allow_shell"],
  ];
  for (const [key, field] of map) {
    const v = patch[key];
    if (typeof v === "boolean") next[field] = v;
  }
  if (patch.enabled === true) next.warning_acknowledged = true;

  const candidate = { ...(cfg as Record<string, unknown>), dangerous_mode: next };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.bak-${stamp}`;
  await fs.copyFile(file, backup);

  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(candidate, null, 2), "utf8");
  await fs.rename(tmp, file);

  // 复读校验
  const verify = await readJson<RawConfig>(file);
  const dm = (verify?.dangerous_mode ?? {}) as Record<string, unknown>;
  const mode: PeerDangerousMode = {
    enabled: dm.enabled === true,
    autoApprovePreparedWrites: dm.auto_approve_prepared_writes === true,
    exposeDirectWriteFile: dm.expose_direct_write_file === true,
    allowCreate: dm.allow_create === true,
    allowOverwrite: dm.allow_overwrite === true,
    allowDelete: dm.allow_delete === true,
    allowMove: dm.allow_move === true,
    allowShell: dm.allow_shell === true,
  };
  return { ok: true, backup, file, dangerousMode: mode };
}