import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExportPlan, createVisualDocument, type ExportPlan } from "@video-workbench/core";
import type { MediaAsset } from "@video-workbench/core/node";
import { probeMedia } from "../mediaCut";
import { assembleCut, composeFilm, runFfmpeg, verifyFilm } from "./compose";
import { MARKER_STRIP_HEIGHT } from "./overlayPage";

/** A real immutable local media fixture; never imports into a running project. */
async function createMediaFixture(root: string, fps: number, duration: number): Promise<string> {
  const source = join(root, "broll.mp4");
  await runFfmpeg([
    "-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=64x48:rate=${fps}:duration=${duration}`,
    "-an", "-frames:v", String(Math.round(duration * fps)), "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);
  const bytes = await readFile(source);
  const assetId = createHash("sha256").update(bytes).digest("hex");
  const probe = await probeMedia(source);
  const directory = join(root, ".chengfeng-videocut", "media", assetId);
  await mkdir(directory, { recursive: true });
  await copyFile(source, join(directory, "source.mp4"));
  const manifest: MediaAsset = {
    schemaVersion: 1, assetId, sha256: assetId, bytes: (await stat(source)).size,
    duration: Math.min(probe.duration, probe.videoDuration ?? 0),
    width: probe.width, height: probe.height, frameRate: probe.frameRate!,
    codec: "h264", hasAudio: false,
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  return assetId;
}

const fractionalMediaEdges = [
  { startFrame: 624, endFrame: 824, layerStart: 20.78, sourceOut: 6.66, nativeFrames: 160, sourceSeek: 0.02 },
  { startFrame: 4344, endFrame: 4633, layerStart: 144.7825, sourceOut: 9.625, nativeFrames: 231, sourceSeek: 0.0175 },
];

for (const edge of fractionalMediaEdges) {
  test(`fractional 24->30fps media edge seek=${edge.sourceSeek} preserves ${edge.endFrame - edge.startFrame} frames`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "compose-media-edge-")));
    try {
      const fps = 30;
      const frameCount = edge.endFrame + 3;
      const duration = frameCount / fps - 1 / 300;
      const sourceDuration = Math.ceil(duration) + 1;
      const source = join(root, "narration.wav");
      await runFfmpeg([
        "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=437:sample_rate=48000:duration=${sourceDuration}`,
        "-c:a", "pcm_s16le", source,
      ]);
      const assetId = await createMediaFixture(root, 24, edge.nativeFrames / 24);
      const media = { assetId, sourceIn: 0, sourceOut: edge.sourceOut, fit: "contain" as const, muted: true as const };
      const plan = buildExportPlan({
        editList: {
          schemaVersion: 1, projectId: "edge-fixture", baseTranscriptRevision: "none",
          baseCutsRevision: "none", mode: "manual", sourceDuration, duration,
          segments: [{ id: "speech", source: "narration.wav", sourceStart: 0, sourceEnd: duration, timelineStart: 0, trackId: "a-roll", playbackRate: 1 }],
        },
        words: [{ id: "edge", text: "edge", start: edge.layerStart, end: edge.layerStart + edge.sourceOut }],
        subtitles: null,
        visuals: { ...createVisualDocument("edge-fixture", "none"), layers: [{ id: "edge", wordIds: ["edge"], media }] },
        source: { width: 64, height: 48, frameRate: fps, duration: sourceDuration }, scale: 1, fps,
      });
      expect(plan.frameCount).toBe(frameCount);
      expect(plan.zoomSpans.map(span => [span.startFrame, span.endFrame, !!span.media])).toEqual([
        [0, edge.startFrame, false], [edge.startFrame, edge.endFrame, true], [edge.endFrame, frameCount, false],
      ]);
      expect(Number((plan.zoomSpans[1]!.startFrame / fps - plan.zoomSpans[1]!.media!.layerStart).toFixed(6))).toBe(edge.sourceSeek);
      // Check the generated fixture's decoded source count, not container duration alone.
      const native = await verifyFilm(join(root, ".chengfeng-videocut", "media", assetId, "source.mp4"), {
        ...plan, frameCount: edge.nativeFrames, fps: 24, duration: edge.nativeFrames / 24,
      });
      expect(native.frames).toBe(edge.nativeFrames);
      expect(native.problems).toEqual(["成片没有音频轨"]);
      const assembled = join(root, "assembled.mkv");
      await assembleCut({ source, output: assembled, plan, audioOnly: true });
      const base = await verifyFilm(assembled, plan);
      expect(base.frames).toBe(frameCount);
      expect(base.problems).toEqual([]);
      const spans = join(root, "spans");
      const output = join(root, "out.mp4");
      await composeFilm({ projectDirectory: root, assembled, framePattern: null, output, workDirectory: spans, plan, profile: "fast" });
      await assertComposedFrames(spans, output, plan);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
}

async function inspectEverySpan(directory: string, plan: ExportPlan) {
  const actual: Array<{ index: number; frames: number; problems: string[] }> = [];
  for (const [index, span] of plan.zoomSpans.entries()) {
    const count = span.endFrame - span.startFrame;
    const result = await verifyFilm(join(directory, `span-${String(index).padStart(3, "0")}.mp4`), {
      ...plan, duration: count / plan.fps, frameCount: count,
    });
    actual.push({ index, frames: result.frames, problems: result.problems });
  }
  return actual;
}

async function assertComposedFrames(directory: string, output: string, plan: ExportPlan) {
  // Read every span AND the joined file before asserting, so a failing report
  // distinguishes a short encoder span from frames lost by the final concat.
  const spans = await inspectEverySpan(directory, plan);
  const result = await verifyFilm(output, plan);
  expect({
    spans,
    sumSpanFrames: spans.reduce((sum, span) => sum + span.frames, 0),
    joinedFrames: result.frames,
    joinedProblems: result.problems,
    hasAudio: result.probe.hasAudio,
  }).toEqual({
    spans: plan.zoomSpans.map((span, index) => ({
      index, frames: span.endFrame - span.startFrame,
      // Compose spans intentionally omit audio; no other issue is allowed.
      problems: ["成片没有音频轨"],
    })),
    sumSpanFrames: plan.frameCount,
    joinedFrames: plan.frameCount,
    joinedProblems: [],
    hasAudio: true,
  });
}

for (const { mediaFps, duration } of [
  { mediaFps: 24, duration: 1.53 },
  { mediaFps: 30, duration: 1.53 },
  { mediaFps: 24, duration: 240.53 },
]) {
  for (const tailFrames of [1, 2, 3]) {
    test(`fractional mixed ${mediaFps}->30fps ${duration}s export preserves each span and its ${tailFrames}-frame base tail`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "compose-tail-")));
      try {
        const source = join(root, "narration.wav");
        const sourceDuration = Math.ceil(duration) + 1;
        await runFfmpeg([
          "-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=437:sample_rate=48000:duration=${sourceDuration}`,
          "-c:a", "pcm_s16le", source,
        ]);
        const sourceStart = 0.15025;
        // Fractional audio duration still has one exact rounded video frame count.
        const fps = 30;
        const frameCount = Math.round(duration * fps);
        const mediaStart = 0.117;
        const mediaEnd = (frameCount - tailFrames) / fps - 1 / 300;
        const sourceIn = 0.011;
        const sourceOut = sourceIn + mediaEnd - mediaStart;
        // End the clip at its first native frame boundary after the visible range.
        // A long spare source tail would hide EOF/resampling edge regressions.
        const mediaDuration = Math.ceil(sourceOut * mediaFps - 1e-8) / mediaFps;
        const assetId = await createMediaFixture(root, mediaFps, mediaDuration);
        const media = {
          assetId, sourceIn, sourceOut,
          fit: "contain" as const, muted: true as const,
        };
        const plan = buildExportPlan({
          editList: {
            schemaVersion: 1, projectId: "tail-fixture", baseTranscriptRevision: "none",
            baseCutsRevision: "none", mode: "manual", sourceDuration, duration,
            segments: [{
              id: "speech", source: "narration.wav", sourceStart, sourceEnd: sourceStart + duration,
              timelineStart: 0, trackId: "a-roll", playbackRate: 1,
            }],
          },
          words: [{ id: "broll", text: "broll", start: sourceStart + mediaStart, end: sourceStart + mediaEnd }],
          subtitles: null,
          visuals: { ...createVisualDocument("tail-fixture", "none"), layers: [{ id: "broll", wordIds: ["broll"], media }] },
          source: { width: 64, height: 48, frameRate: fps, duration: sourceDuration }, scale: 1, fps,
        });
        expect(plan.frameCount).toBe(frameCount);
        expect(plan.zoomSpans.map(span => [span.startFrame, span.endFrame, !!span.media])).toEqual([
          [0, 4, false], [4, frameCount - tailFrames, true], [frameCount - tailFrames, frameCount, false],
        ]);
        expect(plan.zoomSpans.reduce((sum, span) => sum + span.endFrame - span.startFrame, 0)).toBe(frameCount);

        const assembled = join(root, "assembled.mkv");
        await assembleCut({ source, output: assembled, plan, audioOnly: true });
        const assembledResult = await verifyFilm(assembled, plan);
        expect(assembledResult.frames).toBe(frameCount);
        expect(assembledResult.problems).toEqual([]);

        const spans = join(root, "spans");
        const output = join(root, "out.mp4");
        await composeFilm({
          projectDirectory: root, assembled, framePattern: null, output,
          workDirectory: spans, plan, profile: "fast",
        });
        await assertComposedFrames(spans, output, plan);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
}

test("frame-index overlays stay aligned across media boundaries and narration PCM matches the reference AAC", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "compose-overlay-edge-")));
  try {
    const width = 64, height = 48, fps = 30, frameCount = 36;
    const source = join(root, "narration.wav");
    await runFfmpeg([
      "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=437:sample_rate=48000:duration=2",
      "-c:a", "pcm_s16le", source,
    ]);
    const assetId = await createMediaFixture(root, 24, 25 / 24);
    const media = { assetId, sourceIn: 0.02, sourceOut: 0.993, fit: "contain" as const, muted: true as const };
    const plan = buildExportPlan({
      editList: {
        schemaVersion: 1, projectId: "overlay-fixture", baseTranscriptRevision: "none", baseCutsRevision: "none",
        mode: "manual", sourceDuration: 2, duration: 1.2,
        segments: [{ id: "speech", source: "narration.wav", sourceStart: 0.15025, sourceEnd: 1.35025, timelineStart: 0, trackId: "a-roll", playbackRate: 1 }],
      },
      words: [{ id: "media", text: "media", start: 0.26725, end: 1.24025 }],
      subtitles: null,
      visuals: { ...createVisualDocument("overlay-fixture", "none"), layers: [{ id: "media", wordIds: ["media"], media }] },
      source: { width, height, duration: 2, frameRate: fps }, scale: 1, fps,
    });
    expect(plan.frameCount).toBe(frameCount);
    expect(plan.zoomSpans.map(span => [span.startFrame, span.endFrame, !!span.media])).toEqual([
      [0, 4, false], [4, 33, true], [33, 36, false],
    ]);

    // Synthetic renderer output: the real marker-strip geometry plus six
    // opaque black/white bit cells identifying every absolute timeline frame.
    // All remaining pixels are transparent, leaving the real base/media visible.
    const overlayHeight = height + MARKER_STRIP_HEIGHT;
    const rgba = Buffer.alloc(frameCount * width * overlayHeight * 4);
    for (let frame = 0; frame < frameCount; frame++) {
      const offset = frame * width * overlayHeight * 4;
      for (let y = 0; y < MARKER_STRIP_HEIGHT; y++) for (let x = 0; x < width; x++) {
        const p = offset + (y * width + x) * 4;
        rgba[p] = frame; rgba[p + 2] = 199; rgba[p + 3] = 255;
      }
      for (let bit = 0; bit < 6; bit++) for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) {
        const p = offset + ((y + MARKER_STRIP_HEIGHT) * width + bit * 8 + x) * 4;
        const value = frame & (1 << bit) ? 235 : 20;
        rgba[p] = value; rgba[p + 1] = value; rgba[p + 2] = value; rgba[p + 3] = 255;
      }
    }
    const rgbaPath = join(root, "overlay.rgba");
    await writeFile(rgbaPath, rgba);
    const overlayDirectory = join(root, "overlay");
    await mkdir(overlayDirectory);
    const framePattern = join(overlayDirectory, "frame-%06d.png");
    await runFfmpeg([
      "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s:v", `${width}x${overlayHeight}`,
      "-framerate", String(fps), "-i", rgbaPath, "-frames:v", String(frameCount), "-start_number", "0", framePattern,
    ]);
    const assembled = join(root, "assembled.mkv");
    await assembleCut({ source, output: assembled, plan, audioOnly: true });
    const output = join(root, "out.mp4");
    const spans = join(root, "spans");
    await composeFilm({ projectDirectory: root, assembled, framePattern, output, workDirectory: spans, plan, profile: "fast" });
    await assertComposedFrames(spans, output, plan);

    const rgbPath = join(root, "decoded.rgb");
    await runFfmpeg(["-y", "-v", "error", "-i", output, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", rgbPath]);
    const rgb = await readFile(rgbPath);
    expect(rgb.length).toBe(frameCount * width * height * 3);
    for (const frame of [0, 3, 4, 5, 31, 32, 33, 34, 35]) {
      let decodedIndex = 0;
      for (let bit = 0; bit < 6; bit++) {
        const p = (frame * width * height + 8 * width + bit * 8 + 4) * 3;
        const luminance = (rgb[p]! + rgb[p + 1]! + rgb[p + 2]!) / 3;
        if (luminance > 127) decodedIndex |= 1 << bit;
      }
      expect(decodedIndex, `absolute frame index at ${frame}`).toBe(frame);
      const lowerPixels: number[] = [];
      for (let y = 32; y < height; y++) for (let x = 48; x < width; x++) {
        const p = (frame * width * height + y * width + x) * 3;
        lowerPixels.push(rgb[p]!, rgb[p + 1]!, rgb[p + 2]!);
      }
      if (frame < 4 || frame >= 33) expect(lowerPixels.every(value => value > 230)).toBe(true);
      else expect(lowerPixels.some(value => value < 100)).toBe(true);
    }

    // Encode the same assembled narration with exactly composeFilm's AAC
    // settings. Comparing decoded samples catches changed content or offsets
    // without pretending lossy AAC equals the original uncompressed WAV.
    const reference = join(root, "reference.m4a");
    await runFfmpeg([
      "-y", "-v", "error", "-i", assembled, "-map", "0:a:0", "-c:a", "aac", "-b:a", "256k", reference,
    ]);
    const pcms: Buffer[] = [];
    for (const [name, input] of [["actual", output], ["reference", reference]] as const) {
      const path = join(root, `${name}.pcm`);
      await runFfmpeg(["-y", "-v", "error", "-i", input, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", path]);
      pcms.push(await readFile(path));
    }
    expect(pcms[0]!.length).toBeGreaterThan(0);
    expect(pcms[0]!.length).toBe(pcms[1]!.length);
    expect(createHash("sha256").update(pcms[0]!).digest("hex")).toBe(createHash("sha256").update(pcms[1]!).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
