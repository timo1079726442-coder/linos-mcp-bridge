import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditChain } from "./AuditChain.js";

let stateRoot: string;
let chain: AuditChain;

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "c2c-audit-"));
  chain = new AuditChain(stateRoot, "mb_pf_test");
  await chain.open();
});

describe("AuditChain (CP9 + SECURITY_MODEL_V2 §6 + P0-8)", () => {
  it("first entry has previousHash = 0×64", async () => {
    const e = await chain.append({ event: "BOOT" });
    expect(e.sequence).toBe(1);
    expect(e.previousHash).toBe("0".repeat(64));
    expect(e.payloadHash).toHaveLength(64);
  });

  it("subsequent entries chain correctly", async () => {
    const a = await chain.append({ event: "A" });
    const b = await chain.append({ event: "B" });
    expect(b.previousHash).toBe(a.payloadHash);
  });

  it("serializes concurrent appends without forking the hash chain", async () => {
    const entries = await Promise.all(
      Array.from({ length: 20 }, (_, i) => chain.append({ event: `CONCURRENT_${i}` })),
    );
    expect(new Set(entries.map((entry) => entry.sequence)).size).toBe(20);
    expect((await chain.verify()).ok).toBe(true);
  });

  it("verify() passes on intact chain", async () => {
    for (let i = 0; i < 5; i++) await chain.append({ event: `e${i}` });
    const r = await chain.verify();
    expect(r.ok).toBe(true);
  });

  it("verify() detects payload mutation", async () => {
    await chain.append({ event: "ORIG" });
    const raw = await readFile(join(stateRoot, "profiles", "mb_pf_test", "audit", "active.log"), "utf8");
    const tampered = raw.replace(/"event":"ORIG"/, '"event":"TAMPERED"');
    await writeFile(join(stateRoot, "profiles", "mb_pf_test", "audit", "active.log"), tampered, "utf8");
    chain = new AuditChain(stateRoot, "mb_pf_test");
    await chain.open();
    expect(chain.isTamperDetected()).toBe(true);
    expect(chain.isFrozen()).toBe(true);
  });

  it("P0-8 rotation preserves chain continuity (NO reset to genesis)", async () => {
    await chain.append({ event: "A" });
    await chain.append({ event: "B" });
    const anchor = await chain.rotate();
    expect(anchor.firstSequence).toBe(1);
    expect(anchor.lastSequence).toBe(2);
    // CRITICAL: next append must chain off archive.lastHash, NOT genesis
    const post = await chain.append({ event: "POST_ROTATE" });
    expect(post.sequence).toBe(3); // GLOBAL MONOTONIC across archives
    expect(post.previousHash).toBe(anchor.lastHash); // chains across archive
    expect(post.previousHash).not.toBe("0".repeat(64)); // NOT genesis
  });

  it("P0-8 verify() across append → rotate → append → append works", async () => {
    await chain.append({ event: "A" });
    await chain.append({ event: "B" });
    await chain.rotate();
    await chain.append({ event: "C" });
    await chain.append({ event: "D" });
    const r = await chain.verify();
    expect(r.ok).toBe(true);
  });

  it("readVerifiedEntries returns ordered records across archives and active log", async () => {
    await chain.append({ event: "CASE_OBSERVED", signature: "fault:v1:test" });
    await chain.rotate();
    await chain.append({ event: "REPAIR_ATTEMPT", attemptId: "attempt-safe" });

    const entries = await chain.readVerifiedEntries();
    expect(entries.map((entry) => entry.payload.event)).toEqual(["CASE_OBSERVED", "REPAIR_ATTEMPT"]);
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it("readVerifiedEntries fails closed after integrity damage", async () => {
    await chain.append({ event: "CASE_OBSERVED" });
    const activePath = join(stateRoot, "profiles", "mb_pf_test", "audit", "active.log");
    const raw = await readFile(activePath, "utf8");
    await writeFile(activePath, raw.replace("CASE_OBSERVED", "TAMPERED"), "utf8");

    await expect(chain.readVerifiedEntries()).rejects.toThrow("audit_chain_projection_unavailable");
  });

  it("P0-8 open() verifies existing chain; clean state stays unfrozen", async () => {
    await chain.append({ event: "X" });
    await chain.append({ event: "Y" });
    // re-open
    chain = new AuditChain(stateRoot, "mb_pf_test");
    await chain.open();
    expect(chain.isTamperDetected()).toBe(false);
    expect(chain.isFrozen()).toBe(false);
  });

  it("P0-8 open() detects tampered active log on startup", async () => {
    await chain.append({ event: "Z" });
    // tamper
    const raw = await readFile(join(stateRoot, "profiles", "mb_pf_test", "audit", "active.log"), "utf8");
    await writeFile(
      join(stateRoot, "profiles", "mb_pf_test", "audit", "active.log"),
      raw.replace(/"Z"/, '"Z_TAMPERED"'),
      "utf8",
    );
    chain = new AuditChain(stateRoot, "mb_pf_test");
    await chain.open();
    expect(chain.isTamperDetected()).toBe(true);
    expect(chain.isFrozen()).toBe(true);
    await expect(chain.append({ event: "X" })).rejects.toThrow(/frozen/);
  });

  it("explicit quarantine preserves invalid evidence and starts a new writable chain", async () => {
    const auditDir = join(stateRoot, "profiles", "mb_pf_test", "audit");
    await chain.append({ event: "BEFORE_CORRUPTION" });
    const original = await readFile(join(auditDir, "active.log"));
    await writeFile(join(auditDir, "active.log"), Buffer.concat([original, Buffer.from("not-audit-entry\n")]));

    chain = new AuditChain(stateRoot, "mb_pf_test");
    await chain.open({ integrityRecovery: "quarantine" });

    expect(chain.isTamperDetected()).toBe(true);
    expect(chain.isFrozen()).toBe(false);
    expect((await chain.verify()).ok).toBe(true);
    const after = await chain.append({ event: "AFTER_QUARANTINE" });
    expect(after.sequence).toBe(2); // quarantine marker is sequence 1

    const quarantineRoot = join(auditDir, "quarantine");
    const entries = await readdir(quarantineRoot);
    expect(entries).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(quarantineRoot, entries[0]!, "manifest.json"), "utf8")) as {
      continuity: string;
      evidence: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.continuity).toBe("new_chain_starts_after_quarantine_boundary");
    expect(manifest.evidence.some((item) => item.path === "active.log")).toBe(true);
    expect(await readFile(join(quarantineRoot, entries[0]!, "active.log"))).toEqual(
      Buffer.concat([original, Buffer.from("not-audit-entry\n")]),
    );
  });

  it("freeze() prevents further appends", async () => {
    chain.freeze();
    await expect(chain.append({ event: "X" })).rejects.toThrow(/frozen/);
  });
});
