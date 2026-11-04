import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ProfileClientRegistry } from "../oauth/ProfileClientRegistry.js";
import { WorkspaceGrantStore } from "../oauth/WorkspaceGrantStore.js";
import {
  connectorLayerFromOAuth,
  conversationLayerFromAudit,
  readConnectorEvidence,
  readConversationEvidence,
} from "./ReadinessEvidence.js";

function writeToolAuditChain(profileDir: string, records: Array<{ tool: string; ok: boolean; at: string }>): void {
  const file = join(profileDir, "audit", "tool-calls.jsonl");
  mkdirSync(join(profileDir, "audit"), { recursive: true });
  let prev = "0".repeat(64);
  const lines: string[] = [];
  records.forEach((record, index) => {
    const entry = { seq: index + 1, at: record.at, prevHash: prev, tool: record.tool, ok: record.ok, durationMs: 1 };
    const hash = createHash("sha256").update(prev).update(JSON.stringify(entry)).digest("hex");
    lines.push(JSON.stringify({ ...entry, hash }));
    prev = hash;
  });
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

describe("readiness evidence", () => {
  it("maps persisted OAuth grants to a passing connector layer", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "c2c-readiness-evidence-"));
    const profileId = `mb_pf_${randomBytes(6).toString("base64url")}`;
    const workspaceDir = mkdtempSync(join(tmpdir(), "c2c-readiness-workspace-"));
    const { ProfileStore } = await import("../profile/ProfileStore.js");
    const { DeviceIdentity } = await import("../profile/DeviceIdentity.js");
    const store = new ProfileStore(stateRoot, new DeviceIdentity(stateRoot));
    const profile = await store.create({ profileName: "证据", profileType: "custom", initialWorkspaceRoot: workspaceDir });
    const clientId = `client_${randomBytes(6).toString("base64url")}`;
    await new ProfileClientRegistry(stateRoot, profile.profileId).upsert({
      clientId,
      clientName: "证据客户端",
      redirectUris: ["http://localhost/callback"],
      scopes: ["workspace.read"],
    });
    await new WorkspaceGrantStore(stateRoot, profile.profileId).set(profile.currentWorkspace.workspaceId!, {
      clientId,
      accessTokenHash: `access-${randomBytes(4).toString("hex")}`,
      refreshTokenHash: `refresh-${randomBytes(4).toString("hex")}`,
      scopes: ["workspace.read"],
      audience: profile.currentWorkspace.workspaceId!,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      revoked: false,
    });

    const evidence = await readConnectorEvidence(stateRoot, profile.profileId, profile.currentWorkspace.workspaceId);
    expect(evidence).toMatchObject({ state: "PASS", oauthState: "AUTHORIZED", validWorkspaceGrant: true, activeClientCount: 1 });
    expect(connectorLayerFromOAuth(evidence.oauthState)).toBe("PASS");
    expect(profileId.startsWith("mb_pf_")).toBe(true);
  });

  it("requires an unexpired unrevoked grant before reporting OAuth as ready", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "c2c-readiness-expired-"));
    const evidence = await readConnectorEvidence(stateRoot, "mb_pf_missing", "missing-workspace");
    expect(evidence.state).toBe("UNKNOWN");
    expect(connectorLayerFromOAuth("EXPIRED")).toBe("FAIL");
    expect(connectorLayerFromOAuth("AUTH_REQUIRED")).toBe("DEGRADED");
  });

  it("reports a passing conversation layer only after a successful audited tool call", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "c2c-readiness-empty-"));
    const empty = await readConversationEvidence(emptyDir);
    expect(empty).toMatchObject({ state: "UNKNOWN", entries: 0, chainOk: true });
    expect(conversationLayerFromAudit(empty)).toBe("UNKNOWN");

    const profileDir = mkdtempSync(join(tmpdir(), "c2c-readiness-conversation-"));
    writeToolAuditChain(profileDir, [
      { tool: "workspace_info", ok: true, at: new Date(Date.now() - 1000).toISOString() },
    ]);
    const ok = await readConversationEvidence(profileDir);
    expect(ok).toMatchObject({ state: "PASS", latestSuccessfulTool: "workspace_info", entries: 1, chainOk: true });
    expect(conversationLayerFromAudit(ok)).toBe("PASS");
    const raw = readFileSync(join(profileDir, "audit", "tool-calls.jsonl"), "utf8");
    expect(raw.replace(/"at":"[^"]+"/, '"at":"redacted"')).not.toContain("secret");
  });

  it("fails closed on a broken tool-audit chain", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "c2c-readiness-tampered-"));
    writeToolAuditChain(profileDir, [
      { tool: "workspace_info", ok: true, at: new Date(Date.now() - 1000).toISOString() },
    ]);
    const file = join(profileDir, "audit", "tool-calls.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace(`"tool":"workspace_info"`, `"tool":"tampered"`), "utf8");

    const evidence = await readConversationEvidence(profileDir);
    expect(evidence.state).toBe("FAIL");
    expect(evidence.chainOk).toBe(false);
    expect(conversationLayerFromAudit(evidence)).toBe("FAIL");
  });
});
