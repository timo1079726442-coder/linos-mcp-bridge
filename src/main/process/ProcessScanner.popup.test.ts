import { describe, expect, it } from "vitest";
import { getProcessInfo, WINDOWS_PROCESS_QUERY_OPTIONS } from "./ProcessScanner.js";

/**
 * Proves that the real subprocess call uses the single frozen Windows spawn policy.
 * No PowerShell process is launched by these tests.
 */
describe("Windows process query popup prevention", () => {
  it("uses a no-window spawn option for routine PowerShell process inspection", () => {
    expect(WINDOWS_PROCESS_QUERY_OPTIONS).toEqual({
      encoding: "utf8", timeout: 5000, windowsHide: true,
    });
    expect(Object.isFrozen(WINDOWS_PROCESS_QUERY_OPTIONS)).toBe(true);
  });

  it("does not execute a process query for an invalid pid", async () => {
    expect(await getProcessInfo(-1)).toBeNull();
    expect(await getProcessInfo(0)).toBeNull();
  });
});
