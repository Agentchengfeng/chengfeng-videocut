import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ingestKouboProject, probeMedia } from "@video-workbench/koubo-adapter";
import { buildPreviewStream } from "./preview-stream";
import { projectInput, canPlayFromLedger } from "./edit-preview-artifact";

test("WAV: atomic ingest, cache retry, audio-only fragments and source preservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "videocut-wav-"));
  try {
    const job = join(root, "recording");
    await mkdir(join(job, "input"), { recursive: true });
    const path = join(job, "input", "voice.wav");
    const ffmpeg = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-y", path], { stdout: "ignore", stderr: "pipe" });
    expect(await ffmpeg.exited).toBe(0);
    const bytes = await readFile(path);
    const sha = createHash("sha256").update(bytes).digest("hex");
    let calls = 0;
    const options = {
      video: "input/voice.wav",
      runTranscription: async (directory: string, opts: any) => {
        calls++;
        const output = join(directory, opts.output);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({ schemaVersion: 1, provider: "volcengine", language: "zh-CN",
          media: { source: opts.video, sha256: sha, duration: 3 },
          cues: [{ id: "cue", words: [{ id: "one", text: "你好", start: 0, end: 1 }, { id: "two", text: "继续", start: 2, end: 3 }] }],
        }));
        return { provider: "volcengine" as const, source: path, output, cueCount: 1, wordCount: 2, duration: 3 };
      },
    };
    await expect(ingestKouboProject(job, { ...options, create: { finalize: () => { throw new Error("registration failed"); } } })).rejects.toThrow("registration failed");
    const result = await ingestKouboProject(job, options);
    expect(calls).toBe(1);
    expect(result.transcription.reused).toBe(true);
    const project = JSON.parse(await readFile(join(job, "project.json"), "utf8"));
    expect(project.source.mediaKind).toBe("audio");
    expect(await readFile(join(job, "input/source.wav"))).toEqual(bytes);
    const metadata = result.metadata.previewProxy as any;
    expect(metadata).toMatchObject({ status: "ready", hasVideo: false, hasAudio: true, width: 0, height: 0 });
    const projects = join(root, "projects");
    await mkdir(projects);
    await symlink(job, join(projects, "recording"));
    const input = await projectInput(projects, "recording");
    expect(input.audioOnly).toBe(true);
    expect(canPlayFromLedger(input)).toBe(false);
    const streamInput = { projectDir: job, proxySource: metadata.source, proxyCacheKey: metadata.cacheKey, audioOnly: true,
      segments: [{ start: 0, end: 0.8 }, { start: 2, end: 2.8 }] };
    const stream = await buildPreviewStream(streamInput);
    expect(stream.mimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
    expect(stream.totalSeconds).toBe(1.6);
    expect(stream.segments).toHaveLength(2);
    for (const chunk of stream.segments) {
      expect(chunk.headExtra).toBe(0);
      expect(await probeMedia(join(job, chunk.source))).toMatchObject({ hasVideo: false, hasAudio: true });
    }
    expect(await buildPreviewStream(streamInput)).toEqual(stream);
    const restored = await buildPreviewStream({ ...streamInput, segments: [{ start: 0, end: 3 }] });
    expect(restored.totalSeconds).toBe(3);
    expect(await readFile(path)).toEqual(bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("unsupported extension and invalid WAV fail before paid ASR", async () => {
  const job = await mkdtemp(join(tmpdir(), "videocut-bad-media-"));
  try {
    let calls = 0;
    for (const file of ["bad.pdf", "bad.wav"]) {
      await writeFile(join(job, file), "not media");
      await expect(ingestKouboProject(job, { video: file, runTranscription: async () => { calls++; throw new Error("ASR called"); } })).rejects.toThrow();
    }
    expect(calls).toBe(0);
  } finally { await rm(job, { recursive: true, force: true }); }
});
