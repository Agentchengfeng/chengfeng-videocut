import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cutVideoByRanges,
  keepSegmentsForCuts,
  mergeCutRanges,
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
    expect(probe.duration).toBeGreaterThan(1.35);
    expect(probe.duration).toBeLessThan(1.7);
    expect(result.deletedDuration).toBeGreaterThan(0.35);
  }, 20_000);
});
