// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { RuntimeSpawner, type SpawnFn, type SpawnResult } from "./RuntimeSpawner.js";

const SECRET_PLAINTEXT = "aGVsbG90aGVyZQaGVsbG90aGVyZQaGVsbG90aGVyZQ";
const SECRET_B64URL = Buffer.from(SECRET_PLAINTEXT, "base64").toString("base64url");
function makeSecret(): Buffer {
  return Buffer.from(SECRET_PLAINTEXT, "base64");
}

class FakeStdin extends Writable {
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    cb();
  }
}
class FakeStdout extends Readable {
  _read(): void {}
}
class FakeProc extends EventEmitter {
  stdin: FakeStdin;
  stdout = new FakeStdout();
  stderr = new FakeStdout();
  pid = 99999;
  killed = false;
  kill(): boolean { this.killed = true; return true; }
  constructor() {
    super();
    this.stdin = new FakeStdin();
  }
}

/**
 * Capture-only spawn factory: returns a FakeProc that records argv+env.
 * No real OS process is launched.
 */
function makeCaptureSpawn(): { spawn: SpawnFn; last: { binary: string; args: string[]; env: NodeJS.ProcessEnv } | null } {
  const last: { binary: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
  const spawn: SpawnFn = (binary, args, options) => {
    const o = last as { binary: string; args: string[]; env: NodeJS.ProcessEnv } | null;
    if (o) {
      o.binary = binary;
      o.args = [...args];
      o.env = { ...options.env as NodeJS.ProcessEnv };
    }
    return new FakeProc() as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, last: last as { binary: string; args: string[]; env: NodeJS.ProcessEnv } | null };
}

function makeOpts(overrides: Partial<ConstructorParameters<typeof RuntimeSpawner>[0]> = {}): ConstructorParameters<typeof RuntimeSpawner>[0] {
  return {
    deviceId: "d", profileId: "p", runtimeId: "r",
    workspaceRoot: "C:\workspace", port: 48766,
    binaryPath: "node", entryPath: "x",
    runtimeInstanceSecret: makeSecret(),
    ...overrides,
  };
}

describe("RuntimeSpawner (P0-B SECRET_STDIN_ONLY_PRODUCTION)", () => {
  it("P0-B TEST_RUNTIME_SECRET_NOT_IN_ENV_DEFAULT: child env does NOT contain C2C_RUNTIME_INSTANCE_SECRET", () => {
    const cap = makeCaptureSpawn();
    const spawner = new RuntimeSpawner(makeOpts());
    const result: SpawnResult = spawner.spawn(cap.spawn);
    expect(result.captured.env.C2C_RUNTIME_INSTANCE_SECRET).toBeUndefined();
    expect(cap.last?.env.C2C_RUNTIME_INSTANCE_SECRET).toBeUndefined();
  });

  it("P0-B TEST_RUNTIME_SECRET_NOT_IN_COMMAND_LINE: argv is free of secret", () => {
    const cap = makeCaptureSpawn();
    const spawner = new RuntimeSpawner(makeOpts());
    spawner.spawn(cap.spawn);
    const argv = cap.last?.args ?? [];
    const joined = argv.join("\n");
    expect(joined.includes(SECRET_B64URL)).toBe(false);
    expect(joined.includes(SECRET_PLAINTEXT)).toBe(false);
  });

  it("P0-B TEST_RUNTIME_SECRET_STDIN_ONLY: secret is delivered via stdin pipe", () => {
    const cap = makeCaptureSpawn();
    const spawner = new RuntimeSpawner(makeOpts());
    const result = spawner.spawn(cap.spawn);
    expect(result.captured.stdin.startsWith("c2c_ri_secret_")).toBe(true);
    expect(result.captured.stdin).toBe(`c2c_ri_secret_${SECRET_B64URL}\n`);
  });

  it("REMOTE_OAUTH_DISCOVERY_USES_EXPLICIT_PUBLIC_MCP_URL", () => {
    const cap = makeCaptureSpawn();
    const publicMcpUrl = "https://c2c-v2-preview.example.com/mcp";
    const spawner = new RuntimeSpawner(makeOpts({ publicMcpUrl }));
    const result = spawner.spawn(cap.spawn);
    const publicUrlIndex = result.captured.args.indexOf("--public-mcp-url");
    expect(publicUrlIndex).toBeGreaterThanOrEqual(0);
    expect(result.captured.args[publicUrlIndex + 1]).toBe(publicMcpUrl);
  });

  it("P0-B TEST_ENV_SECRET_FALLBACK_REQUIRES_EXPLICIT_OPT_IN: allowEnvSecretFallback=true + missing C2C_RUNTIME_ALLOW_ENV_SECRET=1 throws", () => {
    const origGate = process.env.C2C_RUNTIME_ALLOW_ENV_SECRET;
    delete process.env.C2C_RUNTIME_ALLOW_ENV_SECRET;
    try {
      const spawner = new RuntimeSpawner(makeOpts({ allowEnvSecretFallback: true }));
      expect(() => spawner.spawn(makeCaptureSpawn().spawn)).toThrow(
        /SECRET_STDIN_ONLY_PRODUCTION|requires C2C_RUNTIME_ALLOW_ENV_SECRET/,
      );
    } finally {
      if (origGate !== undefined) process.env.C2C_RUNTIME_ALLOW_ENV_SECRET = origGate;
    }
  });

  it("P0-B fallback works only when both gates open", () => {
    process.env.C2C_RUNTIME_ALLOW_ENV_SECRET = "1";
    try {
      const cap = makeCaptureSpawn();
      const spawner = new RuntimeSpawner(makeOpts({ allowEnvSecretFallback: true }));
      const result = spawner.spawn(cap.spawn);
      expect(result.captured.env.C2C_RUNTIME_INSTANCE_SECRET).toBe(SECRET_B64URL);
    } finally {
      delete process.env.C2C_RUNTIME_ALLOW_ENV_SECRET;
    }
  });

  it("P0-B default (no opt-in) NEVER puts secret in env even when C2C_RUNTIME_ALLOW_ENV_SECRET=1", () => {
    process.env.C2C_RUNTIME_ALLOW_ENV_SECRET = "1";
    try {
      const cap = makeCaptureSpawn();
      const spawner = new RuntimeSpawner(makeOpts()); // no allowEnvSecretFallback
      spawner.spawn(cap.spawn);
      expect(cap.last?.env.C2C_RUNTIME_INSTANCE_SECRET).toBeUndefined();
    } finally {
      delete process.env.C2C_RUNTIME_ALLOW_ENV_SECRET;
    }
  });
});

describe("RuntimeSpawner Supervisor IPC bridge", () => {
  it("allocates stdio index 3 as IPC only when the authenticated bridge is configured", () => {
    let capturedStdio: unknown;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnWithCapture: SpawnFn = (_binary, _args, options) => {
      capturedStdio = options.stdio;
      capturedEnv = options.env;
      return new FakeProc() as unknown as ReturnType<SpawnFn>;
    };

    new RuntimeSpawner(makeOpts()).spawn(spawnWithCapture);
    expect(capturedStdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(capturedEnv?.C2C_RUNTIME_SUPERVISOR_BRIDGE_FD).toBeUndefined();
    expect(capturedEnv?.C2C_RUNTIME_SUPERVISOR_BRIDGE_DIAGNOSTICS).toBeUndefined();

    new RuntimeSpawner(makeOpts({ enableSupervisorBridge: true })).spawn(spawnWithCapture);
    expect(capturedStdio).toEqual(["pipe", "pipe", "pipe", "ipc"]);
    expect(capturedEnv?.C2C_RUNTIME_SUPERVISOR_BRIDGE_FD).toBe("3");
    expect(capturedEnv?.C2C_RUNTIME_SUPERVISOR_BRIDGE_DIAGNOSTICS).toBe("1");
  });
});

describe("RuntimeSpawner PID desync (packaged Electron)", () => {
  // process.versions.electron is a read-only property injected by Electron.
  // Simulate it via defineProperty on a mutable view, restoring afterward.
  const versions = process.versions as Record<string, string> & { electron?: string };
  const hadElectron = Object.prototype.hasOwnProperty.call(versions, "electron");
  const savedElectron = versions.electron;

  afterEach(() => {
    if (hadElectron) {
      versions.electron = savedElectron;
    } else {
      delete versions.electron;
    }
  });

  it("PACKAGED_V2 sets ELECTRON_RUN_AS_NODE=1 so proc.pid is the true Runtime PID", () => {
    // Simulate the packaged build where process.execPath is electron.exe.
    versions.electron = "31.0.0";
    const cap = makeCaptureSpawn();
    const spawner = new RuntimeSpawner(makeOpts({ binaryPath: "C:\\app\\MCP Bridge.exe" }));
    const result = spawner.spawn(cap.spawn);
    // Without this, the spawn would relaunch a full Electron app and proc.pid
    // would point at a launcher process, desyncing from the process that
    // actually listens on 48766 (see docs/DSH_V21_RUNTIME_PID_DEFECT.md).
    expect(result.captured.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("non-Electron (dev/plain node) does NOT set ELECTRON_RUN_AS_NODE", () => {
    delete versions.electron;
    // Remove any inherited env value so the test is hermetic regardless of
    // how vitest itself was launched.
    const savedEnv = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    try {
      const cap = makeCaptureSpawn();
      const spawner = new RuntimeSpawner(makeOpts({ binaryPath: "node" }));
      const result = spawner.spawn(cap.spawn);
      expect(result.captured.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    } finally {
      if (savedEnv !== undefined) process.env.ELECTRON_RUN_AS_NODE = savedEnv;
    }
  });
});
