import type { DiagnosticsReport, ProfileConfig, RepairSuggestionId } from "../../../shared/types.js";

/**
 * Tunnel self-heal helpers.
 *
 * Pure functions only. The Renderer must reuse the existing
 * `window.c2c.diagnostics.{run,matchRepairOptions,runRepair}` channels and never
 * touch tunnel state directly. All authorization (capability MAC, native
 * confirmation, ownership check, Legacy-profile guard, isolated-defaults
 * guard, daily budget) is enforced by the existing Main-side pipeline
 * (`src/main/ipc/handlers.ts:188-205`,
 * `src/main/health/FaultKnowledgeService.ts:171-260, 419-463`).
 */

export type SelfHealSuggestion = Extract<
  RepairSuggestionId,
  "START_PROFILE_TUNNEL" | "RESTART_PROFILE_TUNNEL"
>;

export function pickSelfHealSuggestion(
  report: DiagnosticsReport | null,
  profile: ProfileConfig | null,
): SelfHealSuggestion | null {
  if (!profile || !report) return null;
  if (profile.profileType === "company") return null;
  if (profile.transport.provider !== "CLOUDFLARE_NAMED") return null;
  if (report.transport.processAlive === false) return "START_PROFILE_TUNNEL";
  return "RESTART_PROFILE_TUNNEL";
}

const KNOWN_REASON_MESSAGES: Readonly<Record<string, string>> = {
  COMPANY_PROFILE_PROTECTED: "Legacy Profile 不允许自修隧道。",
  COMPANY_PROFILE_REPAIR_DISABLED: "Legacy Profile 不允许自修隧道。",
  TRANSPORT_PROFILE_NOT_ALLOWED: "当前 Profile 不在自修白名单（c2c-company / mcpbridge-tunnel 受保护）。",
  TRANSPORT_PROCESS_NOT_OWNED: "控制中心未持有当前隧道进程；请勿手动结束外部 cloudflared。",
  REPAIR_BUDGET_EXHAUSTED: "今日自修次数已用完（24h 内 3 次），请稍后再试。",
  RETRY_COOLDOWN_ACTIVE: "距离上一次自修时间过短，请在 cooldown 结束后再试。",
  INVALID_REQUEST: "请求参数未通过校验，请刷新后重试。",
  INVALID_REPAIR_REQUEST: "请求参数未通过校验，请刷新后重试。",
  UNVERIFIED: "自修已执行但未通过复核；详见诊断或审计。",
  STALE: "诊断已过期，请先点“重新诊断”再发起自修。",
  NO_MATCH: "未找到匹配的自修建议。",
  NO_SAFE_REPAIR: "当前故障未匹配到任何自修建议。",
  IDENTITY_MISMATCH_REQUIRES_MANUAL_REVIEW: "Profile 身份与当前会话不一致，需手动复核。",
  REPAIR_REJECTED: "已在系统弹窗中取消自修。",
  REPAIR_NOT_ALLOWED: "当前 Profile 不允许执行此自修动作。",
};

export function reasonCodeToMessage(reasonCode: string | null | undefined): string {
  if (!reasonCode) return "自修未完成；请查看诊断或重试。";
  return KNOWN_REASON_MESSAGES[reasonCode] ?? `自修未完成（${reasonCode}）。`;
}
