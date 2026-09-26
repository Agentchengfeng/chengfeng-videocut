import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createConnectionApi } from "./connection-api";

// Real readable PCM WAV, generated entirely within a unique test fixture.
function wav() {
  const rate = 16000, samples = rate * 3, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++) bytes.writeInt16LE(Math.round(8000 * Math.sin(n * 2 * Math.PI * 440 / rate)), 44 + n * 2);
  return bytes;
}

test("connected WAV export plans are finite, ratio-correct, snapshot-bound and read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "wav-export-plan-"));
  try {
    const project = join(root, "fixture"), registry = join(root, "registry");
    await mkdir(join(project, "input"), { recursive: true }); await mkdir(registry);
    await symlink(project, join(registry, "fixture"));
    const documents = {
      "project.json": { jobId: "fixture", status: "cut_review_ready", inputVideo: "input/source.wav", config: { aspectRatio: "4:3" } },
      "edit-list.json": { schemaVersion: 1, projectId: "fixture", baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "b".repeat(64), mode: "manual", sourceDuration: 3, duration: 1.82,
        segments: [
          { id: "one", source: "input/source.wav", sourceStart: .15, sourceEnd: 1.06, timelineStart: 0, trackId: "a-roll", playbackRate: 1 },
          { id: "two", source: "input/source.wav", sourceStart: 1.31, sourceEnd: 2.22, timelineStart: .91, trackId: "a-roll", playbackRate: 1 },
        ] },
    };
    for (const [name, value] of Object.entries(documents)) await writeFile(join(project, name), JSON.stringify(value));
    const source = wav(); await writeFile(join(project, "input/source.wav"), source);
    const fingerprint = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const api = createConnectionApi(registry, 1234);
    const snapshots = [];
    for (const profile of ["fast", "master"]) {
      const response = await api(new Request(`http://127.0.0.1:1234/api/v1/projects/fixture/export-plan?profile=${profile}`, { headers: { host: "127.0.0.1:1234" } }), "127.0.0.1");
      const body = await response!.json();
      expect(response!.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({ audioOnly: true, profile, fps: 30, frameCount: 55, cutSegments: 2, source: { width: 1440, height: 1080 }, outputSize: { width: 1440, height: 1080 }, subtitleScreens: 0, visualLayers: 0, warnings: [] });
      expect(body.duration).toBeCloseTo(1.82);
      expect(body.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/); snapshots.push(body.snapshotFingerprint);
    }
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(fingerprint(await readFile(join(project, "input/source.wav")))).toBe(fingerprint(source));
    for (const [name, value] of Object.entries(documents)) expect(await readFile(join(project, name), "utf8")).toBe(JSON.stringify(value));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
