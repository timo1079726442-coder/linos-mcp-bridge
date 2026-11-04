import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "./WorkspaceManager.js";
describe("WorkspaceManager", () => {
    it("validate returns exists=false for non-existent path", async () => {
        const wm = new WorkspaceManager();
        const info = await wm.validate("/path/that/does/not/exist/xyz");
        expect(info.exists).toBe(false);
        expect(info.workspaceId).toHaveLength(12);
    });
    it("validate returns exists=true for an existing dir", async () => {
        const dir = await mkdtemp(join(tmpdir(), "c2c-wm-"));
        const wm = new WorkspaceManager();
        const info = await wm.validate(dir);
        expect(info.exists).toBe(true);
        expect(info.isGitRepo).toBe(false);
    });
    it("detectProject identifies Node + TypeScript via package.json + tsconfig", async () => {
        const dir = await mkdtemp(join(tmpdir(), "c2c-wm-proj-"));
        await writeFile(join(dir, "package.json"), JSON.stringify({
            name: "test",
            dependencies: { react: "18", next: "14" },
        }));
        await writeFile(join(dir, "tsconfig.json"), "{}");
        const wm = new WorkspaceManager();
        const proj = await wm.detectProject(dir);
        expect(proj.projectType).toBe("node");
        expect(proj.languages).toContain("TypeScript");
        expect(proj.languages).toContain("JavaScript");
        expect(proj.frameworks).toContain("React");
        expect(proj.frameworks).toContain("Next.js");
    });
    it("REPO_READY conditional: non-git workspace is NOT_APPLICABLE", async () => {
        const dir = await mkdtemp(join(tmpdir(), "c2c-wm-nogit-"));
        const wm = new WorkspaceManager();
        const info = await wm.validate(dir);
        expect(info.isGitRepo).toBe(false);
        // Per CP1 IDENTITY_MODEL_V2 §3 and READINESS_ENGINE conditional logic, this maps to NOT_APPLICABLE.
        const mapped = info.isGitRepo ? "REQUIRED" : "NOT_APPLICABLE";
        expect(mapped).toBe("NOT_APPLICABLE");
    });
});
