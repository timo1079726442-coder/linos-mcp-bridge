#!/usr/bin/env node
/**
 * 全历史密钥扫描（无 gitleaks 时的本地等价兜底）。
 *
 * 覆盖范围：所有分支、所有 tag、所有提交里的所有文本文件（git grep 跨全部提交搜索）。
 *
 * 用法：
 *   node scripts/secret-scan.mjs
 *
 * 退出码：0 = 无非允许项命中；1 = 存在未允许的命中（可直接用作 CI 门禁）。
 *
 * 说明：
 * - 只读 git 对象，不修改仓库；
 * - `ALLOWLIST` 用于"示例/占位符/测试夹具"，命中仍会出现在报告里并标 allowed=true，
 *   便于评审而不静默丢弃；
 * - 真实凭据命中必须轮换 + 从历史清除，不能只加白名单。
 */
import { execFileSync } from "node:child_process";

/** git grep 使用 POSIX ERE，故不使用 \b 与非捕获组。 */
const RULES = [
  { id: "aws-access-key", pattern: "AKIA[0-9A-Z]{16}" },
  { id: "github-token", pattern: "(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}" },
  { id: "github-pat", pattern: "github_pat_[A-Za-z0-9_]{22,}" },
  { id: "openai-key", pattern: "sk-[A-Za-z0-9_-]{20,}" },
  { id: "slack-token", pattern: "xox[baprs]-[A-Za-z0-9-]{10,}" },
  { id: "private-key-block", pattern: "-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----" },
  { id: "cloudflare-tunnel-token", pattern: "eyJhIjoi[A-Za-z0-9+/=]{20,}" },
  { id: "jwt-like", pattern: "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" },
  { id: "app-api-token", pattern: "c2c_api_[A-Za-z0-9]{16,}" },
  { id: "password-assignment", pattern: "(password|passwd|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*[\"'][^\"']{8,}[\"']" },
];

/**
 * 示例/占位符/测试夹具：命中标记为 allowed，不算失败。
 * 只登记**精确的**夹具值，禁止用宽泛规则把真实凭据一并放行。
 */
const ALLOWLIST = [
  /c2c_api_\.\.\./,
  /c2c_api_\{\{?/,
  /c2c_at_inner_token_xyz/, // src/main/redaction 夹具：用于验证脱敏
  /\bdead-token\b/, // runtime/test/tool-audit：失效锁文件夹具
  /\bstale-token\b/, // src/main/process/SupervisorInstanceLock.test：陈旧锁夹具
  /a-strong-password/, // datasource 测试夹具
  /must not be accepted/, // settings 拒绝路径夹具
  /example/i,
  /placeholder/i,
  /redacted/i,
  /^\s*<[A-Z_]+>$/,
  /x{8,}/i,
  /sk-test/i,
  /your[-_]?(token|key)/i,
];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function mask(value) {
  return value.replace(/[A-Za-z0-9_-]{12,}/g, (token) => `${token.slice(0, 4)}***`);
}

function isAllowed(snippet) {
  return ALLOWLIST.some((rule) => rule.test(snippet));
}

const commits = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
const refs = git(["for-each-ref", "--format=%(refname)"]).trim().split("\n").filter(Boolean);
const hits = [];

for (const rule of RULES) {
  let output = "";
  try {
    output = git(["grep", "--no-color", "-n", "-I", "-E", "-e", rule.pattern, ...commits]);
  } catch (error) {
    // git grep 在无命中时退出码为 1
    if (error.status !== 1) throw error;
    output = "";
  }
  for (const line of output.split("\n")) {
    if (!line) continue;
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    const third = line.indexOf(":", second + 1);
    if (first === -1 || second === -1 || third === -1) continue;
    const commit = line.slice(0, first);
    const file = line.slice(first + 1, second);
    const number = line.slice(second + 1, third);
    const content = line.slice(third + 1).trim();
    hits.push({
      rule: rule.id,
      commit: commit.slice(0, 12),
      file,
      line: Number(number),
      allowed: isAllowed(content),
      snippet: mask(content).slice(0, 160),
    });
  }
}

// 同一文件同一行的多次命中只保留一条（不同提交会重复）
const unique = new Map();
for (const hit of hits) {
  const key = `${hit.rule}|${hit.file}|${hit.line}|${hit.snippet}`;
  if (!unique.has(key)) unique.set(key, hit);
}
const all = [...unique.values()];
const denied = all.filter((hit) => !hit.allowed);

const report = {
  refsReviewed: refs.length,
  commitsReviewed: commits.length,
  rules: RULES.map((rule) => rule.id),
  findings: all.length,
  denied: denied.length,
  hits: all.slice(0, 200),
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = denied.length > 0 ? 1 : 0;
