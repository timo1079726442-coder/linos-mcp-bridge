import type { ProfileConfig, ReadinessSnapshot } from "../shared/types.js";
import { getReadinessFreshness } from "./readinessFreshness.ts";

export interface ConnectionPreflight {
  allowed: boolean;
  reason: string | null;
}

export function checkLocalIntentPreflight(
  profile: ProfileConfig | null,
  readiness: ReadinessSnapshot | null,
): ConnectionPreflight {
  if (!profile?.currentWorkspace?.root || !profile.currentWorkspace.workspaceId) {
    return { allowed: false, reason: "请先配置测试 Workspace。" };
  }
  if (getReadinessFreshness(readiness).status !== "FRESH") {
    return { allowed: false, reason: "连接状态缺少新鲜检查，请先刷新状态。" };
  }
  if (readiness?.layers.runtime !== "PASS") {
    return { allowed: false, reason: "本地 C2C Runtime 尚未健康，暂不能建立连接申请。" };
  }
  return { allowed: true, reason: null };
}

/**
 * ChatGPT may only be opened when the current Profile has a verified,
 * externally reachable MCP endpoint. LOCAL_ONLY is deliberately fail-closed:
 * a healthy local Runtime is not the same thing as a ChatGPT connection.
 */
export function checkConnectionPreflight(
  profile: ProfileConfig | null,
  readiness: ReadinessSnapshot | null,
): ConnectionPreflight {
  if (!profile?.currentWorkspace?.root) {
    return { allowed: false, reason: "请先选择工作区。" };
  }
  if (getReadinessFreshness(readiness).status !== "FRESH") {
    return { allowed: false, reason: "连接状态缺少新鲜检查，请先刷新状态。" };
  }
  if (readiness?.layers.runtime !== "PASS") {
    return { allowed: false, reason: "本地 C2C 服务尚未正常，请先运行诊断。" };
  }
  if (profile.transport.provider === "LOCAL_ONLY" || !profile.transport.publicMcpUrl) {
    return { allowed: false, reason: "当前 Profile 的 Transport 配置没有外部 MCP 端点；本地 Runtime 状态仍需独立判断。" };
  }
  if (readiness?.layers.transport !== "PASS") {
    return { allowed: false, reason: "安全连接通道尚未验证通过。" };
  }
  return { allowed: true, reason: null };
}
