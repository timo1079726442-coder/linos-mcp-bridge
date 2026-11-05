import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchMcp } from "../dist/mcp-tools.js";
import { toolAuditPath, verifyToolAudit } from "../dist/tool-audit.js";

async function call(root, profile, name, args, writeScopeGranted = true) {
  return dispatchMcp(
    { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } },
    "workspace-audit",
    root,
    null,
    { writeScopeGranted, toolPolicyDir: profile },
  );
}

test("tool audit appends a verifiable hash chain without file contents", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-profile-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: { write_file: { enabled: true, approval: "auto" }, update_file: { enabled: true, approval: "auto" } } }), "utf8");
    await call(root, profile, "write_file", { path: "a.txt", content: "TOP-SECRET-CONTENT" });
    await call(root, profile, "update_file", { path: "a.txt", content: "SECOND-SECRET" });
    await assert.rejects(
      () => call(root, profile, "create_file", { path: "b.txt", content: "DENIED" }, false),
      /workspace.write/,
    );

    const raw = await readFile(toolAuditPath(profile), "utf8");
    const lines = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].tool, "write_file");
    assert.equal(lines[0].prevHash, "0".repeat(64));
    assert.equal(lines[1].prevHash, lines[0].hash);
    assert.equal(lines[1].ok, true);
    assert.equal(lines[2].ok, false);
    assert.equal(lines[2].errorCode, "INSUFFICIENT_SCOPE");
    assert.equal(raw.includes("TOP-SECRET-CONTENT"), false);
    assert.equal(raw.includes("SECOND-SECRET"), false);
    assert.equal(raw.includes("DENIED"), false);

    assert.deepEqual(await verifyToolAudit(profile), { ok: true, entries: 3 });
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("tool audit detects a tampered entry", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-tamper-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "c2c-audit-tamper-root-"));
  try {
    await writeFile(path.join(profile, "tool-policy.json"), JSON.stringify({ version: 1, tools: { write_file: { enabled: true, approval: "auto" } } }), "utf8");
    await call(root, profile, "write_file", { path: "a.txt", content: "one" });
    const file = toolAuditPath(profile);
    const raw = await readFile(file, "utf8");
    const tampered = raw.replace('"tool":"write_file"', '"tool":"delete_file"');
    await import("node:fs/promises").then(({ writeFile }) => writeFile(file, tampered, "utf8"));
    const result = await verifyToolAudit(profile);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

