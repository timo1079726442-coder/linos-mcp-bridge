/**
 * Watchdog — independent per-user background process.
 *
 * Per ADR-V2-003 Option B + CP1 ARCHITECTURE_V2 §1.1:
 *   - Bidirectional Liveness: Watchdog ↔ Supervisor heartbeat over Named Pipe
 *   - Restart Budget persisted to disk (survives restart)
 *   - Exponential backoff (1s → 2s → 4s → 8s → 16s → 30s max)
 *   - 24h window: max 3 restarts → LOOP_GUARD
 *
 * Invocation: node c2c-watchdog.js [state-root]
 */
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import { DeviceIdentity } from "../main/profile/DeviceIdentity.js";
import { getProcessInfo, isProcessAlive } from "../main/process/ProcessScanner.js";
import { AuditChain } from "../main/audit/AuditChain.js";
const STATE_ROOT = process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "linos-c2c-control-center");
const BUDGET_FILE = path.join(STATE_ROOT, "restart-budget.json");
const PIPE_NAME = `\\\\.\\pipe\\C2CWatchdog-${Date.now().toString(36)}`;
const SUPERVISOR_PIPE_FROM_FILE = path.join(STATE_ROOT, "supervisor-pipe.txt");
async function readBudget() {
    try {
        const raw = await fs.readFile(BUDGET_FILE, "utf8");
        const b = JSON.parse(raw);
        // 24h window reset
        if (Date.now() - b.windowStartedAt > 24 * 60 * 60 * 1000) {
            return { windowStartedAt: Date.now(), supervisor: 0, watchdog: 0 };
        }
        return b;
    }
    catch {
        return { windowStartedAt: Date.now(), supervisor: 0, watchdog: 0 };
    }
}
async function writeBudget(b) {
    await fs.mkdir(STATE_ROOT, { recursive: true });
    await fs.writeFile(BUDGET_FILE, JSON.stringify(b, null, 2), "utf8");
}
async function consumeBudget(side) {
    const b = await readBudget();
    b[side] += 1;
    await writeBudget(b);
    return { remaining: Math.max(0, 3 - b[side]), loopGuard: b[side] >= 3 };
}
function exponentialBackoff(attempt) {
    // 1s, 2s, 4s, 8s, 16s, 30s (capped)
    return Math.min(30_000, 1000 * Math.pow(2, attempt));
}
async function readSupervisorPipe() {
    try {
        const p = await fs.readFile(SUPERVISOR_PIPE_FROM_FILE, "utf8");
        return p.trim() || null;
    }
    catch {
        return null;
    }
}
async function discoverSupervisor() {
    const pipe = await readSupervisorPipe();
    if (!pipe)
        return null;
    // Search for a Supervisor process that holds this pipe.
    // For now, return null; the supervisor's IPC server announces its pipe via
    // shared state file. We treat the watcher as a sidecar started after the
    // Supervisor, so the pipe is discovered lazily via PID scan.
    const candidates = [process.ppid].filter((p) => p && p > 1);
    for (const pid of candidates) {
        if (!isProcessAlive(pid))
            continue;
        const info = await getProcessInfo(pid);
        if (!info)
            continue;
        if (/c2c[-_]supervisor/i.test(info.cmdline) || /c2c-supervisor/i.test(info.executablePath)) {
            return { pipe, pid };
        }
    }
    return { pipe, pid: 0 };
}
class WatchdogClient {
    pipeName;
    socket = null;
    connected = false;
    lastPingAt = 0;
    pendingId = 1;
    callbacks = new Map();
    constructor(pipeName) {
        this.pipeName = pipeName;
    }
    async connect() {
        return new Promise((resolve) => {
            const sock = net.createConnection(this.pipeName, () => {
                this.socket = sock;
                this.connected = true;
                resolve(true);
            });
            sock.on("error", () => resolve(false));
            sock.on("close", () => {
                this.connected = false;
                this.socket = null;
                for (const cb of this.callbacks.values()) {
                    cb({ ok: false, error: "socket_closed" });
                }
                this.callbacks.clear();
            });
            sock.on("data", (chunk) => {
                this.handleData(chunk.toString("utf8"));
            });
            setTimeout(() => {
                if (!this.connected)
                    resolve(false);
            }, 3000);
        });
    }
    isConnected() {
        return this.connected;
    }
    async call(method, params = {}) {
        if (!this.socket)
            throw new Error("watchdog_not_connected");
        const id = this.pendingId++;
        const req = JSON.stringify({ id, method, params }) + "\n";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.callbacks.delete(id);
                reject(new Error("watchdog_call_timeout"));
            }, 5000);
            this.callbacks.set(id, (response) => {
                clearTimeout(timer);
                const r = response;
                if (r.ok)
                    resolve(r.data);
                else
                    reject(new Error(r.error ?? "watchdog_call_failed"));
            });
            this.socket.write(req);
        });
    }
    handleData(raw) {
        for (const line of raw.split("\n")) {
            if (!line.trim())
                continue;
            try {
                const r = JSON.parse(line);
                const cb = this.callbacks.get(r.id);
                if (cb) {
                    this.callbacks.delete(r.id);
                    cb(r);
                }
            }
            catch {
                // ignore malformed
            }
        }
    }
}
async function main() {
    await fs.mkdir(STATE_ROOT, { recursive: true });
    // Initialize persistent budget file (default = empty budget).
    try {
        await readBudget();
    }
    catch {
        await writeBudget({ windowStartedAt: Date.now(), supervisor: 0, watchdog: 0 });
    }
    const device = new DeviceIdentity(STATE_ROOT);
    await device.getDeviceId();
    const audit = new AuditChain(STATE_ROOT, "mb_pf_diag");
    await audit.open();
    console.log(JSON.stringify({
        event: "watchdog:boot",
        stateRoot: STATE_ROOT,
        pipe: PIPE_NAME,
        pid: process.pid,
        ppid: process.ppid,
    }));
    let supervisorPipe = await readSupervisorPipe();
    let supervisorClient = null;
    let supervisorPid = 0;
    let restartAttempt = 0;
    let lastSupervisorSeenAt = Date.now();
    async function connectSupervisor() {
        if (!supervisorPipe) {
            const discovered = await discoverSupervisor();
            if (discovered) {
                supervisorPipe = discovered.pipe;
                supervisorPid = discovered.pid;
            }
        }
        if (!supervisorPipe)
            return false;
        supervisorClient = new WatchdogClient(supervisorPipe);
        const ok = await supervisorClient.connect();
        if (ok) {
            lastSupervisorSeenAt = Date.now();
            await audit.append({ event: "WATCHDOG_SUPERVISOR_CONNECTED", pipe: supervisorPipe, supervisorPid });
            return true;
        }
        supervisorClient = null;
        return false;
    }
    async function superviseSupervisor() {
        if (!supervisorClient) {
            const ok = await connectSupervisor();
            if (!ok) {
                const budget = await consumeBudget("supervisor");
                console.log(JSON.stringify({ event: "watchdog:supervisor_missing", budget }));
                if (!budget.loopGuard) {
                    await audit.append({ event: "WATCHDOG_SUPERVISOR_RESTART_INITIATED", attempt: restartAttempt });
                    // Real restart logic: spawn new Supervisor via saved launcher path.
                    // For now, exponential backoff.
                    const wait = exponentialBackoff(restartAttempt);
                    restartAttempt++;
                    await new Promise((r) => setTimeout(r, wait));
                    await superviseSupervisor();
                }
                else {
                    await audit.append({ event: "WATCHDOG_LOOP_GUARD", side: "supervisor" });
                    console.log(JSON.stringify({ event: "watchdog:loop_guard", side: "supervisor" }));
                }
                return;
            }
            restartAttempt = 0;
        }
        // Liveness ping
        try {
            await supervisorClient.call("watchdog.heartbeat");
            lastSupervisorSeenAt = Date.now();
        }
        catch {
            // Connection dropped; reconnect next tick
            supervisorClient = null;
        }
        if (Date.now() - lastSupervisorSeenAt > 30_000) {
            const budget = await consumeBudget("supervisor");
            console.log(JSON.stringify({ event: "watchdog:supervisor_stale", budget }));
        }
    }
    // Tick loop: every 5s
    setInterval(() => {
        void superviseSupervisor();
    }, 5_000);
    // Also have the Supervisor monitor us via our own Named Pipe + heartbeat
    // (the inverse direction is implemented as Supervisor calling our endpoint;
    // for CP10 the Supervisor in-process will poll us via the IPC bridge instead).
    // We expose a Named Pipe server for legacy / future Supervisor binaries.
    const server = net.createServer((socket) => {
        let buf = "";
        socket.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line)
                    continue;
                try {
                    const req = JSON.parse(line);
                    // We currently only support heartbeat reverse-ping.
                    if (req.method === "watchdog.ping") {
                        socket.write(JSON.stringify({ id: req.id, ok: true, data: { alive: true, ts: Date.now() } }) + "\n");
                    }
                    else {
                        socket.write(JSON.stringify({ id: req.id, ok: false, error: "unknown_method" }) + "\n");
                    }
                }
                catch {
                    // ignore
                }
            }
        });
    });
    server.listen(PIPE_NAME, () => {
        console.log(JSON.stringify({ event: "watchdog:listening", pipe: PIPE_NAME }));
    });
    // Initial connection
    void superviseSupervisor();
    // Re-redact on shutdown
    process.on("SIGINT", async () => {
        await audit.append({ event: "WATCHDOG_SHUTDOWN" });
        process.exit(0);
    });
    process.on("SIGTERM", async () => {
        await audit.append({ event: "WATCHDOG_SHUTDOWN" });
        process.exit(0);
    });
}
main().catch((e) => {
    console.error("watchdog FATAL:", e);
    process.exit(1);
});
