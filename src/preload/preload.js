/**
 * Preload — the only bridge between Renderer and Main.
 *
 * Per CP1 SECURITY_MODEL_V2 §3, every IPC call carries a capability token.
 * Renderer cannot directly call ipcRenderer.invoke with arbitrary channels;
 * it must use the typed wrappers exported as `c2c`.
 */
import { contextBridge, ipcRenderer } from "electron";
const c2c = {
    profile: {
        list: () => ipcRenderer.invoke("profile:list", "profile:list"),
        create: (params) => ipcRenderer.invoke("profile:create", "profile:create", params),
        setActive: (profileId) => ipcRenderer.invoke("profile:set-active", "profile:set-active", profileId),
        getActive: () => ipcRenderer.invoke("profile:get-active", "profile:get-active"),
    },
    workspace: {
        pick: () => ipcRenderer.invoke("workspace:pick", "workspace:pick"),
        validate: (root) => ipcRenderer.invoke("workspace:validate", "workspace:validate", root),
        detect: (root) => ipcRenderer.invoke("workspace:detect", "workspace:detect", root),
        changePrepare: (params) => ipcRenderer.invoke("workspace:change-prepare", "workspace:change-prepare", params),
    },
    intent: {
        create: () => ipcRenderer.invoke("intent:create", "intent:create"),
        openChatgpt: () => ipcRenderer.invoke("intent:open-chatgpt", "intent:open-chatgpt"),
    },
    readiness: {
        get: () => ipcRenderer.invoke("readiness:get", "readiness:get"),
    },
    diagnostics: {
        run: () => ipcRenderer.invoke("diagnostics:run", "diagnostics:run"),
        exportBundle: () => ipcRenderer.invoke("diagnostics:export-bundle", "diagnostics:export-bundle"),
    },
};
contextBridge.exposeInMainWorld("c2c", c2c);
