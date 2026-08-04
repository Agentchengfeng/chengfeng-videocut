import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendKouboEvent, atomicWriteJson } from "./project";
import { serializeKouboProjectOperation } from "./projectLock";
import { parseKouboSrt } from "./artifact";
import { ffmpegFileArg } from "@video-workbench/core";
import {
  readKouboWorkflow,
  type KouboProjectDocument,
  type KouboWorkflowSnapshot,
} from "./workflow";

type JsonObject = Record<string, unknown>;

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const FINAL_VIDEO_RELATIVE = "renders/final.mp4";
const VERIFICATION_RELATIVE = "renders/verification.json";
const VERIFICATION_FRAMES_RELATIVE = "renders/verification-frames";
const CONFIG_RELATIVE = "成片配置/config.json";
const PLAYER_RELATIVE = "final-player.html";
const TIMELINE_RELATIVE = "timeline.json";
const MANIFEST_RELATIVE = "动画/manifest.json";
const SOURCE_CUT_RELATIVE = "剪口播/3_审核/source_cut.mp4";
const SUBTITLES_RELATIVE = "subtitles.srt";

export type KouboRenderErrorCode =
  | "confirmation_required"
  | "invalid_argument"
  | "invalid_project"
  | "invalid_state"
  | "missing_artifact"
  | "missing_renderer"
  | "render_failed"
  | "revision_conflict"
  | "revision_required"
  | "verification_failed";

export class KouboRenderError extends Error {
  readonly code: KouboRenderErrorCode;
  readonly details?: JsonObject;

  constructor(code: KouboRenderErrorCode, message: string, details?: JsonObject) {
    super(message);
    this.name = "KouboRenderError";
    this.code = code;
    this.details = details;
  }
}

export interface KouboRenderProbe {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  videoCodec?: string;
  audioCodec?: string;
}

export interface KouboRendererInvocation {
  rendererPath: string | null;
  cwd: string;
  args: string[];
  projectDir: string;
  sourceCutPath: string;
  configPath: string;
  playerPath: string;
  outputPath: string;
}

export interface KouboFrameExtraction {
  videoPath: string;
  time: number;
  outputPath: string;
}

export interface KouboRenderDependencies {
  runner: (input: KouboRendererInvocation) => Promise<void>;
  probe: (path: string) => Promise<KouboRenderProbe>;
  frameExtractor: (input: KouboFrameExtraction) => Promise<void>;
}

export interface RunKouboRenderOptions {
  confirmed: boolean;
  expectedRevision: string;
  rendererPath?: string;
  now?: () => Date;
  dependencies?: Partial<KouboRenderDependencies>;
}

export interface VerifyKouboFinalOptions {
  now?: () => Date;
  dependencies?: Partial<Pick<KouboRenderDependencies, "probe" | "frameExtractor">>;
}

export interface KouboVerificationFrame {
  time: number;
  path: string;
}

export interface KouboHtmlSceneVerificationFrame extends KouboVerificationFrame {
  sceneId: string;
}

export interface KouboVerificationReport {
  schemaVersion: 1;
  passed: boolean;
  verifiedAt: string;
  projectId: string;
  projectRevision: string;
  aspectRatio: string;
  finalVideo: string;
  sourceCut: string;
  expected: {
    width: number;
    height: number;
    fps: number;
    maxDurationDelta: number;
  };
  actual: {
    final: KouboRenderProbe;
    source: KouboRenderProbe;
    durationDelta: number;
  };
  checks: {
    hasVideo: boolean;
    hasAudio: boolean;
    fps: boolean;
    dimensions: boolean;
    duration: boolean;
    timeline: boolean;
    animationManifest: boolean;
    finalPlayerSeekTo: boolean;
    finalPlayerVideoModel: boolean;
    finalPlayerCaptions: boolean;
  };
  errors: string[];
  frames: {
    directory: string;
    global: KouboVerificationFrame[];
    htmlScenes: KouboHtmlSceneVerificationFrame[];
    unique: KouboVerificationFrame[];
  };
}

export interface VerifyKouboFinalResult {
  report: KouboVerificationReport;
  verificationPath: string;
}

export interface RunKouboRenderResult extends KouboWorkflowSnapshot {
  previousRevision: string;
  invocation: KouboRendererInvocation;
  verification: KouboVerificationReport;
  finalVideoPath: string;
  verificationPath: string;
}

interface RenderPaths {
  directory: string;
  sourceCutPath: string;
  subtitlesPath: string;
  configPath: string;
  playerPath: string;
  timelinePath: string;
  manifestPath: string;
  finalVideoPath: string;
  verificationPath: string;
  verificationFramesDir: string;
}

interface HtmlScene {
  id: string;
  start: number;
  end: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowValue(now?: () => Date): { date: Date; iso: string } {
  const date = (now ?? (() => new Date()))();
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new KouboRenderError("invalid_argument", "now() must return a valid Date");
  }
  return { date, iso: date.toISOString() };
}

function assertConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new KouboRenderError(
      "confirmation_required",
      "Rendering requires explicit user confirmation",
    );
  }
}

function assertExpectedRevision(expectedRevision: string | undefined): asserts expectedRevision is string {
  if (!expectedRevision) {
    throw new KouboRenderError(
      "revision_required",
      "Rendering requires expectedRevision",
    );
  }
  if (!REVISION_PATTERN.test(expectedRevision)) {
    throw new KouboRenderError(
      "invalid_argument",
      "expectedRevision must be a lowercase SHA-256 revision",
      { expectedRevision },
    );
  }
}

function assertRevision(snapshot: KouboWorkflowSnapshot, expectedRevision: string): void {
  if (snapshot.revision !== expectedRevision) {
    throw new KouboRenderError(
      "revision_conflict",
      "project.json changed after it was inspected",
      { expectedRevision, currentRevision: snapshot.revision },
    );
  }
}

function assertInsideProject(directory: string, path: string): void {
  const value = relative(directory, path);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new KouboRenderError(
      "invalid_project",
      `Render artifacts must stay inside the project directory: ${path}`,
    );
  }
}

async function existingProjectFile(directory: string, value: string): Promise<string | null> {
  if (!value.trim()) return null;
  const candidate = isAbsolute(value) ? value : resolve(directory, value);
  assertInsideProject(directory, candidate);
  try {
    const path = await realpath(candidate);
    assertInsideProject(directory, path);
    return (await stat(path)).isFile() ? path : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function requireProjectFile(
  directory: string,
  candidates: readonly string[],
  label: string,
): Promise<string> {
  const unique = [...new Set(candidates.filter((candidate) => candidate.trim()))];
  for (const candidate of unique) {
    const path = await existingProjectFile(directory, candidate);
    if (path) return path;
  }
  throw new KouboRenderError(
    "missing_artifact",
    `${label} is missing from this project`,
    { label, candidates: unique },
  );
}

function artifactValue(project: KouboProjectDocument, key: string): string {
  const artifacts = isObject(project.artifacts) ? project.artifacts : {};
  return typeof artifacts[key] === "string" ? String(artifacts[key]).trim() : "";
}

async function resolveRenderPaths(
  directory: string,
  project: KouboProjectDocument,
  requireFinalVideo: boolean,
): Promise<RenderPaths> {
  const sourceCutPath = await requireProjectFile(
    directory,
    [artifactValue(project, "sourceCut"), SOURCE_CUT_RELATIVE, "source_cut.mp4"],
    "source_cut.mp4",
  );
  const subtitlesPath = await requireProjectFile(
    directory,
    [artifactValue(project, "subtitles"), SUBTITLES_RELATIVE],
    "subtitles.srt",
  );
  // These are product-canonical files. The renderer receives their fixed task
  // paths, so legacy review-page aliases are deliberately not accepted.
  const configPath = await requireProjectFile(directory, [CONFIG_RELATIVE], "成片配置/config.json");
  const playerPath = await requireProjectFile(directory, [PLAYER_RELATIVE], "final-player.html");
  const timelinePath = await requireProjectFile(directory, [TIMELINE_RELATIVE], "timeline.json");
  const manifestPath = await requireProjectFile(directory, [MANIFEST_RELATIVE], "动画/manifest.json");
  const finalVideoPath = join(directory, FINAL_VIDEO_RELATIVE);
  if (requireFinalVideo) {
    await requireProjectFile(directory, [FINAL_VIDEO_RELATIVE], "renders/final.mp4");
  }
  return {
    directory,
    sourceCutPath,
    subtitlesPath,
    configPath,
    playerPath,
    timelinePath,
    manifestPath,
    finalVideoPath,
    verificationPath: join(directory, VERIFICATION_RELATIVE),
    verificationFramesDir: join(directory, VERIFICATION_FRAMES_RELATIVE),
  };
}

async function readJsonObject(path: string, label: string): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new KouboRenderError(
      "verification_failed",
      `${label} is not valid JSON: ${errorMessage(error)}`,
      { path },
    );
  }
  if (!isObject(value)) {
    throw new KouboRenderError(
      "verification_failed",
      `${label} must contain a JSON object`,
      { path },
    );
  }
  return value;
}

function capOutput(previous: string, chunk: string, maximum = 65_536): string {
  const next = previous + chunk;
  return next.length <= maximum ? next : next.slice(-maximum);
}

async function runCommand(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout = capOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk: string) => { stderr = capOutput(stderr, chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(
        `${command} failed (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

function rational(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const [left, right] = text.split("/").map(Number);
  if (Number.isFinite(left) && Number.isFinite(right) && right !== 0) return left / right;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export async function probeKouboRenderMedia(path: string): Promise<KouboRenderProbe> {
  const { stdout } = await runCommand("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate",
    "-of", "json",
    ffmpegFileArg(path),
  ]);
  const payload = JSON.parse(stdout) as {
    format?: { duration?: string | number };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const averageFps = rational(video?.avg_frame_rate);
  return {
    duration: Math.max(0, finite(payload.format?.duration)),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: Math.max(0, finite(video?.width)),
    height: Math.max(0, finite(video?.height)),
    fps: Math.max(0, averageFps || rational(video?.r_frame_rate)),
    ...(video ? { videoCodec: String(video.codec_name ?? "") } : {}),
    ...(audio ? { audioCodec: String(audio.codec_name ?? "") } : {}),
  };
}

export async function extractKouboVerificationFrame(
  input: KouboFrameExtraction,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await runCommand("ffmpeg", [
    "-y", "-v", "error",
    "-ss", input.time.toFixed(3),
    "-i", ffmpegFileArg(input.videoPath),
    "-frames:v", "1",
    "-f", "image2",
    input.outputPath,
  ]);
}

async function defaultRendererRunner(input: KouboRendererInvocation): Promise<void> {
  if (!input.rendererPath) {
    throw new KouboRenderError(
      "missing_renderer",
      "Set rendererPath or CHENGFENG_VIDEOCUT_RENDERER_PATH before rendering",
    );
  }
  const nodePath = process.env.CHENGFENG_VIDEOCUT_NODE_PATH?.trim() || "node";
  await runCommand(nodePath, [input.rendererPath, ...input.args], input.cwd);
}

async function resolveRendererPath(
  explicitPath: string | undefined,
  hasInjectedRunner: boolean,
): Promise<string | null> {
  const configured = explicitPath?.trim() ||
    process.env.CHENGFENG_VIDEOCUT_RENDERER_PATH?.trim() ||
    "";
  if (!configured) {
    if (hasInjectedRunner) return null;
    throw new KouboRenderError(
      "missing_renderer",
      "Set rendererPath or CHENGFENG_VIDEOCUT_RENDERER_PATH before rendering",
    );
  }
  const candidate = resolve(configured);
  if (hasInjectedRunner) return candidate;
  try {
    const path = await realpath(candidate);
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    return path;
  } catch (error) {
    throw new KouboRenderError(
      "missing_renderer",
      `Renderer does not exist: ${candidate}`,
      { rendererPath: candidate, cause: errorMessage(error) },
    );
  }
}

function rendererInvocation(paths: RenderPaths, rendererPath: string | null): KouboRendererInvocation {
  return {
    rendererPath,
    cwd: paths.directory,
    args: [
      "--project-dir", paths.directory,
      "--input-video", paths.sourceCutPath,
      "--config", paths.configPath,
      "--player", PLAYER_RELATIVE,
      "--output", FINAL_VIDEO_RELATIVE,
      "--frame-format", "png",
      "--fps", "30",
      "--crf", "14",
      "--preset", "slow",
    ],
    projectDir: paths.directory,
    sourceCutPath: paths.sourceCutPath,
    configPath: paths.configPath,
    playerPath: paths.playerPath,
    outputPath: paths.finalVideoPath,
  };
}

function expectedDimensions(aspectRatio: string): { width: number; height: number } | null {
  if (aspectRatio === "3:4") return { width: 1620, height: 2160 };
  if (aspectRatio === "16:9") return { width: 1920, height: 1080 };
  if (aspectRatio === "4:3") return { width: 1440, height: 1080 };
  return null;
}

function htmlScenes(timeline: JsonObject, duration: number, errors: string[]): HtmlScene[] {
  const scenes = Array.isArray(timeline.scenes) ? timeline.scenes : [];
  const result: HtmlScene[] = [];
  scenes.forEach((scene, index) => {
    if (!isObject(scene) || scene.kind !== "html") return;
    const id = typeof scene.id === "string" ? scene.id.trim() : "";
    const start = Number(scene.start);
    const end = Number(scene.end);
    if (
      !id ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > duration + 0.100001
    ) {
      errors.push(`timeline html scene ${index} has an invalid id or time range`);
      return;
    }
    result.push({ id, start, end });
  });
  return result;
}

function relativeProjectPath(directory: string, path: string): string {
  assertInsideProject(directory, path);
  return relative(directory, path).split(sep).join("/");
}

function emptyFrames(): KouboVerificationReport["frames"] {
  return {
    directory: VERIFICATION_FRAMES_RELATIVE,
    global: [],
    htmlScenes: [],
    unique: [],
  };
}

async function persistVerificationFailure(
  paths: RenderPaths,
  report: KouboVerificationReport,
): Promise<never> {
  await atomicWriteJson(paths.verificationPath, report);
  throw new KouboRenderError(
    "verification_failed",
    report.errors.join("; ") || "Final video verification failed",
    {
      verificationPath: paths.verificationPath,
      errors: report.errors,
    },
  );
}

async function verifyKouboFinalUnlocked(input: {
  snapshot: KouboWorkflowSnapshot;
  paths: RenderPaths;
  now?: () => Date;
  dependencies?: VerifyKouboFinalOptions["dependencies"];
}): Promise<VerifyKouboFinalResult> {
  const timestamp = nowValue(input.now);
  const [config, timeline, manifest, player, subtitles, finalProbe, sourceProbe] = await Promise.all([
    readJsonObject(input.paths.configPath, "成片配置/config.json"),
    readJsonObject(input.paths.timelinePath, "timeline.json"),
    readJsonObject(input.paths.manifestPath, "动画/manifest.json"),
    readFile(input.paths.playerPath, "utf8"),
    readFile(input.paths.subtitlesPath, "utf8"),
    (input.dependencies?.probe ?? probeKouboRenderMedia)(input.paths.finalVideoPath),
    (input.dependencies?.probe ?? probeKouboRenderMedia)(input.paths.sourceCutPath),
  ]);
  const aspectRatio = String(config.aspectRatio ?? "").trim().replaceAll("：", ":");
  const dimensions = expectedDimensions(aspectRatio);
  const errors: string[] = [];
  const scenes = htmlScenes(timeline, finalProbe.duration, errors);
  const manifestOkay = Array.isArray(manifest.modules);
  const timelineOkay = Array.isArray(timeline.scenes);
  const seekToOkay = player.includes("seekTo");
  const finalVideoModelOkay = player.includes("finalVideo");
  const subtitleCues = parseKouboSrt(subtitles);
  const serializedCaptions = JSON.stringify(subtitleCues).replaceAll("<", "\\u003c");
  const finalPlayerCaptionsOkay = subtitleCues.length > 0 &&
    player.includes(`const finalCaptions=${serializedCaptions}`);
  const durationDelta = Math.abs(finalProbe.duration - sourceProbe.duration);
  const hasVideo = finalProbe.hasVideo && finalProbe.duration > 0;
  const hasAudio = finalProbe.hasAudio;
  const fpsOkay = Math.abs(finalProbe.fps - 30) <= 0.01;
  const dimensionsOkay = Boolean(dimensions) &&
    finalProbe.width === dimensions?.width && finalProbe.height === dimensions?.height;
  const durationOkay = sourceProbe.duration > 0 && finalProbe.duration > 0 && durationDelta <= 0.100001;

  if (!dimensions) errors.push(`unsupported aspectRatio: ${aspectRatio || "empty"}`);
  if (!hasVideo) errors.push("final.mp4 has no readable video stream");
  if (!hasAudio) errors.push("final.mp4 has no audio stream");
  if (!fpsOkay) errors.push(`final.mp4 fps is ${finalProbe.fps}, expected 30`);
  if (!dimensionsOkay && dimensions) {
    errors.push(
      `final.mp4 dimensions are ${finalProbe.width}x${finalProbe.height}, expected ${dimensions.width}x${dimensions.height}`,
    );
  }
  if (!durationOkay) {
    errors.push(
      `final.mp4 duration differs from source_cut by ${durationDelta.toFixed(3)}s, maximum is 0.10s`,
    );
  }
  if (!timelineOkay) errors.push("timeline.json must contain scenes");
  if (!manifestOkay) errors.push("动画/manifest.json must contain modules");
  if (!seekToOkay) errors.push("final-player.html does not expose seekTo");
  if (!finalVideoModelOkay) errors.push("final-player.html does not expose finalVideo");
  if (!finalPlayerCaptionsOkay) {
    errors.push("final-player.html does not embed the canonical subtitles.srt cues");
  }

  const report: KouboVerificationReport = {
    schemaVersion: 1,
    passed: errors.length === 0,
    verifiedAt: timestamp.iso,
    projectId: input.snapshot.jobId,
    projectRevision: input.snapshot.revision,
    aspectRatio,
    finalVideo: FINAL_VIDEO_RELATIVE,
    sourceCut: relativeProjectPath(input.paths.directory, input.paths.sourceCutPath),
    expected: {
      width: dimensions?.width ?? 0,
      height: dimensions?.height ?? 0,
      fps: 30,
      maxDurationDelta: 0.1,
    },
    actual: {
      final: finalProbe,
      source: sourceProbe,
      durationDelta,
    },
    checks: {
      hasVideo,
      hasAudio,
      fps: fpsOkay,
      dimensions: dimensionsOkay,
      duration: durationOkay,
      timeline: timelineOkay,
      animationManifest: manifestOkay,
      finalPlayerSeekTo: seekToOkay,
      finalPlayerVideoModel: finalVideoModelOkay,
      finalPlayerCaptions: finalPlayerCaptionsOkay,
    },
    errors,
    frames: emptyFrames(),
  };
  if (errors.length > 0) return persistVerificationFailure(input.paths, report);

  const globalTimes = [0.1, 0.5, 0.9].map((ratio) => finalProbe.duration * ratio);
  const requests = [
    ...globalTimes.map((time, index) => ({ kind: "global" as const, id: String(index), time })),
    ...scenes.map((scene) => ({
      kind: "html" as const,
      id: scene.id,
      time: Math.max(0, Math.min(finalProbe.duration * 0.999999, scene.start + (scene.end - scene.start) / 2)),
    })),
  ];
  const uniqueTimes = new Map<string, number>();
  for (const request of requests) {
    const key = request.time.toFixed(3);
    if (!uniqueTimes.has(key)) uniqueTimes.set(key, request.time);
  }
  if (new Set(globalTimes.map((time) => time.toFixed(3))).size < 3) {
    report.passed = false;
    report.errors.push("final.mp4 is too short to extract three distinct global keyframes");
    return persistVerificationFailure(input.paths, report);
  }

  await rm(input.paths.verificationFramesDir, { recursive: true, force: true });
  await mkdir(input.paths.verificationFramesDir, { recursive: true });
  const extracted = new Map<string, KouboVerificationFrame>();
  const frameExtractor = input.dependencies?.frameExtractor ?? extractKouboVerificationFrame;
  try {
    let index = 0;
    for (const [key, time] of [...uniqueTimes.entries()].sort((left, right) => left[1] - right[1])) {
      index += 1;
      const outputPath = join(
        input.paths.verificationFramesDir,
        `frame-${String(index).padStart(4, "0")}-${String(Math.round(time * 1000)).padStart(8, "0")}ms.png`,
      );
      await frameExtractor({ videoPath: input.paths.finalVideoPath, time, outputPath });
      const info = await stat(outputPath);
      if (!info.isFile() || info.size === 0) {
        throw new Error(`Frame extractor did not create a non-empty image: ${outputPath}`);
      }
      extracted.set(key, { time, path: relativeProjectPath(input.paths.directory, outputPath) });
    }
  } catch (error) {
    report.passed = false;
    report.errors.push(`keyframe extraction failed: ${errorMessage(error)}`);
    report.frames.unique = [...extracted.values()];
    return persistVerificationFailure(input.paths, report);
  }

  report.frames.unique = [...extracted.values()];
  report.frames.global = globalTimes.map((time) => {
    const frame = extracted.get(time.toFixed(3));
    if (!frame) throw new Error(`Missing global frame evidence at ${time.toFixed(3)}s`);
    return { ...frame };
  });
  report.frames.htmlScenes = scenes.map((scene) => {
    const time = Math.max(
      0,
      Math.min(finalProbe.duration * 0.999999, scene.start + (scene.end - scene.start) / 2),
    );
    const frame = extracted.get(time.toFixed(3));
    if (!frame) throw new Error(`Missing HTML-scene frame evidence for ${scene.id}`);
    return { sceneId: scene.id, ...frame };
  });
  report.passed = true;
  await atomicWriteJson(input.paths.verificationPath, report);
  return { report, verificationPath: input.paths.verificationPath };
}

/** Verifies an already rendered canonical final.mp4 and writes verification.json. */
export async function verifyKouboFinal(
  jobDir: string,
  options: VerifyKouboFinalOptions = {},
): Promise<VerifyKouboFinalResult> {
  const initial = await readKouboWorkflow(jobDir);
  return serializeKouboProjectOperation(initial.directory, async () => {
    const snapshot = await readKouboWorkflow(initial.directory);
    const paths = await resolveRenderPaths(initial.directory, snapshot.project, true);
    return verifyKouboFinalUnlocked({
      snapshot,
      paths,
      now: options.now,
      dependencies: options.dependencies,
    });
  });
}

function renderStateAllowed(snapshot: KouboWorkflowSnapshot): boolean {
  const continuation = isObject(snapshot.project.codexContinue)
    ? snapshot.project.codexContinue
    : {};
  return (
    snapshot.status === "codex_continue_required" && continuation.stage === "render"
  ) || (
    snapshot.status === "failed" && snapshot.project.failedAt === "rendering"
  );
}

function clearedArtifacts(project: KouboProjectDocument): JsonObject {
  const artifacts = isObject(project.artifacts) ? { ...project.artifacts } : {};
  delete artifacts.finalVideo;
  delete artifacts.verification;
  return artifacts;
}

function activeProject(
  project: KouboProjectDocument,
  status: "rendering" | "verifying",
  updatedAt: string,
): KouboProjectDocument {
  return {
    ...project,
    status,
    updatedAt,
    artifacts: clearedArtifacts(project),
    failedAt: null,
    error: null,
    recoverable: null,
    codexContinue: {
      required: false,
      stage: "",
      prompt: "",
      reason: "",
    },
  };
}

function asRenderError(error: unknown, phase: "rendering" | "verifying"): KouboRenderError {
  if (error instanceof KouboRenderError) return error;
  return new KouboRenderError(
    phase === "verifying" ? "verification_failed" : "render_failed",
    errorMessage(error),
  );
}

async function markRenderFailure(input: {
  snapshot: KouboWorkflowSnapshot;
  project: KouboProjectDocument;
  phase: "rendering" | "verifying";
  error: unknown;
  now?: () => Date;
}): Promise<void> {
  const timestamp = nowValue(input.now);
  const failure = asRenderError(input.error, input.phase);
  const failed: KouboProjectDocument = {
    ...input.project,
    status: "failed",
    updatedAt: timestamp.iso,
    failedAt: input.phase,
    error: failure.message,
    recoverable: true,
    codexContinue: {
      required: false,
      stage: "",
      prompt: "",
      reason: "",
    },
  };
  await atomicWriteJson(input.snapshot.projectPath, failed);
  await appendKouboEvent(input.snapshot.directory, "failed", {
    failedAt: input.phase,
    error: failure.message,
    errorCode: failure.code,
    recoverable: true,
  }, timestamp.date);
}

/**
 * Runs the fixed high-quality renderer contract and admits `done` only after
 * machine-readable media and frame-evidence verification succeeds.
 */
export async function runKouboRender(
  jobDir: string,
  options: RunKouboRenderOptions,
): Promise<RunKouboRenderResult> {
  assertConfirmed(options.confirmed);
  assertExpectedRevision(options.expectedRevision);
  const initial = await readKouboWorkflow(jobDir);
  return serializeKouboProjectOperation(initial.directory, async () => {
    const snapshot = await readKouboWorkflow(initial.directory);
    assertRevision(snapshot, options.expectedRevision);
    if (!renderStateAllowed(snapshot)) {
      throw new KouboRenderError(
        "invalid_state",
        "Rendering can start only from codex_continue_required(stage=render) or failedAt=rendering",
        {
          status: snapshot.status,
          stage: isObject(snapshot.project.codexContinue)
            ? snapshot.project.codexContinue.stage ?? null
            : null,
          failedAt: snapshot.project.failedAt ?? null,
        },
      );
    }

    const paths = await resolveRenderPaths(snapshot.directory, snapshot.project, false);
    const injectedRunner = options.dependencies?.runner;
    const rendererPath = await resolveRendererPath(options.rendererPath, Boolean(injectedRunner));
    const invocation = rendererInvocation(paths, rendererPath);
    const runner = injectedRunner ?? defaultRendererRunner;
    let phase: "rendering" | "verifying" = "rendering";
    const renderingTime = nowValue(options.now);
    let currentProject = activeProject(snapshot.project, "rendering", renderingTime.iso);
    await atomicWriteJson(snapshot.projectPath, currentProject);

    try {
      await appendKouboEvent(snapshot.directory, "status_changed", {
        from: snapshot.status,
        status: "rendering",
        source: "chengfeng-videocut",
      }, renderingTime.date);
      await rm(paths.finalVideoPath, { force: true });
      await rm(paths.verificationPath, { force: true });
      await runner(invocation);

      const verifyingTime = nowValue(options.now);
      currentProject = activeProject(currentProject, "verifying", verifyingTime.iso);
      await atomicWriteJson(snapshot.projectPath, currentProject);
      phase = "verifying";
      await appendKouboEvent(snapshot.directory, "status_changed", {
        from: "rendering",
        status: "verifying",
        source: "chengfeng-videocut",
      }, verifyingTime.date);

      const verifyingSnapshot = await readKouboWorkflow(snapshot.directory);
      const verifiedPaths = await resolveRenderPaths(
        snapshot.directory,
        verifyingSnapshot.project,
        true,
      );
      const verification = await verifyKouboFinalUnlocked({
        snapshot: verifyingSnapshot,
        paths: verifiedPaths,
        now: options.now,
        dependencies: {
          probe: options.dependencies?.probe,
          frameExtractor: options.dependencies?.frameExtractor,
        },
      });
      const completed = nowValue(options.now);
      const artifacts = isObject(currentProject.artifacts) ? { ...currentProject.artifacts } : {};
      artifacts.finalVideo = FINAL_VIDEO_RELATIVE;
      artifacts.verification = VERIFICATION_RELATIVE;
      const doneProject: KouboProjectDocument = {
        ...currentProject,
        status: "done",
        updatedAt: completed.iso,
        artifacts,
        failedAt: null,
        error: null,
        recoverable: null,
        codexContinue: {
          required: false,
          stage: "",
          prompt: "",
          reason: "",
        },
      };
      await atomicWriteJson(snapshot.projectPath, doneProject);
      await appendKouboEvent(snapshot.directory, "verification_completed", {
        verification: VERIFICATION_RELATIVE,
        uniqueFrameCount: verification.report.frames.unique.length,
        htmlSceneCount: verification.report.frames.htmlScenes.length,
      }, completed.date);
      await appendKouboEvent(snapshot.directory, "render_done", {
        finalVideo: FINAL_VIDEO_RELATIVE,
        verification: VERIFICATION_RELATIVE,
      }, completed.date);
      await appendKouboEvent(snapshot.directory, "status_changed", {
        from: "verifying",
        status: "done",
        source: "chengfeng-videocut",
      }, completed.date);
      const doneSnapshot = await readKouboWorkflow(snapshot.directory);
      return {
        ...doneSnapshot,
        previousRevision: snapshot.revision,
        invocation,
        verification: verification.report,
        finalVideoPath: paths.finalVideoPath,
        verificationPath: paths.verificationPath,
      };
    } catch (error) {
      try {
        await markRenderFailure({
          snapshot,
          project: currentProject,
          phase,
          error,
          now: options.now,
        });
      } catch (markError) {
        throw new KouboRenderError(
          phase === "verifying" ? "verification_failed" : "render_failed",
          `${errorMessage(error)}; additionally failed to persist recovery state: ${errorMessage(markError)}`,
        );
      }
      throw asRenderError(error, phase);
    }
  });
}
