import type { DiagnosticsReport } from "../../../shared/types.js";

export type ObservationCode =
  | "ACTIVE_PROFILE_UNRESOLVED"
  | "LOCAL_RUNTIME_NOT_READY"
  | "TUNNEL_EDGE_UNAVAILABLE"
  | "PUBLIC_530"
  | "PUBLIC_OAUTH_DISCOVERY_UNVERIFIED"
  | "OAUTH_AUTH_STATE_UNAVAILABLE"
  | "WORKSPACE_IDENTITY_UNAVAILABLE"
  | "WORKSPACE_IDENTITY_MISMATCH";

export interface FaultObservation {
  code: ObservationCode;
  title: string;
  evidence: string[];
  relatedLessonIds: string[];
  evidenceStatus: "OBSERVED_ONLY";
  repairReady: false;
}

/**
 * Convert only facts present in a single DiagnosticsReport into observations.
 * This deliberately does not infer a root cause, create a durable signature,
 * or choose an action. Those decisions belong to the trusted local controller.
 */
export function observeReport(report: DiagnosticsReport): FaultObservation[] {
  const observations: FaultObservation[] = [];
  const remote = report.transport.provider?.toUpperCase() === "CLOUDFLARE_NAMED";

  if (!report.profileMetadata) {
    observations.push({
      code: "ACTIVE_PROFILE_UNRESOLVED",
      title: "当前 Profile 未取得",
      evidence: ["DiagnosticsReport.profileMetadata 为空"],
      relatedLessonIds: ["L31"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  if (report.runtime.port !== null && !report.runtime.healthEndpointOk) {
    observations.push({
      code: "LOCAL_RUNTIME_NOT_READY",
      title: "本地 Runtime 健康探测未通过",
      evidence: [
        "探测端口已配置",
        report.runtime.pid === null ? "Supervisor 未提供 Runtime PID" : "Supervisor 提供了 Runtime PID，但 health 探测未通过",
      ],
      relatedLessonIds: ["L23", "L31"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  if (remote && !report.transport.edgeConnected) {
    observations.push({
      code: "TUNNEL_EDGE_UNAVAILABLE",
      title: "Tunnel Edge 当前未连接",
      evidence: ["活动 Profile 的 transport.provider 为 CLOUDFLARE_NAMED", "transport.edgeConnected 为 false"],
      relatedLessonIds: ["L02", "L22", "L32"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  if (remote && report.transport.publicHealthStatus === 530) {
    observations.push({
      code: "PUBLIC_530",
      title: "公网 Health 返回 HTTP 530",
      evidence: ["transport.publicHealthStatus 为 530"],
      relatedLessonIds: ["L22", "L25", "L26"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  if (remote && report.transport.publicHealthStatus === 200 && !report.transport.oauthDiscoveryOk) {
    observations.push({
      code: "PUBLIC_OAUTH_DISCOVERY_UNVERIFIED",
      title: "公网 OAuth Discovery 未通过探测",
      evidence: ["公网 Health 返回 200", "transport.oauthDiscoveryOk 为 false"],
      relatedLessonIds: ["L25", "L26"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  const expectedWorkspaceId = report.profileMetadata?.currentWorkspaceId;
  const observedWorkspaceId = report.workspace.workspaceId;
  const workspaceConfigured = Boolean(report.profileMetadata?.currentWorkspaceRoot && expectedWorkspaceId);
  const workspaceObserved = Boolean(report.workspace.root && observedWorkspaceId);
  if (report.profileMetadata && (!workspaceConfigured || !workspaceObserved)) {
    observations.push({
      code: "WORKSPACE_IDENTITY_UNAVAILABLE",
      title: "当前 Workspace 身份不可用",
      evidence: [workspaceConfigured ? "Workspace 探测身份不可用" : "Profile 尚未配置 Workspace 身份"],
      relatedLessonIds: ["L31"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  } else if (expectedWorkspaceId && observedWorkspaceId && expectedWorkspaceId !== observedWorkspaceId) {
    observations.push({
      code: "WORKSPACE_IDENTITY_MISMATCH",
      title: "Profile 与 Workspace 探测身份不一致",
      evidence: ["Profile Workspace ID 与 Diagnostics Workspace ID 不同"],
      relatedLessonIds: ["L05", "L31"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  const oauthState = report.oauthAuthorization?.state;
  if (oauthState && ["UNKNOWN", "AUTH_REQUIRED", "REVOKED", "EXPIRED"].includes(oauthState)) {
    observations.push({
      code: "OAUTH_AUTH_STATE_UNAVAILABLE",
      title: "OAuth 授权状态需要检查",
      evidence: [
        oauthState === "UNKNOWN" ? "OAuth 授权真源不可读取" : `OAuth 授权状态为 ${oauthState}`,
        `当前 Profile 注册客户端数：${report.oauthAuthorization?.activeClientCount ?? 0}`,
      ],
      relatedLessonIds: ["L07", "L17", "L18"],
      evidenceStatus: "OBSERVED_ONLY",
      repairReady: false,
    });
  }

  return observations;
}
