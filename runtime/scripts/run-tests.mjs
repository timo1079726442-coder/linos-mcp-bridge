// 显式列出 test/*.test.js 再交给 node --test：
// Windows 的 cmd/PowerShell 不会展开通配符，直接写 test/*.test.js 在部分 Node 版本会失败。
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const testDir = path.join(process.cwd(), "test");
const files = readdirSync(testDir).filter((name) => name.endsWith(".test.js")).map((name) => path.join("test", name));
if (files.length === 0) {
  console.error("找不到任何 test/*.test.js");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
