import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
export async function detectWorkspace(root) {
    const exists = await pathExists(root);
    let real = root;
    if (exists) {
        try {
            real = await fs.realpath(root);
        }
        catch {
            // ignore
        }
    }
    const normalized = process.platform === "win32" || process.platform === "darwin"
        ? real.toLowerCase()
        : real;
    const workspaceId = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    if (!exists) {
        return {
            root: real,
            workspaceId,
            exists: false,
            isGitRepo: false,
            projectType: "unknown",
            languages: [],
            frameworks: [],
        };
    }
    const languages = new Set();
    const frameworks = new Set();
    let projectType = "unknown";
    if (await pathExists(path.join(real, "package.json"))) {
        projectType = projectType === "unknown" ? "node" : projectType;
        languages.add("JavaScript");
    }
    if (await pathExists(path.join(real, "tsconfig.json")))
        languages.add("TypeScript");
    if (await pathExists(path.join(real, "pyproject.toml")))
        languages.add("Python");
    if (await pathExists(path.join(real, "Cargo.toml")))
        languages.add("Rust");
    if (await pathExists(path.join(real, "go.mod")))
        languages.add("Go");
    return {
        root: real,
        workspaceId,
        exists: true,
        isGitRepo: await pathExists(path.join(real, ".git")),
        projectType,
        languages: [...languages],
        frameworks: [...frameworks],
    };
}
async function pathExists(p) {
    try {
        await fs.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
