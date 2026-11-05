/**
 * NamedTunnelProvisioner — 让用户用自己的 Cloudflare 域名，傻瓜式建一条固定隧道。
 *
 * 流程（每一步都可单独调用，失败即停，不猜）：
 *   1. status()    检查 cloudflared 是否存在、是否已登录（~/.cloudflared/cert.pem）、列出已有隧道
 *   2. login()     打开浏览器完成 Cloudflare 授权（cloudflared tunnel login）
 *   3. provision() 创建隧道（已存在则复用）→ 绑定 DNS → 返回写入 profile 所需的全部字段
 *
 * 安全边界：
 * - 只操作"这个账号下的隧道与 DNS"，不碰别的服务；
 * - 创建隧道/绑定 DNS 都会在真实账号上留痕，因此必须由用户点确认后调用；
 * - 所有外部命令都带超时，输出只取必要片段，不回显凭证内容。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { locateCloudflared } from "./LocalTunnelManager.js";

export interface NamedTunnelStatus {
  cloudflaredPath: string | null;
  loggedIn: boolean;
  certPath: string;
  tunnels: Array<{ id: string; name: string }>;
  detail: string;
}

export interface ProvisionResult {
  ok: boolean;
  tunnelId: string;
  tunnelName: string;
  hostname: string;
  zone: string;
  credentialPath: string;
  configPath: string;
  /** cloudflared 可执行文件绝对路径；写入 Profile 后 Transport 启动才不用 PATH 猜。 */
  binaryPath: string;
  publicMcpUrl: string;
  /** DNS 结论：PASS=已确认真指向；UNVERIFIED=查询失败无法确认；FAIL=指向别处；ROLLBACK_REQUIRED=需人工恢复。 */
  dnsState?: "PASS" | "UNVERIFIED" | "FAIL" | "ROLLBACK_REQUIRED";
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

const CLOUDFLARED_DIR = path.join(os.homedir(), ".cloudflared");
const CERT_PATH = path.join(CLOUDFLARED_DIR, "cert.pem");

interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(bin: string, args: string[], timeoutMs = 45_000): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // cloudflared 在 Windows 上收到 kill 后不一定立刻触发 close；
      // 到点必须返回，否则整个“新建隧道”流程会永久挂起。
      setTimeout(() => finish(null), 1_500);
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (e) => {
      stderr += String(e);
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

/** 从 hostname 推出 Cloudflare 区域名：取最后两段（example.com）。 */
export function zoneFromHostname(hostname: string): string {
  const parts = hostname.trim().toLowerCase().split(".").filter(Boolean);
  if (parts.length < 3) return parts.join(".");
  return parts.slice(-2).join(".");
}

/** 校验用户填的子域名：只允许 a-z0-9 与连字符，必须至少三段。 */
export function validateHostname(hostname: string): { ok: boolean; reason?: string } {
  const h = hostname.trim().toLowerCase();
  if (!h) return { ok: false, reason: "请填写域名，例如 c2c-home.example.com" };
  if (h.split(".").length < 3) return { ok: false, reason: "需要是子域名，例如 c2c-home.example.com" };
  if (!/^[a-z0-9.-]+$/.test(h)) return { ok: false, reason: "只能包含字母、数字、点和连字符" };
  if (h.startsWith("-") || h.includes("..")) return { ok: false, reason: "域名格式不正确" };
  return { ok: true };
}

export async function namedTunnelStatus(): Promise<NamedTunnelStatus> {
  const bin = await locateCloudflared();
  const certExists = await fs
    .access(CERT_PATH)
    .then(() => true)
    .catch(() => false);

  if (!bin) {
    return {
      cloudflaredPath: null,
      loggedIn: certExists,
      certPath: CERT_PATH,
      tunnels: [],
      detail: "未找到 cloudflared。请先安装，或用环境变量 C2C_CLOUDFLARED_PATH 指定路径。",
    };
  }
  if (!certExists) {
    return {
      cloudflaredPath: bin,
      loggedIn: false,
      certPath: CERT_PATH,
      tunnels: [],
      detail: "cloudflared 已找到，但还没有登录 Cloudflare。点「登录 Cloudflare」完成授权。",
    };
  }

  const out = await run(bin, ["tunnel", "list"], 20_000);
  const tunnels: Array<{ id: string; name: string }> = [];
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/i);
    if (m?.[1] && m[2]) tunnels.push({ id: m[1], name: m[2] });
  }
  return {
    cloudflaredPath: bin,
    loggedIn: true,
    certPath: CERT_PATH,
    tunnels,
    detail:
      tunnels.length > 0
        ? `已登录，账号下现有 ${tunnels.length} 条隧道。`
        : "已登录，账号下还没有隧道。",
  };
}

/** 打开浏览器完成 Cloudflare 授权；成功后 cert.pem 会被写入。 */
export async function loginNamedTunnel(): Promise<{ ok: boolean; detail: string }> {
  const bin = await locateCloudflared();
  if (!bin) return { ok: false, detail: "未找到 cloudflared。" };
  // 该命令会自己拉起浏览器，并在授权完成后退出；给足时间。
  const out = await run(bin, ["tunnel", "login"], 300_000);
  const certExists = await fs
    .access(CERT_PATH)
    .then(() => true)
    .catch(() => false);
  if (out.timedOut) {
    return { ok: certExists, detail: "等待授权超时。若浏览器已完成授权，可直接点「重新检查」。" };
  }
  if (!certExists) {
    const tail = (out.stderr || out.stdout).trim().split(/\r?\n/).slice(-2).join(" ");
    return { ok: false, detail: `授权未完成：${tail || "未知原因"}` };
  }
  return { ok: true, detail: "Cloudflare 授权完成。" };
}

/**
 * 创建（或复用）隧道 → 绑定 DNS → 写 cloudflared 配置。
 * 调用方必须已经确认过：这一步会在用户账号上真实创建隧道与 DNS 记录。
 */
/**
 * 用 Cloudflare DoH 真查一次 CNAME，确认它指向本次隧道。
 * 返回 true=指向本次 / false=指向别处 / null=查询失败（不据此判失败）。
 */
async function dnsTargetMatches(hostname: string, tunnelId: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { Answer?: Array<{ data?: unknown }> };
    const expected = `${tunnelId}.cfargotunnel.com`.toLowerCase();
    const answers = (json.Answer ?? []).map((a) => String(a.data ?? "").toLowerCase());
    if (answers.length === 0) return null;
    return answers.some((data) => data.includes(expected));
  } catch {
    return null;
  }
}

export async function provisionNamedTunnel(input: {
  hostname: string;
  tunnelName: string;
  port: number;
}): Promise<ProvisionResult> {
  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  const hostname = input.hostname.trim().toLowerCase();
  const tunnelName = input.tunnelName.trim() || `linos-c2c-${hostname.split(".")[0]}`;
  const zone = zoneFromHostname(hostname);

  const fail = (detail: string, dnsState?: ProvisionResult["dnsState"]): ProvisionResult => ({
    ok: false,
    dnsState,
    tunnelId: "",
    tunnelName,
    hostname,
    zone,
    credentialPath: "",
    configPath: "",
    binaryPath: "",
    publicMcpUrl: `https://${hostname}/mcp`,
    steps: [...steps, { step: "abort", ok: false, detail }],
  });

  const v = validateHostname(hostname);
  if (!v.ok) return fail(v.reason ?? "域名不合法");
  steps.push({ step: "validate", ok: true, detail: `域名 ${hostname}，区域 ${zone}` });

  const bin = await locateCloudflared();
  if (!bin) return fail("未找到 cloudflared。");
  steps.push({ step: "locate", ok: true, detail: bin });

  const certExists = await fs
    .access(CERT_PATH)
    .then(() => true)
    .catch(() => false);
  if (!certExists) return fail("还没有登录 Cloudflare，请先点「登录 Cloudflare」。");
  steps.push({ step: "auth", ok: true, detail: "已登录" });

  // 1) 复用同名隧道，否则创建
  const list = await run(bin, ["tunnel", "list"], 20_000);
  let tunnelId = "";
  for (const line of list.stdout.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/i);
    if (m?.[1] && m[2] === tunnelName) {
      tunnelId = m[1] ?? "";
      break;
    }
  }
  if (tunnelId) {
    steps.push({ step: "create", ok: true, detail: `复用已有隧道 ${tunnelName} (${tunnelId})` });
  } else {
    const created = await run(bin, ["tunnel", "create", tunnelName], 45_000);
    const m =
      created.stdout.match(/with id ([0-9a-f-]{36})/i) ??
      created.stderr.match(/with id ([0-9a-f-]{36})/i);
    if (!m) {
      const tail = (created.stderr || created.stdout).trim().split(/\r?\n/).slice(-2).join(" ");
      return fail(`创建隧道失败：${tail || "未知原因"}`);
    }
    tunnelId = m[1] ?? "";
    steps.push({ step: "create", ok: true, detail: `已创建隧道 ${tunnelName} (${tunnelId})` });
  }

  const credentialPath = path.join(CLOUDFLARED_DIR, `${tunnelId}.json`);
  const hasCred = await fs
    .access(credentialPath)
    .then(() => true)
    .catch(() => false);
  if (hasCred) {
    steps.push({ step: "credential", ok: true, detail: credentialPath });
  } else {
    steps.push({
      step: "credential",
      ok: false,
      detail: `未找到凭证文件 ${credentialPath}（若是复用旧隧道，请先用该隧道跑过一次）。`,
    });
  }

  // 2) 绑定 DNS。
  // 不带 --overwrite-dns：已有记录指向别处时必须人工确认，不能静默改写。
  // 绑定后用 DoH 真查一次解析结果，避免"记录存在 = 绑定成功"的假成功。
  // 先看现有记录：如果已经指向别的隧道，不覆盖、直接要求人工处理（避免静默改写生产 DNS）。
  const before = await dnsTargetMatches(hostname, tunnelId);
  if (before === false) {
    steps.push({ step: "dns-precheck", ok: false, detail: `${hostname} 已有 CNAME 指向其他隧道` });
    return fail(`DNS 已存在且指向别的隧道；本工具不会覆盖。请先删除该记录再重试。`, "ROLLBACK_REQUIRED");
  }
  const routed = await run(bin, ["tunnel", "route", "dns", tunnelName, hostname], 45_000);
  const routeAccepted =
    routed.code === 0 || /already exists|already configured|CNAME|overwrit/i.test(routed.stdout + routed.stderr);
  let dnsMatches: boolean | null = false;
  if (routeAccepted) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      dnsMatches = await dnsTargetMatches(hostname, tunnelId);
      if (dnsMatches !== false) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const dnsState: NonNullable<ProvisionResult["dnsState"]> =
    dnsMatches === true ? "PASS" : dnsMatches === false ? "FAIL" : "UNVERIFIED";
  steps.push({
    step: "dns",
    ok: dnsState === "PASS",
    detail: dnsState === "PASS"
      ? `DNS 已确认指向 ${hostname} → ${tunnelId}.cfargotunnel.com`
      : dnsState === "FAIL"
        ? `DNS 仍指向别的隧道。请把 ${hostname} 的 CNAME 改为 ${tunnelId}.cfargotunnel.com`
        : `DNS 绑定命令已执行，但查询失败无法确认（${(routed.stderr || routed.stdout).trim().split(/\r?\n/).slice(-1).join("") || "无输出"}）。请用 Resolve-DnsName ${hostname} 复核后再启动隧道。`,
  });
  if (dnsState === "FAIL") {
    return { ...fail("DNS 指向错误，公网会返回 530/1033。", "FAIL") };
  }
  if (dnsState === "UNVERIFIED") {
    return {
      ...fail("DNS 结果无法验证（查询失败），不能当作成功。", "UNVERIFIED"),
    };
  }

  // 3) 写 cloudflared 配置（供 --config 启动）
  const configPath = path.join(CLOUDFLARED_DIR, `linos-c2c-${tunnelId}.yml`);
  const yml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialPath.replaceAll("\\", "/")}`,
    "",
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${input.port}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
  try {
    await fs.mkdir(CLOUDFLARED_DIR, { recursive: true });
    await fs.writeFile(configPath, yml, "utf8");
    steps.push({ step: "config", ok: true, detail: configPath });
  } catch (e) {
    steps.push({ step: "config", ok: false, detail: String(e) });
  }

  const ok = steps.every((s) => s.ok) && Boolean(tunnelId) && hasCred;
  return {
    ok,
    tunnelId,
    tunnelName,
    hostname,
    zone,
    credentialPath: hasCred ? credentialPath : "",
    configPath,
    binaryPath: bin,
    publicMcpUrl: `https://${hostname}/mcp`,
    steps,
  };
}

/**
 * 自动下载 cloudflared 到 %LOCALAPPDATA%\cloudflared\cloudflared.exe。
 * 这个路径本来就在 locateCloudflared() 的候选列表里，下载完立即能被发现。
 * 来源是 Cloudflare 官方 GitHub release（固定 latest 链接）。
 */
export async function installCloudflared(): Promise<{ ok: boolean; path: string; detail: string }> {
  const dir = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "cloudflared");
  const target = path.join(dir, "cloudflared.exe");
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    return { ok: false, path: target, detail: `无法创建目录：${String(e)}` };
  }

  const url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return { ok: false, path: target, detail: `下载失败：HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10_000_000) {
      return { ok: false, path: target, detail: `下载内容异常（${buf.length} 字节），已放弃写入` };
    }
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
    return {
      ok: true,
      path: target,
      detail: `已下载 cloudflared（${Math.round(buf.length / 1_048_576)} MB）到 ${target}`,
    };
  } catch (e) {
    return { ok: false, path: target, detail: `下载失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}