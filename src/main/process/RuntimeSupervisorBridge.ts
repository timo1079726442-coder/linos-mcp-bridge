import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { deriveRuntimeSupervisorBridgeKey } from "../security/HKDF.js";

export const RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL = "c2c.runtime-supervisor.v1";
export const RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND = "c2c.runtime-supervisor-bridge.frame.v1";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 8;
const MAX_NONCES_PER_RUNTIME = 4096;
const MAX_CLOCK_SKEW_MS = 30_000;

export interface RuntimeCreateIntentRequest {
  runtimeInstanceId: string;
  correlationId?: string;
  caller: { clientId: string; requestId: string | number };
  intent: { operation: "CREATE"; relativePath: string; content: string };
}

export interface RuntimeUpdateIntentRequest {
  runtimeInstanceId: string;
  correlationId?: string;
  caller: { clientId: string; requestId: string | number };
  intent: {
    operation: "UPDATE";
    relativePath: string;
    content: string;
    expectedTargetSha256: string;
  };
}

export type RuntimeWriteIntentRequest = RuntimeCreateIntentRequest | RuntimeUpdateIntentRequest;

export interface RuntimeBridgeDiagnosticEvent {
  stage: string;
  correlationId: string;
  elapsedMs: number;
  errorCode?: string;
}

export type RuntimeBridgeDiagnosticSink = (event: RuntimeBridgeDiagnosticEvent) => void;

export interface RuntimeCreateIntentResult {
  status: "PENDING" | "REJECTED";
  requestId?: string;
}

export type RuntimeCreateIntentHandler = (request: RuntimeWriteIntentRequest) => Promise<RuntimeCreateIntentResult>;

/** Adapts the owned child's stdio[3] IPC channel to the existing framed bridge session. */
export function createRuntimeSupervisorBridgeIpcStream(child: ChildProcess): Duplex | undefined {
  if (!child.connected || typeof child.send !== "function") return undefined;
  const queued: Buffer[] = [];
  let queuedBytes = 0;
  let stream: Duplex;
  const drain = (): void => {
    if (!stream || stream.destroyed) return;
    while (queued.length > 0) {
      const next = queued.shift()!;
      queuedBytes = Math.max(0, queuedBytes - next.byteLength);
      if (!stream.push(next)) return;
    }
  };
  stream = new Duplex({
    read: drain,
    write(chunk, encoding, callback) {
      if (!child.connected) {
        callback(new Error("runtime_supervisor_bridge_ipc_disconnected"));
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      child.send({ kind: RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND, data: bytes.toString("utf8") }, (error) => {
        callback(error ?? undefined);
      });
    },
  });
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      stream.destroy(new Error("runtime_supervisor_bridge_ipc_message_invalid"));
      return;
    }
    const frame = message as Record<string, unknown>;
    if (Object.keys(frame).sort().join(",") !== "data,kind"
      || frame.kind !== RUNTIME_SUPERVISOR_BRIDGE_IPC_KIND || typeof frame.data !== "string"
      || Buffer.byteLength(frame.data, "utf8") > MAX_FRAME_BYTES + 1
      || queuedBytes + Buffer.byteLength(frame.data, "utf8") > MAX_FRAME_BYTES * MAX_PENDING_REQUESTS) {
      stream.destroy(new Error("runtime_supervisor_bridge_ipc_message_invalid"));
      return;
    }
    const bytes = Buffer.from(frame.data, "utf8");
    queued.push(bytes);
    queuedBytes += bytes.byteLength;
    drain();
  };
  const onDisconnect = (): void => { stream.push(null); };
  child.on("message", onMessage);
  child.on("disconnect", onDisconnect);
  stream.once("close", () => {
    child.off("message", onMessage);
    child.off("disconnect", onDisconnect);
    if (child.connected) child.disconnect();
  });
  return stream;
};

interface RequestFrame {
  protocol: string;
  runtimeInstanceId: string;
  sequence: number;
  timestamp: number;
  nonce: string;
  payload: unknown;
  mac: string;
}

/** Owns one inherited fd 3 channel from one already-owned Runtime child. */
export class RuntimeSupervisorBridgeSession {
  private readonly key: Buffer;
  private buffer = Buffer.alloc(0);
  private lastSequence = 0;
  private readonly seenNonces = new Set<string>();
  private inFlight = 0;
  private closed = false;

  constructor(
    private readonly stream: Duplex,
    secret: Buffer,
    private readonly runtimeInstanceId: string,
    private readonly onCreateIntent: RuntimeCreateIntentHandler,
    private readonly diagnosticsEnabled = false,
    private readonly diagnosticSink?: RuntimeBridgeDiagnosticSink,
  ) {
    if (secret.byteLength < 32 || !isRuntimeInstanceId(runtimeInstanceId)
      || typeof onCreateIntent !== "function") {
      throw new Error("runtime_supervisor_bridge_configuration_invalid");
    }
    this.key = deriveRuntimeSupervisorBridgeKey(secret);
    stream.on("data", this.onData);
    stream.on("error", this.onStreamFailure);
    stream.on("end", this.onStreamFailure);
    stream.on("close", this.onStreamFailure);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.off("data", this.onData);
    this.stream.off("error", this.onStreamFailure);
    this.stream.off("end", this.onStreamFailure);
    this.stream.off("close", this.onStreamFailure);
    this.key.fill(0);
    this.seenNonces.clear();
    this.stream.destroy();
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.buffer = Buffer.concat([this.buffer, bytes]);
    let newline: number;
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > MAX_FRAME_BYTES || !this.acceptLine(line)) {
        this.close();
        this.stream.destroy();
        return;
      }
    }
    if (this.buffer.byteLength > MAX_FRAME_BYTES) {
      this.close();
      this.stream.destroy();
    }
  };

  private readonly onStreamFailure = (): void => {
    this.close();
  };

  private acceptLine(line: Buffer): boolean {
    let frame: unknown;
    try { frame = JSON.parse(line.toString("utf8")) as unknown; }
    catch {
      this.emitDiagnostic("supervisor_frame_rejected", "unavailable", 0, "BRIDGE_JSON_INVALID");
      return false;
    }
    if (!isRequestFrame(frame)) {
      this.emitDiagnostic("supervisor_frame_rejected", "unavailable", 0, "BRIDGE_FRAME_INVALID");
      return false;
    }
    const correlationId = `${frame.runtimeInstanceId}:${frame.sequence}`;
    if (frame.protocol !== RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL
      || frame.runtimeInstanceId !== this.runtimeInstanceId
      || !Number.isSafeInteger(frame.sequence) || frame.sequence !== this.lastSequence + 1
      || !Number.isSafeInteger(frame.timestamp) || Math.abs(Date.now() - frame.timestamp) > MAX_CLOCK_SKEW_MS
      || !/^[A-Za-z0-9_-]{24}$/.test(frame.nonce) || this.seenNonces.has(frame.nonce)
      || this.seenNonces.size >= MAX_NONCES_PER_RUNTIME || !verifyFrameMac(this.key, frame)) {
      this.emitDiagnostic("supervisor_frame_rejected", correlationId, 0, "BRIDGE_AUTHENTICATION_REJECTED");
      return false;
    }
    const request = parseWriteIntentPayload(frame.payload, frame.runtimeInstanceId, frame.sequence);
    if (!request || this.inFlight >= MAX_PENDING_REQUESTS) {
      this.emitDiagnostic("supervisor_frame_rejected", correlationId, 0,
        request ? "BRIDGE_CAPACITY_EXCEEDED" : "BRIDGE_REQUEST_INVALID");
      return false;
    }

    this.lastSequence = frame.sequence;
    this.seenNonces.add(frame.nonce);
    this.inFlight += 1;
    this.emitDiagnostic("supervisor_frame_received", correlationId, 0);
    void this.handleRequest(frame, request);
    return true;
  }

  private async handleRequest(frame: RequestFrame, request: RuntimeWriteIntentRequest): Promise<void> {
    const startedAt = Date.now();
    const correlationId = request.correlationId ?? `${frame.runtimeInstanceId}:${frame.sequence}`;
    this.emitDiagnostic("supervisor_handler_started", correlationId, 0);
    let payload: RuntimeCreateIntentResult | { error: string };
    try {
      const result = await this.onCreateIntent(request);
      if (isValidResult(result)) {
        payload = result;
        this.emitDiagnostic("supervisor_handler_completed", correlationId, Date.now() - startedAt,
          result.status === "REJECTED" ? "SUPERVISOR_CREATE_INTENT_REJECTED" : undefined);
      } else {
        payload = { error: "SUPERVISOR_CREATE_INTENT_RESPONSE_INVALID" };
        this.emitDiagnostic("supervisor_handler_completed", correlationId, Date.now() - startedAt, "SUPERVISOR_CREATE_INTENT_RESPONSE_INVALID");
      }
    } catch (error) {
      const errorCode = this.diagnosticsEnabled
        ? safeCreateIntentFailureCode(error)
        : "SUPERVISOR_CREATE_INTENT_UNAVAILABLE";
      payload = { error: errorCode };
      this.emitDiagnostic("supervisor_handler_rejected", correlationId, Date.now() - startedAt, errorCode);
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.closed || this.stream.destroyed || !this.stream.writable) {
      this.emitDiagnostic("supervisor_response_unavailable", correlationId, Date.now() - startedAt, "BRIDGE_RESPONSE_CHANNEL_CLOSED");
      return;
    }
    const unsigned = {
      protocol: RUNTIME_SUPERVISOR_BRIDGE_PROTOCOL,
      runtimeInstanceId: this.runtimeInstanceId,
      sequence: frame.sequence,
      timestamp: Date.now(),
      nonce: frame.nonce,
      payload,
    };
    const response = { ...unsigned, mac: signFrameMac(this.key, unsigned) };
    const line = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (line.byteLength > MAX_FRAME_BYTES) {
      this.emitDiagnostic("supervisor_response_failed", correlationId, Date.now() - startedAt, "BRIDGE_FRAME_TOO_LARGE");
      this.close();
      this.stream.destroy();
      return;
    }
    this.stream.write(line, (error?: Error | null) => {
      if (error) {
        this.emitDiagnostic("supervisor_response_failed", correlationId, Date.now() - startedAt, "BRIDGE_RESPONSE_WRITE_FAILED");
        this.close();
        this.stream.destroy();
        return;
      }
      this.emitDiagnostic("supervisor_response_written", correlationId, Date.now() - startedAt);
    });
  }

  private emitDiagnostic(stage: string, correlationId: string, elapsedMs: number, errorCode?: string): void {
    if (!this.diagnosticsEnabled || !this.diagnosticSink) return;
    try {
      this.diagnosticSink({ stage, correlationId, elapsedMs: Math.max(0, Math.round(elapsedMs)), ...(errorCode ? { errorCode } : {}) });
    } catch { /* diagnostic failures must not affect CREATE handling */ }
  }
}

function isRequestFrame(value: unknown): value is RequestFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Partial<RequestFrame>;
  return Object.keys(value).sort().join(",") === "mac,nonce,payload,protocol,runtimeInstanceId,sequence,timestamp"
    && typeof frame.protocol === "string" && typeof frame.runtimeInstanceId === "string"
    && typeof frame.sequence === "number" && typeof frame.timestamp === "number"
    && typeof frame.nonce === "string" && typeof frame.mac === "string"
    && !!frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload);
}

function parseWriteIntentPayload(value: unknown, runtimeInstanceId: string, sequence: number): RuntimeWriteIntentRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).sort().join(",") !== "caller,intent,operation"
    || (payload.operation !== "MCP_CREATE_INTENT" && payload.operation !== "MCP_UPDATE_INTENT")) return null;
  const caller = payload.caller;
  const intent = payload.intent;
  if (!caller || typeof caller !== "object" || Array.isArray(caller)
    || !intent || typeof intent !== "object" || Array.isArray(intent)) return null;
  const callerRecord = caller as Record<string, unknown>;
  const intentRecord = intent as Record<string, unknown>;
  const requestId = callerRecord.requestId;
  const relativePath = intentRecord.relativePath;
  const content = intentRecord.content;
  if (Object.keys(callerRecord).sort().join(",") !== "clientId,requestId"
    || typeof callerRecord.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(callerRecord.clientId)
    || !(typeof requestId === "string" && requestId.length >= 1 && requestId.length <= 128
      || typeof requestId === "number" && Number.isSafeInteger(requestId))) return null;
  if (typeof relativePath !== "string" || !isSafeRelativePath(relativePath)
    || typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > 1_000_000) return null;

  const common = {
    runtimeInstanceId,
    correlationId: `${runtimeInstanceId}:${sequence}`,
    caller: { clientId: callerRecord.clientId, requestId },
  };
  if (payload.operation === "MCP_CREATE_INTENT") {
    if (Object.keys(intentRecord).sort().join(",") !== "content,operation,relativePath"
      || intentRecord.operation !== "CREATE") return null;
    return { ...common, intent: { operation: "CREATE", relativePath, content } };
  }

  const expectedTargetSha256 = intentRecord.expectedTargetSha256;
  if (Object.keys(intentRecord).sort().join(",") !== "content,expectedTargetSha256,operation,relativePath"
    || intentRecord.operation !== "UPDATE"
    || typeof expectedTargetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedTargetSha256)) return null;
  return {
    ...common,
    intent: { operation: "UPDATE", relativePath, content, expectedTargetSha256 },
  };
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 32_768 || value.trim() !== value || value.includes("\0") || value.includes(":")) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== ".."
    && !/[. ]$/.test(part));
}

function safeCreateIntentFailureCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : "SUPERVISOR_CREATE_INTENT_UNAVAILABLE";
}

function isValidResult(value: unknown): value is RuntimeCreateIntentResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.status === "REJECTED") return Object.keys(result).length === 1;
  return result.status === "PENDING" && Object.keys(result).sort().join(",") === "requestId,status"
    && typeof result.requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(result.requestId);
}

function isRuntimeInstanceId(value: string): boolean {
  return typeof value === "string" && /^c2c_ri_[A-Za-z0-9_-]{8,128}$/.test(value);
}

function verifyFrameMac(key: Buffer, frame: RequestFrame): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(frame.mac)) return false;
  const expected = Buffer.from(signFrameMac(key, frame), "base64url");
  const provided = Buffer.from(frame.mac, "base64url");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function signFrameMac(
  key: Buffer,
  frame: { protocol: string; runtimeInstanceId: string; sequence: number; timestamp: number; nonce: string; payload: unknown },
): string {
  const digest = createHash("sha256").update(JSON.stringify(frame.payload), "utf8").digest("hex");
  return createHmac("sha256", key)
    .update(`${frame.protocol}\n${frame.runtimeInstanceId}\n${frame.sequence}\n${frame.timestamp}\n${frame.nonce}\n${digest}`, "utf8")
    .digest("base64url");
}
