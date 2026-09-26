import { createHash } from "node:crypto";
import fs from "node:fs";
import { lstat, realpath, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { VideocutError } from "./errors";
import type { VisualMedia } from "./visuals";

export const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
export interface MediaAsset {
  schemaVersion: 1;
  assetId: string;
  sha256: string;
  bytes: number;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  codec: "h264";
  hasAudio: boolean;
}
export function mediaInvalid(message: string): never {
  throw new VideocutError("invalid_visuals", message);
}
export async function regularMediaPath(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) mediaInvalid("An absolute clean media path is required");
  for (let p = path;; p = dirname(p)) {
    const s = await lstat(p);
    if (s.isSymbolicLink()) mediaInvalid("Media symlinks are forbidden");
    if (p === dirname(p)) break;
  }
  const s = await lstat(path);
  if (!s.isFile() || s.size <= 0 || s.size > MEDIA_MAX_BYTES) mediaInvalid("Media must be a nonempty regular file of at most 512MiB");
  return path;
}
// Cache content facts, never path permission or a manifest. Every use rechecks the
// full path and nanosecond file identity. Bound both lifetime and retained entries.
const digestCache = new Map<string, { identity: string; digest: string; expires: number }>();
const DIGEST_CACHE_LIMIT = 128;
const DIGEST_CACHE_TTL_MS = 60_000;
async function mediaIdentity(path: string): Promise<string> {
  await regularMediaPath(path);
  const canonical = await realpath(path);
  if (canonical !== path) mediaInvalid("Media path changed during verification");
  const s = await lstat(path, { bigint: true });
  if (!s.isFile()) mediaInvalid("Media must be a regular file");
  return [canonical, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}
export async function mediaSha256(path: string, expectedSha256?: string): Promise<string> {
  try {
    const identity = await mediaIdentity(path);
    const cached = digestCache.get(path);
    if (cached?.identity === identity && cached.expires > Date.now()) {
      if (expectedSha256 && cached.digest !== expectedSha256) mediaInvalid("Media SHA-256 mismatch");
      return cached.digest;
    }
    digestCache.delete(path);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of fs.createReadStream(path)) {
      bytes += chunk.length;
      if (bytes > MEDIA_MAX_BYTES) mediaInvalid("Media exceeds size limit");
      hash.update(chunk);
    }
    const digest = hash.digest("hex");
    if (await mediaIdentity(path) !== identity) mediaInvalid("Media changed during verification");
    if (expectedSha256 && digest !== expectedSha256) mediaInvalid("Media SHA-256 mismatch");
    digestCache.set(path, { identity, digest, expires: Date.now() + DIGEST_CACHE_TTL_MS });
    while (digestCache.size > DIGEST_CACHE_LIMIT) digestCache.delete(digestCache.keys().next().value!);
    return digest;
  } catch (error) {
    digestCache.delete(path);
    throw error;
  }
}
export async function readMediaAsset(projectDirectory: string, id: string): Promise<{ manifest: MediaAsset; path: string }> {
  if (!/^[a-f0-9]{64}$/.test(id)) mediaInvalid("Invalid media asset id");
  const root = await realpath(projectDirectory);
  const folder = resolve(root, ".chengfeng-videocut", "media", id);
  const manifestPath = await regularMediaPath(resolve(folder, "manifest.json"));
  if ((await lstat(manifestPath)).size > 4096) mediaInvalid("Media manifest too large");
  const m = JSON.parse(await readFile(manifestPath, "utf8")) as MediaAsset;
  if (m.schemaVersion !== 1 || m.assetId !== id || m.sha256 !== id || m.codec !== "h264" ||
      !Number.isSafeInteger(m.bytes) || m.bytes <= 0 || m.bytes > MEDIA_MAX_BYTES ||
      !Number.isFinite(m.duration) || m.duration <= 0 || m.duration > 3600 ||
      !Number.isInteger(m.width) || m.width <= 0 || m.width > 8192 ||
      !Number.isInteger(m.height) || m.height <= 0 || m.height > 8192 ||
      !Number.isFinite(m.frameRate) || m.frameRate <= 0 || m.frameRate > 120 || typeof m.hasAudio !== "boolean")
    mediaInvalid("Invalid media manifest");
  const path = await regularMediaPath(resolve(folder, "source.mp4"));
  if ((await lstat(path)).size !== m.bytes || await mediaSha256(path, id) !== id)
    mediaInvalid("Media asset has changed; import a new verified version");
  return { manifest: m, path };
}
export async function validateVisualMedia(root: string, media: VisualMedia) {
  const result = await readMediaAsset(root, media.assetId);
  if (media.sourceOut > result.manifest.duration + 0.000001) mediaInvalid("Video sourceOut exceeds asset duration");
  return result;
}
