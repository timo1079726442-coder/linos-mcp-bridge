import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
/**
 * WorkspaceManager — validates, detects, and inspects workspace directories.
 *
 * Identity: workspaceId = sha256(lowercase(realpath))[:12]
 * Per CP1 IDENTITY_MODEL_V2 §2, workspaceId NEVER participates in
 * Transport Identity or Runtime Identity calculation.
 */
export class WorkspaceManager {
    async validate(root) {
        const exists = await this.exists(root);
        if (!exists) {
            return {
                root,
                workspaceId: await this.computeWorkspaceId(root),
                exists: false,
                isGitRepo: false,
                branch: null,
                commit: null,
                dirty: null,
            };
        }
        const isGitRepo = await this.detectGit(root);
        let branch = null;
        let commit = null;
        let dirty = null;
        if (isGitRepo) {
            try {
                branch = await this.runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
                commit = await this.runGit(root, ["rev-parse", "--short", "HEAD"]);
                const status = await this.runGit(root, ["status", "--porcelain", "--", "."]);
                dirty = status.trim().length > 0;
            }
            catch {
                // Git operations failed; treat as non-git rather than throw.
                branch = null;
                commit = null;
                dirty = null;
            }
        }
        return {
            root: await this.realpath(root),
            workspaceId: await this.computeWorkspaceId(root),
            exists: true,
            isGitRepo,
            branch,
            commit,
            dirty,
        };
    }
    async detect(root) {
        const info = await this.validate(root);
        const project = await this.detectProject(root);
        return {
            root: info.root,
            workspaceId: info.workspaceId,
            isGitRepo: info.isGitRepo,
            projectType: project.projectType,
            languages: project.languages,
            frameworks: project.frameworks,
        };
    }
    /** Compute workspaceId from realpath. Pure (best-effort). */
    async computeWorkspaceId(root) {
        let real = root;
        try {
            real = await fs.realpath(root);
        }
        catch {
            // not exist yet; use lowercased as-given
        }
        const normalized = process.platform === "win32" || process.platform === "darwin"
            ? real.toLowerCase()
            : real;
        return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    }
    /** Detect basic project metadata. Best-effort; never throws. */
    async detectProject(root) {
        const languages = new Set();
        const frameworks = new Set();
        let projectType = "unknown";
        if (await this.exists(path.join(root, "package.json"))) {
            projectType = projectType === "unknown" ? "node" : projectType;
            languages.add("JavaScript");
            try {
                const raw = await fs.readFile(path.join(root, "package.json"), "utf8");
                const pkg = JSON.parse(raw);
                const deps = {};
                for (const k of ["dependencies", "devDependencies"]) {
                    const v = pkg[k];
                    if (v && typeof v === "object")
                        Object.assign(deps, v);
                }
                const known = {
                    next: "Next.js",
                    react: "React",
                    vue: "Vue",
                    svelte: "Svelte",
                    express: "Express",
                    fastify: "Fastify",
                    "@nestjs/core": "NestJS",
                    electron: "Electron",
                };
                for (const [dep, label] of Object.entries(known)) {
                    if (deps[dep])
                        frameworks.add(label);
                }
            }
            catch {
                // ignore malformed package.json
            }
        }
        if (await this.exists(path.join(root, "tsconfig.json")))
            languages.add("TypeScript");
        if (await this.exists(path.join(root, "pyproject.toml")) || await this.exists(path.join(root, "requirements.txt"))) {
            languages.add("Python");
            if (projectType === "unknown")
                projectType = "python";
        }
        if (await this.exists(path.join(root, "Cargo.toml"))) {
            languages.add("Rust");
            if (projectType === "unknown")
                projectType = "rust";
        }
        if (await this.exists(path.join(root, "go.mod"))) {
            languages.add("Go");
            if (projectType === "unknown")
                projectType = "go";
        }
        return { projectType, languages: [...languages], frameworks: [...frameworks] };
    }
    async exists(p) {
        try {
            await fs.stat(p);
            return true;
        }
        catch {
            return false;
        }
    }
    async realpath(p) {
        try {
            return await fs.realpath(p);
        }
        catch {
            return p;
        }
    }
    async detectGit(root) {
        return new Promise((resolve) => {
            const proc = spawn("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
            let stdout = "";
            proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
            proc.on("error", () => resolve(false));
            proc.on("close", (code) => {
                resolve(code === 0 && stdout.trim() === "true");
            });
        });
    }
    runGit(root, args) {
        return new Promise((resolve) => {
            const proc = spawn("git", args, { cwd: root });
            let stdout = "";
            proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
            proc.on("error", () => resolve(""));
            proc.on("close", () => resolve(stdout.trim()));
        });
    }
}
