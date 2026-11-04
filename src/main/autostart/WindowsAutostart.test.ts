import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsAutostart } from "./WindowsAutostart.js";

let stateRoot: string;
let fakeRegPath: string;

beforeEach(async () => {
  if (process.platform !== "win32") return; // skip on non-windows
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-autostart-"));
  fakeRegPath = join(stateRoot, "fake-reg.exe");
  await writeFile(fakeRegPath, "@echo off\n");
  await chmod(fakeRegPath, 0o755);
});

describe("WindowsAutostart (CP10-B)", () => {
  it("non-Windows returns registered=false without throwing", async () => {
    if (process.platform === "win32") return;
    const a = new WindowsAutostart();
    const s = await a.status();
    expect(s.registered).toBe(false);
  });

  it("non-Windows enable throws on non-Windows", async () => {
    if (process.platform === "win32") return;
    const a = new WindowsAutostart();
    await expect(a.enable("/some/path", "/state")).rejects.toThrow(/Windows/);
  });

  it("WindowsAutostart export shape is stable (UI toggle contract)", () => {
    // Compile-time check: methods + fields exist with expected names.
    const proto = WindowsAutostart.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.enable).toBe("function");
    expect(typeof proto.disable).toBe("function");
    expect(typeof proto.status).toBe("function");
    expect(typeof proto.selfRepair).toBe("function");
  });
});
