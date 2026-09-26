import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canPlayFromLedger, EditPreviewArtifactManager, generatePreviewArtifactAudio, projectInput,
} from "./edit-preview-artifact";

const sampleRate = 48_000;
const ranges = [{ start: 0.12325, end: 0.61175 }, { start: 1.37025, end: 1.81175 }, { start: 0.8505, end: 1.02125 }];

async function audioFixture() {
  const root = await mkdtemp(join(tmpdir(), "continuous-audio-preview-"));
  const projectDir = join(root, "voice");
  await mkdir(join(projectDir, "input"), { recursive: true });
  const pcm = new Int16Array(2 * sampleRate);
  for (let index = 0; index < pcm.length; index++) {
    const t = index / sampleRate;
    pcm[index] = Math.round(32767 * (0.45 * Math.sin(2 * Math.PI * (311 * t + 173 * t * t))
      + 0.2 * Math.sin(2 * Math.PI * (917 * t + 307 * t * t))));
  }
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  for (let index = 0; index < pcm.length; index++) wav.writeInt16LE(pcm[index]!, 44 + index * 2);
  const source = join(projectDir, "input/source.wav");
  await writeFile(source, wav);
  const sourceSha256 = createHash("sha256").update(wav).digest("hex");
  await writeFile(join(projectDir, "project.json"), JSON.stringify({ source: { path: "input/source.wav", mediaKind: "audio" } }));
  // A ready but undecodable proxy proves generation really uses the verified WAV.
  await writeFile(join(projectDir, "proxy.mp4"), "do not decode the lossy proxy");
  await writeFile(join(projectDir, "workbench.json"), JSON.stringify({ sourceSha256,
    previewProxy: { source: "proxy.mp4", status: "ready", revision: "proxy-v1", cacheKey: "proxy-key",
      hasVideo: false, hasAudio: true, width: 0, height: 0, duration: 2 },
  }));
  const writeEdit = async (selected = ranges) => {
    let cursor = 0;
    const segments = selected.map((range, index) => {
      const segment = { id: `s${index}`, source: "input/source.wav", sourceStart: range.start,
        sourceEnd: range.end, timelineStart: cursor, trackId: "a-roll", playbackRate: 1 };
      cursor = Math.round((cursor + range.end - range.start) * 1e6) / 1e6;
      return segment;
    });
    await writeFile(join(projectDir, "edit-list.json"), JSON.stringify({ schemaVersion: 1, projectId: "voice",
      mode: "manual", sourceDuration: 2, duration: cursor, baseCutsRevision: "b".repeat(64),
      baseTranscriptRevision: "c".repeat(64), segments }));
  };
  await writeEdit();
  return { root, projectDir, source, pcm, wav, writeEdit };
}

async function output(command: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`${command[0]} failed: ${error}`);
  return new Uint8Array(bytes);
}

function correlation(actual: Float32Array, expected: number[], start: number, end: number, lag = 0): number {
  let xx = 0, yy = 0, xy = 0;
  for (let index = start; index < end; index++) {
    const x = actual[index + lag]!, y = expected[index]!;
    xx += x * x; yy += y * y; xy += x * y;
  }
  return xy / Math.sqrt(xx * yy);
}

test("continuous AAC compensates its only priming packet and aligns PCM at every irregular EDL seam", async () => {
  const f = await audioFixture();
  try {
    const artifact = join(f.root, "edited.mp4");
    await generatePreviewArtifactAudio({ input: f.source, output: artifact, segments: ranges });
    const probe = JSON.parse(new TextDecoder().decode(await output([
      "ffprobe", "-v", "error", "-show_streams", "-show_packets", "-show_format", "-of", "json", artifact,
    ])));
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({ codec_name: "aac", codec_type: "audio", sample_rate: "48000", start_time: "0.000000" });
    const firstPacket = probe.packets[0];
    const skip = firstPacket.side_data_list?.find((item: any) => item.side_data_type === "Skip Samples")?.skip_samples;
    expect(skip).toBe(1024);
    expect(firstPacket.pts + skip).toBe(0);
    expect(probe.packets.slice(1).every((packet: any) => !packet.side_data_list?.some((side: any) => side.skip_samples > 0))).toBe(true);
    const expected = ranges.flatMap((range) => Array.from(f.pcm.subarray(
      Math.round(range.start * sampleRate), Math.round(range.end * sampleRate),
    ), (sample) => sample / 32768));
    expect(Math.abs(Number(probe.format.duration) - expected.length / sampleRate)).toBeLessThan(0.002);
    expect(Math.abs(Number(probe.streams[0].duration) - expected.length / sampleRate)).toBeLessThan(0.002);
    const bytes = await output(["ffmpeg", "-v", "error", "-i", artifact, "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
    const decoded = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(decoded.length).toBeGreaterThanOrEqual(expected.length);
    expect(decoded.length - expected.length).toBeLessThan(1024);
    let cursor = 0;
    for (const range of ranges) {
      const length = Math.round(range.end * sampleRate) - Math.round(range.start * sampleRate);
      const start = cursor + 240, end = Math.min(cursor + length - 240, start + 4800);
      const matched = correlation(decoded, expected, start, end);
      expect(matched).toBeGreaterThan(0.97);
      expect(matched).toBeGreaterThan(correlation(decoded, expected, start, end, 1024) + 0.5);
      const bestLag = Array.from({ length: 9 }, (_, index) => index - 4)
        .sort((a, b) => correlation(decoded, expected, start, end, b) - correlation(decoded, expected, start, end, a))[0];
      expect(bestLag).toBe(0);
      cursor += length;
    }
    expect(await readFile(f.source)).toEqual(f.wav);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

test("audio preview uses canonical source, atomic encoded cache, and current EDL revision", async () => {
  const f = await audioFixture();
  try {
    const input = await projectInput(f.root, "voice");
    expect(input).toMatchObject({ audioOnly: true, sourceKind: "canonical", previewFrameRate: 0 });
    expect(input.sourceProxy).toEndWith("/input/source.wav");
    expect(canPlayFromLedger(input)).toBe(false);
    const manager = new EditPreviewArtifactManager(f.root, { debounceMs: 0,
      buildStream: async () => { throw new Error("audio must not use per-span AAC fragments"); },
    });
    const waitCurrent = async () => {
      for (let index = 0; index < 200; index++) {
        const state = await manager.ensure("voice");
        if (state.phase === "failed") throw new Error(state.error ?? "audio generation failed");
        if (state.phase === "current") return state;
        await Bun.sleep(10);
      }
      throw new Error("audio preview did not complete");
    };
    const ready = await waitCurrent();
    expect(ready).toMatchObject({ stream: null, hasVideo: false, hasAudio: true, artifactRevision: input.editRevision });
    expect(ready.source).toMatch(/^\.chengfeng-videocut\/preview-edited\/[a-f0-9]{64}\.mp4$/);
    const before = await stat(join(f.projectDir, ready.source!));
    expect(await manager.ensure("voice")).toEqual(ready);
    expect((await stat(join(f.projectDir, ready.source!))).mtimeMs).toBe(before.mtimeMs);
    await f.writeEdit([ranges[1]!]);
    const changed = await waitCurrent();
    expect(changed.editRevision).not.toBe(ready.editRevision);
    expect(changed.source).not.toBe(ready.source);
    expect(changed.artifactRevision).toBe(changed.editRevision);
    const manifest = JSON.parse(await readFile(join(f.projectDir, ".chengfeng-videocut/preview-edited/current.json"), "utf8"));
    expect(manifest).toEqual(changed);
    expect((await readdir(join(f.projectDir, ".chengfeng-videocut/preview-edited"))).some((name) => name.includes(".tmp"))).toBe(false);
    expect(await readFile(f.source)).toEqual(f.wav);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

test("single-encode audio preview suppresses a nonzero splice jump without adding samples", async () => {
  const f = await audioFixture();
  try {
    const artifact = join(f.root, "soft-seams.mp4");
    await generatePreviewArtifactAudio({ input: f.source, output: artifact, segments: ranges });
    const bytes = await output(["ffmpeg", "-v", "error", "-i", artifact, "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
    const decoded = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const lengths = ranges.map((range) => Math.round(range.end * sampleRate) - Math.round(range.start * sampleRate));
    // This source boundary jumps from +.482 to -.385: it must not lose the
    // fragment path's click protection when switching to a continuous encoder.
    const boundary = lengths[0]! + lengths[1]!;
    const before = f.pcm[Math.round(ranges[1]!.end * sampleRate) - 1]! / 32768;
    const after = f.pcm[Math.round(ranges[2]!.start * sampleRate)]! / 32768;
    const rawJump = Math.abs(after - before);
    expect(rawJump).toBeGreaterThan(0.8);
    expect(Math.abs(decoded[boundary]! - decoded[boundary - 1]!)).toBeLessThan(rawJump * 0.1);
    expect(Math.abs(decoded[boundary - 1]!)).toBeLessThan(0.03);
    expect(Math.abs(decoded[boundary]!)).toBeLessThan(0.03);
    const expectedSamples = lengths.reduce((sum, length) => sum + length, 0);
    expect(decoded.length).toBeGreaterThanOrEqual(expectedSamples);
    expect(decoded.length - expectedSamples).toBeLessThan(1024);
    // The body remains at its exact EDL position after each five-millisecond ramp.
    const expectedBody = Array.from(f.pcm.subarray(Math.round(ranges[2]!.start * sampleRate),
      Math.round(ranges[2]!.end * sampleRate)), (sample) => sample / 32768);
    expect(correlation(decoded.subarray(boundary), expectedBody, 480, 2880)).toBeGreaterThan(0.97);
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 20_000);

test("audio preview rejects unsupported EDL instead of publishing incorrect media", async () => {
  const f = await audioFixture();
  try {
    const artifact = join(f.root, "invalid.mp4");
    for (const segments of [[], [{ start: 1, end: 0 }], [{ start: 0, end: 3 }],
      [{ start: 0, end: 1, playbackRate: 2 }],
      [{ start: 0, end: 1, source: "first.wav" }, { start: 1, end: 2, source: "other.wav" }]]) {
      await expect(generatePreviewArtifactAudio({ input: f.source, output: artifact, segments })).rejects.toThrow();
    }
    expect(await stat(artifact).catch(() => null)).toBeNull();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
