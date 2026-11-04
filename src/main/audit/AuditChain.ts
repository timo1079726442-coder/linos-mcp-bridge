import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { redactObject } from "../redaction/Redactor.js";

/**
 * AuditChain — APPEND_ONLY with SHA-256 Hash Chain.
 *
 * Per CP1 SECURITY_MODEL_V2 §6 + P0-8 (rotation semantics):
 *   - Each entry: sequence (GLOBALLY MONOTONIC across archives), timestamp,
 *     previousHash, payloadHash
 *   - verify() recomputes the chain across archives + active and detects:
 *       sequence gap
 *       previousHash mismatch
 *       payloadHash mismatch
 *   - rotate() preserves the chain across archives via Anchor Registry; it
 *     does NOT reset the chain identity to genesis (lastHash != genesis).
 *     A new entry's previousHash after rotation points to the last entry's
 *     payloadHash from the previous archive (via last anchor).
 *   - open() VERIFIES the existing chain; if verification fails, freezes
 *     and reports TAMPER_EVIDENT_TRIGGERED (caller decides MANUAL).
 *   - **CHAIN_INTEGRITY_DETECTION** (NOT tamper proof against a privileged
 *     local attacker that can rewrite the entire log + recompute hashes).
 */
export interface AuditEntry {
  sequence: number;
  timestamp: string;
  previousHash: string;
  payloadHash: string;
  payload: Record<string, unknown>;
}

export interface AnchorRecord {
  archiveFilename: string;
  firstSequence: number;
  lastSequence: number;
  lastHash: string;
  rotatedAt: string;
}

export interface VerifyResult {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
  /** When not ok, this is the entry that failed verification. */
  entry?: AuditEntry;
}

export interface AuditOpenOptions {
  /**
   * Keep the default fail-closed behavior. Quarantine is an explicit
   * Supervisor recovery action: the invalid chain is preserved verbatim in a
   * new evidence directory and a new chain starts at a documented boundary.
   */
  integrityRecovery?: "fail_closed" | "quarantine";
}

export class AuditChain {
  private readonly activeLogPath: string;
  private readonly anchorRegistryPath: string;
  private readonly archiveDir: string;
  /** Last hash we believe the chain is at. After open(): anchor.lastHash or last active entry. */
  private lastHash = "0".repeat(64);
  /** Last sequence we believe the chain is at. */
  private lastSequence = 0;
  /** True if lastHash/lastSequence reflect the most recent ARCHIVE anchor (not genesis). */
  private lastFromArchive = false;
  private frozen = false;
  private tamperDetected = false;
  /** Serialize async read-modify-write appends within one Supervisor process. */
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(stateRoot: string, profileId: string) {
    const dir = path.join(stateRoot, "profiles", profileId, "audit");
    this.activeLogPath = path.join(dir, "active.log");
    this.anchorRegistryPath = path.join(dir, "anchor-registry.json");
    this.archiveDir = path.join(dir, "archive");
  }

  /** Boot: replay + verify. If verification fails, freeze + flag TAMPER_EVIDENT. */
  async open(options: AuditOpenOptions = {}): Promise<void> {
    await fs.mkdir(path.dirname(this.activeLogPath), { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });

    // Walk archives in order, building the chain head.
    let registry: AnchorRecord[];
    try {
      registry = await this.readAnchorRegistryStrict();
    } catch (error) {
      await this.handleIntegrityFailure(options, `anchor_registry_invalid:${safeErrorCode(error)}`);
      return;
    }
    let head = "0".repeat(64);
    let headSeq = 0;
    for (const anchor of registry) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(this.archiveDir, anchor.archiveFilename), "utf8");
      } catch (error) {
        await this.handleIntegrityFailure(options, `archive_unreadable:${safeErrorCode(error)}`);
        return;
      }
      const r = await verifyChainSlice(raw, head, headSeq + 1);
      if (!r.ok) {
        await this.handleIntegrityFailure(options, r.reason ?? "archive_integrity_failure");
        return;
      }
      head = anchor.lastHash;
      headSeq = anchor.lastSequence;
    }
    // Continue into active log
    let activeRaw = "";
    try {
      activeRaw = await fs.readFile(this.activeLogPath, "utf8");
    } catch {
      // no active log
    }
    const r = await verifyChainSlice(activeRaw, head, headSeq + 1);
    if (!r.ok && r.brokenAt !== undefined) {
      // Allow empty active
      if (activeRaw.trim() === "") {
        // OK — empty active log after rotations
      } else {
        await this.handleIntegrityFailure(options, r.reason ?? "active_integrity_failure");
        return;
      }
    }
    // Commit head state from anchor registry's last anchor (or genesis)
    if (registry.length > 0) {
      const last = registry[registry.length - 1]!;
      this.lastHash = last.lastHash;
      this.lastSequence = last.lastSequence;
      this.lastFromArchive = true;
    } else {
      this.lastHash = head;
      this.lastSequence = headSeq;
      this.lastFromArchive = false;
    }
    // If active log had entries, advance further by walking it.
    for (const line of activeRaw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        this.lastSequence = entry.sequence;
        this.lastHash = entry.payloadHash;
        this.lastFromArchive = false;
      } catch {
        await this.handleIntegrityFailure(options, "active_entry_parse_failure");
        return;
      }
    }
  }

  private async handleIntegrityFailure(options: AuditOpenOptions, reason: string): Promise<void> {
    this.tamperDetected = true;
    if (options.integrityRecovery !== "quarantine") {
      this.frozen = true;
      return;
    }
    await this.quarantineInvalidState(reason);
    this.frozen = false;
  }

  /**
   * Preserve every known piece of the invalid chain, then create a new chain
   * at the original paths. No historical file is edited or deleted.
   */
  private async quarantineInvalidState(reason: string): Promise<void> {
    const auditDir = path.dirname(this.activeLogPath);
    const quarantineId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(8).toString("hex")}`;
    const quarantineDir = path.join(auditDir, "quarantine", quarantineId);
    await fs.mkdir(quarantineDir, { recursive: true });

    const sources = [
      { source: this.activeLogPath, relative: "active.log" },
      { source: `${this.activeLogPath}.tmp`, relative: "active.log.tmp" },
      { source: this.anchorRegistryPath, relative: "anchor-registry.json" },
      { source: `${this.anchorRegistryPath}.tmp`, relative: "anchor-registry.json.tmp" },
      { source: this.archiveDir, relative: "archive" },
    ];
    const files: Array<{ path: string; bytes: number; sha256: string }> = [];
    for (const item of sources) {
      if (await exists(item.source)) {
        files.push(...await hashEvidence(item.source, item.relative));
      }
    }

    // Rename on the same volume, preserving bytes and timestamps. The
    // original locations are then recreated exclusively for the new chain.
    for (const item of sources) {
      if (await exists(item.source)) {
        await fs.rename(item.source, path.join(quarantineDir, item.relative));
      }
    }

    const manifest = {
      schemaVersion: 1,
      kind: "AUDIT_CHAIN_QUARANTINE",
      quarantineId,
      detectedAt: new Date().toISOString(),
      reason,
      evidence: files,
      continuity: "new_chain_starts_after_quarantine_boundary",
    };
    await fs.writeFile(path.join(quarantineDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fs.mkdir(this.archiveDir, { recursive: true });
    await fs.writeFile(this.anchorRegistryPath, "[]\n", "utf8");
    await fs.writeFile(this.activeLogPath, "", "utf8");
    this.lastHash = "0".repeat(64);
    this.lastSequence = 0;
    this.lastFromArchive = false;
    await this.append({
      event: "AUDIT_CHAIN_QUARANTINED",
      reason,
      quarantineId,
      preservedFileCount: files.length,
    });
  }

  isTamperDetected(): boolean {
    return this.tamperDetected;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  /**
   * Append a new entry. Read-modify-write atomic via tmp + rename.
   * previousHash ALWAYS points to the most recent entry (archive anchor or
   * last active entry), preserving global chain continuity.
   */
  async append(payload: Record<string, unknown>): Promise<AuditEntry> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.appendSerialized(payload);
    } finally {
      release();
    }
  }

  private async appendSerialized(payload: Record<string, unknown>): Promise<AuditEntry> {
    if (this.frozen) throw new Error("audit_chain_frozen_tamper_evident");
    // P0-6: Central redaction. Defense-in-depth even if caller forgot.
    const safePayload = redactObject(payload);
    const sequence = this.lastSequence + 1;
    const timestamp = new Date().toISOString();
    const canonicalPayload = canonicalize(safePayload);
    const payloadHash = createHash("sha256")
      .update(`${sequence}|${timestamp}|${this.lastHash}|${canonicalPayload}`)
      .digest("hex");
    const entry: AuditEntry = {
      sequence,
      timestamp,
      previousHash: this.lastHash,
      payloadHash,
      payload: safePayload,
    };
    const newLine = JSON.stringify(entry) + "\n";
    let existing = "";
    try {
      existing = await fs.readFile(this.activeLogPath, "utf8");
    } catch {
      // no active log yet
    }
    const tmp = `${this.activeLogPath}.tmp`;
    await fs.writeFile(tmp, existing + newLine, "utf8");
    await fs.rename(tmp, this.activeLogPath);
    this.lastSequence = sequence;
    this.lastHash = payloadHash;
    this.lastFromArchive = false;
    return entry;
  }

  /**
   * Rotate the active log to an archive; record its anchor.
   * CRITICAL: chain identity is NOT reset to genesis. The next append after
   * rotation uses the archived anchor's lastHash as previousHash.
   */
  async rotate(): Promise<AnchorRecord> {
    if (this.lastSequence === 0) {
      throw new Error("audit_chain_empty_nothing_to_rotate");
    }
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-seq-${this.lastSequence}.log`;
    const archivePath = path.join(this.archiveDir, filename);
    const raw = await fs.readFile(this.activeLogPath, "utf8");
    await fs.writeFile(archivePath, raw, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const firstSeq = lines.length > 0 ? (JSON.parse(lines[0]!) as AuditEntry).sequence : 1;
    const anchor: AnchorRecord = {
      archiveFilename: filename,
      firstSequence: firstSeq,
      lastSequence: this.lastSequence,
      lastHash: this.lastHash,
      rotatedAt: new Date().toISOString(),
    };
    const registry = await this.readAnchorRegistry();
    registry.push(anchor);
    await fs.writeFile(this.anchorRegistryPath, JSON.stringify(registry, null, 2), "utf8");
    // Reset active log. CRITICAL: do NOT reset lastHash/lastSequence to genesis —
    // next append must chain off this archive's lastHash.
    await fs.writeFile(this.activeLogPath, "", "utf8");
    // lastHash / lastSequence remain unchanged.
    this.lastFromArchive = true;
    return anchor;
  }

  /** Verify chain integrity across active + all archives. */
  async verify(): Promise<VerifyResult> {
    let registry: AnchorRecord[];
    try {
      registry = await this.readAnchorRegistryStrict();
    } catch (error) {
      return { ok: false, reason: `anchor_registry_invalid:${safeErrorCode(error)}` };
    }
    let expectedPrev = "0".repeat(64);
    let expectedSeq = 1;
    for (const anchor of registry) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(this.archiveDir, anchor.archiveFilename), "utf8");
      } catch (error) {
        return { ok: false, reason: `archive_unreadable:${safeErrorCode(error)}` };
      }
      const r = await verifyChainSlice(raw, expectedPrev, expectedSeq);
      if (!r.ok) return r;
      expectedPrev = anchor.lastHash;
      expectedSeq = anchor.lastSequence + 1;
    }
    let activeRaw = "";
    try {
      activeRaw = await fs.readFile(this.activeLogPath, "utf8");
    } catch {
      // missing
    }
    if (activeRaw.trim() !== "") {
      const r = await verifyChainSlice(activeRaw, expectedPrev, expectedSeq);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  /**
   * Read a verified projection source across archives and the active segment.
   * Callers must still expose only an allowlisted projection; raw audit
   * payloads are never a Renderer API.
   */
  async readVerifiedEntries(): Promise<AuditEntry[]> {
    if (this.frozen || this.tamperDetected) throw new Error("audit_chain_projection_unavailable");
    const integrity = await this.verify();
    if (!integrity.ok) throw new Error("audit_chain_projection_unavailable");

    const entries: AuditEntry[] = [];
    const registry = await this.readAnchorRegistryStrict();
    for (const anchor of registry) {
      const raw = await fs.readFile(path.join(this.archiveDir, anchor.archiveFilename), "utf8");
      entries.push(...parseAuditEntries(raw));
    }
    let activeRaw = "";
    try {
      activeRaw = await fs.readFile(this.activeLogPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw new Error("audit_chain_projection_unavailable");
    }
    entries.push(...parseAuditEntries(activeRaw));
    return entries;
  }

  async readAnchorRegistry(): Promise<AnchorRecord[]> {
    try {
      const raw = await fs.readFile(this.anchorRegistryPath, "utf8");
      return JSON.parse(raw) as AnchorRecord[];
    } catch {
      return [];
    }
  }

  private async readAnchorRegistryStrict(): Promise<AnchorRecord[]> {
    try {
      const raw = await fs.readFile(this.anchorRegistryPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error("registry_not_array");
      return parsed as AnchorRecord[];
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  /** Freeze after TAMPER_EVIDENT. */
  freeze(): void {
    this.frozen = true;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function hashEvidence(target: string, relative: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const stat = await fs.stat(target);
  if (stat.isFile()) {
    const raw = await fs.readFile(target);
    return [{ path: relative, bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") }];
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  const out: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(...await hashEvidence(path.join(target, entry.name), path.join(relative, entry.name)));
  }
  return out;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "read_error";
}

async function verifyChainSlice(
  raw: string,
  expectedPrevHash: string,
  expectedStartSeq: number,
): Promise<VerifyResult> {
  let prev = expectedPrevHash;
  let seq = expectedStartSeq;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return { ok: false, brokenAt: seq, reason: `parse_error_at_${seq}` };
    }
    if (entry.sequence !== seq) {
      return { ok: false, brokenAt: seq, reason: `sequence_gap_expected_${seq}_got_${entry.sequence}` };
    }
    if (entry.previousHash !== prev) {
      return { ok: false, brokenAt: seq, reason: `previousHash_mismatch_at_${seq}`, entry };
    }
    const expectedPayloadHash = createHash("sha256")
      .update(`${entry.sequence}|${entry.timestamp}|${entry.previousHash}|${canonicalize(entry.payload)}`)
      .digest("hex");
    if (entry.payloadHash !== expectedPayloadHash) {
      return { ok: false, brokenAt: seq, reason: `payloadHash_mismatch_at_${seq}`, entry };
    }
    prev = entry.payloadHash;
    seq++;
  }
  return { ok: true };
}

function parseAuditEntries(raw: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (!Number.isInteger(entry.sequence) || typeof entry.timestamp !== "string" || !entry.payload || typeof entry.payload !== "object") {
        throw new Error("invalid_entry");
      }
      entries.push(entry);
    } catch {
      throw new Error("audit_chain_projection_unavailable");
    }
  }
  return entries;
}

/** Stable JSON serialization for hashing. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

