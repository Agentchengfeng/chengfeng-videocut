import { createHash } from "node:crypto";
import fs from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { probeMedia } from "../mediaCut";

export interface MainSource { path: string; sha256: string; duration: number; mediaKind: "audio" | "video" }

const verifiedSources = new Map<string, { identity: string; declaration: string; expires: number }>();
const SOURCE_CACHE_LIMIT = 128;
const SOURCE_CACHE_TTL_MS = 60_000;

async function sourceIdentity(root: string, relative: string) {
  const parts = relative.split("/");
  let path = root;
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`Main source must be a regular project file: ${relative}`);
    }
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`Main source path changed: ${relative}`);
  const info = await lstat(path, { bigint: true });
  if (!info.isFile()) throw new Error(`Main source must be a regular project file: ${relative}`);
  return [canonical, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

/** Fail closed on every declared source, including unused ones. No symlink traversal. */
export async function resolveMainSources(projectDirectory: string, sources: readonly MainSource[]) {
  const root = await realpath(projectDirectory);
  const paths: Record<string, string> = Object.create(null);
  if (!sources.length) throw new Error("Main source manifest is empty");
  for (const source of sources) {
    const parts = source.path.split("/");
    if (!source.path || /[\\:\x00-\x1f]/.test(source.path)
      || parts.some(p => !p || p === "." || p === "..") || paths[source.path]
      || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("Invalid main source manifest path or hash");
    const path = join(root, ...parts);
    try {
      const identity = await sourceIdentity(root, source.path);
      // The caller's entire declaration is checked afresh, including duration/kind;
      // a cache hit for one manifest must not authorize another manifest.
      const declaration = JSON.stringify([source.sha256, source.duration, source.mediaKind]);
      const cached = verifiedSources.get(path);
      if (cached?.identity === identity && cached.declaration === declaration && cached.expires > Date.now()) {
        paths[source.path] = path;
        continue;
      }
      verifiedSources.delete(path);
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
      if (hash.digest("hex") !== source.sha256) throw new Error(`Main source SHA-256 mismatch: ${source.path}`);
      const media = await probeMedia(path);
      if (source.mediaKind !== "audio" || media.hasVideo || !media.hasAudio) {
        throw new Error(`Multi-source main-track video/mixed media is not supported: ${source.path}`);
      }
      if (!Number.isFinite(source.duration) || source.duration <= 0 || Math.abs(media.duration - source.duration) > 0.002) {
        throw new Error(`Main source duration mismatch: ${source.path}`);
      }
      if (await sourceIdentity(root, source.path) !== identity) throw new Error(`Main source changed during verification: ${source.path}`);
      verifiedSources.set(path, { identity, declaration, expires: Date.now() + SOURCE_CACHE_TTL_MS });
      while (verifiedSources.size > SOURCE_CACHE_LIMIT) verifiedSources.delete(verifiedSources.keys().next().value!);
      paths[source.path] = resolve(path);
    } catch (error) {
      verifiedSources.delete(path);
      throw error;
    }
  }
  return paths;
}

/** Normalize each original source to PCM before trimming; one shared sample clock. */
export function mainAudioFilter(spans: readonly { source?: string; sourceStart: number; sourceEnd: number }[], keys: readonly string[], firstInput = 0): string {
  const parts: string[] = [];
  keys.forEach((key, input) => {
    const uses = spans.map((span, i) => ({ span, i })).filter(({ span }) => (span.source ?? "") === key);
    if (uses.length) parts.push(`[${input + firstInput}:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,asplit=${uses.length}${uses.map(({ i }) => `[src${i}]`).join("")}`);
  });
  spans.forEach((span, i) => {
    if (!keys.includes(span.source ?? "") || !Number.isFinite(span.sourceStart) || !Number.isFinite(span.sourceEnd) || span.sourceStart < 0 || span.sourceEnd <= span.sourceStart) throw new Error(`Unresolved main-track span #${i}`);
    const start = Math.round(span.sourceStart * 48000), end = Math.round(span.sourceEnd * 48000);
    const duration = (end - start) / 48000;
    if (end <= start) throw new Error(`Empty main-track span #${i}`);
    const fade = duration > 0.02 ? `,afade=t=in:st=0:d=0.005,afade=t=out:st=${(duration - 0.005).toFixed(8)}:d=0.005` : "";
    parts.push(`[src${i}]atrim=start_sample=${start}:end_sample=${end},asetpts=PTS-STARTPTS${fade}[a${i}]`);
  });
  parts.push(`${spans.map((_, i) => `[a${i}]`).join("")}concat=n=${spans.length}:v=0:a=1,asetpts=N/SR/TB[outa]`);
  return parts.join(";");
}
