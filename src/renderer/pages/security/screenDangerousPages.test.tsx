import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { C2CApi } from "../../../preload/preload.js";
import { DangerousPermissionsPage } from "../DangerousPermissions.tsx";
import { ScreenAccessPage } from "../ScreenAccess.tsx";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let originalC2cDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  if (originalC2cDescriptor) Object.defineProperty(window, "c2c", originalC2cDescriptor);
  else Reflect.deleteProperty(window, "c2c");
  originalC2cDescriptor = undefined;
});

function setProfileApi(getActive: ReturnType<typeof vi.fn>): void {
  originalC2cDescriptor = Object.getOwnPropertyDescriptor(window, "c2c");
  const api = { profile: { getActive } } as unknown as C2CApi;
  Object.defineProperty(window, "c2c", { configurable: true, value: api });
}

describe("security pages", () => {
  it("shows screen access as unknown and exposes no capture or authorization action", async () => {
    const getActive = vi.fn().mockResolvedValue(null);
    setProfileApi(getActive);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<ScreenAccessPage />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("授权接口尚未接入");
    expect(container.textContent).toContain("不能将其解释为 windows=[]");
    expect(container.textContent).toContain("当前未执行屏幕采集");
    const buttons=Array.from(container.querySelectorAll("button"));
    expect(buttons.map(button=>button.textContent?.trim())).toEqual([
      "重读当前 Profile", "列出窗口（本机确认）", "截取所选窗口（再次本机确认）",
    ]);
    // Visible is not authorized: without a Profile or screen IPC both screen operations stay disabled.
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[2]?.disabled).toBe(true);
    expect(getActive).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("keeps Shell and audit controls unavailable while showing their real unknown state", async () => {
    const getActive = vi.fn().mockResolvedValue(null);
    setProfileApi(getActive);
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(<DangerousPermissionsPage />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain("危险权限接口尚未接入");
    expect(container.textContent).toContain("安全审计模式接口尚未接入");
    expect(container.textContent).toContain("默认策略：关闭");
    const labels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(labels).toContain("重读当前 Profile");
    expect(labels).toContain("开启危险模式");
    expect(labels).toContain("全部开启");
    expect(getActive).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });
});

