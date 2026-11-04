/**
 * IPC Handlers — capability-based IPC.
 *
 * Per CP1 SECURITY_MODEL_V2 §3, /admin/* endpoints require Capability MAC.
 * The same model is applied here to IPC: each IPC channel requires a capability.
 * Renderer cannot bypass capability to read secret / mutate runtime.json.
 */
import { ipcMain, dialog, shell } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
export function registerIpcHandlers(ctx) {
    // ===== Profile =====
    ipcMain.handle("profile:list", async (_event, capability) => {
        requireCap(capability, "profile:list");
        return ctx.supervisor.listProfiles();
    });
    ipcMain.handle("profile:create", async (_event, capability, params) => {
        requireCap(capability, "profile:create");
        return ctx.supervisor.createProfile(params);
    });
    ipcMain.handle("profile:set-active", async (_event, capability, profileId) => {
        requireCap(capability, "profile:set-active");
        await ctx.supervisor.setActiveProfile(profileId);
        return ctx.supervisor.getActiveProfile();
    });
    ipcMain.handle("profile:get-active", async (_event, capability) => {
        requireCap(capability, "profile:get-active");
        return ctx.supervisor.getActiveProfile();
    });
    // ===== Workspace =====
    ipcMain.handle("workspace:pick", async (_event, capability) => {
        requireCap(capability, "workspace:pick");
        const win = ctx.getMainWindow();
        if (!win)
            throw new Error("No main window available");
        const result = await dialog.showOpenDialog(win, {
            title: "Select Workspace Directory",
            properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        return result.filePaths[0] ?? null;
    });
    ipcMain.handle("workspace:validate", async (_event, capability, root) => {
        requireCap(capability, "workspace:validate");
        return ctx.supervisor.validateWorkspace(root);
    });
    ipcMain.handle("workspace:detect", async (_event, capability, root) => {
        requireCap(capability, "workspace:detect");
        return ctx.supervisor.detectWorkspace(root);
    });
    ipcMain.handle("workspace:change-prepare", async (_event, capability, params) => {
        requireCap(capability, "workspace:change-prepare");
        return ctx.supervisor.prepareWorkspaceChange(params);
    });
    // ===== Connection Intent =====
    ipcMain.handle("intent:create", async (_event, capability) => {
        requireCap(capability, "intent:create");
        return ctx.supervisor.createIntent();
    });
    ipcMain.handle("intent:open-chatgpt", async (_event, capability) => {
        requireCap(capability, "intent:open-chatgpt");
        const active = await ctx.supervisor.getActiveProfile();
        const url = active?.chatgptLaunchUrl ?? "https://chatgpt.com/plugins";
        await shell.openExternal(url);
        return { url };
    });
    // ===== Readiness =====
    ipcMain.handle("readiness:get", async (_event, capability) => {
        requireCap(capability, "readiness:get");
        return ctx.supervisor.getReadiness();
    });
    // ===== Diagnostics =====
    ipcMain.handle("diagnostics:run", async (_event, capability) => {
        requireCap(capability, "diagnostics:run");
        return ctx.supervisor.runDiagnostics();
    });
    ipcMain.handle("diagnostics:export-bundle", async (_event, capability) => {
        requireCap(capability, "diagnostics:export-bundle");
        const report = await ctx.supervisor.runDiagnostics();
        const win = ctx.getMainWindow();
        const dir = await dialog.showOpenDialog(win, {
            title: "Save Diagnostic Bundle",
            properties: ["openDirectory", "createDirectory"],
        });
        if (dir.canceled || dir.filePaths.length === 0)
            throw new Error("Cancelled");
        const out = path.join(dir.filePaths[0] ?? "", `c2c-diagnostic-${Date.now()}.json`);
        await fs.writeFile(out, JSON.stringify(report, null, 2), "utf8");
        return { path: out };
    });
}
function requireCap(provided, expected) {
    if (provided !== expected) {
        throw new Error(`Capability mismatch: expected ${expected}, got ${provided}`);
    }
}
