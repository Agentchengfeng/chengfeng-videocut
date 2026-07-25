import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cutVideoByRanges,
  cutVideoBySegments,
  keepSegmentsForCuts,
  mergeCutRanges,
  normalizeOrderedMediaSegments,
  probeMedia,
} from "./mediaCut";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function command(name: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(name, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`${name} exited with ${code}`)));
  });
}

async function commandOutput(name: string, args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout))
      : reject(new Error(`${name} exited with ${code}: ${stderr.trim()}`)));
  });
}

async function sampleRgb(path: string, seconds: number): Promise<[number, number, number]> {
  const frame = await commandOutput("ffmpeg", [
    "-v", "error", "-i", path,
    "-ss", seconds.toFixed(3),
    "-frames:v", "1",
    "-vf", "scale=1:1:flags=neighbor,format=rgb24",
    "-f", "rawvideo", "pipe:1",
  ]);
  if (frame.length < 3) throw new Error(`No RGB frame at ${seconds}s`);
  return [frame[0] ?? 0, frame[1] ?? 0, frame[2] ?? 0];
}

function expectDominantChannel(
  pixel: readonly [number, number, number],
  channel: 0 | 1 | 2,
): void {
  const competing = pixel.filter((_, index) => index !== channel);
  expect(pixel[channel]).toBeGreaterThan(80);
  expect(pixel[channel]).toBeGreaterThan(Math.max(...competing) + 40);
}

function estimateFrequency(
  pcm: Buffer,
  startSeconds: number,
  durationSeconds: number,
  sampleRate = 48_000,
): number {
  const firstSample = Math.floor(startSeconds * sampleRate);
  const lastSample = Math.min(
    Math.floor((startSeconds + durationSeconds) * sampleRate),
    Math.floor(pcm.length / 2),
  );
  if (lastSample - firstSample < 2) throw new Error("PCM sample window is empty");
  let previous = pcm.readInt16LE(firstSample * 2);
  let positiveCrossings = 0;
  for (let sample = firstSample + 1; sample < lastSample; sample += 1) {
    const current = pcm.readInt16LE(sample * 2);
    if (previous <= 0 && current > 0) positiveCrossings += 1;
    previous = current;
  }
  return positiveCrossings / ((lastSample - firstSample) / sampleRate);
}

describe("media cut", () => {
  it("merges close cut ranges and derives retained segments", () => {
    const ranges = mergeCutRanges([
      { start: 3.01, end: 4 },
      { start: 1, end: 2 },
      { start: 2.15, end: 2.8 },
    ], 5);
    expect(ranges).toEqual([{ start: 1, end: 2.8 }, { start: 3.01, end: 4 }]);
    expect(keepSegmentsForCuts(ranges, 5)).toEqual([
      { start: 0, end: 1 },
      { start: 2.8, end: 3.01 },
      { start: 4, end: 5 },
    ]);
  });

  it("preserves authored EDL order while validating retained source ranges", () => {
    expect(normalizeOrderedMediaSegments([
      { start: 4, end: 5 },
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ], 5)).toEqual([
      { start: 4, end: 5 },
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
    expect(() => normalizeOrderedMediaSegments([{ start: 1, end: 1.01 }], 5)).toThrow(
      "Invalid edit-list segment #0",
    );
    expect(() => normalizeOrderedMediaSegments([{ start: 4, end: 6 }], 5)).toThrow(
      "Invalid edit-list segment #0",
    );
  });

  it("physically cuts a real audio-video fixture and retains its audio stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-media-"));
    cleanup.push(root);
    const input = join(root, "source.mp4");
    const output = join(root, "source_cut.mp4");
    await command("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", input,
    ]);

    const sourceProbe = await probeMedia(input);
    const result = await cutVideoByRanges({
      input,
      output,
      ranges: [{ start: 0.5, end: 1 }],
      concurrency: 1,
    });
    const probe = await probeMedia(output);

    expect(result.hasAudio).toBe(true);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(sourceProbe.frameRate).toBeCloseTo(30, 3);
    expect(probe.duration).toBeGreaterThan(1.35);
    expect(probe.duration).toBeLessThan(1.7);
    expect(result.deletedDuration).toBeGreaterThan(0.35);
  }, 20_000);

  it("exports many authored audio-video segments in order with one bounded-duration result", async () => {
    const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-edl-media-"));
    cleanup.push(root);
    const input = join(root, "source.mp4");
    const output = join(root, "source_cut.mp4");
    await command("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:size=160x120:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=1",
      "-f", "lavfi", "-i", "color=c=green:size=160x120:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
      "-f", "lavfi", "-i", "color=c=blue:size=160x120:rate=30:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=1",
      "-filter_complex",
      "[0:v][1:a][2:v][3:a][4:v][5:a]concat=n=3:v=1:a=1[v][a]",
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k",
      input,
    ]);

    const colorCycle = [
      { start: 0.1, end: 0.7 },
      { start: 1.1, end: 1.7 },
      { start: 2.1, end: 2.7 },
    ];
    const segments = Array.from({ length: 4 }, () => colorCycle)
      .flat()
      .map((segment) => ({ ...segment }));
    const mathematicalDuration = segments.reduce(
      (total, segment) => total + segment.end - segment.start,
      0,
    );
    // Two 30 fps frames plus one 48 kHz AAC frame cover container timestamp
    // quantization without permitting per-segment encoder padding to accumulate.
    const durationToleranceSeconds = 2 / 30 + 1024 / 48_000;

    const result = await cutVideoBySegments({ input, output, segments });
    const probe = await probeMedia(output);

    expect(result.hasAudio).toBe(true);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    const decodedAudio = await commandOutput("ffmpeg", [
      "-v", "error", "-i", output,
      "-map", "0:a:0", "-ac", "1", "-ar", "48000",
      "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ]);
    expect(decodedAudio.length).toBeGreaterThan(1_000);
    expect(decodedAudio.some((byte) => byte !== 0)).toBe(true);
    const audioFrequencies = [0.2, 0.8, 1.4]
      .map((start) => estimateFrequency(decodedAudio, start, 0.2));
    for (const [index, frequency] of audioFrequencies.entries()) {
      expect(Math.abs(frequency - [220, 440, 660][index]!)).toBeLessThan(35);
    }
    expect(Math.abs(probe.duration - mathematicalDuration))
      .toBeLessThanOrEqual(durationToleranceSeconds);
    expect(Math.abs(result.newDuration - mathematicalDuration))
      .toBeLessThanOrEqual(durationToleranceSeconds);

    const sampleChannels: Array<0 | 1 | 2> = [0, 1, 2, 0, 1, 2];
    for (const [index, channel] of sampleChannels.entries()) {
      expectDominantChannel(
        await sampleRgb(output, index * 0.6 + 0.3),
        channel,
      );
    }
  }, 30_000);
});
