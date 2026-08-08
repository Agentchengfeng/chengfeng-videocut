import { afterEach, describe, expect, it } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportPlan } from "@video-workbench/core";
import { ensureRendererRuntime } from "./renderer-runtime";
import { MARKER_MAGIC_BLUE } from "./overlayPage";
import { markerColor, renderOverlayFrames } from "./overlayRenderer";

const cleanup: string[] = [];
const runManagedRendererE2E = process.env.CHENGFENG_VIDEOCUT_RENDERER_E2E === "1" ? it : it.skip;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function minimalPlan(): ExportPlan {
  return {
    duration: 2 / 24,
    fps: 24,
    frameCount: 2,
    source: { width: 64, height: 64 },
    output: { width: 64, height: 64 },
    spans: [],
    zoomSpans: [],
    subtitleStyle: null,
    subtitleCues: [{ cueId: "cue-1", text: "测试", start: 0, end: 2 / 24 }],
    layers: [],
    warnings: [],
  };
}

describe("Product-managed Headless Shell overlay renderer", () => {
  runManagedRendererE2E("downloads once, reuses the verified cache, and renders fixed-seek PNG frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "videocut-managed-renderer-e2e-"));
    cleanup.push(root);
    const dataDirectory = join(root, "data");
    const projectDirectory = join(root, "project");
    const firstFrames = join(projectDirectory, "frames-first");
    const secondFrames = join(projectDirectory, "frames-second");
    const previousDataDirectory = process.env.CHENGFENG_VIDEOCUT_DATA_DIR;
    const previousHome = process.env.CHENGFENG_VIDEOCUT_HOME;
    const previousOverride = process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
    process.env.CHENGFENG_VIDEOCUT_DATA_DIR = dataDirectory;
    delete process.env.CHENGFENG_VIDEOCUT_HOME;
    delete process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
    try {
      const first = await ensureRendererRuntime({ dataDirectory });
      const second = await ensureRendererRuntime({ dataDirectory });
      expect(first.source).toBe("download");
      expect(second.source).toBe("cache");
      expect(second.executablePath).toBe(first.executablePath);
      expect((await lstat(first.executablePath)).isFile()).toBe(true);

      for (const framesDirectory of [firstFrames, secondFrames]) {
        const result = await renderOverlayFrames({
          plan: minimalPlan(),
          projectDirectory,
          framesDirectory,
        });
        expect(result.frameCount).toBe(2);
        for (const [index, token] of [1, 2].entries()) {
          const frame = join(framesDirectory, `${String(index).padStart(6, "0")}.png`);
          expect(markerColor(await readFile(frame))).toEqual({
            r: token,
            g: 0,
            b: MARKER_MAGIC_BLUE,
          });
        }
      }
    } finally {
      if (previousDataDirectory === undefined) delete process.env.CHENGFENG_VIDEOCUT_DATA_DIR;
      else process.env.CHENGFENG_VIDEOCUT_DATA_DIR = previousDataDirectory;
      if (previousHome === undefined) delete process.env.CHENGFENG_VIDEOCUT_HOME;
      else process.env.CHENGFENG_VIDEOCUT_HOME = previousHome;
      if (previousOverride === undefined) delete process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
      else process.env.CHENGFENG_VIDEOCUT_CHROME_PATH = previousOverride;
    }
  }, 180_000);
});
