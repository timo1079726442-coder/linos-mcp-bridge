import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  defaultPolicy,
  loadToolPolicy,
  loadToolPolicyWithSource,
  policyFile,
  saveToolPolicy,
  workspacePolicyFile,
} from "../dist/tool-policy.js";

const WORKSPACE_ID = "95dfd326ff7e";

async function tempProfile() {
  const parent = await mkdtemp(path.join(tmpdir(), "c2c-policy-"));
  const profile = path.join(parent, "profiles", "mb_pf_policy");
  await mkdir(profile, { recursive: true });
  return { parent, profile };
}

test("没有策略文件时使用内置默认并标明来源", async () => {
  const { parent, profile } = await tempProfile();
  try {
    const loaded = await loadToolPolicyWithSource(profile, WORKSPACE_ID);
    assert.equal(loaded.source, "default");
    assert.equal(loaded.file, null);
    assert.equal(loaded.policy.tools.commit_operation.enabled, true);
    assert.equal(loaded.policy.tools.commit_operation.approval, "manual");
    assert.equal(loaded.policy.tools.screen_capture_once.enabled, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("工作区级策略优先于 Profile 级旧策略", async () => {
  const { parent, profile } = await tempProfile();
  try {
    await writeFile(policyFile(profile), JSON.stringify({
      version: 1,
      tools: { commit_operation: { enabled: true, approval: "auto" } },
    }), "utf8");
    let loaded = await loadToolPolicyWithSource(profile, WORKSPACE_ID);
    assert.equal(loaded.source, "profile");
    assert.equal(loaded.policy.tools.commit_operation.approval, "auto");

    const workspaceFile = workspacePolicyFile(profile, WORKSPACE_ID);
    await mkdir(path.dirname(workspaceFile), { recursive: true });
    await writeFile(workspaceFile, JSON.stringify({
      version: 1,
      tools: { commit_operation: { enabled: false, approval: "manual" } },
    }), "utf8");

    loaded = await loadToolPolicyWithSource(profile, WORKSPACE_ID);
    assert.equal(loaded.source, "workspace");
    assert.equal(loaded.file, workspaceFile);
    assert.equal(loaded.policy.tools.commit_operation.enabled, false);
    assert.equal(loaded.policy.tools.commit_operation.approval, "manual");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("保存到工作区级后读回一致，且不影响其它工作区", async () => {
  const { parent, profile } = await tempProfile();
  try {
    const policy = defaultPolicy();
    policy.tools.commit_operation = { enabled: true, approval: "auto" };
    policy.tools.screen_capture_once = { enabled: true, approval: "manual" };
    await saveToolPolicy(profile, policy, WORKSPACE_ID);

    const file = workspacePolicyFile(profile, WORKSPACE_ID);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.tools.commit_operation.approval, "auto");

    const reloaded = await loadToolPolicyWithSource(profile, WORKSPACE_ID);
    assert.equal(reloaded.source, "workspace");
    assert.equal(reloaded.policy.tools.commit_operation.approval, "auto");
    assert.equal(reloaded.policy.tools.screen_capture_once.enabled, true);

    // 另一个工作区没写过文件，仍在默认层。
    const other = await loadToolPolicyWithSource(profile, "aabbccddeeff");
    assert.equal(other.source, "default");
    assert.equal(other.policy.tools.screen_capture_once.enabled, false);

    // 非法 workspaceId 不会拼出越界路径，直接退到 Profile/默认层。
    const invalid = await loadToolPolicyWithSource(profile, "../escape");
    assert.equal(invalid.source, "default");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("损坏的工作区文件退回 Profile 级，而不是清空策略", async () => {
  const { parent, profile } = await tempProfile();
  try {
    await writeFile(policyFile(profile), JSON.stringify({
      version: 1,
      tools: { prepare_write: { enabled: false, approval: "manual" } },
    }), "utf8");
    const workspaceFile = workspacePolicyFile(profile, WORKSPACE_ID);
    await mkdir(path.dirname(workspaceFile), { recursive: true });
    await writeFile(workspaceFile, "{ not json", "utf8");

    const loaded = await loadToolPolicyWithSource(profile, WORKSPACE_ID);
    assert.equal(loaded.source, "profile");
    assert.equal(loaded.policy.tools.prepare_write.enabled, false);
    const policy = await loadToolPolicy(profile, WORKSPACE_ID);
    assert.equal(policy.tools.prepare_write.approval, "manual");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
