import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEditListDocument, buildExportPlan } from "@video-workbench/core";
import { resolveMainSources, exportFilm, type MainSource } from "@video-workbench/koubo-adapter";
import { projectInput, generatePreviewArtifactAudio, editPreviewArtifactCacheKey, editPreviewArtifactConfig } from "./edit-preview-artifact";

async function run(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [bytes, error, status] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (status) throw new Error(error);
  return bytes;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "multisource-audio-"));
  const dir = join(root, "voice");
  await mkdir(join(dir, "input"), { recursive: true });
  const sources: MainSource[] = [];
  for (const [name, rate, frequency] of [["a", 44100, 440], ["b", 32000, 880]] as const) {
    const path = `input/${name}.wav`;
    await run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=${rate}:duration=1`, join(dir, path)]);
    sources.push({ path, sha256: createHash("sha256").update(await readFile(join(dir, path))).digest("hex"), duration: 1, mediaKind: "audio" });
  }
  const edit = parseEditListDocument({ schemaVersion: 2, projectId: "voice", mode: "manual", sourceDuration: 1,
    duration: 1.2, baseCutsRevision: "b".repeat(64), baseTranscriptRevision: "c".repeat(64), sources,
    segments: [0, 1, 0].map((source, i) => ({ id: `s${i}`, source: sources[source]!.path,
      instanceId: `i${i}`, sourceStart: 0.1, sourceEnd: 0.5, timelineStart: i * 0.4, trackId: "a-roll", playbackRate: 1 })) });
  await writeFile(join(dir, "edit-list.json"), JSON.stringify(edit));
  await writeFile(join(dir, "workbench.json"), "{}");
  return { root, dir, sources, edit };
}
function toneEnergy(data: Float32Array, start: number, frequency: number) {
  let sin = 0, cos = 0;
  for (let i = 0; i < 4800; i++) { const t = 2 * Math.PI * frequency * i / 48000; const v = data[start + i]!; sin += v * Math.sin(t); cos += v * Math.cos(t); }
  return sin * sin + cos * cos;
}
test("two real WAV rates and repeated source use preserve order in preview and full export", async () => {
  const f = await fixture();
  try {
    const input = await projectInput(f.root, "voice");
    const preview = join(f.root, "preview.mp4");
    await generatePreviewArtifactAudio({ input: input.sourceProxy, sourcePaths: input.sourcePaths, output: preview, segments: input.segments });
    const plan = buildExportPlan({ editList: f.edit, words: [], subtitles: null, visuals: null, source: { width: 64, height: 64, duration: 1, frameRate: 30 }, scale: 1 });
    expect(plan.spans.map(s => s.source)).toEqual(["input/a.wav", "input/b.wav", "input/a.wav"]);
    const film = join(f.root, "film.mp4");
    const result = await exportFilm({ projectDirectory: f.dir, sourcePath: input.sourceProxy, audioOnly: true, plan, outputPath: film, workDirectory: join(f.root, "work") });
    expect(result.problems).toEqual([]);
    expect(result.frameCount).toBe(36);
    for (const artifact of [preview, film]) {
      const pcm = new Float32Array(await run(["ffmpeg", "-v", "error", "-i", artifact, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]));
      for (const [i, expected] of [440, 880, 440].entries()) {
        const start = Math.round((i * 0.4 + 0.08) * 48000);
        expect(toneEnergy(pcm, start, expected)).toBeGreaterThan(100 * toneEnergy(pcm, start, expected === 440 ? 880 : 440));
      }
    }
    const key = editPreviewArtifactCacheKey({ ...input, config: editPreviewArtifactConfig(input) });
    const changed = { ...input, sourceManifest: input.sourceManifest!.map((s, i) => i ? { ...s, sha256: "d".repeat(64) } : s) };
    expect(editPreviewArtifactCacheKey({ ...changed, config: editPreviewArtifactConfig(changed) })).not.toBe(key);
    await writeFile(join(f.dir, "input/b.wav"), "tampered");
    await expect(projectInput(f.root, "voice")).rejects.toThrow("SHA-256");
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 30000);

test("source manifest rejects traversal, symlinks, missing media and video declarations", async () => {
  const f = await fixture();
  try {
    await symlink(join(f.dir, "input/a.wav"), join(f.dir, "input/link.wav"));
    for (const patch of [{ path: "../escape.wav" }, { path: "input/link.wav" }, { path: "input/missing.wav" }, { mediaKind: "video" as const }]) {
      await expect(resolveMainSources(f.dir, [{ ...f.sources[0]!, ...patch }])).rejects.toThrow();
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
}, 20000);
