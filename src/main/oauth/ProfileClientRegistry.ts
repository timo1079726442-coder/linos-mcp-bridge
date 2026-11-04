import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes, createHash } from "node:crypto";

/**
 * ProfileClientRegistry — persists OAuth client registrations per profile.
 *
 * Per CP1 SECURITY_MODEL_V2 + CP7 OAuth Storage Split:
 *   - Index: profileId
 *   - Stored at: state/profiles/<profileId>/client-registry.json
 *   - Survives Workspace Change (Profile-scoped, not Workspace-scoped)
 *   - First successful DCR pins client_id + redirect_uris; later changes
 *     require new Intent + Consent.
 */

export interface ProfileClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  pinStatus: "active" | "revoked";
  registeredAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface ProfileClientRegistrySnapshot {
  state: "READY" | "NOT_CONFIGURED" | "UNAVAILABLE";
  records: ProfileClientRecord[];
}

export class ProfileClientRegistry {
  constructor(
    private readonly stateRoot: string,
    private readonly profileId: string,
  ) {}

  private path(): string {
    return path.join(this.stateRoot, "profiles", this.profileId, "client-registry.json");
  }

  async list(): Promise<ProfileClientRecord[]> {
    const snapshot = await this.inspect();
    return snapshot.state === "READY" ? snapshot.records : [];
  }

  async inspect(): Promise<ProfileClientRegistrySnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path(), "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "NOT_CONFIGURED", records: [] }
        : { state: "UNAVAILABLE", records: [] };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(isProfileClientRecord)) {
        return { state: "UNAVAILABLE", records: [] };
      }
      return { state: "READY", records: parsed };
    } catch {
      return { state: "UNAVAILABLE", records: [] };
    }
  }

  async upsert(rec: Omit<ProfileClientRecord, "pinStatus" | "registeredAt" | "lastSeenAt">): Promise<ProfileClientRecord> {
    const all = await this.list();
    const existing = all.findIndex((r) => r.clientId === rec.clientId);
    const now = new Date().toISOString();
    const next: ProfileClientRecord =
      existing >= 0
        ? { ...all[existing]!, ...rec, lastSeenAt: now, pinStatus: all[existing]!.pinStatus }
        : { ...rec, pinStatus: "active", registeredAt: now, lastSeenAt: now };
    if (existing >= 0) all[existing] = next;
    else all.push(next);
    await fs.mkdir(path.dirname(this.path()), { recursive: true });
    await this.writeAtomic(all);
    return next;
  }

  async revoke(clientId: string): Promise<void> {
    const all = await this.list();
    const updated = all.map((r) =>
      r.clientId === clientId ? { ...r, pinStatus: "revoked" as const, lastSeenAt: new Date().toISOString() } : r,
    );
    await this.writeAtomic(updated);
  }

  async findByClientId(clientId: string): Promise<ProfileClientRecord | null> {
    const all = await this.list();
    return all.find((r) => r.clientId === clientId) ?? null;
  }

  private async writeAtomic(records: ProfileClientRecord[]): Promise<void> {
    const tmp = `${this.path()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(records, null, 2), "utf8");
    await fs.rename(tmp, this.path());
  }
}

export function generateClientId(): string {
  return `c2c_client_${randomBytes(12).toString("base64url")}`;
}

export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function isProfileClientRecord(value: unknown): value is ProfileClientRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.clientId === "string" &&
    typeof record.clientName === "string" &&
    Array.isArray(record.redirectUris) && record.redirectUris.every((item) => typeof item === "string") &&
    Array.isArray(record.scopes) && record.scopes.every((item) => typeof item === "string") &&
    (record.pinStatus === "active" || record.pinStatus === "revoked") &&
    typeof record.registeredAt === "string" &&
    typeof record.lastSeenAt === "string";
}
