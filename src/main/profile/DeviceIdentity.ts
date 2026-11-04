import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DeviceId } from "../../shared/types.js";

/**
 * DeviceIdentity — single stable deviceId per install.
 *
 * Persisted at state/device.dpapi. On first call, generates a CSPRNG deviceId
 * and writes it. Subsequent calls return the same deviceId.
 */
export class DeviceIdentity {
  private readonly deviceFile: string;
  private cached: DeviceId | null = null;

  constructor(stateRoot: string) {
    this.deviceFile = path.join(stateRoot, "device.dpapi");
  }

  async getDeviceId(): Promise<DeviceId> {
    if (this.cached) return this.cached;
    let raw: string;
    try {
      raw = await fs.readFile(this.deviceFile, "utf8");
    } catch {
      raw = "";
    }
    if (raw.trim().length > 0) {
      this.cached = raw.trim() as DeviceId;
      return this.cached;
    }
    const generated = `c2c_dev_${randomBytes(24).toString("base64url")}`;
    await fs.mkdir(path.dirname(this.deviceFile), { recursive: true });
    await fs.writeFile(this.deviceFile, generated, "utf8");
    this.cached = generated;
    return this.cached;
  }

  /** Stable hash for diagnostics output (does not leak secret). */
  static fingerprint(deviceId: DeviceId): string {
    return createHash("sha256").update(deviceId).digest("hex").slice(0, 12);
  }
}