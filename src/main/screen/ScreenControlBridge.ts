/**
 * ScreenControlBridge — 屏幕类动作（由主进程执行，经 ControlServer 暴露给 runtime）。
 *
 * 共同约定：
 * - 只把截图落到本机状态目录 `<stateRoot>/screen/frames/`，返回路径与元信息；
 * - "最新帧"指最近一次成功截取的那张，`screen_select_latest` 可改指向；
 * - 标注在独立的离屏 Electron 窗口里合成（ScreenAnnotationRenderer），
 *   坐标是 0–1000 的归一化值；标注结果另存，不覆盖原始帧；
 * - 不主动外传任何图片，是否外传由调用方决定。
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BrowserWindow, desktopCapturer, nativeImage } from "electron";
import { renderAnnotatedPng } from "./ScreenAnnotationRenderer.js";

export interface ScreenWindowInfo {
  id: string;
  title: string;
  appName: string;
  minimized: boolean;
}

export interface FrameInfo {
  frameId: string;
  filePath: string;
  bytes: number;
  width: number;
  height: number;
  capturedAt: number;
  sourceId: string | null;
  native: boolean;
}

interface BridgeState {
  stateRoot: string;
  framesDir: string;
  latestFrameId: string | null;
  annotated: AnnotatedFrame | null;
}

interface AnnotatedFrame {
  filePath: string;
  sourceFrameId: string;
  createdAt: number;
  marks: number;
  width: number;
  height: number;
}

let state: BridgeState | null = null;

export function configureScreenBridge(stateRoot: string): void {
  state = {
    stateRoot,
    framesDir: path.join(stateRoot, "screen", "frames"),
    latestFrameId: null,
    annotated: null,
  };
}

function requireState(): BridgeState {
  if (!state) throw new Error("SCREEN_BRIDGE_NOT_CONFIGURED");
  return state;
}

async function ensureFramesDir(s: BridgeState): Promise<void> {
  await fs.mkdir(s.framesDir, { recursive: true });
}

export async function listScreenWindows(): Promise<{ windows: ScreenWindowInfo[]; count: number }> {
  if (BrowserWindow.getAllWindows().length === 0) return { windows: [], count: 0 };
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const windows: ScreenWindowInfo[] = sources.map((s) => ({
    id: String(s.id),
    title: s.name ?? "",
    appName: "",
    minimized: false,
  }));
  return { windows, count: windows.length };
}

async function capture(
  types: Array<"screen" | "window">,
  sourceId?: string,
  maxWidth = 2560,
): Promise<FrameInfo> {
  const s = requireState();
  await ensureFramesDir(s);

  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: maxWidth, height: Math.round((maxWidth * 9) / 16) },
    fetchWindowIcons: false,
  });
  if (sources.length === 0) throw new Error("NO_CAPTURE_SOURCE");

  const picked = sourceId ? sources.find((x) => String(x.id) === sourceId) : sources[0];
  if (!picked) throw new Error("SOURCE_NOT_FOUND");

  const image = picked.thumbnail;
  const png = image.toPNG();
  const frameId = `frame_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const filePath = path.join(s.framesDir, `${frameId}.png`);
  await fs.writeFile(filePath, png);
  s.latestFrameId = frameId;

  const size = image.getSize();
  return {
    frameId,
    filePath,
    bytes: png.length,
    width: size.width,
    height: size.height,
    capturedAt: Date.now(),
    sourceId: String(picked.id),
    native: false,
  };
}

export async function captureOnce(): Promise<FrameInfo> {
  return capture(["screen"]);
}

export async function captureActiveWindow(): Promise<FrameInfo> {
  const { windows } = await listScreenWindows();
  if (windows.length === 0) throw new Error("NO_WINDOW");
  return capture(["window"], windows[0]!.id);
}

export async function captureWindow(params: { windowId?: string }): Promise<FrameInfo> {
  const id = String(params.windowId ?? "");
  if (!id) throw new Error("WINDOW_ID_REQUIRED");
  return capture(["window"], id);
}

export async function captureWindows(params: { windowIds?: string[] }): Promise<{ frames: FrameInfo[] }> {
  const ids = Array.isArray(params.windowIds) ? params.windowIds : [];
  if (ids.length === 0) throw new Error("WINDOW_IDS_REQUIRED");
  const frames: FrameInfo[] = [];
  for (const id of ids) frames.push(await capture(["window"], id));
  return { frames };
}

export async function selectLatest(params: { frameId?: string }): Promise<{ latestFrameId: string }> {
  const s = requireState();
  const id = String(params.frameId ?? "");
  if (!id) throw new Error("FRAME_ID_REQUIRED");
  await fs.access(path.join(s.framesDir, `${id}.png`));
  s.latestFrameId = id;
  return { latestFrameId: id };
}

export async function getLatestFrame(): Promise<FrameInfo> {
  const s = requireState();
  if (!s.latestFrameId) throw new Error("NO_FRAME_YET");
  const filePath = path.join(s.framesDir, `${s.latestFrameId}.png`);
  const stat = await fs.stat(filePath);
  const image = nativeImage.createFromPath(filePath);
  const size = image.getSize();
  return {
    frameId: s.latestFrameId,
    filePath,
    bytes: stat.size,
    width: size.width,
    height: size.height,
    capturedAt: stat.mtimeMs,
    sourceId: null,
    native: false,
  };
}

export async function exportLatestImage(params: { targetPath?: string }): Promise<{ filePath: string }> {
  const s = requireState();
  if (!s.latestFrameId) throw new Error("NO_FRAME_YET");
  const src = path.join(s.framesDir, `${s.latestFrameId}.png`);
  const target =
    typeof params.targetPath === "string" && params.targetPath.trim()
      ? params.targetPath.trim()
      : path.join(s.stateRoot, "screen", `latest-${Date.now()}.png`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(src, target);
  return { filePath: target };
}

export async function latestImageUrl(): Promise<{ url: string; frameId: string }> {
  const s = requireState();
  if (!s.latestFrameId) throw new Error("NO_FRAME_YET");
  const filePath = path.join(s.framesDir, `${s.latestFrameId}.png`);
  return { url: `file:///${filePath.replaceAll("\\", "/")}`, frameId: s.latestFrameId };
}

export async function exportLatestArtifactCode(): Promise<{ markdown: string; frameId: string }> {
  const s = requireState();
  if (!s.latestFrameId) throw new Error("NO_FRAME_YET");
  const filePath = path.join(s.framesDir, `${s.latestFrameId}.png`);
  const png = await fs.readFile(filePath);
  return {
    markdown: `![screenshot](${filePath.replaceAll("\\", "/")})`,
    frameId: s.latestFrameId,
  };
}

export interface AnnotatedInfo {
  annotatedId: string;
  filePath: string;
  bytes: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  marks: number;
  sourceFrameId: string;
  createdAt: number;
}

async function ensureAnnotatedDir(s: BridgeState): Promise<string> {
  const dir = path.join(s.stateRoot, "screen", "annotated");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 在最新帧上合成标注，另存为 PNG。
 * marks 由调用方给出（0–1000 归一化坐标），渲染在离屏窗口内完成，不执行任意 HTML/JS。
 */
export async function annotateLatestImage(params: {
  marks?: unknown;
  annotations?: unknown;
} = {}): Promise<AnnotatedInfo> {
  const s = requireState();
  if (!s.latestFrameId) throw new Error("NO_FRAME_YET");
  const sourcePath = path.join(s.framesDir, `${s.latestFrameId}.png`);
  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error("SCREEN_SOURCE_INVALID");
  const size = image.getSize();
  // 渲染层画布上限 1280×800；大屏截图先等比缩小，标注坐标是 0–1000 归一化，位置不变。
  const scale = Math.min(1, 1280 / Math.max(1, size.width), 800 / Math.max(1, size.height));
  const rendered = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "good",
    })
    : image;
  const renderedSize = rendered.getSize();
  const jpeg = rendered.toJPEG(85);
  if (jpeg.length === 0) throw new Error("SCREEN_SOURCE_INVALID");
  const marks = Array.isArray(params.marks) ? params.marks
    : Array.isArray(params.annotations) ? params.annotations
      : [];
  const png = await renderAnnotatedPng(
    `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    marks,
  );
  const annotatedId = `annotated-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = await ensureAnnotatedDir(s);
  const filePath = path.join(dir, `${annotatedId}.png`);
  await fs.writeFile(filePath, png, { mode: 0o600 });
  const stat = await fs.stat(filePath);
  s.annotated = {
    filePath,
    sourceFrameId: s.latestFrameId,
    createdAt: Date.now(),
    marks: Array.isArray(marks) ? marks.length : 0,
    width: renderedSize.width,
    height: renderedSize.height,
  };
  return {
    annotatedId,
    filePath,
    bytes: stat.size,
    width: renderedSize.width,
    height: renderedSize.height,
    sourceWidth: size.width,
    sourceHeight: size.height,
    marks: s.annotated.marks,
    sourceFrameId: s.annotated.sourceFrameId,
    createdAt: s.annotated.createdAt,
  };
}

function requireAnnotated(): AnnotatedFrame {
  const s = requireState();
  if (!s.annotated) throw new Error("SCREEN_ANNOTATED_FRAME_MISSING");
  return s.annotated;
}

async function assertExportTargetInWorkspace(stateRoot: string, target: string): Promise<void> {
  const { readActiveProfileContext } = await import("../control/LocalApprovalBridge.js");
  const context = await readActiveProfileContext(stateRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(context.workspaceRoot), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("EXPORT_PATH_OUTSIDE_WORKSPACE");
  }
}

export async function exportAnnotatedImage(params: { targetPath?: string } = {}): Promise<{ filePath: string }> {
  const s = requireState();
  const annotated = requireAnnotated();
  let target: string;
  if (typeof params.targetPath === "string" && params.targetPath.trim()) {
    target = path.resolve(params.targetPath.trim());
    await assertExportTargetInWorkspace(s.stateRoot, target);
  } else {
    target = path.join(s.stateRoot, "screen", `annotated-latest-${Date.now()}.png`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(annotated.filePath, target);
  return { filePath: target };
}

export async function exportAnnotatedArtifactCode(): Promise<{ markdown: string; filePath: string }> {
  const annotated = requireAnnotated();
  return {
    markdown: `![annotation](${annotated.filePath.replaceAll("\\", "/")})`,
    filePath: annotated.filePath,
  };
}

export async function annotatedImageUrl(): Promise<{ url: string; filePath: string }> {
  const annotated = requireAnnotated();
  return {
    url: `file:///${annotated.filePath.replaceAll("\\", "/")}`,
    filePath: annotated.filePath,
  };
}

/** 注册给 ControlServer 的动作表。 */
export const SCREEN_CONTROL_HANDLERS = {
  "screen.list_windows": () => listScreenWindows(),
  "screen.capture_once": () => captureOnce(),
  "screen.capture_active_window": () => captureActiveWindow(),
  "screen.capture_window": (p: Record<string, unknown>) => captureWindow(p as { windowId?: string }),
  "screen.capture_windows": (p: Record<string, unknown>) => captureWindows(p as { windowIds?: string[] }),
  "screen.select_latest": (p: Record<string, unknown>) => selectLatest(p as { frameId?: string }),
  "screen.get_latest_frame": () => getLatestFrame(),
  "screen.export_latest_image": (p: Record<string, unknown>) => exportLatestImage(p as { targetPath?: string }),
  "screen.export_latest_artifact_code": () => exportLatestArtifactCode(),
  "screen.latest_image_url": () => latestImageUrl(),
  "screen.annotate_latest_image": (p: Record<string, unknown>) => annotateLatestImage(p),
  "screen.export_annotated_image": (p: Record<string, unknown>) => exportAnnotatedImage(p as { targetPath?: string }),
  "screen.export_annotated_artifact_code": () => exportAnnotatedArtifactCode(),
  "screen.annotated_image_url": () => annotatedImageUrl(),
} as const;
