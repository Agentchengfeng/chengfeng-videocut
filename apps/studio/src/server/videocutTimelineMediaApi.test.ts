/// <reference types="node" />

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TIMELINE_FRAME_MAX_TIME_SECONDS,
  createVideocutTimelineMediaHandler,
  isVideocutTimelineMediaRequest,
  type TimelineFrameExtraction,
} from "./videocutTimelineMediaApi";

const JPEG = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "videocut-timeline-frame-"));
  cleanupPaths.push(root);
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  const inputDir = join(projectDir, "input");
  const cacheDir = join(root, "cache", "timeline-media");
  const sourcePath = join(inputDir, "source.mp4");
  await mkdir(inputDir, { recursive: true });
  await writeFile(join(projectDir, "project.json"), JSON.stringify({ jobId: "demo" }));
  await writeFile(sourcePath, "fixture source remains untouched");
  return { root, projectsDir, projectDir, cacheDir, sourcePath };
}

function frameUrl(
  overrides: Partial<{ projectId: string; source: string; time: string; width: string }> = {},
): string {
  const projectId = overrides.projectId ?? "demo";
  const query = new URLSearchParams({
    source: overrides.source ?? "input/source.mp4",
    time: overrides.time ?? "1.2344",
    width: overrides.width ?? "160",
  });
  return `http://localhost/api/v1/projects/${projectId}/media/frame?${query}`;
}

function waveformUrl(
  overrides: Partial<{ projectId: string; source: string }> = {},
): string {
  const projectId = overrides.projectId ?? "demo";
  const query = new URLSearchParams({ source: overrides.source ?? "input/source.mp4" });
  return `http://localhost/api/v1/projects/${projectId}/media/waveform?${query}`;
}

async function required(value: Promise<Response | null>): Promise<Response> {
  const response = await value;
  if (!response) throw new Error("Expected timeline media handler response");
  return response;
}

describe("videocut Timeline frame API", () => {
  it("deduplicates in-flight work, persists only disposable cache, and supports HEAD/ETag", async () => {
    const { projectsDir, projectDir, cacheDir, sourcePath } = await fixture();
    const sourceBefore = await readFile(sourcePath, "utf8");
    const projectEntriesBefore = await readdir(projectDir);
    let extractionCount = 0;
    let releaseExtraction = (): void => undefined;
    const extractionStarted = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    let allowExtraction = (): void => undefined;
    const extractionAllowed = new Promise<void>((resolve) => {
      allowExtraction = resolve;
    });
    const inputs: TimelineFrameExtraction[] = [];
    const handle = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractFrame(input) {
        extractionCount += 1;
        inputs.push(input);
        releaseExtraction();
        await extractionAllowed;
        await writeFile(input.targetPath, JPEG);
      },
    });

    const firstPending = required(handle(new Request(frameUrl())));
    const secondPending = required(handle(new Request(frameUrl())));
    await extractionStarted;
    allowExtraction();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(extractionCount).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ time: 1.234, width: 160 });
    expect(inputs[0].sourcePath).toBe(await realpath(sourcePath));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/jpeg");
    expect(first.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(JPEG);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(JPEG);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"frame-[a-f0-9]{64}"$/);

    const head = await required(handle(new Request(frameUrl(), { method: "HEAD" })));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(JPEG.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(extractionCount).toBe(1);

    const notModified = await required(handle(new Request(frameUrl(), {
      headers: { "If-None-Match": etag ?? "" },
    })));
    expect(notModified.status).toBe(304);
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);
    expect(extractionCount).toBe(1);

    expect((await readdir(join(cacheDir, "frames"))).filter((name) => name.endsWith(".jpg")))
      .toHaveLength(1);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    expect(await readdir(projectDir)).toEqual(projectEntriesBefore);
  });

  it("rejects unsafe paths, unsupported media, invalid bounds, and project-local cache", async () => {
    const { root, projectsDir, projectDir, cacheDir } = await fixture();
    let extractionCount = 0;
    const handle = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractFrame(input) {
        extractionCount += 1;
        await writeFile(input.targetPath, JPEG);
      },
    });
    const outside = join(root, "outside.mp4");
    await writeFile(outside, "outside");
    await symlink(outside, join(projectDir, "input", "escape.mp4"));

    const requests = [
      frameUrl({ source: "../outside.mp4" }),
      frameUrl({ source: outside }),
      frameUrl({ source: "input\\source.mp4" }),
      frameUrl({ source: "input/source.mp3" }),
      frameUrl({ source: "input/escape.mp4" }),
      frameUrl({ time: "-1" }),
      frameUrl({ time: String(TIMELINE_FRAME_MAX_TIME_SECONDS + 0.001) }),
      frameUrl({ time: "1e3" }),
      frameUrl({ width: "47" }),
      frameUrl({ width: "641" }),
      frameUrl({ width: "160.5" }),
      frameUrl({ projectId: "%2Ftmp" }),
    ];
    const responses = await Promise.all(
      requests.map((url) => required(handle(new Request(url)))),
    );
    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 415, 404, 400, 400, 400, 400, 400, 400, 400,
    ]);
    expect(extractionCount).toBe(0);

    const method = await required(handle(new Request(frameUrl(), { method: "POST" })));
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");

    const unsafeCache = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir: join(projectDir, ".cache"),
      async extractFrame() { extractionCount += 1; },
    });
    const cacheResponse = await required(unsafeCache(new Request(frameUrl())));
    expect(cacheResponse.status).toBe(500);
    expect(await cacheResponse.json()).toMatchObject({
      error: { code: "invalid_cache_location" },
    });
    expect(extractionCount).toBe(0);

    await mkdir(cacheDir, { recursive: true });
    await symlink(projectDir, join(cacheDir, "frames"));
    const escapedCache = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractFrame() { extractionCount += 1; },
    });
    const escapedCacheResponse = await required(escapedCache(new Request(frameUrl())));
    expect(escapedCacheResponse.status).toBe(500);
    expect(await escapedCacheResponse.json()).toMatchObject({
      error: { code: "invalid_cache_location" },
    });
    expect(extractionCount).toBe(0);
  });

  it("returns stable recoverable errors for FFmpeg absence and invalid output", async () => {
    const { projectsDir, cacheDir } = await fixture();
    const unavailable = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractFrame() {
        throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
      },
    });
    const unavailableResponse = await required(unavailable(new Request(frameUrl())));
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toMatchObject({
      error: { code: "ffmpeg_unavailable" },
    });

    const invalid = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractFrame(input) {
        await writeFile(input.targetPath, "not a JPEG");
      },
    });
    const invalidResponse = await required(invalid(new Request(frameUrl())));
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toMatchObject({
      error: { code: "frame_not_available" },
    });
    expect((await readdir(cacheDir)).filter((name) => name.endsWith(".tmp.jpg"))).toEqual([]);
  });

  it("deduplicates one real waveform source and keeps its cache outside the project", async () => {
    const { projectsDir, projectDir, cacheDir, sourcePath } = await fixture();
    const sourceBefore = await readFile(sourcePath, "utf8");
    const projectEntriesBefore = await readdir(projectDir);
    let extractionCount = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started = (): void => undefined;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const handle = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractWaveform() {
        extractionCount += 1;
        started();
        await gate;
        return [0, 0.25, 0.75, 1];
      },
    });

    const firstPending = required(handle(new Request(waveformUrl())));
    const secondPending = required(handle(new Request(waveformUrl())));
    await didStart;
    release();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect(extractionCount).toBe(1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({
      schemaVersion: 1,
      projectId: "demo",
      source: "input/source.mp4",
      peakCount: 4,
      peaks: [0, 0.25, 0.75, 1],
    });
    const etag = second.headers.get("etag");
    expect(etag).toMatch(/^"waveform-[a-f0-9]{64}"$/);
    const head = await required(handle(new Request(waveformUrl(), { method: "HEAD" })));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    const notModified = await required(handle(new Request(waveformUrl(), {
      headers: { "If-None-Match": etag ?? "" },
    })));
    expect(notModified.status).toBe(304);
    expect(extractionCount).toBe(1);
    expect((await readdir(join(cacheDir, "waveforms"))).filter((name) => name.endsWith(".json")))
      .toHaveLength(1);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
    expect(await readdir(projectDir)).toEqual(projectEntriesBefore);
  });

  it("distinguishes no_audio from waveform decode failure", async () => {
    const { projectsDir, cacheDir } = await fixture();
    const noAudio = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractWaveform() {
        throw Object.assign(new Error("fixture has no audio"), { code: "no_audio" });
      },
    });
    const response = await required(noAudio(new Request(waveformUrl())));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "no_audio" } });

    const invalid = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      async extractWaveform() { return []; },
    });
    const invalidResponse = await required(invalid(new Request(waveformUrl())));
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toMatchObject({
      error: { code: "waveform_not_available" },
    });
  });

  it("limits frame and waveform FFmpeg work across keys and reclaims the disk cache", async () => {
    const { projectsDir, cacheDir } = await fixture();
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const work = async <T>(result: T): Promise<T> => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return result;
    };
    const handle = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      ffmpegConcurrency: 2,
      maxCacheEntries: 2,
      maxCacheBytes: 1_024,
      async extractFrame(input) {
        await work(undefined);
        await writeFile(input.targetPath, JPEG);
      },
      async extractWaveform() {
        return work([0.1, 0.4, 0.8]);
      },
    });
    const responses = await Promise.all([
      required(handle(new Request(frameUrl({ time: "0.1" })))),
      required(handle(new Request(frameUrl({ time: "0.2" })))),
      required(handle(new Request(frameUrl({ time: "0.3" })))),
      required(handle(new Request(waveformUrl()))),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(started).toBe(4);
    expect(maximumActive).toBe(2);
    const cached = [
      ...(await readdir(join(cacheDir, "frames"))).filter((name) => name.endsWith(".jpg")),
      ...(await readdir(join(cacheDir, "waveforms"))).filter((name) => name.endsWith(".json")),
    ];
    expect(cached.length).toBeLessThanOrEqual(2);
  });

  it("touches disk cache hits so reclamation keeps recently used frames", async () => {
    const { projectsDir, cacheDir } = await fixture();
    let extractionCount = 0;
    const handle = createVideocutTimelineMediaHandler({
      projectsDir,
      cacheDir,
      maxCacheEntries: 2,
      maxCacheBytes: 1_024,
      async extractFrame(input) {
        extractionCount += 1;
        await writeFile(input.targetPath, JPEG);
      },
    });
    const get = (time: string) => required(handle(new Request(frameUrl({ time }))));
    await get("0.1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await get("0.2");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await get("0.1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await get("0.3");
    expect(extractionCount).toBe(3);

    await get("0.1");
    expect(extractionCount).toBe(3);
    await get("0.2");
    expect(extractionCount).toBe(4);
  });

  it("ignores unrelated routes", async () => {
    const { projectsDir, cacheDir } = await fixture();
    const handle = createVideocutTimelineMediaHandler({ projectsDir, cacheDir });
    expect(isVideocutTimelineMediaRequest("/api/v1/projects/demo/media/frame")).toBe(true);
    expect(isVideocutTimelineMediaRequest("/api/v1/projects/demo/media/waveform")).toBe(true);
    expect(isVideocutTimelineMediaRequest("/api/projects/demo/preview/input/source.mp4")).toBe(false);
    expect(await handle(new Request("http://localhost/api/health"))).toBeNull();
  });

  const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  (ffmpegAvailable ? it : it.skip)("extracts different decodable JPEGs from real source PTS", async () => {
    const { projectsDir, projectDir, cacheDir, sourcePath } = await fixture();
    const generated = spawnSync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc2=duration=1:size=160x90:rate=10",
      "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-shortest",
      "-c:v", "mpeg4",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      sourcePath,
    ], { encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    const handle = createVideocutTimelineMediaHandler({ projectsDir, cacheDir });

    const first = await required(handle(new Request(frameUrl({ time: "0.1", width: "96" }))));
    const later = await required(handle(new Request(frameUrl({ time: "0.7", width: "96" }))));
    const firstBody = new Uint8Array(await first.arrayBuffer());
    const laterBody = new Uint8Array(await later.arrayBuffer());
    expect(first.status).toBe(200);
    expect(later.status).toBe(200);
    expect(firstBody[0]).toBe(0xff);
    expect(firstBody[1]).toBe(0xd8);
    expect(firstBody.at(-2)).toBe(0xff);
    expect(firstBody.at(-1)).toBe(0xd9);
    expect(Buffer.compare(Buffer.from(firstBody), Buffer.from(laterBody))).not.toBe(0);

    const waveform = await required(handle(new Request(waveformUrl())));
    expect(waveform.status).toBe(200);
    const waveformBody = await waveform.json() as { peakCount: number; peaks: number[] };
    expect(waveformBody.peakCount).toBeGreaterThan(0);
    expect(waveformBody.peaks).toHaveLength(waveformBody.peakCount);
    expect(Math.max(...waveformBody.peaks)).toBeGreaterThan(0);

    const noAudioPath = join(projectDir, "input", "no-audio.mp4");
    const generatedNoAudio = spawnSync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:size=160x90:rate=10:duration=0.5",
      "-c:v", "mpeg4",
      "-pix_fmt", "yuv420p",
      noAudioPath,
    ], { encoding: "utf8" });
    expect(generatedNoAudio.status, generatedNoAudio.stderr).toBe(0);
    const noAudio = await required(handle(new Request(waveformUrl({
      source: "input/no-audio.mp4",
    }))));
    expect(noAudio.status).toBe(422);
    expect(await noAudio.json()).toMatchObject({ error: { code: "no_audio" } });
  });
});
