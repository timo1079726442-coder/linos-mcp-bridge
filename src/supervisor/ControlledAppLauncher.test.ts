import { describe, expect, it, vi } from "vitest";
import { launchApprovedApp } from "./ControlledAppLauncher.js";

describe("ControlledAppLauncher", () => {
  it("fails closed on relative or non-executable targets without calling the launcher", async () => {
    const audit = vi.fn(async () => undefined);
    const approve = vi.fn(async () => true);
    const fakeSpawn = vi.fn() as never;
    const result = await launchApprovedApp({
      programPath: "relative-script.cmd",
      allowedRoots: [],
      approvedPrograms: [],
      expectedSha256: "a".repeat(64),
    }, approve, audit, fakeSpawn);
    expect(result).toMatchObject({ status: "REJECTED", pid: null });
    expect(approve).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it("refuses non-Windows platform use and emits an audit event", async () => {
    if (process.platform === "win32") return;
    const audit = vi.fn(async () => undefined);
    const result = await launchApprovedApp({
      programPath: "C:\\temp\\app.exe",
      allowedRoots: ["C:\\temp"],
      approvedPrograms: ["C:\\temp\\app.exe"],
      expectedSha256: "a".repeat(64),
    }, async () => true, audit);
    expect(result).toMatchObject({ status: "REJECTED", code: "WINDOWS_ONLY", pid: null });
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
