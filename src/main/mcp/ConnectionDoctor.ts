/**
 * ConnectionDoctor — 本机 MCP 的「检测并修复」五级链。
 *
 * 链路与用户既有产品保持一致：
 *   MCP Server（本机端口/健康） → Cloudflare Tunnel → Public URL
 *   → OAuth（发现文档） → MCP Protocol（/mcp 往返）
 *
 * 设计原则：
 * - 只做只读探测 + 对"我们托管的隧道"执行修复，绝不改对方服务的配置；
 * - 每一级都必须给出可读原因，不允许只回一个 FAIL；
 * - 无法自动修复的级别明确标注 fixable=false，不做假动作。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectPeerService } from "./PeerServiceInspector.js";
import {
  getLocalTunnelStatus,
  startLocalTunnel,
  stopLocalTunnel,
} from "../tunnel/LocalTunnelManager.js";

export type StageStatus = "PASS" | "FAIL" | "SKIP";

export interface StageResult {
  stage: "server" | "tunnel" | "publicUrl" | "oauth" | "mcpProtocol";
  label: string;
  status: StageStatus;
  detail: string;
  /** 控制中心是否有能力自动修复这一级 */
  fixable: boolean;
}

export interface DiagnosisReport {
  port: number;
  stages: StageResult[];
  overall: "PASS" | "FAIL";
  suggestion: string;
  checkedAt: number;
}

const TIMEOUT_MS = 6000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; text: string; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, text: "", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 读取对方服务的公网基础 URL（部分实现会把它写进自身配置）。 */
async function readPublicBaseUrl(): Promise<string | null> {
  const candidates = [
    path.join(os.homedir(), ".local-files-mcp", "config.json"),
    path.join(process.env.LOCALAPPDATA ?? "", "local-files-mcp", "config.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const value =
        cfg.publicBaseUrl ?? cfg.public_base_url ?? cfg.publicUrl ?? cfg.baseUrl ?? null;
      if (typeof value === "string" && /^https:\/\//i.test(value)) return value.replace(/\/$/, "");
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

async function probeServer(port: number): Promise<StageResult> {
  const base = `http://127.0.0.1:${port}`;
  const health = await fetchWithTimeout(`${base}/health`);
  if (health.status === 0) {
    return {
      stage: "server",
      label: "MCP Server",
      status: "FAIL",
      detail: `127.0.0.1:${port} 连不上（${health.error ?? "无响应"}）`,
      fixable: false,
    };
  }
  if (!health.ok) {
    return {
      stage: "server",
      label: "MCP Server",
      status: "FAIL",
      detail: `/health 返回 HTTP ${health.status}`,
      fixable: false,
    };
  }
  return {
    stage: "server",
    label: "MCP Server",
    status: "PASS",
    detail: `127.0.0.1:${port} 健康检查通过`,
    fixable: false,
  };
}

async function probeTunnel(port: number): Promise<StageResult> {
  const st = getLocalTunnelStatus();
  if (!st.running) {
    return {
      stage: "tunnel",
      label: "Cloudflare Tunnel",
      status: "FAIL",
      detail: "控制中心托管的隧道未运行",
      fixable: true,
    };
  }
  if (st.port !== port) {
    return {
      stage: "tunnel",
      label: "Cloudflare Tunnel",
      status: "FAIL",
      detail: `隧道指向端口 ${st.port ?? "?"}，与当前服务 ${port} 不一致`,
      fixable: true,
    };
  }
  if (!st.url) {
    return {
      stage: "tunnel",
      label: "Cloudflare Tunnel",
      status: "FAIL",
      detail: "隧道进程在，但尚未拿到公网地址",
      fixable: true,
    };
  }
  return {
    stage: "tunnel",
    label: "Cloudflare Tunnel",
    status: "PASS",
    detail: `已连接：${st.url}`,
    fixable: true,
  };
}

async function probePublicUrl(publicBase: string | null): Promise<StageResult> {
  if (!publicBase) {
    return {
      stage: "publicUrl",
      label: "Public URL",
      status: "SKIP",
      detail: "没有可用的公网地址（隧道未开通，且未读到对方配置的 publicBaseUrl）",
      fixable: true,
    };
  }
  const res = await fetchWithTimeout(`${publicBase}/health`);
  if (res.status === 0) {
    return {
      stage: "publicUrl",
      label: "Public URL",
      status: "FAIL",
      detail: `公网地址无法访问（${res.error ?? "无响应"}）`,
      fixable: true,
    };
  }
  if (res.status === 530 || res.status === 502 || res.status === 1033) {
    return {
      stage: "publicUrl",
      label: "Public URL",
      status: "FAIL",
      detail: `公网 URL 返回 HTTP ${res.status}（Cloudflare 源站不可达，隧道多半已断）`,
      fixable: true,
    };
  }
  if (!res.ok) {
    return {
      stage: "publicUrl",
      label: "Public URL",
      status: "FAIL",
      detail: `公网 URL 返回 HTTP ${res.status}`,
      fixable: true,
    };
  }
  return {
    stage: "publicUrl",
    label: "Public URL",
    status: "PASS",
    detail: `${publicBase} 可达`,
    fixable: true,
  };
}

async function probeOauth(publicBase: string | null, port: number): Promise<StageResult> {
  const targets = [
    publicBase ? `${publicBase}/.well-known/oauth-authorization-server` : null,
    `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`,
  ].filter((v): v is string => Boolean(v));

  for (const url of targets) {
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      let issuer = "";
      try {
        const doc = JSON.parse(res.text) as { issuer?: string };
        issuer = typeof doc.issuer === "string" ? doc.issuer : "";
      } catch {
        /* 文档非 JSON 也仍算发现成功 */
      }
      return {
        stage: "oauth",
        label: "OAuth",
        status: "PASS",
        detail: issuer ? `发现文档有效，issuer=${issuer}` : "OAuth 发现文档可达",
        fixable: false,
      };
    }
  }
  return {
    stage: "oauth",
    label: "OAuth",
    status: "FAIL",
    detail: "找不到 OAuth 发现文档（该服务可能不是 OAuth 模式）",
    fixable: false,
  };
}

async function probeMcpProtocol(publicBase: string | null, port: number): Promise<StageResult> {
  const targets = [
    publicBase ? `${publicBase}/mcp` : null,
    `http://127.0.0.1:${port}/mcp`,
  ].filter((v): v is string => Boolean(v));

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "linos-control-center-doctor", version: "1.0.0" },
    },
  });

  for (const url of targets) {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
    });
    // 401/403 表示服务在、协议端点存在，只是没带令牌 —— 这属于"通"
    if (res.ok || res.status === 401 || res.status === 403 || res.status === 400) {
      return {
        stage: "mcpProtocol",
        label: "MCP Protocol",
        status: "PASS",
        detail: `${url} 有响应（HTTP ${res.status}）`,
        fixable: false,
      };
    }
    if (res.status === 530 || res.status === 502) {
      return {
        stage: "mcpProtocol",
        label: "MCP Protocol",
        status: "FAIL",
        detail: `${url} 返回 HTTP ${res.status}（隧道链路中断）`,
        fixable: true,
      };
    }
  }
  return {
    stage: "mcpProtocol",
    label: "MCP Protocol",
    status: "FAIL",
    detail: "/mcp 端点无有效响应",
    fixable: false,
  };
}

function buildReport(port: number, stages: StageResult[]): DiagnosisReport {
  const overall = stages.every((s) => s.status !== "FAIL") ? "PASS" : "FAIL";
  const firstFail = stages.find((s) => s.status === "FAIL") ?? null;
  let suggestion: string;
  if (overall === "PASS") {
    suggestion = "链路全部通过，可以到 ChatGPT 里添加连接器。";
  } else if (!firstFail) {
    suggestion = "存在未完成的检查项。";
  } else if (firstFail.stage === "server") {
    suggestion = `先启动本机 MCP 服务（端口 ${port}），再点「一键修复」。`;
  } else if (firstFail.stage === "tunnel") {
    suggestion = "点「一键修复」由控制中心开通隧道。";
  } else if (firstFail.stage === "publicUrl") {
    suggestion = "公网链路断开，点「一键修复」重开隧道。";
  } else if (firstFail.stage === "oauth") {
    suggestion = "OAuth 发现失败，请确认该服务使用 OAuth 模式并在其面板里检查授权设置。";
  } else {
    suggestion = "MCP 协议端点异常，先把隧道修好再复检。";
  }
  return { port, stages, overall, suggestion, checkedAt: Date.now() };
}

export async function diagnoseLocalMcp(port: number): Promise<DiagnosisReport> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("DOCTOR_PORT_INVALID");
  const stages: StageResult[] = [];

  const server = await probeServer(port);
  stages.push(server);

  // 该端口是不是"自带隧道的外来服务"（例如 Legacy MCP）？
  // 如果是，隧道由它自己托管，控制中心不应把它判成"隧道未运行"。
  let peerPublicBase: string | null = null;
  let peerOwnedTunnel = false;
  if (server.status === "PASS") {
    try {
      const peer = await inspectPeerService(port);
      if (peer.reachable && peer.publicBaseUrl) {
        peerPublicBase = peer.publicBaseUrl;
        peerOwnedTunnel = true;
      }
    } catch {
      /* 不是该类型服务 */
    }
  }

  if (peerOwnedTunnel && peerPublicBase) {
    stages.push({
      stage: "tunnel",
      label: "Cloudflare Tunnel",
      status: "SKIP",
      detail: `由该服务自行托管（${peerPublicBase}），控制中心不接管、也不重启它`,
      fixable: false,
    });
    stages.push(await probePublicUrl(peerPublicBase));
    stages.push(await probeOauth(peerPublicBase, port));
    stages.push(await probeMcpProtocol(peerPublicBase, port));
    return buildReport(port, stages);
  }

  // 以下为"隧道由控制中心托管"的情形
  const publicBase = await readPublicBaseUrl();
  const tunnel = await probeTunnel(port);
  stages.push(tunnel);
  const effectivePublic = tunnel.status === "PASS" ? getLocalTunnelStatus().url : publicBase;
  stages.push(await probePublicUrl(effectivePublic));
  stages.push(await probeOauth(effectivePublic, port));
  stages.push(await probeMcpProtocol(effectivePublic, port));
  return buildReport(port, stages);
}

export interface RepairOutcome {
  actions: Array<{ stage: string; action: string; ok: boolean; detail: string }>;
  report: DiagnosisReport;
}

/**
 * 一键修复：只处理控制中心能力范围内的项（隧道）。
 * 其余级别保持原状并在 report 里体现。
 */
export async function repairLocalMcp(port: number): Promise<RepairOutcome> {
  const actions: RepairOutcome["actions"] = [];
  const before = await diagnoseLocalMcp(port);

  const serverStage = before.stages.find((s) => s.stage === "server");
  const needTunnel = before.stages.some(
    (s) => (s.stage === "tunnel" || s.stage === "publicUrl" || s.stage === "mcpProtocol") && s.status === "FAIL",
  );

  if (serverStage?.status === "FAIL") {
    actions.push({
      stage: "server",
      action: "启动本机服务",
      ok: false,
      detail: "控制中心不代替对方服务启停，请先在它自己的面板里启动服务。",
    });
    return { actions, report: await diagnoseLocalMcp(port) };
  }

  if (needTunnel) {
    try {
      await stopLocalTunnel();
      const started = await startLocalTunnel({ port });
      actions.push({
        stage: "tunnel",
        action: "重开隧道",
        ok: Boolean(started.url),
        detail: started.url ? `新公网地址 ${started.url}` : "隧道已起但没拿到地址",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      actions.push({
        stage: "tunnel",
        action: "重开隧道",
        ok: false,
        detail:
          msg === "CLOUDFLARED_NOT_FOUND"
            ? "本机没有 cloudflared，请先安装后再试"
            : msg === "TUNNEL_URL_TIMEOUT"
              ? "35 秒内没拿到公网地址，请检查网络/代理"
              : msg,
      });
    }
  } else {
    actions.push({
      stage: "tunnel",
      action: "无需修复",
      ok: true,
      detail: "隧道与公网链路当前正常",
    });
  }

  return { actions, report: await diagnoseLocalMcp(port) };
}
