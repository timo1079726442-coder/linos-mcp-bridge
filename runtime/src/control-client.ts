/**
 * control-client — runtime 侧调用主进程控制端点的客户端。
 *
 * 主进程启动时会把 { url, token } 写到 <stateRoot>/control.json；
 * runtime 只知道 profile 目录，因此向上找一级得到 stateRoot。
 * 找不到控制文件表示主进程未启用该通道，调用方应给出明确错误而不是静默失败。
 *
 * 注意：主进程重启会更换端口与令牌；失败时清缓存并重读一次，避免长期用旧地址。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

interface ControlInfo {
  url: string;
  token: string;
  tools: string[];
}

let cached: { info: ControlInfo; at: number } | null = null;

export function candidateFiles(profileDir: string): string[] {
  // 主进程写到 <stateRoot>/control.json；runtime 只知道 <stateRoot>/profiles/<id>。
  // 必须向上两级才是 stateRoot —— 少一级就 CONTROL_BRIDGE_UNAVAILABLE：
  // 权限全给了、桥也活着，但写操作永远到不了审批。
  return [
    path.join(path.dirname(path.dirname(profileDir)), "control.json"),
    path.join(path.dirname(profileDir), "control.json"),
    path.join(profileDir, "control.json"),
  ];
}

async function readControlInfo(profileDir: string, force = false): Promise<ControlInfo | null> {
  if (!force && cached && Date.now() - cached.at < 30_000) return cached.info;
  for (const file of candidateFiles(profileDir)) {
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ControlInfo>;
      if (typeof raw.url === "string" && typeof raw.token === "string") {
        const info: ControlInfo = { url: raw.url, token: raw.token, tools: raw.tools ?? [] };
        cached = { info, at: Date.now() };
        return info;
      }
    } catch {
      /* 继续尝试下一个位置 */
    }
  }
  return null;
}

export async function callControl(
  profileDir: string,
  tool: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<unknown> {
  let info = await readControlInfo(profileDir);
  if (!info) {
    throw new Error(
      "CONTROL_BRIDGE_UNAVAILABLE：主进程控制通道未就绪。请确认控制中心正在运行（不是仅启动 runtime）。",
    );
  }
  try {
    return await postOnce(info, tool, params, timeoutMs);
  } catch (error: unknown) {
    // 主进程重启后端口/令牌会变：强制重读一次再试，仍然失败才上报。
    if (!(error instanceof ControlTransportError)) throw error;
    info = await readControlInfo(profileDir, true);
    if (!info) {
      throw new Error("CONTROL_BRIDGE_UNAVAILABLE：主进程控制通道已断开，请重启控制中心。");
    }
    return await postOnce(info, tool, params, timeoutMs);
  }
}

class ControlTransportError extends Error {}

async function postOnce(
  info: ControlInfo,
  tool: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
    const res = await fetch(info.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-control-token": info.token },
      body: JSON.stringify({ tool, params }),
      signal: controller.signal,
    });
    const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: string };
    if (!res.ok || body.ok !== true) {
      throw new Error(`CONTROL_BRIDGE_FAILED：${body.error ?? `HTTP ${res.status}`}`);
    }
    return body.result;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("CONTROL_BRIDGE_FAILED")) throw error;
    if (controller.signal.aborted) {
      throw new Error("CONTROL_BRIDGE_TIMEOUT：本机确认超时或控制中心无响应。");
    }
    throw new ControlTransportError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
