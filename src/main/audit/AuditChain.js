import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { redactString } from "../redaction/Redactor.js";
export class AuditChain {
    activeLogPath;
    anchorRegistryPath;
    archiveDir;
    /** Last hash we believe the chain is at. After open(): anchor.lastHash or last active entry. */
    lastHash = "0".repeat(64);
    /** Last sequence we believe the chain is at. */
    lastSequence = 0;
    /** True if lastHash/lastSequence reflect the most recent ARCHIVE anchor (not genesis). */
    lastFromArchive = false;
    frozen = false;
    tamperDetected = false;
    /** Serialize async read-modify-write appends within one Supervisor process. */
    mutationQueue = Promise.resolve();
    constructor(stateRoot, profileId) {
        const dir = path.join(stateRoot, "profiles", profileId, "audit");
        this.activeLogPath = path.join(dir, "active.log");
        this.anchorRegistryPath = path.join(dir, "anchor-registry.json");
        this.archiveDir = path.join(dir, "archive");
    }
    /** Boot: replay + verify. If verification fails, freeze + flag TAMPER_EVIDENT. */
    async open(options = {}) {
        await fs.mkdir(path.dirname(this.activeLogPath), { recursive: true });
        await fs.mkdir(this.archiveDir, { recursive: true });
        // Walk archives in order, building the chain head.
        let registry;
        try {
            registry = await this.readAnchorRegistryStrict();
        }
        catch (error) {
            await this.handleIntegrityFailure(options, `anchor_registry_invalid:${safeErrorCode(error)}`);
            return;
        }
        let head = "0".repeat(64);
        let headSeq = 0;
        for (const anchor of registry) {
            let raw;
            try {
                raw = await fs.readFile(path.join(this.archiveDir, anchor.archiveFilename), "utf8");
            }
            catch (error) {
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
        }
        catch {
            // no active log
        }
        const r = await verifyChainSlice(activeRaw, head, headSeq + 1);
        if (!r.ok && r.brokenAt !== undefined) {
            // Allow empty active
            if (activeRaw.trim() === "") {
                // OK — empty active log after rotations
            }
            else {
                await this.handleIntegrityFailure(options, r.reason ?? "active_integrity_failure");
                return;
            }
        }
        // Commit head state from anchor registry's last anchor (or genesis)
        if (registry.length > 0) {
            const last = registry[registry.length - 1];
            this.lastHash = last.lastHash;
            this.lastSequence = last.lastSequence;
            this.lastFromArchive = true;
        }
        else {
            this.lastHash = head;
            this.lastSequence = headSeq;
            this.lastFromArchive = false;
        }
        // If active log had entries, advance further by walking it.
        for (const line of activeRaw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                this.lastSequence = entry.sequence;
                this.lastHash = entry.payloadHash;
                this.lastFromArchive = false;
            }
            catch {
                await this.handleIntegrityFailure(options, "active_entry_parse_failure");
                return;
            }
        }
    }
    async handleIntegrityFailure(options, reason) {
        this.tamperDetected = true;
        if (options.integrityRecovery !== "quarantine") {
            this.frozen = true;
            return;
        }
        await this.quarantineInvalidState(reason);
        this.frozen = false;
    }
    async quarantineInvalidState(reason) {
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
        const files = [];
        for (const item of sources) {
            if (await exists(item.source))
                files.push(...await hashEvidence(item.source, item.relative));
        }
        for (const item of sources) {
            if (await exists(item.source))
                await fs.rename(item.source, path.join(quarantineDir, item.relative));
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
    isTamperDetected() {
        return this.tamperDetected;
    }
    isFrozen() {
        return this.frozen;
    }
    /**
     * Append a new entry. Read-modify-write atomic via tmp + rename.
     * previousHash ALWAYS points to the most recent entry (archive anchor or
     * last active entry), preserving global chain continuity.
     */
    async append(payload) {
        const previous = this.mutationQueue;
        let release;
        this.mutationQueue = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            return await this.appendSerialized(payload);
        }
        finally {
            release();
        }
    }
    async appendSerialized(payload) {
        if (this.frozen)
            throw new Error("audit_chain_frozen_tamper_evident");
        // P0-6: Central redaction. Defense-in-depth even if caller forgot.
        const safePayload = redactPayload(payload);
        const sequence = this.lastSequence + 1;
        const timestamp = new Date().toISOString();
        const canonicalPayload = canonicalize(safePayload);
        const payloadHash = createHash("sha256")
            .update(`${sequence}|${timestamp}|${this.lastHash}|${canonicalPayload}`)
            .digest("hex");
        const entry = {
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
        }
        catch {
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
    async rotate() {
        if (this.lastSequence === 0) {
            throw new Error("audit_chain_empty_nothing_to_rotate");
        }
        const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-seq-${this.lastSequence}.log`;
        const archivePath = path.join(this.archiveDir, filename);
        const raw = await fs.readFile(this.activeLogPath, "utf8");
        await fs.writeFile(archivePath, raw, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim());
        const firstSeq = lines.length > 0 ? JSON.parse(lines[0]).sequence : 1;
        const anchor = {
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
    async verify() {
        let registry;
        try {
            registry = await this.readAnchorRegistryStrict();
        }
        catch (error) {
            return { ok: false, reason: `anchor_registry_invalid:${safeErrorCode(error)}` };
        }
        let expectedPrev = "0".repeat(64);
        let expectedSeq = 1;
        for (const anchor of registry) {
            let raw;
            try {
                raw = await fs.readFile(path.join(this.archiveDir, anchor.archiveFilename), "utf8");
            }
            catch (error) {
                return { ok: false, reason: `archive_unreadable:${safeErrorCode(error)}` };
            }
            const r = await verifyChainSlice(raw, expectedPrev, expectedSeq);
            if (!r.ok)
                return r;
            expectedPrev = anchor.lastHash;
            expectedSeq = anchor.lastSequence + 1;
        }
        let activeRaw = "";
        try {
            activeRaw = await fs.readFile(this.activeLogPath, "utf8");
        }
        catch {
            // missing
        }
        if (activeRaw.trim() !== "") {
            const r = await verifyChainSlice(activeRaw, expectedPrev, expectedSeq);
            if (!r.ok)
                return r;
        }
        return { ok: true };
    }
    async readAnchorRegistry() {
        try {
            const raw = await fs.readFile(this.anchorRegistryPath, "utf8");
            return JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    async readAnchorRegistryStrict() {
        try {
            const raw = await fs.readFile(this.anchorRegistryPath, "utf8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                throw new Error("registry_not_array");
            return parsed;
        }
        catch (error) {
            if (isMissingFile(error))
                return [];
            throw error;
        }
    }
    /** Freeze after TAMPER_EVIDENT. */
    freeze() {
        this.frozen = true;
    }
}
async function exists(target) {
    try {
        await fs.access(target);
        return true;
    }
    catch {
        return false;
    }
}
async function hashEvidence(target, relative) {
    const stat = await fs.stat(target);
    if (stat.isFile()) {
        const raw = await fs.readFile(target);
        return [{ path: relative, bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") }];
    }
    const entries = await fs.readdir(target, { withFileTypes: true });
    const out = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        out.push(...await hashEvidence(path.join(target, entry.name), path.join(relative, entry.name)));
    }
    return out;
}
function isMissingFile(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function safeErrorCode(error) {
    if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code))
            return code;
    }
    return "read_error";
}
async function verifyChainSlice(raw, expectedPrevHash, expectedStartSeq) {
    let prev = expectedPrevHash;
    let seq = expectedStartSeq;
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
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
/** Stable JSON serialization for hashing. */
function canonicalize(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(",")}]`;
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}
/**
 * redactPayload — traverse object and replace string leaves with redactedString.
 * Defense-in-depth: ensures audit chain never persists plaintext secrets even
 * if caller forgot to redact upstream.
 */
function redactPayload(value) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return redactString(value);
    if (Array.isArray(value))
        return value.map((v) => redactPayload(v));
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = redactPayload(v);
        }
        return out;
    }
    return value;
}
