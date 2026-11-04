/**
 * LocalTunnelManager — 为本机 MCP 服务开一条 Cloudflare 快速隧道（quick tunnel）。
 *
 * 背景：ChatGPT 开发者模式要求公网 HTTPS 的 /mcp 地址，127.0.0.1 无法直连。
 * Legacy 桥自带 /admin/tunnel/start，但 Legacy MCP 这类 OAuth 服务没有该接口，
 * 所以在控制中心内直接托管 cloudflared 子进程。
 *
 * 安全约束：
 * - 只允许把 127.0.0.1 上的端口暴露出去，不接受任意 host；
 * - 只读取 cloudflared 输出的公网地址，不注入任何自定义域名；
 * - 子进程由本模块独占，退出时一并结束，避免残留隧道。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LocalTunnelStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  pid: number | null;
  cloudflaredPath: string | null;
  error: string | null;
  startedAt: number | null;
}

const TRYCLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let child: ChildProcess | null = null;
let currentUrl: string | null = null;
let currentPort: number | null = null;
let lastError: string | null = null;
let startedAt: number | null = null;
let cloudflaredPath: string | null = null;

/** 用户手动指定并记住的 cloudflared 路径（写在状态目录里）。 */
function pinnedPathFile(): string {
  return path.join(process.env.C2C_STATE_ROOT?.trim() || path.join(os.homedir(), ".linos-c2c"), "cloudflared-path.txt");
}

async function readPinnedPath(): Promise<string | null> {
  try {
    const v = (await fs.readFile(pinnedPathFile(), "utf8")).trim();
    return v || null;
  } catch {
    return null;
  }
}

/** 记住用户手动选择的 cloudflared 路径。 */
export async function pinCloudflaredPath(exePath: string): Promise<void> {
  const file = pinnedPathFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, exePath.trim(), "utf8");
  cloudflaredPath = exePath.trim();
}

function candidatePaths(): string[] {
  const list: string[] = [];
  const envPath = process.env.C2C_CLOUDFLARED_PATH?.trim();
  if (envPath) list.push(envPath);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const home = os.homedir();
    list.push(
      "C:\\Program Files\\cloudflared\\cloudflared.exe",
      "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      "C:\\ProgramData\\chocolatey\\bin\\cloudflared.exe",
      path.join(local, "cloudflared", "cloudflared.exe"),
      path.join(local, "Programs", "cloudflared", "cloudflared.exe"),
      path.join(local, "Programs", "cloudflared", "bin", "cloudflared.exe"),
      path.join(local, "Microsoft", "WinGet", "Links", "cloudflared.exe"),
      path.join(home, "scoop", "shims", "cloudflared.exe"),
      path.join(home, "Downloads", "cloudflared.exe"),
      path.join(home, "Desktop", "cloudflared.exe"),
      path.join(home, "cloudflared", "cloudflared.exe"),
      "C:\\cloudflared\\cloudflared.exe",
      path.join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe"),
    );
  } else {
    list.push("/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/bin/cloudflared");
  }
  return list.filter(Boolean);
}

/** 在几个常见目录里按文件名找（处理"下载到 Downloads 但改了名"的情况）。 */
async function findByName(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const dirs = [
    path.join(os.homedir(), "Downloads"),
    path.join(os.homedir(), "Desktop"),
    path.join(process.env.LOCALAPPDATA ?? "", "cloudflared"),
  ];
  for (const dir of dirs) {
    try {
      const names = await fs.readdir(dir);
      const hit = names.find((n) => /^cloudflared.*\.exe$/i.test(n));
      if (hit) return path.join(dir, hit);
    } catch {
      /* 目录不存在，跳过 */
    }
  }
  return null;
}

/** 找到 cloudflared 可执行文件；找不到返回 null。不做任何下载。 */
export async function locateCloudflared(): Promise<string | null> {
  // 1) 用户手动指定过的路径优先
  const pinned = await readPinnedPath();
  if (pinned) {
    try {
      await fs.access(pinned);
      cloudflaredPath = pinned;
      return pinned;
    } catch {
      /* 失效则继续找 */
    }
  }
  // 2) 已知候选路径
  for (const p of candidatePaths()) {
    try {
      await fs.access(p);
      cloudflaredPath = p;
      return p;
    } catch {
      /* try next */
    }
  }
  // 3) 按文件名在下载/桌面/cloudflared 目录里搜\n  const byName = await findByName();\n  if (byName) {\n    cloudflaredPath = byName;\n    return byName;\n  }\n\n  // 4) 最后尝试 PATH（不存在的命令会 spawn 失败，这里只做探测）
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", ["cloudflared"], {
      windowsHide: true,
    });
    let out = "";
    probe.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    probe.on("error", () => resolve(null));
    probe.on("close", () => {
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) {
        cloudflaredPath = first;
        resolve(first);
      } else {
        resolve(null);
      }
    });
  });
}

export function getLocalTunnelStatus(): LocalTunnelStatus {
  return {
    running: Boolean(child && !child.killed),
    url: currentUrl,
    port: currentPort,
    pid: child?.pid ?? null,
    cloudflaredPath,
    error: lastError,
    startedAt,
  };
}

export interface StartOptions {
  port: number;
  timeoutMs?: number;
}

/**
 * 启动快速隧道指向 127.0.0.1:<port>，等待 cloudflared 打印公网地址。
 * 已有隧道时先停再起（端口可能变了）。
 */
export async function startLocalTunnel(options: StartOptions): Promise<LocalTunnelStatus> {
  const { port } = options;
  const timeoutMs = options.timeoutMs ?? 35_000;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("TUNNEL_PORT_INVALID");
  }
  if (child && !child.killed && currentPort === port && currentUrl) {
    return getLocalTunnelStatus();
  }
  await stopLocalTunnel();

  const bin = await locateCloudflared();
  if (!bin) {
    lastError = "CLOUDFLARED_NOT_FOUND";
    throw new Error("CLOUDFLARED_NOT_FOUND");
  }

  lastError = null;
  currentUrl = null;
  currentPort = port;

  const args = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
  const proc = spawn(bin, args, { windowsHide: true });
  child = proc;
  startedAt = Date.now();

  const collected: string[] = [];
  const onData = (b: Buffer): void => {
    const text = b.toString("utf8");
    collected.push(text);
    if (collected.length > 400) collected.shift();
    if (!currentUrl) {
      const m = TRYCLOUDFLARE.exec(text);
      if (m) currentUrl = stripTrailing(m[0]);
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  proc.on("error", (err) => {
    lastError = `spawn_failed: ${err.message}`;
  });
  proc.on("close", (code) => {
    if (currentUrl && !currentUrl) currentUrl = null;
    child = null;
    currentUrl = null;
    if (code !== 0 && !lastError) lastError = `cloudflared_exited_${code}`;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentUrl) return getLocalTunnelStatus();
    if (!child) break;
    if (lastError) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!currentUrl) {
    lastError = lastError ?? "TUNNEL_URL_TIMEOUT";
    await stopLocalTunnel();
    throw new Error(lastError);
  }
  return getLocalTunnelStatus();
}

function stripTrailing(url: string): string {
  return url.replace(/[.,;:]+$/, "");
}

export async function stopLocalTunnel(): Promise<LocalTunnelStatus> {
  const proc = child;
  child = null;
  currentUrl = null;
  currentPort = null;
  startedAt = null;
  if (proc && !proc.killed) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === "win32" && proc.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
        killer.on("close", () => resolve());
        killer.on("error", () => resolve());
      });
    }
  }
  return getLocalTunnelStatus();
}

/** 应用退出时确保不留隧道进程。 */
export function disposeLocalTunnel(): void {
  const proc = child;
  child = null;
  currentUrl = null;
  currentPort = null;
  if (proc && !proc.killed) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}
