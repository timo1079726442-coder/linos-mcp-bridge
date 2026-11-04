import { promises as fs } from "node:fs";
import * as path from "node:path";

/**
 * WorkspaceGrantStore — per-(profileId, workspaceId) OAuth grant storage.
 *
 * Per CP1 SECURITY_MODEL_V2 + CP7 OAuth Storage Split:
 *   - Index: (profileId, workspaceId)
 *   - Stored at: state/profiles/<profileId>/grants/<workspaceId>.json
 *   - Holds: clientId (FK to ProfileClientRegistry), accessTokenHash,
 *     refreshTokenHash, scopes, audience=workspaceId
 *   - access / refresh tokens are NEVER persisted in plaintext; only
 *     SHA-256 hashes.
 *   - On Workspace Change COMMIT: old grants get revoked via
 *     revokeAll() called from WorkspaceTransactionCoordinator.
 *   - On Workspace Change ROLLBACK: untouched.
 */

export interface WorkspaceGrant {
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  scopes: string[];
  audience: string; // workspaceId
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt?: string;
  /** Optional user_id / sub if known. */
  subject?: string;
}

export type WorkspaceGrantSnapshot =
  | { state: "PRESENT"; grant: WorkspaceGrant }
  | { state: "MISSING" | "UNAVAILABLE" };

export class WorkspaceGrantStore {
  constructor(
    private readonly stateRoot: string,
    private readonly profileId: string,
  ) {}

  private pathFor(workspaceId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
      throw new Error(`bad_workspace_id: ${workspaceId}`);
    }
    return path.join(this.stateRoot, "profiles", this.profileId, "grants", `${workspaceId}.json`);
  }

  async list(): Promise<Array<{ workspaceId: string; grant: WorkspaceGrant }>> {
    const dir = path.dirname(this.pathFor("_"));
    try {
      const entries = await fs.readdir(dir);
      const out: Array<{ workspaceId: string; grant: WorkspaceGrant }> = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const wid = e.slice(0, -".json".length);
        const g = await this.get(wid);
        if (g) out.push({ workspaceId: wid, grant: g });
      }
      return out;
    } catch {
      return [];
    }
  }

  async get(workspaceId: string): Promise<WorkspaceGrant | null> {
    const snapshot = await this.inspect(workspaceId);
    return snapshot.state === "PRESENT" ? snapshot.grant : null;
  }

  async inspect(workspaceId: string): Promise<WorkspaceGrantSnapshot> {
    let raw: string;
    try {
      raw = await fs.readFile(this.pathFor(workspaceId), "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "MISSING" }
        : { state: "UNAVAILABLE" };
    }
    try {
      const grant: unknown = JSON.parse(raw);
      if (!isWorkspaceGrant(grant)) return { state: "UNAVAILABLE" };
      return { state: "PRESENT", grant };
    } catch {
      return { state: "UNAVAILABLE" };
    }
  }

  async set(workspaceId: string, grant: WorkspaceGrant): Promise<void> {
    await fs.mkdir(path.dirname(this.pathFor(workspaceId)), { recursive: true });
    const tmp = `${this.pathFor(workspaceId)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(grant, null, 2), "utf8");
    await fs.rename(tmp, this.pathFor(workspaceId));
  }

  async revoke(workspaceId: string): Promise<void> {
    const cur = await this.get(workspaceId);
    if (!cur) return;
    const next: WorkspaceGrant = { ...cur, revoked: true, revokedAt: new Date().toISOString() };
    await this.set(workspaceId, next);
  }

  /**
   * Revoke ALL grants for this profile (used on Workspace Change COMMIT).
   * Idempotent.
   */
  async revokeAll(): Promise<number> {
    const all = await this.list();
    let n = 0;
    for (const { workspaceId } of all) {
      await this.revoke(workspaceId);
      n++;
    }
    return n;
  }
}

function isWorkspaceGrant(value: unknown): value is WorkspaceGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return typeof grant.clientId === "string" &&
    typeof grant.accessTokenHash === "string" &&
    typeof grant.refreshTokenHash === "string" &&
    Array.isArray(grant.scopes) && grant.scopes.every((item) => typeof item === "string") &&
    typeof grant.audience === "string" &&
    typeof grant.issuedAt === "string" &&
    typeof grant.expiresAt === "string" &&
    typeof grant.revoked === "boolean";
}
