/**
 * RuntimeSpawner — spawn the Runtime child process with strict IPC and
 * secret-injection semantics.
 *
 * Per ADR-0002 §2 (SECRET_STDIN_ONLY_PRODUCTION):
 *   - Default: secret delivered via stdin pipe ONLY
 *   - env fallback: ONLY when MCP_BRIDGE_ALLOW_ENV_SECRET=1 AND
 *     allowEnvSecretFallback=true is passed to spawn()
 *   - env must NEVER contain MCP_BRIDGE_RUNTIME_INSTANCE_SECRET in production
 *   - command line must NEVER contain the secret
 *
 * Tests inject a custom spawnFn to inspect argv + env without actually
 * running a child process.
 */
import { spawn, type ChildProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  DeviceId,
  ProfileId,
  RuntimeId,
  RuntimeInstanceId,
} from "../../shared/types.js";

export interface SpawnOptions {
  deviceId: DeviceId;
  profileId: ProfileId;
  runtimeId: RuntimeId;
  workspaceRoot: string;
  port: number;
  binaryPath: string;
  entryPath: string;
  runtimeInstanceSecret: Buffer;
  /** Profile state root used for durable OAuth metadata only. */
  stateRoot?: string;
  /** Public MCP URL used by remote Runtime OAuth discovery. */
  publicMcpUrl?: string | null;
  /** Adds an inherited duplex control pipe on fd 3; never opens a network listener. */
  enableSupervisorBridge?: boolean;
  allowEnvSecretFallback?: boolean;
}

export interface CapturedSpawn {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
}

export interface SpawnResult {
  proc: ChildProcess;
  runtimeInstanceId: RuntimeInstanceId;
  /** Captured spawn metadata (always populated for inspection). */
  captured: CapturedSpawn;
}

export type SpawnFn = (
  binary: string,
  args: string[],
  options: NodeSpawnOptions,
) => ChildProcess;

const defaultSpawn: SpawnFn = (binary, args, options) => spawn(binary, args, options);

export class RuntimeSpawner {
  private readonly args: string[];
  private readonly capture: CapturedSpawn | null = { binary: "", args: [], env: {}, stdin: "" };

  constructor(private readonly opts: SpawnOptions) {
    this.args = [
      opts.entryPath,
      "serve",
      "--workspace", opts.workspaceRoot,
      "--port", String(opts.port),
      "--device-id", opts.deviceId,
      "--profile-id", opts.profileId,
      "--runtime-id", opts.runtimeId,
      "--runtime-instance-id", this.generateRuntimeInstanceId(),
    ];
    if (opts.stateRoot) this.args.push("--state-root", opts.stateRoot);
    if (opts.publicMcpUrl) this.args.push("--public-mcp-url", opts.publicMcpUrl);
  }

  spawn(spawnFn: SpawnFn = defaultSpawn): SpawnResult {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET;
    delete childEnv.MCP_BRIDGE_SUPERVISOR_BRIDGE_FD;
    delete childEnv.MCP_BRIDGE_SUPERVISOR_BRIDGE_DIAGNOSTICS;
    if (this.opts.enableSupervisorBridge) {
      childEnv.MCP_BRIDGE_SUPERVISOR_BRIDGE_FD = "3";
      // Bridge diagnostics contain only static error categories and are enabled only for isolated CREATE test mode.
      childEnv.MCP_BRIDGE_SUPERVISOR_BRIDGE_DIAGNOSTICS = "1";
    }
    // The Runtime entrypoint is a plain Node script (runtime/src/main.ts starts
    // an HTTP server, `#!/usr/bin/env node`, no Electron `app` API). But in the
    // packaged build `process.execPath` resolves to the Electron executable, so
    // a bare spawn would relaunch a full Electron app (which forks GPU/utility
    // children and re-execs), making `proc.pid` point at a launcher that is NOT
    // the process actually listening on the V2 port. This desync breaks
    // PROVEN_SAME_RUNTIME (stop/ownership gates) and the diagnostics process
    // evidence. Mirror SupervisorClient.spawnSupervisor and force the same
    // executable to run as Node, so proc.pid is the true Runtime PID.
    if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = "1";

    if (this.opts.allowEnvSecretFallback === true) {
      if (process.env.MCP_BRIDGE_ALLOW_ENV_SECRET !== "1") {
        throw new Error(
          "SECRET_STDIN_ONLY_PRODUCTION: allowEnvSecretFallback=true requires " +
            "MCP_BRIDGE_ALLOW_ENV_SECRET=1 env var. Refusing to spawn with secret in child env.",
        );
      }
      childEnv.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET = this.opts.runtimeInstanceSecret.toString("base64url");
    }

    this.assertNoSecretInArgs(this.args, this.opts.runtimeInstanceSecret);

    const encoded = this.opts.runtimeInstanceSecret.toString("base64url");
    const stdinPayload = `c2c_ri_secret_${encoded}\n`;

    // Capture before actual spawn.
    if (this.capture) {
      this.capture.binary = this.opts.binaryPath;
      this.capture.args = [...this.args];
      this.capture.env = { ...childEnv };
      this.capture.stdin = stdinPayload;
    }

    const proc = spawnFn(this.opts.binaryPath, this.args, {
      detached: false,
      stdio: this.opts.enableSupervisorBridge ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: childEnv,
    });
    // Pipe secret into stdin (always; env fallback is redundant safety net).
    proc.stdin?.write(stdinPayload);
    proc.stdin?.end();

    const runtimeInstanceId = this.args[this.args.indexOf("--runtime-instance-id") + 1] as RuntimeInstanceId;
    return {
      proc,
      runtimeInstanceId,
      captured: this.capture ?? { binary: "", args: [], env: {}, stdin: "" },
    };
  }

  private generateRuntimeInstanceId(): RuntimeInstanceId {
    return `c2c_ri_${randomBytes(12).toString("base64url")}`;
  }

  private assertNoSecretInArgs(args: string[], secret: Buffer): void {
    const s = secret.toString("base64url");
    for (const a of args) {
      if (a.includes(s)) {
        throw new Error("SECRET_STDIN_ONLY_PRODUCTION: secret leaked into spawn argv");
      }
    }
  }
}
