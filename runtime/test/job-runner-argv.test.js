import test from "node:test";
import assert from "node:assert/strict";
import { revalidateArgv } from "../dist/job-runner.js";
import { resolvePowerShellArgv } from "../dist/command-tools.js";

/**
 * 回归：start_job 的 run_powershell 曾用 `argv.length < 9` 校验，
 * 而 resolvePowerShellArgv 只生成 6（user）/ 8（constrained）段，
 * 结果是 job 链路的 PowerShell 任务 100% COMMAND_INVALID（线上真实故障）。
 */
test("resolvePowerShellArgv 生成的两段式 argv 都能通过 start_job 校验", async () => {
  const user = await resolvePowerShellArgv("Start-Sleep -Seconds 1; Write-Output ok", "user");
  const constrained = await resolvePowerShellArgv("Start-Sleep -Seconds 1", "constrained");
  assert.ok(user.argv.length < 9, "user 模式本来就少于 9 段，证明旧校验必失败");
  assert.doesNotThrow(() => revalidateArgv("run_powershell", user.argv));
  assert.doesNotThrow(() => revalidateArgv("run_powershell", constrained.argv));
  assert.ok(user.argv.includes("-Command"));
});

test("start_job 校验拒绝伪装成 PowerShell 的 argv", () => {
  assert.throws(() => revalidateArgv("run_powershell", ["cmd.exe", "/c", "-Command", "whoami"]), /COMMAND_INVALID/);
  assert.throws(() => revalidateArgv("run_powershell", ["powershell.exe", "-NoLogo"]), /COMMAND_INVALID/);
  assert.throws(() => revalidateArgv("run_powershell", ["powershell.exe", "-Command", "   "]), /COMMAND_INVALID/);
});
