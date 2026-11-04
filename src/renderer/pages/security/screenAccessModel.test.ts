import { describe, expect, it } from "vitest";
import {
  buildScreenAccessViewModel,
  redactScreenText,
  type ScreenAccessSnapshot,
} from "./screenAccessModel.ts";

function snapshot(overrides: Partial<ScreenAccessSnapshot> = {}): ScreenAccessSnapshot {
  return {
    observedAt: "2026-10-08T08:00:00.000Z",
    fresh: true,
    freshnessReason: null,
    authorization: "NOT_AUTHORIZED",
    scope: null,
    windowEnumeration: { state: "AVAILABLE", windows: [], reasonCode: null, reason: null },
    capture: {
      state: "NOT_REQUESTED",
      capturedAt: null,
      reasonCode: null,
      reason: null,
      preview: null,
    },
    ...overrides,
  };
}

describe("screen access view model", () => {
  it("does not mistake a missing API for an empty window list or failed capture", () => {
    const result = buildScreenAccessViewModel(null);
    expect(result.authorizationLabel).toContain("未知");
    expect(result.windowsMessage).toContain("不能将其解释为 windows=[]");
    expect(result.captureMessage).toContain("未执行");
    expect(result.previewDataUrl).toBeNull();
  });

  it("shows the actual stale reason and explains an empty successful enumeration", () => {
    const result = buildScreenAccessViewModel(snapshot({
      fresh: false,
      freshnessReason: "cache expired at 08:01",
      windowEnumeration: {
        state: "AVAILABLE",
        windows: [],
        reasonCode: null,
        reason: "No capturable windows were returned.",
      },
    }), true);
    expect(result.freshnessLabel).toBe("fresh=false");
    expect(result.freshnessReason).toContain("cache expired");
    expect(result.windowsMessage).toContain("windows=[]");
    expect(result.windowsMessage).toContain("No capturable windows");
  });

  it("does not claim authorization means capture success and displays the failure cause", () => {
    const result = buildScreenAccessViewModel(snapshot({
      authorization: "AUTHORIZED",
      capture: {
        state: "FAILED",
        capturedAt: null,
        reasonCode: "CAPTURE_DENIED",
        reason: "Protected desktop is not available.",
        preview: null,
      },
    }), true);
    expect(result.authorizationLabel).toContain("不代表截图成功");
    expect(result.captureMessage).toContain("CAPTURE_DENIED");
    expect(result.captureMessage).toContain("Protected desktop");
  });

  it("redacts secrets, email addresses, and local paths from window and failure text", () => {
    const text = redactScreenText("token=abc123 user@example.com C:\\private\\folder\\file.txt");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("user@example.com");
    expect(text).not.toContain("C:\\private");
    expect(text).toContain("[已隐藏]");
    expect(text).toContain("[邮箱已隐藏]");
    expect(text).toContain("[本机路径已隐藏]");
  });

  it("renders only redacted previews that have a short future expiry", () => {
    const base = snapshot();
    const now = Date.now();
    const expiresAt = new Date(now + 30_000).toISOString();
    const raw = buildScreenAccessViewModel(snapshot({
      capture: {
        state: "SUCCEEDED",
        capturedAt: null,
        reasonCode: null,
        reason: null,
        preview: { redacted: false, dataUrl: "data:image/png;base64,AAAA", expiresAt },
      },
    }), true, now);
    expect(raw.previewDataUrl).toBeNull();

    const localApproved = buildScreenAccessViewModel(snapshot({
      capture: {
        state: "SUCCEEDED",
        capturedAt: null,
        reasonCode: null,
        reason: "LOCAL_ONLY_RAW_PREVIEW",
        preview: { redacted: false, localOnlyApproved: true, dataUrl: "data:image/jpeg;base64,AAAA", expiresAt },
      },
    }), true, now);
    expect(localApproved.previewDataUrl).toBe("data:image/jpeg;base64,AAAA");
    expect(localApproved.captureMessage).toContain("本机逐次确认");

    const safe = buildScreenAccessViewModel({
      ...base,
      capture: {
        state: "SUCCEEDED",
        capturedAt: null,
        reasonCode: null,
        reason: null,
        preview: { redacted: true, dataUrl: "data:image/png;base64,AAAA", expiresAt },
      },
    }, true, now);
    expect(safe.previewDataUrl).toBe("data:image/png;base64,AAAA");

    const expired = buildScreenAccessViewModel({
      ...base,
      capture: {
        state: "SUCCEEDED",
        capturedAt: null,
        reasonCode: null,
        reason: null,
        preview: { redacted: true, dataUrl: "data:image/png;base64,AAAA", expiresAt: new Date(now - 1).toISOString() },
      },
    }, true, now);
    expect(expired.previewDataUrl).toBeNull();

    const tooLong = buildScreenAccessViewModel({
      ...base,
      capture: {
        state: "SUCCEEDED",
        capturedAt: null,
        reasonCode: null,
        reason: null,
        preview: { redacted: true, dataUrl: "data:image/png;base64,AAAA", expiresAt: new Date(now + 6 * 60 * 1000).toISOString() },
      },
    }, true, now);
    expect(tooLong.previewDataUrl).toBeNull();
  });
});
