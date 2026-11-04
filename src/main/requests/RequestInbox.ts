import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

export type RequestKind = "git_init" | "git_fetch" | "git_push" | "note" | "enable_dir_read";
export type RequestStatus = "pending" | "approved" | "rejected";

export interface AiRequest {
  /** 相对工作区的唯一标识，含子目录，例如 linos-workspace-integration-20261016/.c2c/requests/git-push-x.json */
  id: string;
  file: string;
  /** 绝对路径，审批时直接用它，避免"根目录找不到"。 */
  path: string;
  /** 该请求所属仓库/项目根（.c2c 的上一层）。 */
  repoRoot: string;
  at: string;
  kind: RequestKind;
  title: string;
  reason: string;
  detail: string;
  status: RequestStatus;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".cache", "tmp", "release-portable"]);

function asKind(value: unknown): RequestKind {
  if (value === "git_init" || value === "git_fetch" || value === "git_push" || value === "enable_dir_read") return value;
  return "note";
}

/** 递归找 <任意层级>\.c2c\requests 目录（限制深度，跳过依赖与构建产物）。 */
async function findRequestDirs(root: string, depth = 0, acc: string[] = []): Promise<string[]> {
  if (depth > 4) return acc;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".c2c") {
      const candidate = path.join(root, entry.name, "requests");
      const exists = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
      if (exists) acc.push(candidate);
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    await findRequestDirs(path.join(root, entry.name), depth + 1, acc);
  }
  return acc;
}

/** AI 把请求写成 <任意项目>\.c2c\requests\<名字>.json，控制中心递归列出。 */
export async function listRequests(workspaceRoot: string): Promise<{ dir: string; dirs: string[]; requests: AiRequest[] }> {
  const dirs = await findRequestDirs(workspaceRoot);
  const requests: AiRequest[] = [];
  for (const dir of dirs) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const absolute = path.join(dir, entry.name);
      const raw = await fs.readFile(absolute, "utf8").catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        requests.push({
          id: path.relative(workspaceRoot, absolute).replace(/\\/g, "/"),
          file: entry.name,
          path: absolute,
          repoRoot: path.dirname(path.dirname(dir)),
          at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
          kind: asKind(parsed.kind),
          title: typeof parsed.title === "string" ? parsed.title : "未命名请求",
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
          detail: typeof parsed.detail === "string" ? parsed.detail : "",
          status: parsed.status === "approved" || parsed.status === "rejected" ? parsed.status : "pending",
        });
      } catch {
        // 解析失败的文件跳过，不阻塞其它请求
      }
    }
  }
  requests.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { dir: path.join(workspaceRoot, ".c2c", "requests"), dirs, requests };
}

async function setStatus(absolutePath: string, status: RequestStatus, extra?: Record<string, unknown>): Promise<void> {
  const raw = await fs.readFile(absolutePath, "utf8").catch(() => null);
  const base = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  await fs.writeFile(absolutePath, JSON.stringify({ ...base, status, decidedAt: new Date().toISOString(), ...extra }, null, 2), "utf8");
}

/** 执行 git 命令并返回可读结果（失败也返回文本，便于展示）。 */
async function runGit(cwd: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) resolve(`git ${args.join(" ")} 失败：${(stderr || error.message).trim().slice(0, 800)}`);
      else resolve(`git ${args.join(" ")} 完成：${(stdout || stderr).trim().slice(0, 800) || "无输出"}`);
    });
  });
}

/**
 * 批准后只执行"低风险且可逆"的动作：
 * - git_init / git_fetch / git_push：在**请求所属仓库**里执行（不是工作区根）；
 * - 其它：只记录决定，不擅自改权限。
 */
export async function approveRequest(workspaceRoot: string, id: string): Promise<{ executed: string; output?: string }> {
  const { requests } = await listRequests(workspaceRoot);
  const found = requests.find((r) => r.id === id || r.file === id);
  if (!found) throw new Error("REQUEST_NOT_FOUND");
  const cwd = found.repoRoot;

  if (found.kind === "git_init") {
    const output = await runGit(cwd, ["init"]);
    await setStatus(found.path, "approved", { executed: "git_init", result: output });
    return { executed: "git_init", output };
  }
  if (found.kind === "git_fetch") {
    const output = await runGit(cwd, ["fetch", "--all", "--prune"]);
    await setStatus(found.path, "approved", { executed: "git_fetch", result: output });
    return { executed: "git_fetch", output };
  }
  if (found.kind === "git_push") {
    // 没有上游时自动 -u origin HEAD（否则 git 会报 No configured push destination）；
    // 只推当前分支，绝不 force，也不推标签。
    const hasOrigin = await runGit(cwd, ["remote", "get-url", "origin"]);
    if (hasOrigin.includes("失败")) {
      await setStatus(found.path, "approved", { executed: "git_push", result: hasOrigin });
      return { executed: "git_push", output: "这个仓库还没有配置 origin 远端，先在仓库里执行：git remote add origin <url>" };
    }
    const upstream = await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const output = upstream.includes("失败")
      ? await runGit(cwd, ["push", "-u", "origin", "HEAD"])
      : await runGit(cwd, ["push"]);
    await setStatus(found.path, "approved", { executed: "git_push", result: output });
    return { executed: "git_push", output };
  }
  await setStatus(found.path, "approved", { executed: "note_only" });
  return { executed: "note_only", output: "已记录批准；这类请求不会自动改权限，需要你到对应页面手动改。" };
}

export async function rejectRequest(workspaceRoot: string, id: string): Promise<void> {
  const { requests } = await listRequests(workspaceRoot);
  const found = requests.find((r) => r.id === id || r.file === id);
  if (!found) throw new Error("REQUEST_NOT_FOUND");
  await setStatus(found.path, "rejected");
}
