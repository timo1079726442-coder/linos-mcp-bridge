import { BrowserWindow, desktopCapturer, dialog } from "electron";
import type { ScreenAccessSnapshot, ScreenWindowSummary } from "../../shared/types.js";
import { redactString } from "../redaction/Redactor.js";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const PREVIEW_MAX_WIDTH = 1280;
const PREVIEW_MAX_HEIGHT = 800;
const PREVIEW_MAX_DATA_URL_LENGTH = 2 * 1024 * 1024;

export async function listWindowsWithLocalConfirmation(
  win: BrowserWindow,
  profileLabel: string,
): Promise<ScreenAccessSnapshot> {
  const confirmation = await dialog.showMessageBox(win, {
    type: "warning",
    title: "本机确认屏幕访问",
    message: "允许 C2C 枚举当前桌面窗口？",
    detail: [
      `Profile: ${safeTitle(profileLabel)}`,
      "窗口标题可能包含文档名或应用信息；返回给 Renderer 前会做基础文本脱敏。",
      "本操作只列出窗口，不截图、不控制鼠标键盘，也不会把画面发送给远程 MCP。",
    ].join("\n"),
    buttons: ["允许一次", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });

  if (confirmation.response !== 0) {
    return snapshotForDenied("SCREEN_WINDOW_ENUMERATION_CANCELLED");
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    const windows: ScreenWindowSummary[] = sources
      .slice(0, 200)
      .map((source) => ({
        windowId: source.id,
        title: safeTitle(source.name) || "未命名窗口",
        active: false,
        protected: false,
      }));

    return {
      observedAt: new Date().toISOString(),
      fresh: true,
      freshnessReason: "由 Electron desktopCapturer 实时枚举；活动/受保护状态未由独立 OS 可信接口确认。",
      authorization: "AUTHORIZED",
      scope: "SELECTED_WINDOW",
      windowEnumeration: {
        state: "AVAILABLE",
        windows,
        reasonCode: null,
        reason: "窗口标题已做基础脱敏；active/protected 未证明，因此不会据此执行自动控制。",
      },
      capture: {
        state: "NOT_REQUESTED",
        capturedAt: null,
        reasonCode: null,
        reason: null,
        preview: null,
      },
    };
  } catch {
    return snapshotForFailure("SCREEN_WINDOW_ENUMERATION_FAILED", "窗口枚举失败；未返回底层异常文本。");
  }
}

export async function captureWindowWithLocalConfirmation(
  win: BrowserWindow,
  profileLabel: string,
  windowId: string,
): Promise<ScreenAccessSnapshot> {
  if (!isSafeWindowId(windowId)) {
    return snapshotForFailure("SCREEN_WINDOW_ID_INVALID", "窗口标识无效。");
  }

  let candidate;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false,
    });
    candidate = sources.find((source) => source.id === windowId);
  } catch {
    return snapshotForFailure("SCREEN_WINDOW_ENUMERATION_FAILED", "截图前无法重新验证窗口列表。");
  }
  if (!candidate) {
    return snapshotForFailure("SCREEN_WINDOW_STALE", "目标窗口已经关闭或窗口标识已变化。");
  }

  const safeName = safeTitle(candidate.name) || "未命名窗口";
  const confirmation = await dialog.showMessageBox(win, {
    type: "warning",
    title: "本机确认截图",
    message: "允许 C2C 截取这个窗口一次？",
    detail: [
      `Profile: ${safeTitle(profileLabel)}`,
      `窗口: ${safeName}`,
      "仅所选窗口的结果进入本机短期预览，不写磁盘、不自动发送给 MCP。",
      "当前 Electron 截图接口会枚举窗口源，可能临时生成其他窗口缩略图；应用不保存或导出其他窗口画面。",
      "要远程发送时，需先查看预览，再独立确认；截图不会自动脱敏。",
    ].join("\n"),
    buttons: ["截图一次", "取消"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) {
    return snapshotForDenied("SCREEN_CAPTURE_CANCELLED", [
      { windowId: candidate.id, title: safeName, active: false, protected: false },
    ]);
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: PREVIEW_MAX_WIDTH, height: PREVIEW_MAX_HEIGHT },
      fetchWindowIcons: false,
    });
    const source = sources.find((entry) => entry.id === windowId);
    if (!source || source.thumbnail.isEmpty()) {
      return snapshotForFailure("SCREEN_CAPTURE_EMPTY", "目标窗口没有返回可用画面。");
    }

    const image = constrainImage(source.thumbnail);
    const dataUrl = `data:image/jpeg;base64,${image.toJPEG(80).toString("base64")}`;
    if (dataUrl.length > PREVIEW_MAX_DATA_URL_LENGTH) {
      return snapshotForFailure("SCREEN_CAPTURE_PREVIEW_TOO_LARGE", "截图已采集，但压缩预览仍超过本机 IPC 安全上限；未返回原图。");
    }
    const capturedAt = new Date();
    const expiresAt = new Date(capturedAt.getTime() + PREVIEW_TTL_MS).toISOString();
    return {
      observedAt: capturedAt.toISOString(),
      fresh: true,
      freshnessReason: "截图由本机用户逐次确认后实时采集。",
      authorization: "AUTHORIZED",
      scope: "SELECTED_WINDOW",
      windowEnumeration: {
        state: "AVAILABLE",
        windows: [{ windowId: source.id, title: safeTitle(source.name) || safeName, active: false, protected: false }],
        reasonCode: null,
        reason: "只保留本次目标窗口；active/protected 状态未证明。",
      },
      capture: {
        state: "SUCCEEDED",
        capturedAt: capturedAt.toISOString(),
        reasonCode: null,
        reason: "LOCAL_ONLY_RAW_PREVIEW",
        preview: {
          redacted: false,
          localOnlyApproved: true,
          dataUrl,
          expiresAt,
        },
      },
    };
  } catch {
    return snapshotForFailure("SCREEN_CAPTURE_FAILED", "截图失败；未返回底层异常文本。");
  }
}

function constrainImage(image: Electron.NativeImage): Electron.NativeImage {
  const size = image.getSize();
  if (size.width <= PREVIEW_MAX_WIDTH && size.height <= PREVIEW_MAX_HEIGHT) return image;
  const ratio = Math.min(PREVIEW_MAX_WIDTH / Math.max(1, size.width), PREVIEW_MAX_HEIGHT / Math.max(1, size.height));
  return image.resize({
    width: Math.max(1, Math.floor(size.width * ratio)),
    height: Math.max(1, Math.floor(size.height * ratio)),
    quality: "good",
  });
}

function snapshotForDenied(reasonCode: string, windows: ScreenWindowSummary[] = []): ScreenAccessSnapshot {
  return {
    observedAt: new Date().toISOString(),
    fresh: true,
    freshnessReason: "本机用户取消了本次屏幕权限请求。",
    authorization: "NOT_AUTHORIZED",
    scope: null,
    windowEnumeration: {
      state: windows.length ? "AVAILABLE" : "NOT_AVAILABLE",
      windows,
      reasonCode,
      reason: "本次授权已取消。",
    },
    capture: {
      state: "NOT_REQUESTED",
      capturedAt: null,
      reasonCode,
      reason: "本次授权已取消。",
      preview: null,
    },
  };
}

function snapshotForFailure(reasonCode: string, reason: string): ScreenAccessSnapshot {
  return {
    observedAt: new Date().toISOString(),
    fresh: true,
    freshnessReason: "本机受控屏幕能力返回失败状态。",
    authorization: "UNKNOWN",
    scope: null,
    windowEnumeration: {
      state: "FAILED",
      windows: [],
      reasonCode,
      reason,
    },
    capture: {
      state: "FAILED",
      capturedAt: null,
      reasonCode,
      reason,
      preview: null,
    },
  };
}

function safeTitle(value: string): string {
  return redactString(value)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[邮箱已隐藏]")
    .replace(/\b[A-Z]:\\(?:[^\\\s/:*?"<>|]+\\)*[^\\\s/:*?"<>|]*/gi, "[本机路径已隐藏]")
    .slice(0, 180)
    .trim();
}

function isSafeWindowId(value: string): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9:_-]+$/.test(value);
}