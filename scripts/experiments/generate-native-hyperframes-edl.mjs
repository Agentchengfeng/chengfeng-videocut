#!/usr/bin/env node

/**
 * Build an isolated HyperFrames project that represents a chengfeng-videocut
 * edit list with HyperFrames' native media clip contract.
 *
 * This is deliberately an experiment, not a production generator. It creates
 * In `segments` mode it creates one muted <video> and one <audio> per retained
 * EDL segment. In `flattened` mode it creates one pair around an already-cut
 * media artifact. Both modes leave play, pause, seek, and timeline time to
 * HyperFrames so they can be compared under the same Studio.
 */

import { copyFile, link, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, true);
    }
  }
  const requiredPath = (name) => {
    const value = values.get(name);
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
    return resolve(value);
  };
  const projectId = String(values.get("project-id") ?? "native-hf-edl-198").trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(projectId)) {
    throw new Error("--project-id may only contain letters, numbers, dot, underscore, and dash");
  }
  const mode = String(values.get("mode") ?? "segments").trim();
  if (!new Set(["segments", "flattened"]).has(mode)) {
    throw new Error("--mode must be segments or flattened");
  }
  return {
    sourceProject: requiredPath("source-project"),
    outputDir: requiredPath("output-dir"),
    projectId,
    force: values.has("force"),
    mode,
    flattenedMedia: typeof values.get("flattened-media") === "string"
      ? resolve(String(values.get("flattened-media")))
      : null,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function isInside(parent, candidate) {
  const value = relative(parent, candidate);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function assert(condition, message, details = {}) {
  if (condition) return;
  const suffix = Object.keys(details).length ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function hardLinkOrCopy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(source, target);
    return "hard-link";
  } catch (linkError) {
    try {
      await copyFile(source, target);
      return "copy";
    } catch (copyError) {
      throw new Error(
        `Cannot materialize ${source}: link=${linkError.message}; copy=${copyError.message}`,
      );
    }
  }
}

function validateEditList(editList) {
  assert(editList?.schemaVersion === 1, "edit-list.json must use schemaVersion 1");
  assert(Array.isArray(editList.segments) && editList.segments.length > 0, "EDL has no segments");
  assert(Number.isFinite(Number(editList.duration)) && Number(editList.duration) > 0, "Bad EDL duration");
  let expectedTimelineStart = 0;
  for (const [index, segment] of editList.segments.entries()) {
    const sourceStart = Number(segment.sourceStart);
    const sourceEnd = Number(segment.sourceEnd);
    const timelineStart = Number(segment.timelineStart);
    const playbackRate = Number(segment.playbackRate);
    assert(
      Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart,
      "EDL segment has an invalid source range",
      { index, segment },
    );
    assert(Number.isFinite(playbackRate) && playbackRate > 0, "Invalid playbackRate", { index });
    assert(
      Math.abs(timelineStart - expectedTimelineStart) <= 0.002,
      "EDL segments are not magnetic/contiguous",
      { index, expectedTimelineStart, actual: timelineStart },
    );
    expectedTimelineStart += (sourceEnd - sourceStart) / playbackRate;
  }
  assert(
    Math.abs(expectedTimelineStart - Number(editList.duration)) <= 0.01,
    "EDL duration does not match its segment sum",
    { expectedTimelineStart, duration: editList.duration },
  );
}

function formatSeconds(value, precision = 6) {
  return Number(value).toFixed(precision).replace(/0+$/, "").replace(/\.$/, "");
}

function mediaNodes(editList, mode) {
  const source = "assets/source-proxy.mp4";
  if (mode === "flattened") {
    const duration = formatSeconds(Number(editList.duration));
    const common = `data-start="0" data-duration="${duration}" data-media-start="0" preload="metadata"`;
    return [
      `      <video id="native-video-0001" class="a-roll-media clip" src="${source}" ${common} data-track-index="0" muted playsinline></video>`,
      `      <audio id="native-audio-0001" class="clip" src="${source}" ${common} data-track-index="10" data-volume="1"></audio>`,
    ].join("\n");
  }
  return editList.segments.flatMap((segment, index) => {
    const ordinal = String(index + 1).padStart(4, "0");
    const start = Number(segment.timelineStart);
    const nextStart = index + 1 < editList.segments.length
      ? Number(editList.segments[index + 1].timelineStart)
      : Number(editList.duration);
    // HyperFrames' static duplicate-audio guard compares IEEE-754 sums with
    // strict inequalities. A 1 µs guard on non-final clips prevents a
    // mathematically contiguous boundary from becoming a false overlap after
    // decimal parsing, while remaining far below a video or audio sample.
    const duration = Math.max(0, nextStart - start - (index + 1 < editList.segments.length ? 0.000001 : 0));
    const mediaStart = Number(segment.sourceStart);
    const common = [
      `data-start="${formatSeconds(start)}"`,
      `data-duration="${formatSeconds(duration)}"`,
      `data-media-start="${formatSeconds(mediaStart)}"`,
      `preload="metadata"`,
    ].join(" ");
    return [
      `      <video id="native-video-${ordinal}" class="a-roll-media clip" src="${source}" ${common} data-track-index="0" muted playsinline></video>`,
      `      <audio id="native-audio-${ordinal}" class="clip" src="${source}" ${common} data-track-index="10" data-volume="1"></audio>`,
    ];
  }).join("\n");
}

function renderIndex(editList, projectId, width, height, mode) {
  const duration = Number(editList.duration).toFixed(3);
  const segmentCount = editList.segments.length;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${escapeHtml(projectId)}</title>
    <script src="assets/gsap.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; margin: 0; overflow: hidden; background: #111; }
      #root { position: relative; width: ${width}px; height: ${height}px; overflow: hidden; background: #111; }
      .a-roll-media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #111; }
    </style>
  </head>
  <body>
    <main
      id="root"
      data-hf-id="hf-root"
      data-composition-id="main"
      data-start="0"
      data-width="${width}"
      data-height="${height}"
      data-duration="${duration}"
      data-native-edl-experiment="1"
      data-native-edl-mode="${mode}"
      data-native-edl-segment-count="${segmentCount}"
    >
${mediaNodes(editList, mode)}
    </main>
    <script>
      window.__timelines = window.__timelines || {};
      const timeline = gsap.timeline({ paused: true });
      timeline.to({}, { duration: ${duration}, ease: "none" }, 0);
      window.__timelines.main = timeline;
    </script>
  </body>
</html>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (await exists(options.outputDir)) {
    if (!options.force) throw new Error(`Output exists; pass --force to replace it: ${options.outputDir}`);
    await rm(options.outputDir, { recursive: true, force: true });
  }

  const [editList, workbench, project] = await Promise.all([
    readJson(join(options.sourceProject, "edit-list.json")),
    readJson(join(options.sourceProject, "workbench.json")),
    readJson(join(options.sourceProject, "project.json")),
  ]);
  validateEditList(editList);

  const previewSource = workbench?.previewProxy?.source;
  const defaultFlattenedMedia = resolve(options.sourceProject, "剪口播/3_审核/source_cut.mp4");
  if (options.mode === "segments") {
    assert(workbench?.previewProxy?.status === "ready", "Source project has no ready preview proxy");
    assert(typeof previewSource === "string" && previewSource.trim(), "Preview proxy path is missing");
  }
  const proxyPath = options.mode === "flattened"
    ? (options.flattenedMedia ?? defaultFlattenedMedia)
    : resolve(options.sourceProject, previewSource);
  if (options.mode === "segments") {
    assert(isInside(options.sourceProject, proxyPath), "Preview proxy escapes the source project");
  }
  const proxyInfo = await stat(proxyPath);
  assert(proxyInfo.isFile() && proxyInfo.size > 0, "Preview proxy is not a non-empty file");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const gsapPath = resolve(scriptDir, "../../apps/studio/node_modules/gsap/dist/gsap.min.js");
  assert(await exists(gsapPath), "Local GSAP distribution is missing", { gsapPath });

  await mkdir(join(options.outputDir, "assets"), { recursive: true });
  const [mediaMaterialization, gsapMaterialization] = await Promise.all([
    hardLinkOrCopy(proxyPath, join(options.outputDir, "assets/source-proxy.mp4")),
    hardLinkOrCopy(gsapPath, join(options.outputDir, "assets/gsap.min.js")),
  ]);

  const width = Number(workbench.width) || 1440;
  const height = Number(workbench.height) || 1080;
  const experimentEditList = { ...editList, projectId: options.projectId };
  const generatedAt = new Date().toISOString();
  await Promise.all([
    writeFile(
      join(options.outputDir, "index.html"),
      renderIndex(experimentEditList, options.projectId, width, height, options.mode),
      "utf8",
    ),
    writeFile(
      join(options.outputDir, "hyperframes.json"),
      `${JSON.stringify({
        $schema: "https://hyperframes.heygen.com/schema/hyperframes.json",
        paths: { blocks: "compositions", components: "compositions/components", assets: "assets" },
      }, null, 2)}\n`,
      "utf8",
    ),
    // Deliberately avoid the production filename `edit-list.json`: the
    // chengfeng-videocut Studio adapter materializes that contract back into
    // the current custom EDL runtime before serving. This sidecar is evidence
    // only; the native clip DOM above is the experiment's source of truth.
    writeFile(
      join(options.outputDir, "native-edl-source.json"),
      `${JSON.stringify(experimentEditList, null, 2)}\n`,
      "utf8",
    ),
    // Product Studio probes both optional transcript locations even in the
    // generic editor view. Empty sidecars keep that capability probe quiet;
    // they are not used by the native media experiment.
    writeFile(
      join(options.outputDir, "transcript.json"),
      `${JSON.stringify({ schemaVersion: 1, cues: [] }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(options.outputDir, "subtitles_words.json"),
      `${JSON.stringify({ schemaVersion: 1, cues: [] }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(options.outputDir, "project.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        jobId: options.projectId,
        title: `${options.projectId} · HyperFrames 原生模拟裁剪`,
        status: "cut_review_ready",
        inputVideo: "assets/source-proxy.mp4",
        config: { aspectRatio: workbench.aspectRatio ?? "4:3" },
        createdAt: generatedAt,
        updatedAt: generatedAt,
        artifacts: { workbenchEntry: "index.html" },
        source: {
          path: "assets/source-proxy.mp4",
          sha256: project?.source?.sha256 ?? workbench?.sourceSha256 ?? null,
          immutable: true,
        },
        failedAt: null,
        error: null,
        recoverable: null,
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(options.outputDir, "workbench.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        projectId: options.projectId,
        jobDir: options.outputDir,
        videoSource: "assets/source-proxy.mp4",
        sourceSha256: project?.source?.sha256 ?? workbench?.sourceSha256 ?? null,
        aspectRatio: workbench.aspectRatio ?? "4:3",
        width,
        height,
        duration: Number(experimentEditList.duration),
        createdAt: generatedAt,
        updatedAt: generatedAt,
      }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      join(options.outputDir, "experiment.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: options.mode === "flattened"
          ? "hyperframes-native-edl-flattened"
          : "hyperframes-native-edl-segments",
        generatedAt,
        sourceProject: options.sourceProject,
        sourceProjectId: editList.projectId,
        projectId: options.projectId,
        segmentCount: experimentEditList.segments.length,
        mediaElementCount: options.mode === "flattened" ? 2 : experimentEditList.segments.length * 2,
        nativeMediaMode: options.mode,
        mediaSource: proxyPath,
        duration: experimentEditList.duration,
        sourceDuration: experimentEditList.sourceDuration,
        mediaMaterialization,
        gsapMaterialization,
        previewProxyBytes: proxyInfo.size,
      }, null, 2)}\n`,
      "utf8",
    ),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    projectId: options.projectId,
    outputDir: options.outputDir,
    segments: experimentEditList.segments.length,
    mediaElements: options.mode === "flattened" ? 2 : experimentEditList.segments.length * 2,
    mode: options.mode,
    duration: experimentEditList.duration,
    mediaMaterialization,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
