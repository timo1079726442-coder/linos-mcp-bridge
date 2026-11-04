import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import { registerIpcHandlers } from "./handlers.js";
import type { IpcContext } from "./handlers.js";
import type { IpcSupervisor } from "../../shared/IpcSupervisor.js";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {},
}));
vi.mock("./handlers.js", async () => vi.importActual<typeof import("./handlers.js")>("./handlers.ts"));

function setup() {
  const updateOrdinarySettings = vi.fn().mockResolvedValue({
    profileId: "profile-test",
    values: { healthCheckIntervalSec: 60, autoStart: { atLogin: false, minimized: true } },
    persisted: true as const,
  });
  const supervisor = { updateOrdinarySettings } as unknown as IpcSupervisor;
  registerIpcHandlers({ supervisor, getMainWindow: () => null, getStateRoot: () => "/tmp/c2c-test-state" } as IpcContext);
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "settings:ordinary:update");
  if (!call) throw new Error("SETTINGS_UPDATE_HANDLER_NOT_REGISTERED");
  return { updateOrdinarySettings, handler: call[1] };
}

describe("ordinary settings IPC", () => {
  beforeEach(() => vi.mocked(ipcMain.handle).mockReset());

  it("requires the dedicated capability and forwards only the approved patch to Supervisor", async () => {
    const { updateOrdinarySettings, handler } = setup();
    const patch = { healthCheckIntervalSec: 60, autoStart: { atLogin: false, minimized: true } };

    await expect(handler({} as never, "profile:get-active", patch)).rejects.toThrow("Capability mismatch");
    expect(updateOrdinarySettings).not.toHaveBeenCalled();

    await expect(handler({} as never, "settings:ordinary:update", patch)).resolves.toEqual({
      profileId: "profile-test",
      values: { healthCheckIntervalSec: 60, autoStart: { atLogin: false, minimized: true } },
      persisted: true,
    });
    expect(updateOrdinarySettings).toHaveBeenCalledOnce();
    expect(updateOrdinarySettings).toHaveBeenCalledWith(patch);
  });
});
