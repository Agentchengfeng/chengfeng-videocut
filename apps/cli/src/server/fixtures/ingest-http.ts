// Isolated, explicit cross-boundary integration fixture. No cloud credentials,
// real recordings, existing registry, or fixed production port are consulted.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startStudioServer } from "../start";

const root = await realpath(await mkdtemp(join(tmpdir(), "ingest-cross-boundary-")));
const taskDirectory = join(root, "fixture-task");
await mkdir(taskDirectory);
const sourcePath = join(taskDirectory, "source.wav");
const ffmpeg = Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", sourcePath], { stdout: "ignore", stderr: "inherit" });
if (await ffmpeg.exited !== 0) throw Error("fixture WAV generation failed");
const expectedSourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
let calls = 0;
const server = await startStudioServer({ host: "127.0.0.1", port: 0, dataDir: join(root, "data"), projectsDir: join(root, "projects"), ingest: {
  runTranscription: async (directory, options) => {
    calls++;
    await writeFile(join(root, "provider-calls.json"), JSON.stringify({ calls }));
    const output = join(directory, options.output!);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ schemaVersion: 1, provider: "volcengine", language: options.language ?? "zh-CN", media: { source: options.video, sha256: expectedSourceSha256, duration: 1 }, cues: [{ id: "cue", words: [{ id: "one", text: "你好", start: 0, end: 0.4 }, { id: "two", text: "继续", start: 0.5, end: 1 }] }] }));
    return { provider: "volcengine", source: sourcePath, output, cueCount: 1, wordCount: 2, duration: 1 };
  },
} });
console.log(JSON.stringify({ schemaVersion: 1, fixture: true, pid: process.pid, url: server.url, root, sourcePath, taskDirectory, expectedSourceSha256 }));
