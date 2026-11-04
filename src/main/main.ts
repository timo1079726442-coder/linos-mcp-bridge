/**
 * LinOS MCP Bridge — Electron Main Process.
 *
 * Responsibilities:
 *   - Application lifecycle (single instance lock, autostart hook)
 *   - Window management (BrowserWindow with secure webPreferences)
 *   - System Tray (control center entry)
 *   - IPC dispatch (delegated to ipc/handlers.ts)
 *   - Profile/Workspace/Readiness state coordination (via SupervisorClient)
 *
 * P0-1: Replaces SupervisorStub with real SupervisorClient. UI exit does
 * NOT stop Supervisor.
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, clipboard, dialog } from "electron";
import * as path from "node:path";
import { promises as fs, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import { desktopStateRoot } from "./portable/PortableMode.js";
import { ProfileStore } from "./profile/ProfileStore.js";
import { SupervisorClient } from "./ipc/SupervisorClient.js";
import { SupervisorAdapter } from "./ipc/SupervisorAdapter.js";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { MultiServiceManager } from "./multi/MultiServiceManager.js";
import { SupervisorRpcKeyStore } from "./ipc/SupervisorRpcKeyStore.js";
import { SecretStore } from "./security/SecretStore.js";
import { disposeLocalTunnel } from "./tunnel/LocalTunnelManager.js";
import { parseFirstBootPort } from "../shared/localPort.js";
import type { IpcSupervisor } from "../shared/IpcSupervisor.js";

const IS_PORTABLE = app.isPackaged &&
  existsSync(path.join(process.resourcesPath, "portable-mode.json"));
let controlServerHandle: { stop(): Promise<void> } | null = null;
const STATE_ROOT = IS_PORTABLE ? desktopStateRoot({
  portable:true,localAppData:process.env.LOCALAPPDATA,homeDir:os.homedir(),
}) : process.env.C2C_STATE_ROOT?.trim()
  ? process.env.C2C_STATE_ROOT.trim() : ProfileStore.defaultStateRoot();
// Portable mode has independent on-device configuration and single-instance identity.
if (IS_PORTABLE) {
  const userData=path.join(STATE_ROOT,"electron");
  mkdirSync(userData,{recursive:true});
  app.setPath("userData",userData);
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayRefreshTimer: NodeJS.Timeout | null = null;
let supervisor: IpcSupervisor | null = null;
let isQuitting = false;

// ===== Single instance lock =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 窗口被关成托盘后再次双击图标，必须能把窗口重新创建出来，
    // 否则用户"点了没反应"（找不到入口）。
    showMainWindow();
  });
  bootstrap().catch((err) => {
    console.error("FATAL: bootstrap failed", err);
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await fs.mkdir(STATE_ROOT, { recursive: true });

  await app.whenReady();

  // 本机控制端点：让纯 Node 的 V2 runtime 能把屏幕类动作委托回主进程。
  // 只监听 127.0.0.1、随机端口、一次性令牌；控制信息写 <stateRoot>/control.json。
  try {
    const { startControlServer } = await import("./control/ControlServer.js");
    const { createLocalApprovalHandler } = await import("./control/LocalApprovalBridge.js");
    const { createMysqlControlHandlers } = await import("./datasources/MysqlControlBridge.js");
    const { configureScreenBridge, SCREEN_CONTROL_HANDLERS } = await import("./screen/ScreenControlBridge.js");
    configureScreenBridge(STATE_ROOT);
    controlServerHandle = await startControlServer({
      stateRoot: STATE_ROOT,
      handlers: {
        ...SCREEN_CONTROL_HANDLERS,
        // 写入/屏幕类工具的人工审批：runtime 发起，主进程弹原生确认框。
        "approval.request": createLocalApprovalHandler({
          stateRoot: STATE_ROOT,
          getMainWindow: () => mainWindow,
        }),
        // 只读 MySQL：密码留在主进程 DPAPI，runtime 只能按数据源 id 取数。
        ...createMysqlControlHandlers({ stateRoot: STATE_ROOT }),
      },
    });
  } catch (e) {
    console.error("control server failed:", e);
  }


  // Legacy management mode: local instance configuration with owner confirmation.
  // No direct Runtime/Supervisor/Tunnel process control or port listener.

  // Development-only visual inspection. No SupervisorClient, IPC handlers,
  // Runtime, Tunnel, auth, or production state is opened in this mode.
  // Real MCP use must NEVER be claimed from this UI-only preview.
  if (!app.isPackaged && process.env.C2C_UI_PREVIEW_ONLY === "1") {
    createMainWindow();
    mainWindow?.setTitle("LinOS C2C · UI ONLY PREVIEW (NO BACKEND)");
    return;
  }

  // SecretStore's DPAPI helper is a packaged extraResource; never fall back to
  // an unprotected key for Supervisor RPC authentication.
  if (!process.env.C2C_SECRET_STORE_DPAPI_SCRIPT) {
    process.env.C2C_SECRET_STORE_DPAPI_SCRIPT = app.isPackaged
      ? path.join(process.resourcesPath, "scripts", "dpapi-helper.ps1")
      : path.join(app.getAppPath(), "scripts", "dpapi-helper.ps1");
  }
  // 一键装机：`LinOS MCP.exe --port=48800` 只在 Profile 从未配过 transport 时
  // 生效（首启默认值），绝不覆盖已有配置；非法值直接拒绝启动。
  try {
    const cliPort = parseFirstBootPort(process.argv);
    if (cliPort !== null) {
      process.env.C2C_V2_FIRST_BOOT_PORT = String(cliPort);
      console.log(JSON.stringify({ event: "cli-first-boot-port", port: cliPort }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      dialog.showErrorBox("端口参数非法，拒绝启动", `${message}\n\n用法：LinOS MCP.exe --port=48800`);
    } catch {
      /* 无窗口环境也必须失败关闭 */
    }
    app.exit(2);
    return;
  }
  const rpcKeyStore = new SupervisorRpcKeyStore(
    STATE_ROOT,
    new SecretStore(STATE_ROOT, "c2c_v2_control"),
  );

  // P0-1: Real Supervisor via SupervisorClient. Electron Main does NOT
  // own the Supervisor lifecycle. UI exit does NOT stop Supervisor. The
  // DPAPI-protected root survives Main restarts; each pipe connection derives
  // a fresh, replay-resistant request key from a Supervisor challenge.
  const supervisorEntry = process.env.C2C_SUPERVISOR_ENTRY ?? path.join(__dirname, "../supervisor/supervisorMain.js");
  const client = new SupervisorClient({
    stateRoot: STATE_ROOT,
    supervisorEntry,
    sessionRootKeyProvider: () => rpcKeyStore.getOrCreate(),
  });
  supervisor = new SupervisorAdapter(client);
  const multiService = new MultiServiceManager({
    stateRoot: STATE_ROOT,
    supervisorEntry,
    sessionRootKeyProvider: () => rpcKeyStore.getOrCreate(),
  });

  // Pre-warm the Supervisor connection (foreground spawn if needed).
  // We do NOT block bootstrap if Supervisor is unavailable — UI degrades
  // gracefully and shows "Supervisor not running" on Dashboard.
  void client.ensureConnected().catch((e) => {
    console.error("Supervisor not reachable:", e.message);
  });

  // The packaged app retains the same guarded local MCP management UI.
  registerIpcHandlers({
    supervisor,
    getMainWindow: () => mainWindow,
    getStateRoot: () => STATE_ROOT,
    multiService,
  });
  createMainWindow();
  createTray();
}

/** 托盘点击 / 二次启动 / activate 共用：窗口没了就重建，有就显示并聚焦。 */
function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#0f1115",
    title: "LinOS MCP 控制中心",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Remove the unused default English File/Edit/View menu from the Chinese desktop UI.
  // Chromium keyboard shortcuts and the dedicated in-app navigation are retained.
  if (process.platform === "win32") mainWindow.setMenuBarVisibility(false);

  // 开机自启且勾选了"启动时最小化"时，静默进托盘，不弹窗。
  // 由 setLoginItemSettings 注册的 args: ["--hidden"] 触发。
  const startHidden = process.argv.includes("--hidden") || process.argv.includes("--minimized");
  mainWindow.once("ready-to-show", () => {
    if (!startHidden) mainWindow?.show();
  });

  // Hide instead of close (UI exit ≠ Supervisor exit per ADR-V2-002)
  mainWindow.on("close", (event) => {
    if (!app.isPackaged && (process.env.C2C_UI_PREVIEW_ONLY === "1" || process.env.C2C_COMPANY_TEST_CLOSE === "1")) {
      isQuitting = true;
      return; // isolated acceptance closes fully; ordinary Legacy mode stays in tray
    }
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
  if (IS_PORTABLE && !existsSync(path.join(STATE_ROOT, "active-profile.json"))) {
    void mainWindow.loadFile(indexHtml, { hash: "/setup" });
  } else {
    void mainWindow.loadFile(indexHtml);
  }


  // Open devtools in dev mode
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function createTray(): void {
  // Use a tiny placeholder icon. Real asset shipped in CP10.
  const iconPath = path.join(__dirname, "../../assets/tray-icon.png");
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }
  // 兜底：旧安装包没有 assets 目录时托盘会是"透明空图标"（实测）。
  // 内嵌一张 32px 图标，保证任何安装状态下都看得见。
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAFCSURBVFhH7ZehbsMwEIYNCwfHrHikcI/Qlxib7cHBwqForI9QUDCpD7HBgNQbDB5twQoqlW3Q0yVL555dEC++aFJP+sjdKf+fix3pGAsEN3osVrd3mZGPfQHP4yt9jbWOApqEkXthlE2H/BKlfMDaLDPqxW9OiXzjhR79vLm89xvSk72qWWMAxhJooIDBwcBJSpgo5RQnKWH1FQkUqDgb+JOBfGcDUdk80HuKOAPvFVZ1IrWBI/GtXVZuPbfLz6QGQOCUeBzdDFTPdt3q7xZ+PYJuBpzxrze5X4/g/xoY5hOYhS0PDoY4hEbZm832dwqeieTXsCH8B2yDwECNeyXd6Hg24g30xNnA8AZgScBJSthVqSc4SQmD7QQnKWnXsjkuUADrYG2gmYL8wA1pkXte6MvDcsoLfZEZ9eQ39g+8eSv+DVxiFlzNNZj/AAAAAElFTkSuQmCC",
    );
  }
  tray = new Tray(icon);
  tray.setToolTip("LinOS MCP 控制中心 · 启动中…");
  // 单击/双击托盘图标就把主窗口叫回来——这是用户最直觉的入口。
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  rebuildTrayMenu();
  // 状态自愈：每 30 秒重建一次，避免托盘长期停在"未响应"。
  if (!trayRefreshTimer) {
    trayRefreshTimer = setInterval(() => rebuildTrayMenu(), 30_000);
    trayRefreshTimer.unref?.();
  }
}

async function runDiagnosticsAndExport(): Promise<unknown> {
  if (!supervisor) return { error: "supervisor_not_initialized" };
  const r = await supervisor.runDiagnostics();
  return r;
}

export function rebuildTrayMenu(): void {
  if (!tray) return;
  // ===== 默认（V2 内核）托盘菜单：先给状态，再给动作 =====
  void (async (): Promise<void> => {
    if (!tray) return;
    const active = await supervisor?.getActiveProfile().catch(() => null) ?? null;
    const port = active?.transport?.expectedLocalPort ?? 48767;
    const provider = (active?.transport?.provider ?? "LOCAL_ONLY").toUpperCase();
    const publicUrl = active?.transport?.publicMcpUrl ?? null;
    const providerLabel = provider === "CLOUDFLARE_NAMED" ? "固定域名" : "仅本机";
    const probeHealth = async (): Promise<boolean> =>
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok)
        .catch(() => false);
    // Runtime 启动/重启期间会短暂不可达；直接判定"未响应"会误导（实测托盘刚开就显示未响应）。
    let healthOk = await probeHealth();
    if (!healthOk) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      healthOk = await probeHealth();
    }
    const stateLabel = healthOk
      ? `状态：运行中（端口 ${port}）`
      : `状态：启动中或未响应（端口 ${port}）`;

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: stateLabel, enabled: false },
      {
        label: `连接：${providerLabel}${publicUrl ? ` · ${publicUrl.replace(/\/mcp$/, "")}` : ""}`,
        enabled: false,
      },
      { type: "separator" },
      { label: "打开控制中心", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: "打开 ChatGPT", click: () => void shell.openExternal(active?.chatgptLaunchUrl || "https://chatgpt.com") },
      {
        label: publicUrl ? "复制 MCP 地址" : "复制本机地址（ChatGPT 网页版不可用）",
        click: () => {
          clipboard.writeText(publicUrl ?? `http://127.0.0.1:${port}/mcp`);
          tray?.setToolTip(`已复制：${publicUrl ?? `127.0.0.1:${port}`}`);
          setTimeout(() => rebuildTrayMenu(), 1500);
        },
      },
      {
        label: "生成配对码并复制",
        enabled: healthOk,
        click: () => {
          void (async (): Promise<void> => {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/oauth/pairing`, {
                method: "POST",
                signal: AbortSignal.timeout(3000),
              });
              if (!res.ok) throw new Error(String(res.status));
              const body = (await res.json()) as { code?: string };
              if (!body.code) throw new Error("no code");
              clipboard.writeText(body.code);
              tray?.setToolTip(`配对码已复制：${body.code}（60 分钟内有效）`);
            } catch {
              tray?.setToolTip("配对码生成失败，请打开控制中心");
            }
            setTimeout(() => rebuildTrayMenu(), 4000);
          })();
        },
      },
      { type: "separator" },
      { label: "刷新状态", click: () => rebuildTrayMenu() },
      {
        label: "退出界面（后台服务继续运行）",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ];
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(
      `LinOS MCP 控制中心 · ${healthOk ? "运行中" : "未响应"} · ${port} · ${providerLabel}`,
    );
  })().catch(() => { tray?.setToolTip("LinOS MCP 控制中心 · 状态未知"); });
}

app.on("window-all-closed", () => {
  if (!app.isPackaged && (process.env.C2C_UI_PREVIEW_ONLY === "1" || process.env.C2C_COMPANY_TEST_CLOSE === "1")) {
    app.quit();
    return;
  }
  // Keep app alive in tray; do not quit on Windows when window closes.
  // (Per ADR-V2-002, UI exit ≠ Supervisor exit.)
});

app.on("activate", () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    mainWindow.show();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  // 退出时结束我们托管的 cloudflared，避免留下公网隧道
  try {
    disposeLocalTunnel();
  } catch {
    /* 退出路径不抛 */
  }
});
