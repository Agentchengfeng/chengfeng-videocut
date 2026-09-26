import { test, expect, spyOn } from "bun:test";
import fs from "node:fs";
import { mkdtemp, realpath, writeFile, readFile, rm, lstat, utimes, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveMainSources, type MainSource } from "./sources";

test("real WAV validation is reused but declaration/file changes and missing or escaped sources fail closed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "main-source-cache-")));
  const path = join(root, "source.wav");
  expect(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=1", path]).status).toBe(0);
  const bytes = await readFile(path);
  const source: MainSource = { path: "source.wav", sha256: createHash("sha256").update(bytes).digest("hex"), duration: 1, mediaKind: "audio" };
  const original = fs.createReadStream;
  let reads = 0;
  const spy = spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof original>) => {
    if (args[0] === path) reads++;
    return original(...args);
  }) as typeof original);
  try {
    const start = performance.now(); await resolveMainSources(root, [source]); const coldMs = performance.now() - start;
    const warm = performance.now();
    for (let i = 0; i < 12; i++) expect((await resolveMainSources(root, [source]))[source.path]).toBe(path);
    const warmMs = performance.now() - warm;
    expect(reads).toBe(1);
    for (const patch of [{ duration: 2 }, { mediaKind: "video" as const }, { sha256: "0".repeat(64) }, { path: "../source.wav" }]) {
      await expect(resolveMainSources(root, [{ ...source, ...patch }])).rejects.toThrow();
    }
    await resolveMainSources(root, [source]);
    const stat = await lstat(path), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await writeFile(path, changed); await utimes(path, stat.atime, stat.mtime);
    await expect(resolveMainSources(root, [source])).rejects.toThrow(/SHA/);
    const failed = reads; await expect(resolveMainSources(root, [source])).rejects.toThrow(/SHA/); expect(reads).toBe(failed + 1);
    await writeFile(path, bytes); await resolveMainSources(root, [source]);
    const replacement = join(root, "replacement.wav"); await writeFile(replacement, changed); await utimes(replacement, stat.atime, stat.mtime); await rename(replacement, path);
    await expect(resolveMainSources(root, [source])).rejects.toThrow(/SHA/);
    await rm(path); await expect(resolveMainSources(root, [source])).rejects.toThrow();
    const elsewhere = join(root, "elsewhere.wav"); await writeFile(elsewhere, bytes); await symlink(elsewhere, path);
    await expect(resolveMainSources(root, [source])).rejects.toThrow(/regular project file/);
    console.info(`main-source-cache evidence: real WAV cold=${coldMs.toFixed(2)}ms; 12 warm validations=${warmMs.toFixed(2)}ms; initial + 12 warm hash reads=1`);
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
