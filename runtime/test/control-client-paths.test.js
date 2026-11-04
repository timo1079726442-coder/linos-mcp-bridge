import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { candidateFiles } from "../dist/control-client.js";

/**
 * 回归：主进程把 control.json 写在 <stateRoot>/control.json，
 * 而 runtime 只拿到 <stateRoot>/profiles/<id>。少向上找一级就会
 * CONTROL_BRIDGE_UNAVAILABLE，写操作永远到不了本机审批（线上真实故障）。
 */
test("control.json 候选路径必须包含 stateRoot 根目录", () => {
  const stateRoot = path.resolve(osTmp(), "linos-state");
  const profileDir = path.join(stateRoot, "profiles", "mb_pf_example");
  const candidates = candidateFiles(profileDir).map((p) => path.resolve(p));

  assert.ok(
    candidates.includes(path.join(stateRoot, "control.json")),
    `缺少 <stateRoot>/control.json，实际候选：${candidates.join(" | ")}`,
  );
  assert.ok(candidates.includes(path.join(stateRoot, "profiles", "control.json")));
  assert.ok(candidates.includes(path.join(profileDir, "control.json")));
});

function osTmp() {
  return process.env.TEMP ?? process.env.TMP ?? "/tmp";
}
