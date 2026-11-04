/**
 * LinOS MCP Bridge — Electron Main Process.
 *
 * Responsibilities:
 *   - Application lifecycle (single instance lock, autostart hook)
 *   - Window management (BrowserWindow with secure webPreferences)
 *   - System Tray (control center entry)
 *   - IPC dispatch (delegated to ipc/handlers.ts)
 *   - Profile/Workspace/Readiness state coordination (via SupervisorStub)
 *
 * Per ADR-V2-002, the real Supervisor process is OUT OF SCOPE for CP2;
 * the SupervisorStub here stands in to keep the IPC contract stable.
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from "electron";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ProfileStore } from "./profile/ProfileStore.js";
import { SupervisorStub } from "./supervisor/SupervisorStub.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
const STATE_ROOT = ProfileStore.defaultStateRoot();
let mainWindow = null;
let tray = null;
let supervisor = null;
let isQuitting = false;
// ===== Single instance lock =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
}
else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.focus();
        }
    });
    bootstrap().catch((err) => {
        console.error("FATAL: bootstrap failed", err);
        app.exit(1);
    });
}
async function bootstrap() {
    await fs.mkdir(STATE_ROOT, { recursive: true });
    supervisor = new SupervisorStub(STATE_ROOT);
    await app.whenReady();
    registerIpcHandlers({
        supervisor,
        getMainWindow: () => mainWindow,
    });
    createMainWindow();
    createTray();
}
function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 720,
        backgroundColor: "#0f1115",
        title: "MCP Bridge",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
        },
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    // Hide instead of close (UI exit ≠ Supervisor exit per ADR-V2-002)
    mainWindow.on("close", (event) => {
        if (mainWindow && !isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        // External links open in system browser
        if (url.startsWith("https://")) {
            shell.openExternal(url);
            return { action: "deny" };
        }
        return { action: "deny" };
    });
    // Load the renderer build
    const indexHtml = path.join(__dirname, "../renderer/index.html");
    void mainWindow.loadFile(indexHtml);
    // Open devtools in dev mode
    if (process.env.NODE_ENV === "development") {
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
}
function createTray() {
    // Use a tiny placeholder icon. Real asset shipped in CP10.
    const iconPath = path.join(__dirname, "../../assets/tray-icon.png");
    let icon;
    try {
        icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty())
            icon = nativeImage.createEmpty();
    }
    catch {
        icon = nativeImage.createEmpty();
    }
    tray = new Tray(icon);
    tray.setToolTip("MCP Bridge");
    rebuildTrayMenu();
}
export function rebuildTrayMenu() {
    if (!tray)
        return;
    const menu = Menu.buildFromTemplate([
        { label: "Open Control Center", click: () => mainWindow?.show() },
        { label: "Open ChatGPT", click: () => shell.openExternal("https://chatgpt.com/plugins") },
        { label: "Run Diagnostics", click: async () => {
                if (supervisor)
                    await supervisor.runDiagnostics();
            } },
        { type: "separator" },
        { label: "Quit", click: () => {
                isQuitting = true;
                app.quit();
            } },
    ]);
    tray.setContextMenu(menu);
}
app.on("window-all-closed", () => {
    // Keep app alive in tray; do not quit on Windows when window closes.
    // (Per ADR-V2-002, UI exit ≠ Supervisor exit.)
});
app.on("activate", () => {
    if (mainWindow === null) {
        createMainWindow();
    }
    else {
        mainWindow.show();
    }
});
app.on("before-quit", () => {
    isQuitting = true;
});
