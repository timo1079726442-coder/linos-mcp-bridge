import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WriteAuthorizationPage } from "./WriteAuthorization.js";
import type { WritePolicy } from "../../shared/types.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; host: HTMLElement }> = [];
const policy: WritePolicy = {
  schemaVersion: 2,
  enabled: false,
  powershellEnabled: false,
  tools: {
    createFile: false,
    updateFile: false,
    deleteFile: false,
    executeCommand: false,
    gitCommit: false,
    powershell: false,
  },
  deviceId: "device-company",
  profileId: "profile-company",
  workspaceId: "workspace-company",
  workspaceRoot: "D:/CODE",
  allowedDirectories: ["D:/CODE/docs"],
  allowedFiles: ["D:/CODE/scripts/build.ps1"],
  maxBytesPerWrite: 1_048_576,
  maxAllowedDirectories: 50,
  maxAllowedFiles: 100,
  updatedAt: "2026-10-14T10:00:00.000Z",
  updatedBy: "owner",
};

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(<WriteAuthorizationPage />);
    await Promise.resolve();
  });
  return host;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  if (!button) throw new Error(`BUTTON_NOT_FOUND:${testId}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function toggle(host: HTMLElement, testId: string): Promise<void> {
  const element = host.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null;
  if (!element) throw new Error(`INPUT_NOT_FOUND:${testId}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

async function input(host: HTMLElement, testId: string, value: string): Promise<void> {
  const element = host.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null;
  if (!element) throw new Error(`INPUT_NOT_FOUND:${testId}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const get = vi.fn<() => Promise<WritePolicy>>();
const set = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const audit = vi.fn<() => Promise<never[]>>();

function installApi(): void {
  get.mockResolvedValue(policy);
  set.mockResolvedValue({ policy, changed: true });
  audit.mockResolvedValue([]);
  Object.defineProperty(window, "c2c", {
    configurable: true,
    value: { writePolicy: { get, set, audit } },
  });
}

afterEach(async () => {
  await act(async () => {
    for (const item of mounted) item.root.unmount();
  });
  mounted.length = 0;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  delete (window as unknown as { c2c?: unknown }).c2c;
});

describe("WriteAuthorizationPage", () => {
  it("shows the device, profile and workspace binding", async () => {
    installApi();
    const host = await mount();
    await flush();

    expect(host.textContent).toContain("device-company");
    expect(host.textContent).toContain("profile-company");
    expect(host.textContent).toContain("workspace-company");
    expect(host.textContent).toContain("D:/CODE");
  });

  it("states that this owner policy applies to Codex 48765, not C2C Runtime", async () => {
    installApi();
    const host = await mount();
    await flush();

    expect(host.textContent).toContain("仅 Codex 48765 MCP");
    expect(host.textContent).toContain("不改变 C2C 48767 Runtime 的 Supervisor／审批策略");
  });

  it("stages an exact-file grant and saves it only on Apply", async () => {
    installApi();
    const host = await mount();
    await flush();

    await input(host, "write-auth-file-input", "D:/CODE/config/local.json");
    await click(host, "write-auth-file-add");
    expect(host.textContent).toContain("D:/CODE/config/local.json");
    expect(set).not.toHaveBeenCalled();

    await click(host, "write-auth-apply");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toEqual({
      update: { allowedFiles: ["D:/CODE/scripts/build.ps1", "D:/CODE/config/local.json"] },
      actor: "owner",
      requireConfirmation: true,
    });
  });

  it("does not show an enabled state while the stored file-write toggle is off", async () => {
    installApi();
    const host = await mount();
    await flush();
    const checkbox = host.querySelector('[data-testid="write-auth-enabled"]') as HTMLInputElement;

    expect(checkbox.checked).toBe(false);
    expect(host.querySelector('[data-testid="write-auth-status"]')?.textContent).toBe("未启用");
  });

  it("identifies Codex bridge entries in the merged audit table", async () => {
    installApi();
    audit.mockResolvedValue([{
      sequence: 4,
      timestamp: "2026-10-15T10:00:00.000Z",
      actor: { clientId: "codex-client", requestId: "request-4" },
      workspaceId: "workspace-company",
      relativePath: ".",
      operation: "EXECUTE_COMMAND",
      bytesWritten: 0,
      beforeSha256: null,
      afterSha256: null,
      outcome: "COMPLETED",
      source: "codex-bridge",
    }] as never[]);
    const host = await mount();
    await flush();

    expect(host.textContent).toContain("Codex 48765");
    expect(host.textContent).toContain("EXECUTE_COMMAND");
    expect(host.textContent).toContain("codex-client");
  });

  it("lists per-tool toggles in Chinese and saves only the changed tools on Apply", async () => {
    installApi();
    const host = await mount();
    await flush();

    expect(host.textContent).toContain("修改已有文件");
    expect(host.textContent).toContain("删除文件");
    expect(host.textContent).toContain("受限命令执行");
    expect(set).not.toHaveBeenCalled();

    await toggle(host, "write-auth-tool-updateFile-toggle");
    await toggle(host, "write-auth-tool-createFile-toggle");
    expect(set).not.toHaveBeenCalled();

    await click(host, "write-auth-apply");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toEqual({
      update: { tools: { updateFile: true, createFile: true } },
      actor: "owner",
      requireConfirmation: true,
    });
  });
});

