import * as net from "node:net";
import {
  createSupervisorRequestAuthorization,
  createSupervisorRpcNonce,
  createSupervisorRpcProof,
  deriveSupervisorRpcSessionKey,
  supervisorMethodRequiresAuthorization,
  SUPERVISOR_RPC_AUTH_KIND,
  SUPERVISOR_RPC_AUTH_OK_KIND,
  SUPERVISOR_RPC_CHALLENGE_KIND,
  verifySupervisorRpcAuthOkProof,
  verifySupervisorRpcResponseFrame,
} from "./SupervisorRequestAuth.js";
import type { SupervisorRequestAuthorization } from "./SupervisorRequestAuth.js";
import { promises as fs } from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";

/**
 * SupervisorClient — typed JSON-RPC client to the Supervisor process.
 *
 * Per ADR-V2-002 + CP1 SECURITY_MODEL_V2 §3:
 *   - Connects over Named Pipe \\.\pipe\C2CSupervisor-<id>
 *   - Single connection per session; lazy reconnect on failure
 *   - Auto-spawns Supervisor if not running (single-instance lock aware)
 *
 * Production: NO SupervisorStub fallback. If real Supervisor fails to
 * start, this client surfaces clear errors; UI must show MANUAL.
 */
export interface SupervisorOptions {
  stateRoot: string;
  /** Path to Supervisor entry (built artifact). */
  supervisorEntry: string;
  /** Pipe name to connect to (defaults to lookup from supervisor-pipe.txt). */
  pipeName?: string;
  /** DPAPI-backed V2 root key provider; never return a plaintext-disk key. */
  sessionRootKeyProvider: () => Promise<Buffer>;
}

export interface SupervisorCallOptions {
  method: string;
  params?: unknown;
  /** Per-call timeout. */
  timeoutMs?: number;
}

export class SupervisorClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; sequence: number }>();
  private nextId = 1;
  private buf = "";
  private alive = false;
  private supervisorProc: ChildProcess | null = null;
  private requestSessionKey: Buffer | null = null;
  private requestNonce = 0;
  private sessionRootKey: Buffer | null = null;
  /**
   * Single-flight guard for connect/handshake. `alive` is only flipped once the
   * handshake resolves, so without this every concurrent caller would observe
   * `alive === false`, run its own handshake, and overwrite `this.socket`.
   * That produced multiple live connections whose request sequences each
   * restarted at 1, which the Supervisor rejects as out-of-order
   * (sequence !== lastRequestSequence + 1) and answers by destroying the pipe.
   */
  private connectInFlight: Promise<void> | null = null;

  constructor(private readonly opts: SupervisorOptions) {}

  isAlive(): boolean {
    return this.alive;
  }

  /** Ensure Supervisor is running, connect if needed. */
  async ensureConnected(): Promise<void> {
    if (this.alive) return;
    // Concurrent callers must share one connect/handshake attempt, otherwise
    // each one replaces `this.socket` and the per-connection request sequence
    // is restarted by whichever handshake lands last.
    if (!this.connectInFlight) {
      const attempt = this.connectInternal();
      this.connectInFlight = attempt;
      void attempt.finally(() => {
        if (this.connectInFlight === attempt) this.connectInFlight = null;
      }).catch(() => undefined);
    }
    return this.connectInFlight;
  }

  private async connectInternal(): Promise<void> {
    if (this.alive) return;
    if (!this.sessionRootKey) {
      const key = await this.opts.sessionRootKeyProvider();
      if (key.length !== 32) throw new Error("supervisor_auth_root_key_invalid");
      this.sessionRootKey = Buffer.from(key);
    }
    if (!this.opts.pipeName) {
      const fromFile = await this.readPipeFile();
      if (fromFile) this.opts.pipeName = fromFile;
    }
    if (this.opts.pipeName) {
      try {
        await this.connect();
        return;
      } catch (error) {
        // A stale pipe publication must not block recovery. The Supervisor
        // process is allowed to be gone while its observation file remains.
        this.opts.pipeName = undefined;
        await this.close();
        if (error instanceof Error && error.message.startsWith("supervisor_auth_")) throw error;
      }
    }
    await this.spawnSupervisor();
    // After spawn, the Supervisor writes its pipe name to supervisor-pipe.txt.
    for (let i = 0; i < 75; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const p = await this.readPipeFile();
      if (p) {
        this.opts.pipeName = p;
        break;
      }
    }
    if (!this.opts.pipeName) throw new Error("supervisor_pipe_not_published");
    await this.connect();
  }

  async call<T = unknown>(opts: SupervisorCallOptions): Promise<T> {
    const retryableRead = /^(ping|readiness\.get|diagnostics\.fault-cases\.list|diagnostics\.repair-history\.list|profile\.list|profile\.get-active|workspace\.validate|workspace\.detect|intent\.list)$/.test(opts.method);
    let attempt = 0;
    while (true) {
      try {
        return await this.callOnce<T>(opts);
      } catch (error) {
        if (!retryableRead || attempt > 0 || !(error instanceof Error) || error.message !== "supervisor_connection_closed") {
          throw error;
        }
        attempt += 1;
        // A Runtime workspace restart can briefly close the control pipe. A
        // read-only call may safely reconnect once; mutating calls never do.
        await this.close();
      }
    }
  }

  private async callOnce<T = unknown>(opts: SupervisorCallOptions): Promise<T> {
    await this.ensureConnected();
    const id = String(this.nextId++);
    const params = opts.params ?? {};
    // Sequence allocation and the socket write must happen without an await in
    // between: the Supervisor enforces sequence === lastRequestSequence + 1 in
    // the order bytes arrive, and the signed authorization nonce must stay
    // monotonically increasing. Any interleaving here desynchronises the two.
    const socket = this.socket;
    if (!socket) throw new Error("supervisor_connection_closed");
    const sequence = ++this.requestNonce;
    let authorization: SupervisorRequestAuthorization | undefined;
    if (supervisorMethodRequiresAuthorization(opts.method)) {
      if (!this.requestSessionKey) throw new Error("supervisor_auth_session_unavailable");
      authorization = createSupervisorRequestAuthorization(this.requestSessionKey, { id, method: opts.method, params }, sequence);
    }
    const payload = JSON.stringify({ id, sequence, method: opts.method, params, ...(authorization ? { authorization } : {}) }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`supervisor_call_timeout:${opts.method}`));
      }, opts.timeoutMs ?? 10_000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sequence });
      socket.write(payload);
    });
  }

  async close(): Promise<void> {
    // Drop any in-flight connect attempt so the next caller performs a fresh
    // handshake instead of observing a resolved promise for a dead socket.
    this.connectInFlight = null;
    if (this.socket) {
      try { this.socket.end(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.requestSessionKey = null;
    this.requestNonce = 0;
    this.alive = false;
  }

  /** For Supervisor process exit handling. */
  on(event: "exit" | "error", cb: () => void): void {
    this.exitCallbacks[event] = cb;
  }
  private exitCallbacks: Record<string, (() => void) | undefined> = {};

  private async connect(): Promise<void> {
    if (!this.opts.pipeName) throw new Error("supervisor_pipe_unknown");
    const rootKey = this.sessionRootKey;
    if (!rootKey) throw new Error("supervisor_auth_session_unavailable");
    const target: string = this.opts.pipeName;
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(target);
      let settled = false;
      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        sock.destroy();
        reject(error);
      };
      const connectTimer = setTimeout(() => finishError(new Error("supervisor_connect_timeout")), 5000);
      const onConnectError = (error: Error): void => finishError(error);
      const onConnectClose = (): void => finishError(new Error("supervisor_connection_closed"));
      sock.once("error", onConnectError);
      sock.once("close", onConnectClose);
      sock.once("connect", () => {
        sock.off("error", onConnectError);
        sock.off("close", onConnectClose);
        void this.performHandshake(sock, rootKey).then((sessionKey) => {
          if (settled) return;
          settled = true;
          clearTimeout(connectTimer);
          sock.off("error", onConnectError);
          sock.off("close", onConnectClose);
          this.socket = sock;
          this.buf = "";
          this.requestSessionKey = sessionKey;
          this.requestNonce = 0;
          this.alive = true;
          this.attachSocketHandlers(sock);
          resolve();
        }).catch((error: unknown) => {
          finishError(error instanceof Error ? error : new Error("supervisor_auth_handshake_failed"));
        });
      });
    });
  }

  private performHandshake(socket: net.Socket, rootKey: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let buffer = "";
      let phase: "CHALLENGE" | "AUTH_OK" = "CHALLENGE";
      let sessionKey: Buffer | null = null;
      let serverChallenge: string | null = null;
      let clientNonce: string | null = null;
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const fail = (code: string): void => {
        cleanup();
        reject(new Error(code));
      };
      const onError = (): void => fail("supervisor_auth_handshake_failed");
      const onClose = (): void => fail("supervisor_auth_handshake_closed");
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 8192) return fail("supervisor_auth_frame_too_large");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let frame: { kind?: unknown; challenge?: unknown; proof?: unknown };
          try { frame = JSON.parse(line) as { kind?: unknown; challenge?: unknown }; }
          catch { return fail("supervisor_auth_frame_invalid"); }
          if (phase === "CHALLENGE") {
            if (frame.kind !== SUPERVISOR_RPC_CHALLENGE_KIND || typeof frame.challenge !== "string") return fail("supervisor_auth_challenge_invalid");
            try {
              serverChallenge = frame.challenge;
              clientNonce = createSupervisorRpcNonce();
              sessionKey = deriveSupervisorRpcSessionKey(rootKey, serverChallenge, clientNonce);
              const proof = createSupervisorRpcProof(rootKey, serverChallenge, clientNonce);
              socket.write(JSON.stringify({ kind: SUPERVISOR_RPC_AUTH_KIND, clientNonce, proof }) + "\n");
              phase = "AUTH_OK";
            } catch {
              return fail("supervisor_auth_challenge_invalid");
            }
          } else {
            if (frame.kind !== SUPERVISOR_RPC_AUTH_OK_KIND || typeof frame.proof !== "string" || !sessionKey || !serverChallenge || !clientNonce ||
                !verifySupervisorRpcAuthOkProof(sessionKey, serverChallenge, clientNonce, frame.proof)) {
              return fail("supervisor_auth_server_proof_invalid");
            }
            const result = sessionKey;
            cleanup();
            resolve(result);
            return;
          }
        }
      };
      const timer = setTimeout(() => fail("supervisor_auth_handshake_timeout"), 3000);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  private attachSocketHandlers(socket: net.Socket): void {
    socket.on("error", () => {
      if (this.socket !== socket) return;
      this.alive = false;
      this.requestSessionKey = null;
      this.requestNonce = 0;
      this.exitCallbacks.error?.();
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.alive = false;
      this.socket = null;
      this.requestSessionKey = null;
      this.requestNonce = 0;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("supervisor_connection_closed"));
        this.pending.delete(id);
      }
      this.exitCallbacks.error?.();
    });
    socket.on("data", (chunk) => this.handleData(chunk.toString("utf8")));
  }

  private handleData(raw: string): void {
    this.buf += raw;
    if (this.buf.length > 4 * 1024 * 1024) {
      this.failAuthenticatedResponse();
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as unknown;
        if (!verifySupervisorRpcResponseFrame(this.requestSessionKey, frame)) {
          this.failAuthenticatedResponse();
          return;
        }
        const r = JSON.parse(frame.payload) as { id?: unknown; sequence?: unknown; ok?: unknown; data?: unknown; error?: unknown };
        if (typeof r.id !== "string" || r.sequence !== frame.sequence || frame.sequence > this.requestNonce || typeof r.ok !== "boolean" ||
            (r.error !== undefined && typeof r.error !== "string")) {
          this.failAuthenticatedResponse();
          return;
        }
        const p = this.pending.get(r.id);
        if (p) {
          if (p.sequence !== frame.sequence) {
            this.failAuthenticatedResponse();
            return;
          }
          this.pending.delete(r.id);
          clearTimeout(p.timer);
          if (r.ok) p.resolve(r.data);
          else p.reject(new Error(typeof r.error === "string" ? r.error : "supervisor_call_failed"));
        }
      } catch {
        this.failAuthenticatedResponse();
        return;
      }
    }
  }

  private failAuthenticatedResponse(): void {
    const error = new Error("supervisor_auth_response_invalid");
    this.alive = false;
    this.requestSessionKey = null;
    this.requestNonce = 0;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.socket?.destroy();
  }

  private async readPipeFile(): Promise<string | null> {
    try {
      const p = path.join(this.opts.stateRoot, "supervisor-pipe.txt");
      const raw = await fs.readFile(p, "utf8");
      const value = raw.trim();
      const prefix = "\\\\.\\pipe\\C2CSupervisor-";
      return value.startsWith(prefix) && /^[a-f0-9]+$/i.test(value.slice(prefix.length)) ? value : null;
    } catch {
      return null;
    }
  }

  private async spawnSupervisor(): Promise<void> {
    if (this.supervisorProc) return;
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      C2C_SUPERVISOR_AUTOSTART: "1",
    };
    // Electron's process.execPath points to electron.exe rather than node.exe.
    // Keep the packaged entrypoint intact, but ask the same executable to run
    // the Supervisor as a Node child so the real Electron lifecycle matches
    // the standalone evidence path.
    if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = "1";
    const sessionKey = this.sessionRootKey;
    if (!sessionKey) throw new Error("supervisor_auth_session_unavailable");
    const child = spawn(
      process.execPath,
      [this.opts.supervisorEntry, this.opts.stateRoot],
      {
        cwd: this.opts.stateRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: childEnv,
      },
    );
    this.supervisorProc = child;
    child.stdin?.end(JSON.stringify({ kind: "C2C_MAIN_SESSION_V1", key: sessionKey.toString("base64url") }) + "\n");
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.on("exit", (code, signal) => {
      if (process.env.C2C_TRACE_SUPERVISOR === "1") {
        console.error(`SUPERVISOR_EXIT code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrTail.replaceAll(/[\r\n]+/g, " ").slice(-1000)}`);
      }
      if (this.supervisorProc === child) {
        this.supervisorProc = null;
        this.requestSessionKey = null;
        this.requestNonce = 0;
      }
      this.alive = false;
      this.exitCallbacks.exit?.();
    });
  }
}
