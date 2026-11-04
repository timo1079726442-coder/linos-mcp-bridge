/**
 * Runtime OAuth state.
 *
 * OAuth credentials are intentionally process-local.  The Supervisor owns the
 * durable profile/client/grant records; this module only holds short-lived
 * protocol state and hashes for the currently running Runtime instance.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  registeredAt: string;
  revoked: boolean;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: "S256";
  state: string;
  resource: string;
  createdAt: number;
  expiresAt: number;
  intentId: string | null;
}

export interface AuthorizationCode extends AuthorizationRequest {
  authorizationCodeHash: string;
  consumed: boolean;
}

export interface TokenSet {
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  scopes: string[];
  audience: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  revoked: boolean;
}

/**
 * Durable OAuth metadata owned by the V2 profile boundary.
 *
 * Raw access/refresh tokens and authorization codes are never written here.
 * The Runtime only receives paths for the profile-scoped metadata files; the
 * values persisted by these helpers are hashes and protocol metadata only.
 */
export interface OAuthPersistenceOptions {
  clientRegistryPath?: string;
  grantPath?: string;
  intentDirectory?: string;
}

export interface PersistedClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  pinStatus: "active" | "revoked";
  registeredAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface PersistedGrantRecord {
  clientId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  scopes: string[];
  audience: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt?: string;
  subject?: string;
}

export class Store<K, V> {
  private readonly map = new Map<K, V>();

  set(key: K, value: V): void { this.map.set(key, value); }
  get(key: K): V | undefined { return this.map.get(key); }
  delete(key: K): boolean { return this.map.delete(key); }
  values(): IterableIterator<V> { return this.map.values(); }
  entries(): IterableIterator<[K, V]> { return this.map.entries(); }
  clear(): void { this.map.clear(); }
}

export const clientRegistry = new Store<string, RegisteredClient>();
export const authCodes = new Store<string, AuthorizationCode>();
export const tokenStore = new Store<string, TokenSet>();

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function findTokenByAccess(accessToken: string): TokenSet | null {
  const token = tokenStore.get(hashSecret(accessToken));
  if (!token || token.revoked || token.accessTokenExpiresAt <= Date.now()) return null;
  return token;
}

export function findTokenByRefresh(refreshToken: string): TokenSet | null {
  const hash = hashSecret(refreshToken);
  for (const token of tokenStore.values()) {
    if (!token.revoked && token.refreshTokenHash === hash && token.refreshTokenExpiresAt > Date.now()) {
      return token;
    }
  }
  return null;
}

export function revokeToken(rawToken: string): boolean {
  const hash = hashSecret(rawToken);
  const access = tokenStore.get(hash);
  if (access) {
    access.revoked = true;
    return true;
  }
  for (const token of tokenStore.values()) {
    if (token.refreshTokenHash === hash) {
      token.revoked = true;
      return true;
    }
  }
  return false;
}

export function clearRuntimeOAuthState(): void {
  clientRegistry.clear();
  authCodes.clear();
  tokenStore.clear();
}

export async function loadPersistentOAuthState(
  persistence: OAuthPersistenceOptions | undefined,
  workspaceId: string,
  resourceAudience: string,
): Promise<void> {
  clearRuntimeOAuthState();
  if (!persistence) return;

  if (persistence.clientRegistryPath) {
    try {
      const raw = await fs.readFile(persistence.clientRegistryPath, "utf8");
      const records = JSON.parse(raw) as unknown;
      if (Array.isArray(records)) {
        for (const value of records) {
          const record = asPersistedClient(value);
          if (!record) continue;
          clientRegistry.set(record.clientId, {
            clientId: record.clientId,
            clientName: record.clientName,
            redirectUris: [...record.redirectUris],
            scopes: [...record.scopes],
            registeredAt: record.registeredAt,
            revoked: record.pinStatus === "revoked",
          });
        }
      }
    } catch {
      // Missing metadata is a valid first-run state; malformed entries are
      // ignored and remain fail-closed at the OAuth endpoint.
    }
  }

  if (persistence.grantPath) {
    try {
      const raw = await fs.readFile(persistence.grantPath, "utf8");
      const record = asPersistedGrant(JSON.parse(raw));
      if (record && record.audience === workspaceId) {
        const expiresAt = Date.parse(record.expiresAt);
        if (Number.isFinite(expiresAt)) {
          tokenStore.set(record.accessTokenHash, {
            clientId: record.clientId,
            accessTokenHash: record.accessTokenHash,
            refreshTokenHash: record.refreshTokenHash,
            scopes: [...record.scopes],
            audience: resourceAudience,
            accessTokenExpiresAt: 0,
            refreshTokenExpiresAt: expiresAt,
            revoked: record.revoked,
          });
        }
      }
    } catch {
      // Missing or malformed grant metadata is treated as no grant.
    }
  }
}

export async function persistClientRecord(
  persistence: OAuthPersistenceOptions | undefined,
  client: RegisteredClient,
): Promise<void> {
  if (!persistence?.clientRegistryPath) return;
  let records: PersistedClientRecord[] = [];
  try {
    const raw = await fs.readFile(persistence.clientRegistryPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) records = parsed.flatMap((value) => {
      const record = asPersistedClient(value);
      return record ? [record] : [];
    });
  } catch {
    // First registration.
  }
  const now = new Date().toISOString();
  const next: PersistedClientRecord = {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUris: [...client.redirectUris],
    scopes: [...client.scopes],
    pinStatus: client.revoked ? "revoked" : "active",
    registeredAt: records.find((r) => r.clientId === client.clientId)?.registeredAt ?? client.registeredAt,
    lastSeenAt: now,
  };
  const index = records.findIndex((r) => r.clientId === client.clientId);
  if (index >= 0) records[index] = next;
  else records.push(next);
  await writeAtomic(persistence.clientRegistryPath, JSON.stringify(records, null, 2));
}

export async function persistGrantRecord(
  persistence: OAuthPersistenceOptions | undefined,
  workspaceId: string,
  token: TokenSet,
): Promise<void> {
  if (!persistence?.grantPath) return;
  const record: PersistedGrantRecord = {
    clientId: token.clientId,
    accessTokenHash: token.accessTokenHash,
    refreshTokenHash: token.refreshTokenHash,
    scopes: [...token.scopes],
    audience: workspaceId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(token.refreshTokenExpiresAt).toISOString(),
    revoked: token.revoked,
    revokedAt: token.revoked ? new Date().toISOString() : undefined,
  };
  await writeAtomic(persistence.grantPath, JSON.stringify(record, null, 2));
}

export async function patchPersistedIntent(
  persistence: OAuthPersistenceOptions | undefined,
  intentId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!persistence?.intentDirectory || !/^c2c_intent_[A-Za-z0-9_-]{16,}$/.test(intentId)) return;
  const target = path.join(persistence.intentDirectory, `${intentId}.json`);
  try {
    const current = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>;
    await writeAtomic(target, JSON.stringify({ ...current, ...patch, intentId }, null, 2));
  } catch {
    // Runtime cannot make a missing Intent valid; the in-memory binding still
    // remains guarded by identity/expiry and the next request fails closed.
  }
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  await fs.writeFile(tmp, contents, "utf8");
  const { renameWithRetry } = await import("./atomic-write.js");
  try {
    await renameWithRetry(tmp, target);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function asPersistedClient(value: unknown): PersistedClientRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.clientId !== "string" || typeof v.clientName !== "string" ||
    !Array.isArray(v.redirectUris) || !v.redirectUris.every((x) => typeof x === "string") ||
    !Array.isArray(v.scopes) || !v.scopes.every((x) => typeof x === "string") ||
    (v.pinStatus !== "active" && v.pinStatus !== "revoked") ||
    typeof v.registeredAt !== "string" || typeof v.lastSeenAt !== "string"
  ) return null;
  return {
    clientId: v.clientId,
    clientName: v.clientName,
    redirectUris: v.redirectUris as string[],
    scopes: v.scopes as string[],
    pinStatus: v.pinStatus,
    registeredAt: v.registeredAt,
    lastSeenAt: v.lastSeenAt,
    revokedAt: typeof v.revokedAt === "string" ? v.revokedAt : undefined,
  };
}

function asPersistedGrant(value: unknown): PersistedGrantRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.clientId !== "string" || typeof v.accessTokenHash !== "string" ||
    typeof v.refreshTokenHash !== "string" || !Array.isArray(v.scopes) ||
    !v.scopes.every((x) => typeof x === "string") || typeof v.audience !== "string" ||
    typeof v.issuedAt !== "string" || typeof v.expiresAt !== "string" || typeof v.revoked !== "boolean"
  ) return null;
  return {
    clientId: v.clientId,
    accessTokenHash: v.accessTokenHash,
    refreshTokenHash: v.refreshTokenHash,
    scopes: v.scopes as string[],
    audience: v.audience,
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
    revoked: v.revoked,
    revokedAt: typeof v.revokedAt === "string" ? v.revokedAt : undefined,
    subject: typeof v.subject === "string" ? v.subject : undefined,
  };
}
