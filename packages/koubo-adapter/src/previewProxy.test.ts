import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreviewProxyFfmpegArgs,
  DEFAULT_PREVIEW_PROXY_CONFIG,
  ensurePreviewProxy,
  normalizePreviewProxyConfig,
  previewProxyCacheKey,
  type PreviewProxyDependencies,
  type PreviewProxyMediaProbe,
  type PreviewProxyTranscodeInput,
} from "./previewProxy";

const temporaryDirectories: string[] = [];
const SOURCE_SHA256 = "a".repeat(64);

const sourceProbe: PreviewProxyMediaProbe = {
  duration: 10,
  startTime: 0,
  videoStartTime: 0,
  audioStartTime: 0,
  hasVideo: true,
  hasAudio: true,
  width: 1_920,
  height: 1_080,
  frameRate: 60,
  videoCodec: "h264",
  audioCodec: "aac",
  maxKeyframeIntervalSeconds: null,
};

const validProxyProbe: PreviewProxyMediaProbe = {
  duration: 10,
  startTime: 0,
  videoStartTime: 0,
  audioStartTime: 0,
  hasVideo: true,
  hasAudio: true,
  width: 960,
  height: 540,
  frameRate: 30,
  videoCodec: "h264",
  audioCodec: "aac",
  maxKeyframeIntervalSeconds: 0.2,
};

async function fixture(): Promise<{ root: string; sourcePath: string; cacheDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-proxy-"));
  temporaryDirectories.push(root);
  const sourcePath = join(root, "source.mp4");
  const cacheDirectory = join(root, "preview");
  await writeFile(sourcePath, "immutable-source");
  return { root, sourcePath, cacheDirectory };
}

async function command(name: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(name, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${name} exited with ${code}`)));
  });
}

function outputPath(cacheDirectory: string): string {
  return join(
    cacheDirectory,
    `${previewProxyCacheKey(SOURCE_SHA256, DEFAULT_PREVIEW_PROXY_CONFIG)}.mp4`,
  );
}

function fakeDependencies(input: {
  probe?: PreviewProxyDependencies["probeMedia"];
  transcode?: PreviewProxyDependencies["transcode"];
} = {}): PreviewProxyDependencies {
  return {
    hashFile: async () => SOURCE_SHA256,
    probeMedia: input.probe ?? (async (path, options) => (
      options.includeKeyframes || path.includes("preview") ? validProxyProbe : sourceProbe
    )),
    transcode: input.transcode ?? (async ({ temporaryPath }) => {
      await writeFile(temporaryPath, "validated-proxy");
    }),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe("preview proxy contract", () => {
  it("normalizes to bounded product defaults and keys the full codec configuration", () => {
    expect(normalizePreviewProxyConfig()).toEqual(DEFAULT_PREVIEW_PROXY_CONFIG);
    expect(normalizePreviewProxyConfig({
      maxWidth: 4_000,
      maxHeight: 4_000,
      frameRate: 120,
      maxKeyframeIntervalSeconds: 2,
    })).toMatchObject({
      maxWidth: 960,
      maxHeight: 720,
      frameRate: 30,
      maxKeyframeIntervalSeconds: 0.25,
    });
    const first = previewProxyCacheKey(SOURCE_SHA256);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(previewProxyCacheKey(SOURCE_SHA256, { maxWidth: 960 }));
    expect(first).not.toBe(previewProxyCacheKey(SOURCE_SHA256, { videoBitrateKbps: 1_500 }));
    expect(first).not.toBe(previewProxyCacheKey("b".repeat(64)));
  });

  it("builds the portable 960x720/30 libx264 + AAC command with a 0.2s GOP", () => {
    const input: PreviewProxyTranscodeInput = {
      sourcePath: "/tmp/source.mp4",
      temporaryPath: "/tmp/proxy.tmp.mp4",
      sourceProbe,
      config: normalizePreviewProxyConfig(),
      ffmpegPath: "ffmpeg",
    };
    const args = buildPreviewProxyFfmpegArgs(input);
    const joined = args.join(" ");
    expect(joined).toContain("scale=w='min(iw,960)':h='min(ih,720)'");
    expect(joined).toContain("fps=30");
    expect(joined).toContain("-c:v libx264");
    // Quality mode: the proxy is judged by whether text survives, not by
    // encode speed. A fixed-bitrate I-frame-heavy stream was visibly mushier
    // than the original.
    expect(joined).toContain("-preset faster");
    expect(joined).toContain("-crf 16");
    expect(joined).not.toContain("-tune fastdecode");
    expect(joined).not.toMatch(/-b:v /);
    expect(joined).toContain("-maxrate 8000k -bufsize 16000k");
    expect(joined).toContain("-g 6 -keyint_min 6 -sc_threshold 0");
    expect(joined).toContain("expr:gte(t,n_forced*0.200000)");
    expect(joined).toContain("-c:a aac -b:a 96k");
    expect(joined).toContain("asetpts=PTS-STARTPTS");
    expect(joined).not.toContain("-avoid_negative_ts");
    expect(joined).toContain("-t 10.000000");
    expect(args.at(-1)).toBe("file:/tmp/proxy.tmp.mp4");
  });

  it("publishes a validated candidate atomically without touching the source", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies(),
    });
    expect(result).toMatchObject({
      status: "ready",
      cacheHit: false,
      sourceSha256: SOURCE_SHA256,
      proxyPath: outputPath(cacheDirectory),
      reason: null,
    });
    expect(await readFile(result.proxyPath!, "utf8")).toBe("validated-proxy");
    expect(await readFile(sourcePath, "utf8")).toBe("immutable-source");
    expect((await readdir(cacheDirectory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("returns a validated cache hit without invoking the encoder", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    await mkdir(cacheDirectory, { recursive: true });
    const target = outputPath(cacheDirectory);
    await writeFile(target, "cached-proxy");
    let transcodeCalls = 0;
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies({
        transcode: async () => { transcodeCalls += 1; },
      }),
    });
    expect(result).toMatchObject({
      status: "ready",
      cacheHit: true,
      proxyPath: target,
      preservedExistingProxy: true,
    });
    expect(transcodeCalls).toBe(0);
    expect(await readFile(target, "utf8")).toBe("cached-proxy");
  });

  it("keeps an existing proxy byte-for-byte when its replacement fails validation", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    await mkdir(cacheDirectory, { recursive: true });
    const target = outputPath(cacheDirectory);
    await writeFile(target, "previous-proxy");
    const invalidProbe = { ...validProxyProbe, maxKeyframeIntervalSeconds: 0.5 };
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies({
        probe: async (path, options) => {
          if (!options.includeKeyframes) return sourceProbe;
          return invalidProbe;
        },
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid-proxy",
      proxyPath: null,
      preservedExistingProxy: true,
    });
    expect(await readFile(target, "utf8")).toBe("previous-proxy");
    expect((await readdir(cacheDirectory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("rejects a proxy whose video stream starts after timeline zero", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies({
        probe: async (_path, options) => options.includeKeyframes
          ? {
              ...validProxyProbe,
              // This models the observed bad output: format start_time was 0,
              // while the video stream actually began two 30 fps frames late.
              startTime: 0.066,
              videoStartTime: 0.066,
            }
          : sourceProbe,
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "invalid-proxy",
      proxyPath: null,
    });
    expect(result.message).toContain("start at zero");
  });

  it("reports unsupported audio-less input without starting FFmpeg", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    let transcodeCalls = 0;
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies({
        probe: async () => ({ ...sourceProbe, hasAudio: false, audioCodec: null }),
        transcode: async () => { transcodeCalls += 1; },
      }),
    });
    expect(result).toMatchObject({
      status: "unsupported",
      reason: "source-without-audio",
      proxyPath: null,
    });
    expect(transcodeCalls).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe("immutable-source");
  });

  it("reports a missing FFmpeg as unsupported and leaves no partial output", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    const unavailable = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies({
        transcode: async () => { throw unavailable; },
      }),
    });
    expect(result).toMatchObject({
      status: "unsupported",
      reason: "ffmpeg-unavailable",
      proxyPath: null,
    });
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("refuses to publish under the old hash if the source changes concurrently", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    const result = await ensurePreviewProxy({
      sourcePath,
      cacheDirectory,
      dependencies: fakeDependencies({
        transcode: async ({ temporaryPath }) => {
          await writeFile(temporaryPath, "candidate");
          await appendFile(sourcePath, "-changed");
        },
      }),
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "source-changed",
      proxyPath: null,
    });
    expect(await readFile(sourcePath, "utf8")).toBe("immutable-source-changed");
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("uses the actual source bytes when no hash dependency is injected", async () => {
    const { sourcePath, cacheDirectory } = await fixture();
    const expectedSourceSha = createHash("sha256").update("immutable-source").digest("hex");
    const dependencies = fakeDependencies();
    delete dependencies.hashFile;
    const result = await ensurePreviewProxy({ sourcePath, cacheDirectory, dependencies });
    expect(result.sourceSha256).toBe(expectedSourceSha);
    expect(result.cacheKey).toBe(previewProxyCacheKey(expectedSourceSha));
  });

  it("creates a real same-timeline browser proxy with bounded GOP and AAC", async () => {
    const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-proxy-media-"));
    temporaryDirectories.push(root);
    const sourcePath = join(root, "source.mp4");
    const cacheDirectory = join(root, "preview");
    await command("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=60:duration=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", sourcePath,
    ]);

    const result = await ensurePreviewProxy({ sourcePath, cacheDirectory });
    if (result.status !== "ready") {
      throw new Error(`Preview proxy integration failed: ${JSON.stringify(result)}`);
    }
    expect(result.status).toBe("ready");
    expect(result.cacheHit).toBe(false);
    expect(result.proxyProbe).toMatchObject({
      hasVideo: true,
      hasAudio: true,
      width: 960,
      height: 540,
      frameRate: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      videoStartTime: 0,
      audioStartTime: 0,
    });
    expect(Math.abs(result.proxyProbe!.duration - result.sourceProbe!.duration)).toBeLessThan(0.12);
    expect(result.proxyProbe!.maxKeyframeIntervalSeconds).toBeLessThanOrEqual(0.21);

    const cached = await ensurePreviewProxy({ sourcePath, cacheDirectory });
    expect(cached).toMatchObject({ status: "ready", cacheHit: true, proxyPath: result.proxyPath });
  }, 20_000);
});
