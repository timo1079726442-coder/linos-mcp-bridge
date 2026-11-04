import type { ScreenAccessSnapshot, ScreenWindowScope, ScreenWindowSummary } from "../../../shared/types.js";

export type { ScreenAccessSnapshot, ScreenWindowScope, ScreenWindowSummary } from "../../../shared/types.js";

export interface ScreenAccessViewModel {
  scopeLabel: string;
  authorizationLabel: string;
  freshnessLabel: string;
  freshnessReason: string;
  windowsMessage: string;
  windowLabels: Array<{ label: string; active: boolean; protected: boolean }>;
  captureMessage: string;
  previewDataUrl: string | null;
  previewExpiresAt: string | null;
  observedAt: string | null;
}

const MAX_PREVIEW_DATA_URL_LENGTH = 2 * 1024 * 1024;
const MAX_PREVIEW_LIFETIME_MS = 5 * 60 * 1000;
const SAFE_PREVIEW_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export function redactScreenText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'\x60]+/gi, "Bearer [已隐藏]")
    .replace(/([?&](?:access_token|refresh_token|token|secret|key)=)[^&#\s]+/gi, "$1[已隐藏]")
    .replace(/\b(password|token|secret|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[邮箱已隐藏]")
    .replace(/\b[A-Z]:\\(?:[^\\\s/:*?"<>|]+\\)*[^\\\s/:*?"<>|]*/gi, "[本机路径已隐藏]")
    .replace(/\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\\\s]+)*/g, "[本机路径已隐藏]")
    .slice(0, 180)
    .trim();
}

function safeReason(reason: string | null | undefined, fallback: string): string {
  const safe = reason ? redactScreenText(reason) : "";
  return safe || fallback;
}

function getSafePreview(snapshot: ScreenAccessSnapshot, nowMs: number): { dataUrl: string; expiresAt: string } | null {
  const preview = snapshot.capture.preview;
  if (!preview || (!preview.redacted && !preview.localOnlyApproved) || preview.dataUrl.length > MAX_PREVIEW_DATA_URL_LENGTH) return null;
  const expiresAtMs = Date.parse(preview.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_PREVIEW_LIFETIME_MS) return null;
  if (!SAFE_PREVIEW_DATA_URL.test(preview.dataUrl)) return null;
  return { dataUrl: preview.dataUrl, expiresAt: preview.expiresAt };
}

export function buildScreenAccessViewModel(
  snapshot: ScreenAccessSnapshot | null,
  apiAvailable = false,
  nowMs = Date.now(),
): ScreenAccessViewModel {
  if (!apiAvailable || !snapshot) {
    return {
      scopeLabel: "未指定授权范围",
      authorizationLabel: "未知：本机屏幕授权接口尚未接入",
      freshnessLabel: "未验证",
      freshnessReason: "没有屏幕观测数据；这不表示没有可用窗口。",
      windowsMessage: "尚无窗口列表数据。窗口枚举接口未接入，不能将其解释为 windows=[]。",
      windowLabels: [],
      captureMessage: "没有截图记录。当前未执行屏幕采集。",
      previewDataUrl: null,
      previewExpiresAt: null,
      observedAt: null,
    };
  }

  const scopeName = snapshot.scope === "ACTIVE_WINDOW" ? "活动窗口"
    : snapshot.scope === "SELECTED_WINDOW" ? "指定窗口"
      : snapshot.scope === "FULL_SCREEN" ? "全屏" : "未指定";
  const scopeLabel = snapshot.scope
    ? scopeName + (snapshot.authorization === "AUTHORIZED" ? "（受控层报告）" : "（未证明已授权）")
    : "未指定授权范围";
  const authorizationLabel = snapshot.authorization === "AUTHORIZED"
    ? "本机已授权（不代表截图成功）"
    : snapshot.authorization === "NOT_AUTHORIZED"
      ? "本机未授权"
      : "授权状态未知";

  const freshnessLabel = snapshot.fresh === true
    ? "fresh=true"
    : snapshot.fresh === false
      ? "fresh=false"
      : "freshness 未知";
  const freshnessReason = snapshot.fresh === true
    ? "观测为新鲜状态。"
    : snapshot.fresh === false
      ? safeReason(snapshot.freshnessReason, "数据已过期，但控制层没有提供具体原因。")
      : safeReason(snapshot.freshnessReason, "控制层没有证明该观测的新鲜度。");

  let windowsMessage: string;
  if (snapshot.windowEnumeration.state === "NOT_AVAILABLE") {
    windowsMessage = safeReason(
      snapshot.windowEnumeration.reason,
      "窗口枚举不可用；不能把缺失数据当作空窗口列表。",
    );
  } else if (snapshot.windowEnumeration.state === "FAILED") {
    const reason = safeReason(snapshot.windowEnumeration.reason, "控制层未提供失败原因。");
    windowsMessage = "窗口枚举失败" + (snapshot.windowEnumeration.reasonCode ? " [" + redactScreenText(snapshot.windowEnumeration.reasonCode) + "]" : "") + "：" + reason;
  } else if (snapshot.windowEnumeration.windows.length === 0) {
    const reason = snapshot.windowEnumeration.reason
      ? " 原因：" + safeReason(snapshot.windowEnumeration.reason, "未提供。")
      : " 控制层未返回更具体原因。";
    windowsMessage = "窗口枚举成功，但结果为空（windows=[]）。" + reason;
  } else {
    windowsMessage = "窗口枚举成功，共 " + snapshot.windowEnumeration.windows.length + " 个窗口。";
  }

  const preview = getSafePreview(snapshot, nowMs);
  let captureMessage: string;
  if (snapshot.capture.state === "SUCCEEDED") {
    captureMessage = preview
      ? preview && snapshot.capture.preview?.redacted
        ? "截图已完成；显示控制层明确标记为脱敏的临时预览。"
        : "截图已完成；显示经过本机逐次确认的临时原图，仅限本机控制中心，不允许直接暴露给远程 MCP。"
      : "截图报告成功，但没有可验证且未过期的安全预览。";
  } else if (snapshot.capture.state === "FAILED") {
    captureMessage = "截图失败" + (snapshot.capture.reasonCode ? " [" + redactScreenText(snapshot.capture.reasonCode) + "]" : "") + "：" +
      safeReason(snapshot.capture.reason, "控制层没有提供具体失败原因。");
  } else if (snapshot.capture.state === "NOT_REQUESTED") {
    captureMessage = "尚未请求截图；授权状态不会被当作采集成功。";
  } else {
    captureMessage = "截图状态未知。";
  }

  return {
    scopeLabel,
    authorizationLabel,
    freshnessLabel,
    freshnessReason,
    windowsMessage,
    windowLabels: snapshot.windowEnumeration.state === "AVAILABLE"
      ? snapshot.windowEnumeration.windows.map((window) => ({
        label: redactScreenText(window.title) || "未命名窗口",
        active: window.active,
        protected: window.protected,
      }))
      : [],
    captureMessage,
    previewDataUrl: preview?.dataUrl ?? null,
    previewExpiresAt: preview?.expiresAt ?? null,
    observedAt: snapshot.observedAt,
  };
}
