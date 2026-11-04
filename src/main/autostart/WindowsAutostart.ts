/**
 * WindowsAutostart — manage per-user Login Autostart via HKCU\...\Run.
 *
 * Per ADR-V2-003 Option B + CP10-B: per-user autostart. NO Administrator
 * privilege required (HKCU registry hive is per-user).
 *
 * Used to launch the Watchdog binary at user login. The Watchdog in turn
 * ensures the Supervisor and Runtime come up.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const ENTRY_NAME = "LinOSC2CWatchdog";

export interface AutostartEntry {
  registered: boolean;
  command: string | null;
  registryValue: string | null;
}

export class WindowsAutostart {
  /**
   * Enable autostart: write HKCU\...\Run\LinOSC2CWatchdog = "<watchdog.exe>" "<state-root>"
   */
  async enable(watchdogBinaryPath: string, stateRoot: string): Promise<AutostartEntry> {
    if (process.platform !== "win32") {
      throw new Error("WindowsAutostart only runs on Windows");
    }
    if (!(await this.exists(watchdogBinaryPath))) {
      throw new Error(`Watchdog binary not found: ${watchdogBinaryPath}`);
    }
    const command = `"${watchdogBinaryPath}" "${stateRoot}"`;
    await this.runReg(["add", REG_KEY, "/v", ENTRY_NAME, "/t", "REG_SZ", "/d", command, "/f"]);
    return this.status();
  }

  async disable(): Promise<AutostartEntry> {
    if (process.platform !== "win32") {
      throw new Error("WindowsAutostart only runs on Windows");
    }
    try {
      await this.runReg(["delete", REG_KEY, "/v", ENTRY_NAME, "/f"]);
    } catch {
      // ignore not-found
    }
    return this.status();
  }

  async status(): Promise<AutostartEntry> {
    if (process.platform !== "win32") {
      return { registered: false, command: null, registryValue: null };
    }
    try {
      const value = await this.runReg(["query", REG_KEY, "/v", ENTRY_NAME]);
      const match = value.match(/REG_SZ\s+(.+?)\r?\n/);
      const cmd = match ? match[1]!.trim() : null;
      return {
        registered: cmd !== null,
        command: cmd,
        registryValue: cmd,
      };
    } catch {
      return { registered: false, command: null, registryValue: null };
    }
  }

  /** Self-repair: if entry exists but binary missing, fix it. */
  async selfRepair(watchdogBinaryPath: string, stateRoot: string): Promise<AutostartEntry> {
    const cur = await this.status();
    if (!cur.registered) {
      return this.enable(watchdogBinaryPath, stateRoot);
    }
    if (cur.command && !(await this.exists(cur.command.replace(/^"|"$/g, "").split(" ")[0] ?? ""))) {
      return this.enable(watchdogBinaryPath, stateRoot);
    }
    return cur;
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private runReg(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "reg.exe",
        args,
        { encoding: "utf8", timeout: 5000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`reg.exe failed: ${err.message}\n${stderr}`));
            return;
          }
          resolve(stdout + stderr);
        },
      );
    });
  }
}