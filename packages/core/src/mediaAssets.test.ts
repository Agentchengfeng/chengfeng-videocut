import { expect, test, spyOn } from "bun:test";
import fs from "node:fs";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, lstat, utimes, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mediaSha256, readMediaAsset } from "./mediaAssets";

test("verified media reuses real reads, but rejects same-size edits, replaced inode, manifest and path tampering", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "media-cache-")));
  const input = join(root, "input.mp4");
  const ff = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", input]);
  expect(ff.status).toBe(0);
  const bytes = await readFile(input);
  const id = createHash("sha256").update(bytes).digest("hex");
  const dir = join(root, ".chengfeng-videocut", "media", id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "source.mp4"), manifest = join(dir, "manifest.json");
  const doc = { schemaVersion: 1, assetId: id, sha256: id, bytes: bytes.length, duration: 1, width: 32, height: 32, frameRate: 24, codec: "h264", hasAudio: false };
  await writeFile(path, bytes); await writeFile(manifest, JSON.stringify(doc));
  const original = fs.createReadStream;
  let reads = 0;
  const spy = spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof original>) => {
    if (args[0] === path) reads++;
    return original(...args);
  }) as typeof original);
  try {
    await readMediaAsset(root, id);
    await readMediaAsset(root, id);
    expect(reads).toBe(1);
    const stat = await lstat(path);
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await writeFile(path, changed); await utimes(path, stat.atime, stat.mtime);
    await expect(readMediaAsset(root, id)).rejects.toThrow();
    expect(reads).toBe(2);
    await expect(readMediaAsset(root, id)).rejects.toThrow();
    expect(reads).toBe(3); // a failed expected digest was not cached
    await writeFile(path, bytes); await readMediaAsset(root, id);
    const beforeReplace = reads;
    const replacement = join(dir, "replacement.mp4");
    await writeFile(replacement, changed); await utimes(replacement, stat.atime, stat.mtime); await rename(replacement, path);
    await expect(readMediaAsset(root, id)).rejects.toThrow(); expect(reads).toBe(beforeReplace + 1);
    await writeFile(path, bytes); await readMediaAsset(root, id);
    await writeFile(manifest, JSON.stringify({ ...doc, sha256: "0".repeat(64) }));
    await expect(readMediaAsset(root, id)).rejects.toThrow();
    await writeFile(manifest, JSON.stringify(doc));
    await rm(path); await expect(readMediaAsset(root, id)).rejects.toThrow();
    await symlink(input, path); await expect(readMediaAsset(root, id)).rejects.toThrow(/symlink/);
    await rm(path); await writeFile(path, bytes);
    await rm(manifest); await symlink(input, manifest);
    await expect(readMediaAsset(root, id)).rejects.toThrow(/symlink/);
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("digest cache expires and evicts bounded entries without replacing byte verification", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "digest-bounds-")));
  const first = join(root, "0");
  const original = fs.createReadStream;
  let reads = 0;
  const spy = spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof original>) => {
    if (args[0] === first) reads++;
    return original(...args);
  }) as typeof original);
  let nowSpy: ReturnType<typeof spyOn> | undefined;
  try {
    for (let i = 0; i <= 128; i++) { const p = join(root, String(i)); await writeFile(p, "bounded"); await mediaSha256(p); }
    await mediaSha256(first); expect(reads).toBe(2);
    await mediaSha256(first); expect(reads).toBe(2);
    const future = Date.now() + 61_000;
    nowSpy = spyOn(Date, "now").mockReturnValue(future);
    await mediaSha256(first); expect(reads).toBe(3);
  } finally { nowSpy?.mockRestore(); spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
