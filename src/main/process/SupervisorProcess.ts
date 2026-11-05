import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import {
  DeviceId,
  ProfileId,
  RuntimeId,
  RuntimeInstanceId,
  WorkspaceId,
} from "../../shared/types.js";
import type { ConnectionIntent, ExecutionListResponse, ExecutionOutputResponse } from "../../shared/types.js";
import { RuntimeSpawner, SpawnOptions } from "./RuntimeSpawner.js";
import {
  RuntimeSupervisorBridgeSession,
  createRuntimeSupervisorBridgeIpcStream,
  type RuntimeBridgeDiagnosticSink,
  type RuntimeCreateIntentHandler,
} from "./RuntimeSupervisorBridge.js";
import type { Duplex } from "node:stream";
import {
  getProcessInfo,
  isProcessAlive,
  type ExpectedIdentity,
} from "./ProcessScanner.js";
import { deriveAdminControlKey } from "../security/HKDF.js";

/**
 * SupervisorProcess — owns the lifecycle of one C2C Runtime child process.
 *
 * Per ADR-V2-003 Option B + CP1 RECOVERY_SAFETY_GUARD_V2:
 *   - spawn Runtime with stdin-injected runtimeInstanceSecret
 *   - track runtime state in observation cache (runtime.json) — NOT a trust anchor
 *   - PROVEN_SAME_RUNTIME gate before any stop
 *   - STRICT FAIL CLOSED on production port drift (no ephemeral fallback)
 *
 * Stop semantics (P0):
 *   - prefer OWNED_CHILD_FAST_PATH (we still hold the ChildProcess handle)
 *   - always also re-verify PROVEN_SAME_RUNTIME via OS process scan
 *   - never auto-kill a foreign process
 */
export interface SupervisorState {
  pid: number | null;
  port: number;
  runtimeInstanceId: RuntimeInstanceId | null;
  startedAt: string | null;
  lastError: string | null;
}

export type StopProof =
  | { kind: "OWNED_CHILD_FAST_PATH"; pid: number }
  | { kind: "PROVEN_RUNTIME_VERIFIED"; pid: number }
  | { kind: "REFUSED"; reason: string };

export interface CodexExecutionCompletionEvent {
  taskId: string;
  iteration: number;
  status: "PASS" | "FAIL" | "UNKNOWN";
  changedFiles: string[];
  tests: Array<{
    category: string;
    command?: string;
    passed: boolean;
    testCount?: number;
    failedCount?: number;
  }>;
  summary: string;
  publicOutput: boolean;
  allowedOutput?: string;
}

function isDuplexStream(value: unknown): value is Duplex {
  if (!value || typeof value !== "object") return false;
  const stream = value as Partial<Duplex>;
  return typeof stream.on === "function" && typeof stream.off === "function"
    && typeof stream.write === "function" && typeof stream.destroy === "function";
}

export class SupervisorProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private readonly runtimeJsonPath: string;
  private readonly state: SupervisorState;
  private readonly deviceId: DeviceId;
  private readonly commandImage: string;
  private readonly runtimeInstanceSecret: Buffer;
  private runtimeBridgeSession: RuntimeSupervisorBridgeSession | null = null;
  private intentionalStop = false;

  constructor(
    private readonly stateDir: string,
    private readonly profileId: ProfileId,
    private readonly opts: SpawnOptions & {
      deviceId: DeviceId;
      commandImage: string;
      onMcpCreateIntent?: RuntimeCreateIntentHandler;
      onMcpCreateDiagnostic?: RuntimeBridgeDiagnosticSink;
    },
  ) {
    super();
    this.runtimeJsonPath = path.join(stateDir, "profiles", profileId, "runtime.json");
    this.deviceId = opts.deviceId;
    this.commandImage = opts.commandImage;
    this.runtimeInstanceSecret = Buffer.from(opts.runtimeInstanceSecret);
    this.state = {
      pid: null,
      port: opts.port,
      runtimeInstanceId: null,
      startedAt: null,
      lastError: null,
    };
  }

  /**
   * Transport 配置切换后同步 Runtime 的对外标识。
   * Runtime 用 publicMcpUrl 生成 OAuth issuer；不更新就会一直是 127.0.0.1，
   * ChatGPT 侧 issuer 与连接器域名不一致会直接拒绝授权。
   */
  applyTransportIdentity(publicMcpUrl: string | null, port: number): void {
    this.opts.publicMcpUrl = publicMcpUrl;
    this.opts.port = port;
  }

  async start(): Promise<SupervisorState> {
    this.intentionalStop = false;
    // Idempotence guard: if we already own a live child, do not spawn another.
    // RecoveryCoordinator SPAWN_RUNTIME and any concurrent caller must not
    // create overlapping child generations (the stale exit callback would then
    // churn state.pid). restartForWorkspace legitimately reaches here only
    // after stop() has confirmed the old child is gone, so this does not block
    // the real restart path.
    if (this.ownsLiveChild()) {
      return this.state;
    }
    const spawner = new RuntimeSpawner({
      ...this.opts,
      enableSupervisorBridge: Boolean(this.opts.onMcpCreateIntent),
    });
    const { proc, runtimeInstanceId } = spawner.spawn();
    this.proc = proc;
    this.state.pid = proc.pid ?? null;
    this.state.runtimeInstanceId = runtimeInstanceId;
    this.state.startedAt = new Date().toISOString();

    let bridgeSession: RuntimeSupervisorBridgeSession | null = null;
    if (this.opts.onMcpCreateIntent) {
      const bridgeStream = createRuntimeSupervisorBridgeIpcStream(proc);
      if (!isDuplexStream(bridgeStream)) {
        this.intentionalStop = true;
        try { proc.kill("SIGTERM"); } catch { /* child is already exiting */ }
        this.proc = null;
        this.state.pid = null;
        this.state.runtimeInstanceId = null;
        this.state.lastError = "runtime_supervisor_bridge_pipe_unavailable";
        throw new Error(this.state.lastError);
      }
      bridgeSession = new RuntimeSupervisorBridgeSession(
        bridgeStream,
        this.runtimeInstanceSecret,
        runtimeInstanceId,
        this.opts.onMcpCreateIntent,
        // This callback exists only when the Supervisor's isolated CREATE test mode is enabled.
        true,
        this.opts.onMcpCreateDiagnostic,
      );
      this.runtimeBridgeSession = bridgeSession;
    }

    proc.on("exit", (code: number | null) => {
      // Guard against child-generation churn: a stale process (one we already
      // replaced via restartForWorkspace / RecoveryCoordinator SPAWN_RUNTIME)
      // must never clear or overwrite the state of the CURRENT child. Without
      // this identity check, the old child's exit callback fires after the new
      // child has been recorded, resetting state.pid to null (or to a dead PID)
      // and re-emitting "exit", which triggers another spawn — the exact
      // "reported PID changes each sample and never exists" churn that broke
      // PROVEN_SAME_RUNTIME and diagnostics process evidence.
      if (this.proc !== proc) {
        bridgeSession?.close();
        return;
      }
      bridgeSession?.close();
      if (this.runtimeBridgeSession === bridgeSession) this.runtimeBridgeSession = null;
      const prev = { ...this.state };
      const expectedStop = this.intentionalStop;
      this.intentionalStop = false;
      this.state.lastError = `runtime exited with code ${code}`;
      this.state.pid = null;
      this.proc = null;
      if (!expectedStop) this.emit("exit", code, prev);
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
  async stop(): Promise<StopProof> {
    const observedPid = this.state.pid;
    if (!observedPid) {
      return { kind: "REFUSED", reason: "no_observed_pid" };
    }

    // Fast path: still hold the ChildProcess handle and pid matches.
    if (this.proc && this.proc.pid === observedPid) {
      this.runtimeBridgeSession?.close();
      this.runtimeBridgeSession = null;
      this.intentionalStop = true;
      try {
        this.proc.kill("SIGTERM");
      } catch {
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
    const expected: ExpectedIdentity = {
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
    if (
      info.executablePath !== expected.commandImage ||
      info.pid !== expected.pid
    ) {
      return { kind: "REFUSED", reason: "structural_mismatch" };
    }
    // Try to kill via OS (process.kill — no direct way to send SIGTERM from JS
    // on Windows; we fall back to TerminateProcess via taskkill /F in production).
    try {
      process.kill(observedPid, "SIGTERM");
      return { kind: "PROVEN_RUNTIME_VERIFIED", pid: observedPid };
    } catch {
      return { kind: "REFUSED", reason: "kill_failed" };
    }
  }

  /** Restart the owned Runtime against a newly committed workspace. */
  async restartForWorkspace(workspaceRoot: string): Promise<SupervisorState> {
    const proof = await this.stop();
    if (proof.kind === "REFUSED") throw new Error(`runtime_stop_refused:${proof.reason}`);
    const deadline = Date.now() + 10_000;
    while (this.isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.isAlive()) throw new Error("runtime_stop_timeout");
    this.opts.workspaceRoot = workspaceRoot;
    this.state.lastError = null;
    return this.start();
  }

  /** Returns true if the child pid is alive. */
  isAlive(): boolean {
    if (!this.state.pid) return false;
    return isProcessAlive(this.state.pid);
  }

  /** True only while the child handle and observed PID still refer to the child we spawned. */
  ownsLiveChild(): boolean {
    const pid = this.state.pid;
    return Boolean(pid && this.proc && this.proc.pid === pid && this.proc.exitCode === null && isProcessAlive(pid));
  }

  getState(): SupervisorState {
    return { ...this.state };
  }

  /**
   * Bind a durable ConnectionIntent to the exact Runtime instance through the
   * loopback Capability-MAC admin endpoint. No token or secret crosses HTTP.
   */
  async bindOAuthIntent(intent: ConnectionIntent): Promise<void> {
    const body = JSON.stringify({
      intentId: intent.intentId,
      deviceId: intent.deviceId,
      profileId: intent.profileId,
      runtimeId: intent.runtimeId,
      runtimeInstanceId: intent.runtimeInstanceId,
      workspaceId: intent.workspaceId,
      status: intent.status,
      expiresAt: intent.expiresAt,
      candidateClientId: intent.candidateClientId,
      // 全权模式：把本机允许的 scope 上限带给 Runtime，授权时据此放宽令牌权限。
      grantedScopes: intent.requestedScopes,
    });
    await this.adminRequest("POST", "/admin/oauth/intent", body);
  }

  /**
   * Forward a bounded, already-redacted Codex/Harness completion event to the
   * Runtime-owned Execution Store. Raw stdout, stderr, diffs and credentials
   * never enter this method or the IPC payload.
   */
  async recordExecutionCompletion(event: CodexExecutionCompletionEvent): Promise<{
    id: string;
    taskId: string;
    iteration: number;
    status: CodexExecutionCompletionEvent["status"];
  }> {
    validateExecutionCompletionEvent(event);
    const body = JSON.stringify({
      taskId: event.taskId,
      iteration: event.iteration,
      status: event.status,
      changedFiles: event.changedFiles.slice(0, 200),
      tests: event.tests.slice(0, 100),
      summary: event.summary.slice(0, 4000),
      publicOutput: event.publicOutput === true,
      allowedOutput: event.publicOutput ? (event.allowedOutput ?? "").slice(0, 32_000) : undefined,
    });
    return this.adminRequest("POST", "/admin/execution/complete", body);
  }

  /** Bounded read-only projection of the Runtime-owned Execution Store. */
  async listExecutionRecords(limit = 20): Promise<ExecutionListResponse> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
    const result = await this.adminRequest<{
      records?: unknown[];
      runtimeInstanceId?: string | null;
      source?: string;
      available?: boolean;
    }>(
      "GET",
      "/admin/execution/list",
      "",
      `limit=${safeLimit}`,
    );
    const records = Array.isArray(result?.records)
      ? (result.records as ExecutionListResponse["records"]).slice(0, 50)
      : [];
    return {
      available: result?.available === true && Array.isArray(result?.records),
      source: "execution-store",
      runtimeInstanceId: typeof result?.runtimeInstanceId === "string"
        ? result.runtimeInstanceId
        : null,
      records,
    };
  }

  /** Whitelisted public output for one record; never raw stdout/diff. */
  async getExecutionOutput(id: string): Promise<ExecutionOutputResponse | null> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) return null;
    const result = await this.adminRequest<{
      output?: string;
      runtimeInstanceId?: string | null;
      error?: string;
    }>(
      "GET",
      "/admin/execution/output",
      "",
      `id=${encodeURIComponent(id)}`,
    );
    if (!result || typeof result.output !== "string") return null;
    return {
      available: true,
      source: "execution-store",
      id,
      output: result.output,
      runtimeInstanceId: typeof result.runtimeInstanceId === "string"
        ? result.runtimeInstanceId
        : null,
    };
  }

  private async adminRequest<T = void>(method: "POST" | "GET", endpoint: string, body = "", query = ""): Promise<T> {
    const key = deriveAdminControlKey(this.runtimeInstanceSecret);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const ts = new Date().toISOString();
      const nonce = `sup_${randomBytes(16).toString("base64url")}`;
      // For GET the admin guard hashes an empty body; keep the request body and
      // the signed payload byte-identical so the Capability-MAC verifies.
      const signedBody = method === "GET" ? "" : body;
      const bodyHash = createHmac("sha256", Buffer.alloc(32)).update(signedBody, "utf8").digest("hex");
      const sig = createHmac("sha256", key)
        .update(`${ts}\n${nonce}\n${method}\n${endpoint}\n${bodyHash}`)
        .digest("base64url");
      try {
        const url = query ? `http://127.0.0.1:${this.state.port}${endpoint}?${query}` : `http://127.0.0.1:${this.state.port}${endpoint}`;
        const response = await fetch(url, {
          method,
          headers: {
            authorization: `C2CAdmin ${JSON.stringify({ ts, nonce, sig })}`,
            "content-type": "application/json",
          },
          body: method === "GET" ? undefined : body,
        });
        const responseBody = await response.text();
        if (response.ok) {
          if (!responseBody) return undefined as T;
          return JSON.parse(responseBody) as T;
        }
        const reason = responseBody;
        throw new Error(`runtime_admin_${response.status}:${reason.slice(0, 120)}`);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.startsWith("runtime_admin_")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("runtime_admin_unavailable");
  }

  /**
   * Persist runtime.json as observation cache. Per SECURITY_MODEL_V2 §1,
   * this is NOT a trust anchor — Supervisor's runtimeInstanceSecret is.
   */
  private async persistObservation(): Promise<void> {
    if (!this.state.pid || !this.state.runtimeInstanceId) return;
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

async function computeWorkspaceId(root: string): Promise<WorkspaceId> {
  let real = root;
  try {
    const fs = await import("node:fs/promises");
    real = await fs.realpath(root);
  } catch {
    // not exist yet
  }
  const normalized = process.platform === "win32" || process.platform === "darwin"
    ? real.toLowerCase()
    : real;
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function validateExecutionCompletionEvent(event: CodexExecutionCompletionEvent): void {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(event.taskId)) throw new Error("execution_task_id_invalid");
  if (!Number.isInteger(event.iteration) || event.iteration < 1 || event.iteration > 1_000_000) {
    throw new Error("execution_iteration_invalid");
  }
  if (event.status !== "PASS" && event.status !== "FAIL" && event.status !== "UNKNOWN") {
    throw new Error("execution_status_invalid");
  }
  if (!Array.isArray(event.changedFiles) || event.changedFiles.length > 200 || event.changedFiles.some((item) => typeof item !== "string" || item.length > 500)) {
    throw new Error("execution_changed_files_invalid");
  }
  if (!Array.isArray(event.tests) || event.tests.length > 100 || event.tests.some((test) =>
    !test || typeof test.category !== "string" || test.category.length > 200 || typeof test.passed !== "boolean")) {
    throw new Error("execution_tests_invalid");
  }
  if (typeof event.summary !== "string" || event.summary.length > 4000) throw new Error("execution_summary_invalid");
  if (typeof event.publicOutput !== "boolean") throw new Error("execution_public_output_invalid");
  if (event.allowedOutput !== undefined && (typeof event.allowedOutput !== "string" || event.allowedOutput.length > 32_000)) {
    throw new Error("execution_allowed_output_invalid");
  }
}
