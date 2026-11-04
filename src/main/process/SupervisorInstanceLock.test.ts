import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorInstanceLock } from "./SupervisorInstanceLock.js";

describe("SupervisorInstanceLock", () => {
  it("allows one owner and rejects a live second owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "c2c-supervisor-lock-"));
    try {
      const first = await SupervisorInstanceLock.acquire(root);
      await expect(SupervisorInstanceLock.acquire(root)).rejects.toThrow("supervisor_instance_already_running");
      const record = JSON.parse(await readFile(join(root, "supervisor.lock.json"), "utf8")) as { pid: number; token: string };
      expect(record.pid).toBe(process.pid);
      expect(record.token).toMatch(/^[a-f0-9]{32}$/);
      await first.release();
      const second = await SupervisorInstanceLock.acquire(root);
      await second.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a stale lock without deleting its evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "c2c-supervisor-stale-lock-"));
    try {
      await writeFile(join(root, "supervisor.lock.json"), JSON.stringify({
        pid: 999999,
        startedAt: new Date(0).toISOString(),
        token: "stale-token",
      }), "utf8");
      const lock = await SupervisorInstanceLock.acquire(root);
      const names = (await import("node:fs/promises")).readdir(root);
      expect((await names).some((name) => name.startsWith("supervisor.lock.json.stale-"))).toBe(true);
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
