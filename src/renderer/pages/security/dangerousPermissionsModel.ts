import { redactScreenText } from "./screenAccessModel.js";

export type PermissionState = "ENABLED" | "DISABLED" | "UNKNOWN";

export interface DangerousPermissionsSnapshot {
  observedAt: string | null;
  profileId: string | null;
  shell: {
    state: PermissionState;
    profileId: string | null;
    confirmedLocally: boolean;
    reason: string | null;
  };
  auditMode: {
    state: PermissionState;
    reason: string | null;
  };
}

export interface DangerousPermissionsViewModel {
  shellState: PermissionState;
  shellLabel: string;
  shellReason: string;
  auditModeState: PermissionState;
  auditModeLabel: string;
  auditModeReason: string;
  observedAt: string | null;
}

export function buildDangerousPermissionsViewModel(
  snapshot: DangerousPermissionsSnapshot | null,
  activeProfileId: string | null,
  apiAvailable = false,
): DangerousPermissionsViewModel {
  if (!apiAvailable || !snapshot) {
    return {
      shellState: "UNKNOWN",
      shellLabel: "未知：本机危险权限接口尚未接入",
      shellReason: "本机危险权限读取接口尚未接入。",
      auditModeState: "UNKNOWN",
      auditModeLabel: "未知：本机安全审计模式接口尚未接入",
      auditModeReason: "本机审计模式读取接口尚未接入。",
      observedAt: null,
    };
  }

  const profileMatches = Boolean(activeProfileId && snapshot.profileId === activeProfileId && snapshot.shell.profileId === activeProfileId);
  const shellTrusted = profileMatches && (snapshot.shell.state !== "ENABLED" || snapshot.shell.confirmedLocally);
  const shellState: PermissionState = shellTrusted ? snapshot.shell.state : "UNKNOWN";
  const shellReason = !profileMatches
    ? "权限状态与当前 Profile 不匹配，按未知处理。"
    : snapshot.shell.reason
      ? redactScreenText(snapshot.shell.reason)
      : "";
  const auditModeReason = !profileMatches
    ? "审计状态与当前 Profile 不匹配，按未知处理。"
    : snapshot.auditMode.reason
      ? redactScreenText(snapshot.auditMode.reason)
      : "";
  const shellLabel = !shellTrusted
    ? "未知：授权缺少本机确认或与当前 Profile 不匹配，按关闭处理"
    : snapshot.shell.state === "ENABLED"
      ? "已启用（受控层确认；仅限当前 Profile）"
      : snapshot.shell.state === "DISABLED"
        ? "已关闭（受控层状态）"
        : "未知（受控层未证明当前状态）";

  const auditModeState: PermissionState = profileMatches ? snapshot.auditMode.state : "UNKNOWN";
  const auditModeLabel = !profileMatches
    ? "未知：审计状态与当前 Profile 不匹配"
    : snapshot.auditMode.state === "ENABLED"
      ? "已启用（受控层状态）"
      : snapshot.auditMode.state === "DISABLED"
        ? "未启用（受控层状态）"
        : "未知（受控层未证明当前状态）";

  return {
    shellState,
    shellLabel,
    shellReason,
    auditModeState,
    auditModeLabel,
    auditModeReason,
    observedAt: snapshot.observedAt,
  };
}
