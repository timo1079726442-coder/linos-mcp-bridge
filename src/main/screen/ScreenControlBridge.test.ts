import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      toJPEG: () => Buffer.from("jpeg-bytes"),
      resize: () => ({
        getSize: () => ({ width: 800, height: 600 }),
        toJPEG: () => Buffer.from("jpeg-bytes"),
      }),
    })),
  },
}));

const renderAnnotatedPng = vi.fn(async (_dataUrl: string, marks: unknown[]) => {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marks.length]);
});

vi.mock("./ScreenAnnotationRenderer.js", () => ({
  renderAnnotatedPng: (dataUrl: string, marks: unknown[]) => renderAnnotatedPng(dataUrl, marks),
}));

import {
  annotatedImageUrl,
  annotateLatestImage,
  configureScreenBridge,
  exportAnnotatedArtifactCode,
  exportAnnotatedImage,
  selectLatest,
} from "./ScreenControlBridge.js";

let stateRoot: string;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(tmpdir(), "c2c-screen-annotate-"));
  configureScreenBridge(stateRoot);
  await mkdir(path.join(stateRoot, "screen", "frames"), { recursive: true });
  await writeFile(path.join(stateRoot, "screen", "frames", "frame1.png"), Buffer.from("png"));
  renderAnnotatedPng.mockClear();
});

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

describe("ScreenControlBridge annotations", () => {
  it("在最新帧上合成标注并另存，不覆盖原帧", async () => {
    await selectLatest({ frameId: "frame1" });
    const annotated = await annotateLatestImage({
      marks: [{ kind: "box", x: 10, y: 20 }, { kind: "text", x: 30, y: 40, text: "注意" }],
    });
    expect(annotated.marks).toBe(2);
    expect(annotated.width).toBe(800);
    expect(annotated.height).toBe(600);
    expect(annotated.sourceFrameId).toBe("frame1");
    expect(await stat(annotated.filePath).then((s) => s.isFile())).toBe(true);
    expect((await readFile(annotated.filePath))[8]).toBe(2);
    expect((await readFile(path.join(stateRoot, "screen", "frames", "frame1.png"), "utf8"))).toBe("png");
    expect(renderAnnotatedPng).toHaveBeenCalledTimes(1);
    expect(String(renderAnnotatedPng.mock.calls[0]![0])).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("导出、Markdown 与 file URL 都指向标注图", async () => {
    await selectLatest({ frameId: "frame1" });
    const annotated = await annotateLatestImage({ marks: [] });
    const url = await annotatedImageUrl();
    expect(url.url).toBe(`file:///${annotated.filePath.replaceAll("\\", "/")}`);
    const code = await exportAnnotatedArtifactCode();
    expect(code.markdown).toContain("![annotation]");
    expect(code.markdown).toContain(annotated.filePath.replaceAll("\\", "/"));

    const exported = await exportAnnotatedImage({});
    expect(await stat(exported.filePath).then((s) => s.isFile())).toBe(true);
  });

  it("导出到工作区外会被拒绝", async () => {
    await mkdir(path.join(stateRoot, "ws"), { recursive: true });
    await writeFile(path.join(stateRoot, "active-profile.json"), JSON.stringify({ profileId: "mb_pf_test" }));
    await mkdir(path.join(stateRoot, "profiles", "mb_pf_test"), { recursive: true });
    await writeFile(path.join(stateRoot, "profiles", "mb_pf_test", "config.json"), JSON.stringify({
      profileId: "mb_pf_test",
      profileName: "T",
      profileType: "custom",
      currentWorkspace: { root: path.join(stateRoot, "ws"), workspaceId: "0123456789ab" },
    }));

    await selectLatest({ frameId: "frame1" });
    await annotateLatestImage({ marks: [] });
    const inside = path.join(stateRoot, "ws", "shot.png");
    const ok = await exportAnnotatedImage({ targetPath: inside });
    expect(ok.filePath).toBe(inside);
    await expect(exportAnnotatedImage({ targetPath: path.join(stateRoot, "outside.png") }))
      .rejects.toThrow(/EXPORT_PATH_OUTSIDE_WORKSPACE/);
  });

  it("没有最新帧或没有标注图时明确失败", async () => {
    await expect(annotateLatestImage({ marks: [] })).rejects.toThrow(/NO_FRAME_YET/);
    await selectLatest({ frameId: "frame1" });
    await expect(exportAnnotatedImage({})).rejects.toThrow(/SCREEN_ANNOTATED_FRAME_MISSING/);
    await expect(annotatedImageUrl()).rejects.toThrow(/SCREEN_ANNOTATED_FRAME_MISSING/);
  });
});
