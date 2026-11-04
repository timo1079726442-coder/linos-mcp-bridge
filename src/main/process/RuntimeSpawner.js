/**
 * RuntimeSpawner — spawn the C2C Runtime child process with strict IPC and
 * secret-injection semantics.
 *
 * Per FOUNDER OPTION_A_PLUS §2 (SECRET_STDIN_ONLY_PRODUCTION):
 *   - Default: secret delivered via stdin pipe ONLY
 *   - env fallback: ONLY when C2C_RUNTIME_ALLOW_ENV_SECRET=1 AND
 *     allowEnvSecretFallback=true is passed to spawn()
 *   - env must NEVER contain C2C_RUNTIME_INSTANCE_SECRET in production
 *   - command line must NEVER contain the secret
 *
 * Tests inject a custom spawnFn to inspect argv + env without actually
 * running a child process.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
const defaultSpawn = (binary, args, options) => spawn(binary, args, options);
export class RuntimeSpawner {
    opts;
    args;
    capture = { binary: "", args: [], env: {}, stdin: "" };
    constructor(opts) {
        this.opts = opts;
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
        if (opts.stateRoot)
            this.args.push("--state-root", opts.stateRoot);
        if (opts.publicMcpUrl)
            this.args.push("--public-mcp-url", opts.publicMcpUrl);
    }
    spawn(spawnFn = defaultSpawn) {
        const childEnv = { ...process.env };
        delete childEnv.C2C_RUNTIME_INSTANCE_SECRET;
        if (this.opts.allowEnvSecretFallback === true) {
            if (process.env.C2C_RUNTIME_ALLOW_ENV_SECRET !== "1") {
                throw new Error("SECRET_STDIN_ONLY_PRODUCTION: allowEnvSecretFallback=true requires " +
                    "C2C_RUNTIME_ALLOW_ENV_SECRET=1 env var. Refusing to spawn with secret in child env.");
            }
            childEnv.C2C_RUNTIME_INSTANCE_SECRET = this.opts.runtimeInstanceSecret.toString("base64url");
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
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: childEnv,
        });
        // Pipe secret into stdin (always; env fallback is redundant safety net).
        proc.stdin?.write(stdinPayload);
        proc.stdin?.end();
        const runtimeInstanceId = this.args[this.args.indexOf("--runtime-instance-id") + 1];
        return {
            proc,
            runtimeInstanceId,
            captured: this.capture ?? { binary: "", args: [], env: {}, stdin: "" },
        };
    }
    generateRuntimeInstanceId() {
        return `c2c_ri_${randomBytes(12).toString("base64url")}`;
    }
    assertNoSecretInArgs(args, secret) {
        const s = secret.toString("base64url");
        for (const a of args) {
            if (a.includes(s)) {
                throw new Error("SECRET_STDIN_ONLY_PRODUCTION: secret leaked into spawn argv");
            }
        }
    }
}
