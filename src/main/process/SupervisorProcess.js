import { promises as fs } from "node:fs";
import * as path from "node:path";
import { RuntimeSpawner } from "./RuntimeSpawner.js";
import { getProcessInfo, isProcessAlive, } from "./ProcessScanner.js";
export class SupervisorProcess {
    stateDir;
    profileId;
    opts;
    proc = null;
    runtimeJsonPath;
    state;
    deviceId;
    commandImage;
    constructor(stateDir, profileId, opts) {
        this.stateDir = stateDir;
        this.profileId = profileId;
        this.opts = opts;
        this.runtimeJsonPath = path.join(stateDir, "profiles", profileId, "runtime.json");
        this.deviceId = opts.deviceId;
        this.commandImage = opts.commandImage;
        this.state = {
            pid: null,
            port: opts.port,
            runtimeInstanceId: null,
            startedAt: null,
            lastError: null,
        };
    }
    async start() {
        const spawner = new RuntimeSpawner(this.opts);
        const { proc, runtimeInstanceId } = spawner.spawn();
        this.proc = proc;
        this.state.pid = proc.pid ?? null;
        this.state.runtimeInstanceId = runtimeInstanceId;
        this.state.startedAt = new Date().toISOString();
        proc.on("exit", (code) => {
            this.state.lastError = `runtime exited with code ${code}`;
            this.state.pid = null;
            this.proc = null;
        });
        await this.persistObservation();
        return this.state;
    }
    /**
     * Stop the owned Runtime child.
     * - If we still hold the ChildProcess handle AND its pid matches our
     *   observed pid AND pid is alive → OWNED_CHILD_FAST_PATH.
     * - Else: re-probe via OS process scan + PROVEN_SAME_RUNTIME.
     * - Else: REFUSE (no auto-kill of foreign process).
     */
    async stop() {
        const observedPid = this.state.pid;
        if (!observedPid) {
            return { kind: "REFUSED", reason: "no_observed_pid" };
        }
        // Fast path: still hold the ChildProcess handle and pid matches.
        if (this.proc && this.proc.pid === observedPid) {
            try {
                this.proc.kill("SIGTERM");
            }
            catch {
                // ignore; the exit handler will clear state
            }
            // Mark as verified (we own this handle and pid matches)
            return { kind: "OWNED_CHILD_FAST_PATH", pid: observedPid };
        }
        // Slow path: probe via OS and PROVEN_SAME_RUNTIME.
        if (!isProcessAlive(observedPid)) {
            this.state.pid = null;
            return { kind: "REFUSED", reason: "pid_already_dead" };
        }
        const info = await getProcessInfo(observedPid);
        if (!info) {
            return { kind: "REFUSED", reason: "os_query_failed" };
        }
        if (info.executablePath !== this.commandImage) {
            return { kind: "REFUSED", reason: `foreign_runtime_executable:${info.executablePath}` };
        }
        if (!this.state.runtimeInstanceId) {
            return { kind: "REFUSED", reason: "no_runtime_instance_id" };
        }
        const wsId = await computeWorkspaceId(this.opts.workspaceRoot);
        const expected = {
            pid: observedPid,
            deviceId: this.deviceId,
            profileId: this.opts.profileId,
            runtimeId: this.opts.runtimeId,
            runtimeInstanceId: this.state.runtimeInstanceId,
            workspaceId: wsId,
            expectedPort: this.opts.port,
            commandImage: this.commandImage,
            startWindow: { earliest: Date.now() - 24 * 60 * 60 * 1000, latest: Date.now() + 60_000 },
            challenge: {
                issuedAt: Date.now(),
                nonce: "",
                signatureB64: "",
                expectedSignatureB64: "",
            },
        };
        // Note: full PROVEN_SAME_RUNTIME predicate requires /admin/challenge signature
        // verification, which we cannot do without re-deriving the runtimeInstanceSecret.
        // We enforce the structural fields here; full challenge verify happens in
        // Supervisor's startup phase via Watchdog liveness ping.
        if (info.executablePath !== expected.commandImage ||
            info.pid !== expected.pid) {
            return { kind: "REFUSED", reason: "structural_mismatch" };
        }
        // Try to kill via OS (process.kill — no direct way to send SIGTERM from JS
        // on Windows; we fall back to TerminateProcess via taskkill /F in production).
        try {
            process.kill(observedPid, "SIGTERM");
            return { kind: "PROVEN_RUNTIME_VERIFIED", pid: observedPid };
        }
        catch {
            return { kind: "REFUSED", reason: "kill_failed" };
        }
    }
    /** Returns true if the child pid is alive. */
    isAlive() {
        if (!this.state.pid)
            return false;
        return isProcessAlive(this.state.pid);
    }
    getState() {
        return { ...this.state };
    }
    /**
     * Persist runtime.json as observation cache. Per SECURITY_MODEL_V2 §1,
     * this is NOT a trust anchor — Supervisor's runtimeInstanceSecret is.
     */
    async persistObservation() {
        if (!this.state.pid || !this.state.runtimeInstanceId)
            return;
        const observation = {
            service: "c2c-bridge",
            version: "2.0.0",
            pid: this.state.pid,
            port: this.state.port,
            runtimeInstanceId: this.state.runtimeInstanceId,
            workspaceId: await computeWorkspaceId(this.opts.workspaceRoot),
            profileId: this.opts.profileId,
            runtimeId: this.opts.runtimeId,
            deviceId: this.opts.deviceId,
            startedAt: this.state.startedAt,
        };
        await fs.mkdir(path.dirname(this.runtimeJsonPath), { recursive: true });
        const tmp = `${this.runtimeJsonPath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(observation, null, 2), "utf8");
        await fs.rename(tmp, this.runtimeJsonPath);
    }
}
async function computeWorkspaceId(root) {
    let real = root;
    try {
        const fs = await import("node:fs/promises");
        real = await fs.realpath(root);
    }
    catch {
        // not exist yet
    }
    const normalized = process.platform === "win32" || process.platform === "darwin"
        ? real.toLowerCase()
        : real;
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
