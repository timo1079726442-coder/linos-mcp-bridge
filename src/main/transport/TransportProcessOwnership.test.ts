import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { TransportProcessOwnership, hashPath } from "./TransportProcessOwnership.js";

const identity = {
  provider: "cloudflare-named",
  tunnelId: "590b136e-4641-416d-820b-7708bf9179c0",
  tunnelName: "c2c-v2-preview",
  hostname: "c2c-v2-preview.example.com",
  credentialPath: "C:/Users/Administrator/AppData/Local/linos-c2c-control-center/profiles/p/transport/tunnel.json",
};

describe("TransportProcessOwnership", () => {
  it("persists identity metadata and a path hash, never credential contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-ownership-"));
    const store = new TransportProcessOwnership(path.join(root, "ownership.json"));
    await store.record(identity, process.pid, new Date().toISOString());
    const raw = await readFile(path.join(root, "ownership.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.tunnelId).toBe(identity.tunnelId);
    expect(parsed.credentialPathHash).toBe(hashPath(identity.credentialPath));
    expect(raw).not.toContain("access_token");
    expect(raw).not.toContain("client_secret");
  });

  it("fails closed when the recorded PID command line is not the V2 tunnel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "c2c-ownership-foreign-"));
    const store = new TransportProcessOwnership(path.join(root, "ownership.json"));
    await store.record(identity, process.pid, new Date().toISOString());
    const verdict = await store.inspect(identity, process.execPath);
    expect(["FOREIGN_PROCESS", "UNKNOWN"]).toContain(verdict);
  });
});
