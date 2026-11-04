import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
/**
 * DeviceIdentity — single stable deviceId per install.
 *
 * Persisted at state/device.dpapi. On first call, generates a CSPRNG deviceId
 * and writes it. Subsequent calls return the same deviceId.
 */
export class DeviceIdentity {
    deviceFile;
    cached = null;
    constructor(stateRoot) {
        this.deviceFile = path.join(stateRoot, "device.dpapi");
    }
    async getDeviceId() {
        if (this.cached)
            return this.cached;
        let raw;
        try {
            raw = await fs.readFile(this.deviceFile, "utf8");
        }
        catch {
            raw = "";
        }
        if (raw.trim().length > 0) {
            this.cached = raw.trim();
            return this.cached;
        }
        const generated = `c2c_dev_${randomBytes(24).toString("base64url")}`;
        await fs.mkdir(path.dirname(this.deviceFile), { recursive: true });
        await fs.writeFile(this.deviceFile, generated, "utf8");
        this.cached = generated;
        return this.cached;
    }
    /** Stable hash for diagnostics output (does not leak secret). */
    static fingerprint(deviceId) {
        return createHash("sha256").update(deviceId).digest("hex").slice(0, 12);
    }
}
