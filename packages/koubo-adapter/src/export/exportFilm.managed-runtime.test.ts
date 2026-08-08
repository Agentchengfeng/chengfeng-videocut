import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExportPlan } from "@video-workbench/core";
import { exportFilm } from "./index";
import { MARKER_MAGIC_BLUE } from "./overlayPage";
import { markerColor } from "./overlayRenderer";
import { ensureRendererRuntime } from "./renderer-runtime";

const cleanup: string[] = [];
const runManagedRendererE2E = process.env.CHENGFENG_VIDEOCUT_RENDERER_E2E === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function shortOverlayPlan(): ExportPlan {
  return {
    duration: 2,
    fps: 15,
    frameCount: 30,
    source: { width: 320, height: 180 },
    output: { width: 320, height: 180 },
    spans: [{ sourceStart: 0, sourceEnd: 2 }],
    zoomSpans: [{ start: 0, end: 2, startFrame: 0, endFrame: 30, box: null }],
    subtitleStyle: null,
    subtitleCues: [{ cueId: "preview-caption", text: "完整导出验证", start: 0, end: 2 }],
    layers: [],
    warnings: [],
  };
}

describe("Product-managed Headless Shell full export", () => {
  runManagedRendererE2E("downloads on the first overlay export, caches the engine, and produces a verified MP4", async () => {
    const root = await mkdtemp(join(tmpdir(), "videocut-full-export-e2e-"));
    cleanup.push(root);
    const dataDirectory = join(root, "renderer-data");
    const projectDirectory = join(root, "project");
    const workDirectory = join(root, "work");
    const outputPath = join(root, "final-with-subtitle.mp4");
    const sourcePath = resolve(
      import.meta.dir,
      "../../../../apps/studio/tests/e2e/fixtures/design-panel-qa/assets/test.mp4",
    );
    await mkdir(projectDirectory, { recursive: true });

    const previousDataDirectory = process.env.CHENGFENG_VIDEOCUT_DATA_DIR;
    const previousHome = process.env.CHENGFENG_VIDEOCUT_HOME;
    const previousOverride = process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
    process.env.CHENGFENG_VIDEOCUT_DATA_DIR = dataDirectory;
    delete process.env.CHENGFENG_VIDEOCUT_HOME;
    delete process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
    try {
      const result = await exportFilm({
        projectDirectory,
        sourcePath,
        plan: shortOverlayPlan(),
        outputPath,
        workDirectory,
        keepWork: true,
      });

      const cached = await ensureRendererRuntime({ dataDirectory });
      expect(cached.source).toBe("cache");
      expect(result.frameCount).toBe(30);
      expect(result.problems).toEqual([]);
      expect(result.probe).toMatchObject({
        duration: 2,
        hasVideo: true,
        hasAudio: true,
        width: 320,
        height: 180,
        frameRate: 15,
      });
      expect(markerColor(await readFile(join(workDirectory, "overlay", "000000.png")))).toEqual({
        r: 1,
        g: 0,
        b: MARKER_MAGIC_BLUE,
      });
    } finally {
      if (previousDataDirectory === undefined) delete process.env.CHENGFENG_VIDEOCUT_DATA_DIR;
      else process.env.CHENGFENG_VIDEOCUT_DATA_DIR = previousDataDirectory;
      if (previousHome === undefined) delete process.env.CHENGFENG_VIDEOCUT_HOME;
      else process.env.CHENGFENG_VIDEOCUT_HOME = previousHome;
      if (previousOverride === undefined) delete process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
      else process.env.CHENGFENG_VIDEOCUT_CHROME_PATH = previousOverride;
    }
  }, 240_000);
});
