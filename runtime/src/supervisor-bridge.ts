import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Duplex } from "node:stream";
import type {
  McpCreateIntentBridge,
  McpCreateIntentRequest,
  McpCreateIntentResult,
  McpUpdateIntentRequest,
} from "./mcp-tools.js";
import { deriveRuntimeSupervisorBridgeKey } from "./capability.js";

export const RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL = "c2c.runtime-supervisor.v1";
export const RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND = "c2c.runtime-supervisor-bridge.frame.v1";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 8;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_TIMED_OUT_RESPONSES = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Open the authenticated IPC channel allocated at stdio index 3. */
export function openRuntimeSupervisorBridgeStream(diagnosticSink?: BridgeDiagnosticSink): Duplex | undefined {
  const send = process.send;
  if (process.env.C2C_RUNTIME_SUPERVISOR_BRIDGE_FD !== "3"
    || !process.connected || typeof send !== "function") return undefined;

  const queued: Buffer[] = [];
  let queuedBytes = 0;
  let bridge: Duplex;
  const drain = (): void => {
    if (!bridge || bridge.destroyed) return;
    while (queued.length > 0) {
      const next = queued.shift()!;
      queuedBytes = Math.max(0, queuedBytes - next.byteLength);
      if (!bridge.push(next)) return;
    }
  };
  bridge = new Duplex({
    read: drain,
    write(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const correlationId = getFrameCorrelationId(bytes);
      const startedAt = Date.now();
      reportBridgeDiagnostic(diagnosticSink, "runtime_fd3_write_started", correlationId, 0);
      try {
        send.call(process, { kind: RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND, data: bytes.toString("utf8") }, (error?: Error | null) => {
          if (error) {
            reportBridgeDiagnostic(diagnosticSink, "runtime_fd3_write_failed", correlationId, Date.now() - startedAt, "BRIDGE_WRITE_FAILED");
            callback(error);
            return;
          }
          reportBridgeDiagnostic(diagnosticSink, "runtime_fd3_write_completed", correlationId, Date.now() - startedAt);
          callback();
        });
      } catch (error) {
        reportBridgeDiagnostic(diagnosticSink, "runtime_fd3_write_failed", correlationId, Date.now() - startedAt, "BRIDGE_WRITE_FAILED");
        callback(error instanceof Error ? error : new Error("runtime_supervisor_bridge_write_failed"));
      }
    },
  });
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      bridge.destroy(new Error("runtime_supervisor_bridge_ipc_message_invalid"));
      return;
    }
    const frame = message as Record<string, unknown>;
    if (Object.keys(frame).sort().join(",") !== "data,kind"
      || frame.kind !== RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND || typeof frame.data !== "string"
      || Buffer.byteLength(frame.data, "utf8") > MAX_FRAME_BYTES + 1
      || queuedBytes + Buffer.byteLength(frame.data, "utf8") > MAX_FRAME_BYTES * MAX_PENDING_REQUESTS) {
      bridge.destroy(new Error("runtime_supervisor_bridge_ipc_message_invalid"));
      return;
    }
    const bytes = Buffer.from(frame.data, "utf8");
    queued.push(bytes);
    queuedBytes += bytes.byteLength;
    drain();
  };
  const onDisconnect = (): void => { bridge.push(null); };
  process.on("message", onMessage);
  process.on("disconnect", onDisconnect);
  bridge.once("close", () => {
    process.off("message", onMessage);
    process.off("disconnect", onDisconnect);
    if (process.connected) process.disconnect();
  });
  return bridge;
}

interface PendingRequest {
  nonce: string;
  correlationId: string;
  startedAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: McpCreateIntentResult) => void;
  reject: (error: Error) => void;
}

interface TimedOutRequest {
  nonce: string;
  correlationId: string;
  startedAt: number;
}

type BridgeDiagnosticEvent = {
  stage: string;
  correlationId: string;
  elapsedMs: number;
  errorCode?: string;
};

type BridgeDiagnosticSink = (event: BridgeDiagnosticEvent) => void;

function getFrameCorrelationId(bytes: Buffer): string {
  try {
    const frame = JSON.parse(bytes.toString("utf8")) as { runtimeInstanceId?: unknown; sequence?: unknown };
    if (typeof frame.runtimeInstanceId === "string" && Number.isSafeInteger(frame.sequence)) {
      return `${frame.runtimeInstanceId}:${frame.sequence}`;
    }
  } catch { /* malformed frame diagnostics stay uncorrelated */ }
  return "unavailable";
}

function reportBridgeDiagnostic(
  sink: BridgeDiagnosticSink | undefined,
  stage: string,
  correlationId: string,
  elapsedMs: number,
  errorCode?: string,
): void {
  if (!sink) return;
  try {
    sink({ stage, correlationId, elapsedMs: Math.max(0, Math.round(elapsedMs)), ...(errorCode ? { errorCode } : {}) });
  } catch { /* diagnostics must not affect fd 3 transport */ }
}

interface ResponseFrame {
  protocol: string;
  runtimeInstanceId: string;
  sequence: number;
  timestamp: number;
  nonce: string;
  payload: unknown;
  mac: string;
}

export class RuntimeSupervisorBridgeClient implements McpCreateIntentBridge {
  private readonly key: Buffer;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timedOut = new Map<number, TimedOutRequest>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly stream: Duplex,
    secret: Buffer,
    private readonly runtimeInstanceId: string,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly diagnosticsEnabled = false,
    private readonly diagnosticSink?: BridgeDiagnosticSink,
  ) {
    if (secret.byteLength < 32 || !isRuntimeInstanceId(runtimeInstanceId)
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) {
      throw new Error("runtime_supervisor_bridge_configuration_invalid");
    }
    this.key = deriveRuntimeSupervisorBridgeKey(secret);
    stream.on("data", this.onData);
    stream.on("error", this.onStreamFailure);
    stream.on("end", this.onStreamFailure);
    stream.on("close", this.onStreamFailure);
  }

  requestCreateIntent(request: McpCreateIntentRequest): Promise<McpCreateIntentResult> {
    if (this.closed || this.stream.destroyed || !this.stream.writable) {
      return Promise.reject(new Error("runtime_supervisor_bridge_unavailable"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS || this.sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error("runtime_supervisor_bridge_capacity_exceeded"));
    }
    if (!isCreateIntentRequest(request)) {
      return Promise.reject(new Error("runtime_supervisor_bridge_request_invalid"));
    }

    const sequence = ++this.sequence;
    const correlationId = `${this.runtimeInstanceId}:${sequence}`;
    const startedAt = Date.now();
    this.emitDiagnostic("runtime_request_started", correlationId, 0);
    const timestamp = Date.now();
    const nonce = randomBytes(18).toString("base64url");
    const payload = {
      operation: "MCP_CREATE_INTENT" as const,
      caller: { clientId: request.caller.clientId, requestId: request.caller.requestId },
      intent: { operation: "CREATE" as const, relativePath: request.intent.relativePath, content: request.intent.content },
    };
    const unsigned = { protocol: RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL, runtimeInstanceId: this.runtimeInstanceId, sequence, timestamp, nonce, payload };
    const frame = { ...unsigned, mac: signPayload(this.key, unsigned) };
    const line = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (line.byteLength > MAX_FRAME_BYTES) return Promise.reject(new Error("runtime_supervisor_bridge_frame_too_large"));

    return new Promise<McpCreateIntentResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        this.rememberTimedOutRequest(sequence, { nonce, correlationId, startedAt });
        this.emitDiagnostic("runtime_request_timeout", correlationId, Date.now() - startedAt, "BRIDGE_TIMEOUT");
        reject(new Error("runtime_supervisor_bridge_timeout"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(sequence, { nonce, correlationId, startedAt, timer, resolve, reject });
      const accepted = this.stream.write(line, (error?: Error | null) => {
        const pending = this.pending.get(sequence);
        if (!pending) return;
        if (!error) {
          this.emitDiagnostic("runtime_frame_written", correlationId, Date.now() - startedAt);
          return;
        }
        this.pending.delete(sequence);
        clearTimeout(pending.timer);
        this.emitDiagnostic("runtime_frame_write_failed", correlationId, Date.now() - startedAt, "BRIDGE_WRITE_FAILED");
        pending.reject(new Error("runtime_supervisor_bridge_write_failed"));
      });
      this.emitDiagnostic(accepted ? "runtime_frame_write_submitted" : "runtime_frame_write_backpressured", correlationId, Date.now() - startedAt);
    });
  }

  requestUpdateIntent(request: McpUpdateIntentRequest): Promise<McpCreateIntentResult> {
    if (this.closed || this.stream.destroyed || !this.stream.writable) {
      return Promise.reject(new Error("runtime_supervisor_bridge_unavailable"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS || this.sequence >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new Error("runtime_supervisor_bridge_capacity_exceeded"));
    }
    if (!isUpdateIntentRequest(request)) {
      return Promise.reject(new Error("runtime_supervisor_bridge_request_invalid"));
    }

    const sequence = ++this.sequence;
    const correlationId = `${this.runtimeInstanceId}:${sequence}`;
    const startedAt = Date.now();
    this.emitDiagnostic("runtime_request_started", correlationId, 0);
    const timestamp = Date.now();
    const nonce = randomBytes(18).toString("base64url");
    const payload = {
      operation: "MCP_UPDATE_INTENT" as const,
      caller: { clientId: request.caller.clientId, requestId: request.caller.requestId },
      intent: {
        operation: "UPDATE" as const,
        relativePath: request.intent.relativePath,
        content: request.intent.content,
        expectedTargetSha256: request.intent.expectedTargetSha256,
      },
    };
    const unsigned = { protocol: RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL, runtimeInstanceId: this.runtimeInstanceId, sequence, timestamp, nonce, payload };
    const frame = { ...unsigned, mac: signPayload(this.key, unsigned) };
    const line = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (line.byteLength > MAX_FRAME_BYTES) return Promise.reject(new Error("runtime_supervisor_bridge_frame_too_large"));

    return new Promise<McpCreateIntentResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        this.rememberTimedOutRequest(sequence, { nonce, correlationId, startedAt });
        this.emitDiagnostic("runtime_request_timeout", correlationId, Date.now() - startedAt, "BRIDGE_TIMEOUT");
        reject(new Error("runtime_supervisor_bridge_timeout"));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(sequence, { nonce, correlationId, startedAt, timer, resolve, reject });
      const accepted = this.stream.write(line, (error?: Error | null) => {
        const pending = this.pending.get(sequence);
        if (!pending) return;
        if (!error) {
          this.emitDiagnostic("runtime_frame_written", correlationId, Date.now() - startedAt);
          return;
        }
        this.pending.delete(sequence);
        clearTimeout(pending.timer);
        this.emitDiagnostic("runtime_frame_write_failed", correlationId, Date.now() - startedAt, "BRIDGE_WRITE_FAILED");
        pending.reject(new Error("runtime_supervisor_bridge_write_failed"));
      });
      this.emitDiagnostic(accepted ? "runtime_frame_write_submitted" : "runtime_frame_write_backpressured", correlationId, Date.now() - startedAt);
    });
  }

  close(): void {
    this.failAll("runtime_supervisor_bridge_closed");
    this.stream.destroy();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.byteLength > MAX_FRAME_BYTES && this.buffer.indexOf(0x0a) < 0) {
      this.failAll("runtime_supervisor_bridge_frame_too_large");
      this.stream.destroy();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > MAX_FRAME_BYTES) {
        this.failAll("runtime_supervisor_bridge_frame_too_large");
        this.stream.destroy();
        return;
      }
      let frame: unknown;
      try { frame = JSON.parse(line.toString("utf8")) as unknown; }
      catch {
        this.failAll("runtime_supervisor_bridge_response_invalid");
        this.stream.destroy();
        return;
      }
      if (!this.acceptResponse(frame)) {
        this.failAll("runtime_supervisor_bridge_response_invalid");
        this.stream.destroy();
        return;
      }
    }
  };

  private readonly onStreamFailure = (): void => {
    this.failAll("runtime_supervisor_bridge_unavailable");
  };

  private acceptResponse(value: unknown): boolean {
    if (!isResponseFrame(value)) return false;
    const frame = value;
    if (frame.protocol !== RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL
      || frame.runtimeInstanceId !== this.runtimeInstanceId
      || !Number.isSafeInteger(frame.sequence) || !Number.isSafeInteger(frame.timestamp)
      || Math.abs(Date.now() - frame.timestamp) > MAX_CLOCK_SKEW_MS
      || !/^[A-Za-z0-9_-]{24}$/.test(frame.nonce)) return false;
    if (!verifyPayload(this.key, frame)) return false;
    const pending = this.pending.get(frame.sequence);
    if (!pending) {
      const timedOut = this.timedOut.get(frame.sequence);
      if (!timedOut || timedOut.nonce !== frame.nonce) return false;
      this.timedOut.delete(frame.sequence);
      this.emitDiagnostic("runtime_late_response_ignored", timedOut.correlationId, Date.now() - timedOut.startedAt, "BRIDGE_LATE_RESPONSE_IGNORED");
      return true;
    }
    if (pending.nonce !== frame.nonce) return false;
    const result = parseResponsePayload(frame.payload);
    if (!result) {
      if (isBridgeErrorPayload(frame.payload)) {
        this.pending.delete(frame.sequence);
        clearTimeout(pending.timer);
        const errorCode = (frame.payload as { error: string }).error;
        this.emitDiagnostic("runtime_supervisor_rejected", pending.correlationId, Date.now() - pending.startedAt, errorCode);
        pending.reject(new Error(this.diagnosticsEnabled
          ? `runtime_supervisor_bridge_supervisor_rejected:${errorCode}`
          : "runtime_supervisor_bridge_request_rejected"));
        return true;
      }
      return false;
    }
    this.pending.delete(frame.sequence);
    clearTimeout(pending.timer);
    this.emitDiagnostic("runtime_response_received", pending.correlationId, Date.now() - pending.startedAt);
    pending.resolve(result);
    return true;
  }

  private rememberTimedOutRequest(sequence: number, request: TimedOutRequest): void {
    this.timedOut.set(sequence, request);
    while (this.timedOut.size > MAX_TIMED_OUT_RESPONSES) {
      const oldest = this.timedOut.keys().next().value;
      if (oldest === undefined) break;
      this.timedOut.delete(oldest);
    }
  }

  private emitDiagnostic(stage: string, correlationId: string, elapsedMs: number, errorCode?: string): void {
    if (!this.diagnosticsEnabled || !this.diagnosticSink) return;
    try {
      this.diagnosticSink({ stage, correlationId, elapsedMs: Math.max(0, Math.round(elapsedMs)), ...(errorCode ? { errorCode } : {}) });
    } catch { /* diagnostic failures must not affect CREATE handling */ }
  }

  private failAll(code: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.off("data", this.onData);
    this.stream.off("error", this.onStreamFailure);
    this.stream.off("end", this.onStreamFailure);
    this.stream.off("close", this.onStreamFailure);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      const errorCode = code === "runtime_supervisor_bridge_response_invalid"
        ? "BRIDGE_RESPONSE_INVALID"
        : "BRIDGE_TRANSPORT_UNAVAILABLE";
      this.emitDiagnostic("runtime_bridge_failed", request.correlationId, Date.now() - request.startedAt, errorCode);
      request.reject(new Error(code));
    }
    this.pending.clear();
    this.timedOut.clear();
    this.key.fill(0);
  }
}

export function createRuntimeSupervisorBridge(
  secret: Buffer,
  runtimeInstanceId: string,
  stream: Duplex | null | undefined,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  diagnosticsEnabled = false,
  diagnosticSink?: BridgeDiagnosticSink,
): RuntimeSupervisorBridgeClient | undefined {
  if (!stream) return undefined;
  return new RuntimeSupervisorBridgeClient(stream, secret, runtimeInstanceId, requestTimeoutMs, diagnosticsEnabled, diagnosticSink);
}

function isCreateIntentRequest(value: unknown): value is McpCreateIntentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<McpCreateIntentRequest>;
  if (!request.caller || !request.intent || request.intent.operation !== "CREATE") return false;
  const clientId = request.caller.clientId;
  const requestId = request.caller.requestId;
  const relativePath = request.intent.relativePath;
  const content = request.intent.content;
  if (typeof relativePath !== "string" || relativePath.length < 1 || relativePath.length > 32_768
    || relativePath.includes("\0") || relativePath.includes(":")
    || relativePath.startsWith("/") || relativePath.startsWith("\\")
    || relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) return false;
  return typeof clientId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(clientId)
    && (typeof requestId === "string" ? requestId.length >= 1 && requestId.length <= 128
      : typeof requestId === "number" && Number.isSafeInteger(requestId))
    && typeof content === "string" && !content.includes("\0") && Buffer.byteLength(content, "utf8") <= 1_000_000;
}

function isUpdateIntentRequest(value: unknown): value is McpUpdateIntentRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<McpUpdateIntentRequest>;
  if (!request.caller || !request.intent || request.intent.operation !== "UPDATE") return false;
  const clientId = request.caller.clientId;
  const requestId = request.caller.requestId;
  const relativePath = request.intent.relativePath;
  const content = request.intent.content;
  const expectedTargetSha256 = request.intent.expectedTargetSha256;
  if (typeof relativePath !== "string" || relativePath.length < 1 || relativePath.length > 32_768
    || relativePath.includes("\0") || relativePath.includes(":")
    || relativePath.startsWith("/") || relativePath.startsWith("\\")
    || relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) return false;
  return typeof clientId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(clientId)
    && (typeof requestId === "string" ? requestId.length >= 1 && requestId.length <= 128
      : typeof requestId === "number" && Number.isSafeInteger(requestId))
    && typeof content === "string" && !content.includes("\0") && Buffer.byteLength(content, "utf8") <= 1_000_000
    && typeof expectedTargetSha256 === "string" && /^[a-f0-9]{64}$/.test(expectedTargetSha256);
}

function isRuntimeInstanceId(value: string): boolean {
  return typeof value === "string" && /^c2c_ri_[A-Za-z0-9_-]{8,128}$/.test(value);
}

function isResponseFrame(value: unknown): value is ResponseFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Partial<ResponseFrame>;
  const keys = Object.keys(value).sort().join(",");
  return keys === "mac,nonce,payload,protocol,runtimeInstanceId,sequence,timestamp"
    && typeof frame.protocol === "string" && typeof frame.runtimeInstanceId === "string"
    && typeof frame.sequence === "number" && typeof frame.timestamp === "number"
    && typeof frame.nonce === "string" && typeof frame.mac === "string"
    && !!frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload);
}

function parseResponsePayload(value: unknown): McpCreateIntentResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.status === "REJECTED" && Object.keys(payload).length === 1) return { status: "REJECTED" };
  if (payload.status === "PENDING" && typeof payload.requestId === "string"
    && /^[A-Za-z0-9_-]{8,128}$/.test(payload.requestId)
    && Object.keys(payload).sort().join(",") === "requestId,status") {
    return { status: "PENDING", requestId: payload.requestId };
  }
  return null;
}

function isBridgeErrorPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return Object.keys(payload).length === 1 && typeof payload.error === "string"
    && /^[A-Z0-9_]{1,80}$/.test(payload.error);
}

function signPayload(
  key: Buffer,
  frame: { protocol: string; runtimeInstanceId: string; sequence: number; timestamp: number; nonce: string; payload: unknown },
): string {
  const digest = createHash("sha256").update(JSON.stringify(frame.payload), "utf8").digest("hex");
  return createHmac("sha256", key)
    .update(`${frame.protocol}\n${frame.runtimeInstanceId}\n${frame.sequence}\n${frame.timestamp}\n${frame.nonce}\n${digest}`, "utf8")
    .digest("base64url");
}

function verifyPayload(key: Buffer, frame: ResponseFrame): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(frame.mac)) return false;
  const expected = Buffer.from(signPayload(key, frame), "base64url");
  const provided = Buffer.from(frame.mac, "base64url");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
