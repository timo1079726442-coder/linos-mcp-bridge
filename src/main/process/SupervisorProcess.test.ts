// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

// ---------------------------------------------------------------------------
// Mock ProcessScanner before importing SupervisorProcess so isProcessAlive is
// controllable per test (the real one shells out to the OS). `alivePids` is
// declared before vi.mock so the factory closes over the live set.
// ---------------------------------------------------------------------------
const alivePids = new Set<number>();
vi.mock("./ProcessScanner.js", () => ({
  isProcessAlive: (pid: number) => alivePids.has(pid),
  getProcessInfo: async () => null,
}));

import { SupervisorProcess } from "./SupervisorProcess.js";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Controllable fake child process: exposes stdin, emitExit, exitCode, pid.
// ---------------------------------------------------------------------------
class FakeStdin extends Writable {
  readonly chunks: Buffer[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    cb();
  }
}
class FakeProc extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  exitCode: number | null = null;
  killed = false;
  constructor(public pid: number) {
    super();
    alivePids.add(pid);
  }
  kill(): boolean {
    this.killed = true;
    // Simulate the OS effect of SIGTERM: the process is no longer alive even
    // before its "exit" event fires (mirrors real Windows semantics).
    alivePids.delete(this.pid);
    return true;
  }
  emitExit(code: number | null = 0): void {
    this.exitCode = code;
    alivePids.delete(this.pid);
    this.emit("exit", code, null);
  }
}

// ---------------------------------------------------------------------------
// Mock RuntimeSpawner: spawn() returns the next queued FakeProc.
// ---------------------------------------------------------------------------
const procQueue: FakeProc[] = [];
const spawnCalls: number[] = [];
vi.mock("./RuntimeSpawner.js", () => ({
  RuntimeSpawner: class {
    constructor(private opts: unknown) {}
    spawn() {
      const proc = procQueue.shift();
      if (!proc) throw new Error("test: no fake proc queued");
      spawnCalls.push(proc.pid);
      return {
        proc: proc as unknown as ChildProcess,
        runtimeInstanceId: `c2c_ri_test_${proc.pid}`,
        captured: { binary: "", args: [], env: {}, stdin: "" },
      };
    }
  },
}));

function makeSupervisor(): SupervisorProcess {
  return new SupervisorProcess(
    // stateDir, profileId
    "/tmp/linos-test-state",
    "pf_test",
    {
      deviceId: "dev_test",
      profileId: "pf_test",
      runtimeId: "rt_test",
      workspaceRoot: "C:\workspace\\linos-c2c-control-center",
      port: 48766,
      binaryPath: "node",
      entryPath: "runtime/dist/main.js",
      runtimeInstanceSecret: Buffer.alloc(32, 7),
      commandImage: "node",
      stateRoot: "/tmp/linos-test-state",
    } as never,
  );
}

beforeEach(() => {
  procQueue.length = 0;
  spawnCalls.length = 0;
  alivePids.clear();
});

describe("SupervisorProcess exit-callback identity guard", () => {
  it("stale child exit does NOT clear the current child's state.pid", async () => {
    const sup = makeSupervisor();
    const first = new FakeProc(111);
    const second = new FakeProc(222);
    procQueue.push(first, second);

    await sup.start();               // state.pid = 111
    await sup.restartForWorkspace("C:\workspace\\linos-c2c-control-center"); // stop(111) -> start(222)

    expect(sup.getState().pid).toBe(222);

    // Simulate the stale child (111) exiting AFTER the new child was recorded.
    // Without the identity guard, this would set state.pid = null.
    first.emitExit(0);

    expect(sup.getState().pid).toBe(222);
    expect(sup.getState().runtimeInstanceId).toBe("c2c_ri_test_222");
  });

  it("current child exit DOES clear state (normal death path preserved)", async () => {
    const sup = makeSupervisor();
    const only = new FakeProc(333);
    procQueue.push(only);

    await sup.start();
    expect(sup.getState().pid).toBe(333);

    only.emitExit(0);
    expect(sup.getState().pid).toBeNull();
  });
});

describe("SupervisorProcess start idempotence guard", () => {
  it("start() does not spawn a second child while one is live", async () => {
    const sup = makeSupervisor();
    const live = new FakeProc(444);
    procQueue.push(live);

    await sup.start();
    await sup.start(); // second start must be a no-op (ownsLiveChild is true)

    expect(spawnCalls).toEqual([444]); // only ONE spawn
    expect(sup.getState().pid).toBe(444);
  });

  it("start() after current child death spawns again", async () => {
    const sup = makeSupervisor();
    const first = new FakeProc(555);
    const second = new FakeProc(666);
    procQueue.push(first, second);

    await sup.start();
    first.emitExit(0); // now dead -> ownsLiveChild false

    await sup.start(); // must spawn the replacement
    expect(spawnCalls).toEqual([555, 666]);
    expect(sup.getState().pid).toBe(666);
  });
});
