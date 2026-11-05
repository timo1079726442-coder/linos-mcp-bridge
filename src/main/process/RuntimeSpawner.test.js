import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { RuntimeSpawner } from "./RuntimeSpawner.js";
const SECRET_PLAINTEXT = "aGVsbG90aGVyZQaGVsbG90aGVyZQaGVsbG90aGVyZQ";
const SECRET_B64URL = Buffer.from(SECRET_PLAINTEXT, "base64").toString("base64url");
function makeSecret() {
    return Buffer.from(SECRET_PLAINTEXT, "base64");
}
class FakeStdin extends Writable {
    chunks = [];
    _write(chunk, _enc, cb) {
        this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        cb();
    }
}
class FakeStdout extends Readable {
    _read() { }
}
class FakeProc extends EventEmitter {
    stdin;
    stdout = new FakeStdout();
    stderr = new FakeStdout();
    pid = 99999;
    killed = false;
    kill() { this.killed = true; return true; }
    constructor() {
        super();
        this.stdin = new FakeStdin();
    }
}
/**
 * Capture-only spawn factory: returns a FakeProc that records argv+env.
 * No real OS process is launched.
 */
function makeCaptureSpawn() {
    const last = null;
    const spawn = (binary, args, options) => {
        const o = last;
        if (o) {
            o.binary = binary;
            o.args = [...args];
            o.env = { ...options.env };
        }
        return new FakeProc();
    };
    return { spawn, last: last };
}
function makeOpts(overrides = {}) {
    return {
        deviceId: "d", profileId: "p", runtimeId: "r",
        workspaceRoot: "C:\workspace", port: 48766,
        binaryPath: "node", entryPath: "x",
        runtimeInstanceSecret: makeSecret(),
        ...overrides,
    };
}
describe("RuntimeSpawner (P0-B SECRET_STDIN_ONLY_PRODUCTION)", () => {
    it("P0-B TEST_RUNTIME_SECRET_NOT_IN_ENV_DEFAULT: child env does NOT contain MCP_BRIDGE_RUNTIME_INSTANCE_SECRET", () => {
        const cap = makeCaptureSpawn();
        const spawner = new RuntimeSpawner(makeOpts());
        const result = spawner.spawn(cap.spawn);
        expect(result.captured.env.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET).toBeUndefined();
        expect(cap.last?.env.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET).toBeUndefined();
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
    it("P0-B TEST_ENV_SECRET_FALLBACK_REQUIRES_EXPLICIT_OPT_IN: allowEnvSecretFallback=true + missing MCP_BRIDGE_ALLOW_ENV_SECRET=1 throws", () => {
        const origGate = process.env.MCP_BRIDGE_ALLOW_ENV_SECRET;
        delete process.env.MCP_BRIDGE_ALLOW_ENV_SECRET;
        try {
            const spawner = new RuntimeSpawner(makeOpts({ allowEnvSecretFallback: true }));
            expect(() => spawner.spawn(makeCaptureSpawn().spawn)).toThrow(/SECRET_STDIN_ONLY_PRODUCTION|requires MCP_BRIDGE_ALLOW_ENV_SECRET/);
        }
        finally {
            if (origGate !== undefined)
                process.env.MCP_BRIDGE_ALLOW_ENV_SECRET = origGate;
        }
    });
    it("P0-B fallback works only when both gates open", () => {
        process.env.MCP_BRIDGE_ALLOW_ENV_SECRET = "1";
        try {
            const cap = makeCaptureSpawn();
            const spawner = new RuntimeSpawner(makeOpts({ allowEnvSecretFallback: true }));
            const result = spawner.spawn(cap.spawn);
            expect(result.captured.env.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET).toBe(SECRET_B64URL);
        }
        finally {
            delete process.env.MCP_BRIDGE_ALLOW_ENV_SECRET;
        }
    });
    it("P0-B default (no opt-in) NEVER puts secret in env even when MCP_BRIDGE_ALLOW_ENV_SECRET=1", () => {
        process.env.MCP_BRIDGE_ALLOW_ENV_SECRET = "1";
        try {
            const cap = makeCaptureSpawn();
            const spawner = new RuntimeSpawner(makeOpts()); // no allowEnvSecretFallback
            spawner.spawn(cap.spawn);
            expect(cap.last?.env.MCP_BRIDGE_RUNTIME_INSTANCE_SECRET).toBeUndefined();
        }
        finally {
            delete process.env.MCP_BRIDGE_ALLOW_ENV_SECRET;
        }
    });
});
