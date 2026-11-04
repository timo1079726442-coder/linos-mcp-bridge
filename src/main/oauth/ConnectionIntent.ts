import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ConnectionIntent,
  DeviceId,
  IntentStatus,
  ProfileId,
  RuntimeId,
  RuntimeInstanceId,
  WorkspaceId,
} from "../../shared/types.js";

/**
 * ConnectionIntentStore — durable, secure storage for OAuth ConnectionIntents.
 *
 * Per CP0-R3 / CP1:
 *   - Intent ID MUST be CSPRNG (NOT Math.random)
 *   - Intent MUST be durably persisted (NOT in-memory only)
 *   - Intent MUST be bound to runtimeInstanceId; on Runtime restart, all
 *     active Intents → REVOKED_RUNTIME_RESTART
 *   - State transitions must be atomic on disk (write-then-rename)
 */
export const INTENT_TTL_MS = 5 * 60 * 1000;

export class ConnectionIntentStore {
  constructor(
    private readonly stateDir: string,
    private readonly profileId: ProfileId,
  ) {}

  private intentDir(): string {
    return path.join(this.stateDir, "profiles", this.profileId, "intents");
  }

  private path(intentId: string): string {
    // Defensive: prevent path traversal via crafted intentId.
    if (!/^c2c_intent_[A-Za-z0-9_-]{16,}$/.test(intentId)) {
      throw new Error(`bad_intent_id: ${intentId}`);
    }
    return path.join(this.intentDir(), `${intentId}.json`);
  }

  async create(opts: {
    deviceId: DeviceId;
    runtimeId: RuntimeId;
    runtimeInstanceId: RuntimeInstanceId;
    workspaceId: WorkspaceId;
    /**
     * 本次连接要授予的 scope 上限。空数组表示"严格按客户端申请授予"（默认，最小权限）。
     * 用户在控制中心显式打开"全权模式"时传全部 scope，Runtime 侧据此放宽令牌权限。
     */
    requestedScopes?: string[];
  }): Promise<ConnectionIntent> {
    await fs.mkdir(this.intentDir(), { recursive: true });
    const now = Date.now();
    const intent: ConnectionIntent = {
      intentId: `c2c_intent_${randomBytes(16).toString("base64url")}`,
      deviceId: opts.deviceId,
      profileId: this.profileId,
      runtimeId: opts.runtimeId,
      runtimeInstanceId: opts.runtimeInstanceId,
      workspaceId: opts.workspaceId,
      status: "PENDING",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + INTENT_TTL_MS).toISOString(),
      candidateClientId: null,
      candidateClientName: null,
      candidateRedirectUris: [],
      requestedScopes: opts.requestedScopes ?? [],
    };
    await this.writeAtomic(intent);
    return intent;
  }

  async read(intentId: string): Promise<ConnectionIntent | null> {
    const target = this.path(intentId); // throws on malformed ID
    try {
      const raw = await fs.readFile(target, "utf8");
      return JSON.parse(raw) as ConnectionIntent;
    } catch {
      return null;
    }
  }

  async listActive(): Promise<ConnectionIntent[]> {
    try {
      const entries = await fs.readdir(this.intentDir());
      const out: ConnectionIntent[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const id = e.slice(0, -".json".length);
        const intent = await this.read(id);
        if (intent && isActive(intent.status)) out.push(intent);
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Invalidate all active Intents whose binding does not match the current
   * runtimeInstanceId. Called by Supervisor whenever a new Runtime is spawned.
   */
  async invalidateForOldRuntime(currentRuntimeInstanceId: RuntimeInstanceId): Promise<number> {
    const all = await this.listActive();
    let count = 0;
    for (const intent of all) {
      if (intent.runtimeInstanceId !== currentRuntimeInstanceId) {
        await this.transition(intent.intentId, "REVOKED_RUNTIME_RESTART", {
          revokeReason: `runtime_restart_at_${new Date().toISOString()}`,
        });
        count++;
      }
    }
    return count;
  }

  async transition(
    intentId: string,
    status: IntentStatus,
    patch: Partial<ConnectionIntent> = {},
  ): Promise<ConnectionIntent> {
    const cur = await this.read(intentId);
    if (!cur) throw new Error(`intent_not_found: ${intentId}`);
    const next: ConnectionIntent = {
      ...cur,
      ...patch,
      intentId,
      profileId: this.profileId,
      status,
    };
    await this.writeAtomic(next);
    return next;
  }

  /** Atomic write: tmp + rename. */
  private async writeAtomic(intent: ConnectionIntent): Promise<void> {
    const target = this.path(intent.intentId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(intent, null, 2), "utf8");
    await fs.rename(tmp, target);
  }
}

function isActive(status: IntentStatus): boolean {
  return (
    status === "PENDING" ||
    status === "CLIENT_BOUND" ||
    status === "CONSENT_PENDING"
  );
}