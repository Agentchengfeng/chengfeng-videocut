#!/usr/bin/env bun

/**
 * Isolated real-media smoke for the complete chengfeng-videocut workflow.
 *
 * The source recording and original Koubo task are read-only inputs. Every
 * generated file, registry link, physical cut, artifact, render, and report is
 * written below a fresh temporary run directory (or --output-root).
 *
 * Usage:
 *   bun scripts/e2e-real-media.ts \
 *     --source /absolute/source.mp4 \
 *     --transcript /absolute/subtitles_words.json \
 *     --original-task /absolute/read-only-task \
 *     --renderer /absolute/export_final_video.cjs
 *   bun scripts/e2e-real-media.ts ... --output-root /tmp/videocut-real-e2e
 *   bun scripts/e2e-real-media.ts ... --no-render
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyKouboCut,
  parseKouboSrt,
  prepareKouboProject,
  probeKouboRenderMedia,
  probeMedia,
  putKouboArtifact,
  readKouboWorkflow,
  runKouboRender,
  transitionKouboWorkflow,
  type KouboArtifactType,
  type KouboTranscriptWord,
  type MediaCutRange,
} from "../packages/koubo-adapter/src/index";
import { registerProject, resolveProject } from "../packages/core/src/node";

type JsonObject = Record<string, unknown>;

interface Options {
  source: string;
  transcript: string;
  originalTask: string;
  renderer: string;
  outputRoot?: string;
  segmentStart: number;
  duration: number;
  render: boolean;
  keepRenderFrames: boolean;
  json: boolean;
}

interface SourceWord {
  id: string;
  text: string;
  start: number;
  end: number;
  isGap: boolean;
  sourceIndex: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface ReadOnlySnapshot {
  source: Awaited<ReturnType<typeof sampledFileFingerprint>>;
  transcript: Awaited<ReturnType<typeof fullFileFingerprint>>;
  originalTask: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      values.set(rawName, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(rawName, next);
      index += 1;
    } else {
      values.set(rawName, true);
    }
  }
  const text = (name: string): string | undefined => {
    const value = values.get(name);
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const requiredText = (name: string): string => {
    const value = text(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const number = (name: string, fallback: number): number => {
    const value = values.get(name);
    const result = typeof value === "string" ? Number(value) : fallback;
    if (!Number.isFinite(result)) throw new Error(`--${name} must be a finite number`);
    return result;
  };
  const duration = number("duration", 8);
  if (duration < 8 || duration > 12) {
    throw new Error("--duration must stay between 8 and 12 seconds for this real-media smoke");
  }
  const segmentStart = number("segment-start", 2.5);
  if (segmentStart < 0) throw new Error("--segment-start must be non-negative");
  const outputValue = values.get("output-root");
  const render = !values.has("no-render");
  const renderer = text("renderer") ?? process.env.CHENGFENG_VIDEOCUT_RENDERER_PATH;
  if (render && !renderer) {
    throw new Error("--renderer or CHENGFENG_VIDEOCUT_RENDERER_PATH is required unless --no-render is used");
  }
  return {
    source: resolve(requiredText("source")),
    transcript: resolve(requiredText("transcript")),
    originalTask: resolve(requiredText("original-task")),
    renderer: renderer ? resolve(renderer) : "",
    ...(typeof outputValue === "string" && outputValue.trim()
      ? { outputRoot: resolve(outputValue) }
      : {}),
    segmentStart,
    duration,
    render,
    keepRenderFrames: values.has("keep-render-frames"),
    json: values.has("json"),
  };
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
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(
        `${command} failed (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${stderr.trim().slice(-4000)}` : ""}`,
      ));
    });
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fullFileFingerprint(path: string): Promise<JsonObject> {
  const info = await stat(path);
  const content = await readFile(path);
  return {
    path,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sha256: sha256(content),
  };
}

async function sampledFileFingerprint(path: string): Promise<JsonObject> {
  const info = await stat(path);
  const sampleSize = Math.min(info.size, 64 * 1024);
  const first = Buffer.alloc(sampleSize);
  const last = Buffer.alloc(sampleSize);
  const handle = await open(path, "r");
  try {
    await handle.read(first, 0, sampleSize, 0);
    await handle.read(last, 0, sampleSize, Math.max(0, info.size - sampleSize));
  } finally {
    await handle.close();
  }
  return {
    path,
    size: info.size,
    mtimeMs: info.mtimeMs,
    sampleSha256: sha256(Buffer.concat([first, last])),
  };
}

async function snapshotReadOnlyInputs(options: Options): Promise<ReadOnlySnapshot> {
  return {
    source: await sampledFileFingerprint(options.source),
    transcript: await fullFileFingerprint(options.transcript),
    originalTask: await taskTreeFingerprint(options.originalTask),
  };
}

async function taskTreeFingerprint(root: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = join(directory, name);
      const info = await lstat(path);
      const local = relative(root, path).split(sep).join("/");
      if (info.isSymbolicLink()) {
        entries.push(`l\t${local}\t${await readlink(path)}\t${info.mtimeMs}`);
      } else if (info.isDirectory()) {
        entries.push(`d\t${local}\t${info.mode}\t${info.mtimeMs}`);
        await walk(path);
      } else if (info.isFile()) {
        const digest = info.size <= 5 * 1024 * 1024
          ? sha256(await readFile(path))
          : "metadata-only";
        entries.push(`f\t${local}\t${info.size}\t${info.mode}\t${info.mtimeMs}\t${digest}`);
      }
    }
  };
  await walk(root);
  return sha256(entries.join("\n"));
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function assertIsolation(options: Options, outputRoot: string): void {
  if (inside(options.originalTask, outputRoot) || inside(outputRoot, options.originalTask)) {
    throw new Error(`Output root must be isolated from the original task: ${outputRoot}`);
  }
  if (inside(dirname(options.transcript), outputRoot) || inside(dirname(options.source), outputRoot)) {
    throw new Error(`Output root overlaps a read-only source directory: ${outputRoot}`);
  }
  if (inside(outputRoot, options.source) || inside(outputRoot, options.transcript)) {
    throw new Error("A read-only input unexpectedly resolves inside the generated output root");
  }
}

function normalizeSourceWords(payload: unknown, start: number, duration: number): SourceWord[] {
  if (!Array.isArray(payload)) throw new Error("The real transcript must contain a word array");
  const end = start + duration;
  return payload.flatMap((raw, sourceIndex) => {
    if (!isObject(raw)) return [];
    const sourceStart = finite(raw.start, -1);
    const sourceEnd = finite(raw.end, -1);
    if (sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd <= start || sourceStart >= end) return [];
    const text = String(raw.text ?? "");
    const wordStart = Math.max(0, sourceStart - start);
    const wordEnd = Math.min(duration, sourceEnd - start);
    if (wordEnd <= wordStart) return [];
    return [{
      id: `real-${String(sourceIndex + 1).padStart(6, "0")}`,
      text,
      start: Number(wordStart.toFixed(3)),
      end: Number(wordEnd.toFixed(3)),
      isGap: Boolean(raw.isGap) || !text.trim(),
      sourceIndex,
    }];
  });
}

function removedBefore(time: number, cuts: readonly MediaCutRange[]): number {
  return cuts.reduce((sum, range) => {
    return sum + Math.max(0, Math.min(time, range.end) - Math.min(time, range.start));
  }, 0);
}

function remapSpeechWords(
  words: readonly KouboTranscriptWord[],
  cuts: readonly MediaCutRange[],
  outputDuration: number,
): Array<{ text: string; start: number; end: number }> {
  return words.flatMap((word) => {
    if (word.isGap || !word.text.trim()) return [];
    const retained = cuts.every((range) => word.end <= range.start || word.start >= range.end);
    if (!retained) return [];
    const start = Math.max(0, word.start - removedBefore(word.start, cuts));
    const end = Math.min(outputDuration, word.end - removedBefore(word.end, cuts));
    return end > start + 0.01 ? [{ text: word.text.trim(), start, end }] : [];
  });
}

function appendToken(previous: string, token: string): string {
  if (!previous) return token;
  const latinEnd = /[A-Za-z0-9]$/.test(previous);
  const latinStart = /^[A-Za-z0-9]/.test(token);
  return `${previous}${latinEnd && latinStart ? " " : ""}${token}`;
}

function subtitleCues(words: Array<{ text: string; start: number; end: number }>): Array<{
  id: string;
  start: number;
  end: number;
  text: string;
}> {
  const cues: Array<{ id: string; start: number; end: number; text: string }> = [];
  let current: { start: number; end: number; text: string; count: number } | null = null;
  const flush = (): void => {
    if (!current) return;
    cues.push({
      id: `real-caption-${String(cues.length + 1).padStart(3, "0")}`,
      start: current.start,
      end: current.end,
      text: current.text,
    });
    current = null;
  };
  for (const word of words) {
    const shouldFlush = current && (
      word.start - current.end > 0.55 ||
      current.count >= 12 ||
      current.text.length >= 20 ||
      /[。！？!?]$/.test(current.text)
    );
    if (shouldFlush) flush();
    if (!current) {
      current = { start: word.start, end: word.end, text: word.text, count: 1 };
    } else {
      current.end = word.end;
      current.text = appendToken(current.text, word.text);
      current.count += 1;
    }
  }
  flush();
  return cues;
}

function formatSrtTime(value: number): string {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainder = milliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}

function renderSrt(cues: ReturnType<typeof subtitleCues>): string {
  return `${cues.map((cue, index) => [
    String(index + 1),
    `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}`,
    cue.text,
  ].join("\n")).join("\n\n")}\n`;
}

async function optionalRevision(path: string): Promise<string> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return "none";
    throw error;
  }
}

function artifactPath(taskDir: string, type: KouboArtifactType): string {
  if (type === "subtitles") return join(taskDir, "subtitles.srt");
  if (type === "visual-plan") return join(taskDir, "visual-plan.json");
  if (type === "animation-manifest") return join(taskDir, "动画/manifest.json");
  return join(taskDir, "timeline.json");
}

async function publishArtifact(
  taskDir: string,
  type: KouboArtifactType,
  content: string,
): Promise<Awaited<ReturnType<typeof putKouboArtifact>>> {
  const snapshot = await readKouboWorkflow(taskDir);
  return putKouboArtifact(taskDir, {
    type,
    content,
    expectedProjectRevision: snapshot.revision,
    expectedArtifactRevision: await optionalRevision(artifactPath(taskDir, type)),
  });
}

function animationModuleHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body,#stage{width:1440px;height:1080px;margin:0;overflow:hidden}
body{background:#101114;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
#stage{display:grid;place-items:center;background:radial-gradient(circle at 50% 35%,#292d38,#101114 65%)}
.card{width:1020px;padding:90px;border:2px solid rgba(255,255,255,.18);border-radius:42px;background:rgba(255,255,255,.08);text-align:center}
.eyebrow{font-size:34px;color:#9aa4b5;letter-spacing:.12em}.title{margin-top:30px;font-size:92px;font-weight:850;line-height:1.08}
.accent{color:#8bffba}body[data-step="1"] .title{transform:scale(1.04)}.title{transition:transform .2s ease-out}
</style></head><body data-step="0"><main id="stage"><section class="card">
<div class="eyebrow">chengfeng-videocut · REAL MEDIA</div><div class="title">口播剪辑<br><span class="accent">音画完整</span></div>
</section></main><script>
function setStep(step){document.body.dataset.step=String(Number(step)||0)}
addEventListener("message",event=>{if(event.data?.type==="set-step")setStep(event.data.step)});window.setStep=setStep;
</script></body></html>\n`;
}

function checkpoint(
  stages: Array<{ label: string; status: string; stage: string | null; revision: string }>,
  label: string,
  snapshot: Awaited<ReturnType<typeof readKouboWorkflow>>,
  expectedStatus: string,
  expectedStage: string | null,
): void {
  const continuation = isObject(snapshot.project.codexContinue)
    ? snapshot.project.codexContinue
    : {};
  const stage = typeof continuation.stage === "string" && continuation.stage
    ? continuation.stage
    : null;
  if (snapshot.status !== expectedStatus || stage !== expectedStage) {
    throw new Error(
      `${label}: expected ${expectedStatus}/${expectedStage ?? "no-stage"}, got ${snapshot.status}/${stage ?? "no-stage"}`,
    );
  }
  stages.push({ label, status: snapshot.status, stage, revision: snapshot.revision });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const before = await snapshotReadOnlyInputs(options);
  const outputRoot = options.outputRoot
    ? options.outputRoot
    : await mkdtemp(join(tmpdir(), "chengfeng-videocut-real-e2e-"));
  assertIsolation(options, outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const taskDir = join(outputRoot, "task");
  const projectsDir = join(outputRoot, "registry");
  const proposalDir = join(outputRoot, "proposals");
  await mkdir(join(taskDir, "input"), { recursive: true });
  await mkdir(join(taskDir, "剪口播/1_转录"), { recursive: true });
  await mkdir(join(taskDir, "剪口播/2_分析"), { recursive: true });
  await mkdir(proposalDir, { recursive: true });

  const jobId = `real-media-e2e-${Date.now()}`;
  const fixtureVideo = join(taskDir, "input/source.mp4");
  const fixtureTranscript = join(taskDir, "剪口播/1_转录/subtitles_words.json");
  const stages: Array<{ label: string; status: string; stage: string | null; revision: string }> = [];
  const evidence: JsonObject = {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    runRoot: outputRoot,
    taskDir,
    readOnlyInputs: before,
    segment: { start: options.segmentStart, duration: options.duration },
    rendererRequested: options.render,
  };

  try {
    await runCommand("ffmpeg", [
      "-y", "-v", "error",
      "-ss", options.segmentStart.toFixed(3),
      "-t", options.duration.toFixed(3),
      "-i", `file:${options.source}`,
      "-map", "0:v:0", "-map", "0:a:0",
      "-vf", "scale=640:480:flags=lanczos,fps=30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      "-movflags", "+faststart",
      `file:${fixtureVideo}`,
    ]);
    const fixtureProbe = await probeMedia(fixtureVideo);
    if (!fixtureProbe.hasVideo || !fixtureProbe.hasAudio || fixtureProbe.duration < 7.8) {
      throw new Error(`Fixture A/V probe failed: ${JSON.stringify(fixtureProbe)}`);
    }
    evidence.fixture = fixtureProbe;

    const rawTranscript = JSON.parse(await readFile(options.transcript, "utf8")) as unknown;
    const sourceWords = normalizeSourceWords(rawTranscript, options.segmentStart, options.duration);
    if (sourceWords.filter((word) => !word.isGap).length < 5) {
      throw new Error("The selected real-media window has too few spoken transcript words");
    }
    await writeJson(fixtureTranscript, sourceWords.map(({ sourceIndex: _sourceIndex, ...word }) => word));
    await writeJson(join(taskDir, "剪口播/2_分析/auto_selected.json"), []);
    await writeJson(join(taskDir, "project.json"), {
      schemaVersion: 1,
      jobId,
      title: "chengfeng-videocut real-media E2E",
      status: "cut_review_ready",
      inputVideo: "input/source.mp4",
      config: { aspectRatio: "4:3" },
      artifacts: {},
    });

    const prepared = await prepareKouboProject(taskDir, {
      video: "input/source.mp4",
      transcript: "剪口播/1_转录/subtitles_words.json",
      duration: fixtureProbe.duration,
      forceIndex: true,
    });
    const preparedSnapshot = await readKouboWorkflow(taskDir);
    checkpoint(stages, "prepared", preparedSnapshot, "cut_review_ready", null);
    const resolvedProject = await resolveProject(taskDir, { projectsDir });
    const registration = await registerProject(resolvedProject, projectsDir);
    const registeredDirectory = await realpath(join(projectsDir, jobId));
    if (registeredDirectory !== await realpath(taskDir)) {
      throw new Error("The isolated registry does not resolve to the prepared task");
    }
    evidence.prepared = {
      projectId: prepared.projectId,
      transcriptCueCount: prepared.transcript.cues.length,
      transcriptWordCount: prepared.transcript.cues.flatMap((cue) => cue.words).length,
      cutWordCount: prepared.cutWordIds.length,
      plannedDeleteSeconds: prepared.metadata.plannedDeleteSeconds,
      indexWritten: prepared.indexWritten,
      registry: registration,
    };

    const cut = await applyKouboCut(taskDir, {
      confirmed: true,
      expectedRevision: preparedSnapshot.revision,
      rootSourceCut: "symlink",
    });
    checkpoint(stages, "physical-cut", cut, "codex_continue_required", "subtitle_rebuild");
    if (!cut.probe.hasAudio || cut.cut.cutRanges.length === 0 || cut.cut.deletedDuration <= 0) {
      throw new Error(`Physical cut evidence is incomplete: ${JSON.stringify(cut.cut)}`);
    }
    evidence.cut = {
      originalDuration: cut.cut.originalDuration,
      outputDuration: cut.probe.duration,
      deletedDuration: cut.cut.deletedDuration,
      cutRanges: cut.cut.cutRanges,
      keepSegments: cut.cut.keepSegments,
      hasAudio: cut.probe.hasAudio,
      width: cut.probe.width,
      height: cut.probe.height,
    };

    const preparedWords = prepared.transcript.cues.flatMap((cue) => cue.words);
    const mappedWords = remapSpeechWords(preparedWords, cut.cut.cutRanges, cut.probe.duration);
    const cues = subtitleCues(mappedWords);
    if (cues.length === 0) throw new Error("Could not rebuild real subtitles for the cut fixture");
    const subtitles = renderSrt(cues);
    if (parseKouboSrt(subtitles).length !== cues.length) {
      throw new Error("Generated SRT does not round-trip through the product caption parser");
    }
    const subtitlesProposal = join(proposalDir, "subtitles.srt");
    await writeFile(subtitlesProposal, subtitles, "utf8");
    const subtitlesResult = await publishArtifact(taskDir, "subtitles", subtitles);
    const subtitlesSnapshot = await readKouboWorkflow(taskDir);
    checkpoint(stages, "subtitles-published", subtitlesSnapshot, "final_config_ready", null);
    evidence.subtitles = {
      cueCount: cues.length,
      sourceWordCount: mappedWords.length,
      firstText: cues[0]?.text,
      lastText: cues.at(-1)?.text,
      artifactRevision: subtitlesResult.artifactRevision,
    };

    const finalStarted = await transitionKouboWorkflow(taskDir, "start-final", {
      confirmed: true,
      expectedRevision: subtitlesSnapshot.revision,
      config: {
        aspectRatio: "4:3",
        animationStyle: "real-media-e2e",
        requirements: "真实口播音画；4:3；字幕与剪后音频必须保留。",
      },
    });
    checkpoint(stages, "final-config-confirmed", finalStarted, "codex_continue_required", "storyboard");

    const stableWordIds = preparedWords
      .filter((word) => !word.isGap && word.text.trim())
      .slice(0, 12)
      .map((word) => word.id);
    const visualPlan = {
      schemaVersion: 2,
      title: "真实口播 4:3 分镜",
      segments: [{
        id: "real-e2e-storyboard-001",
        wordIds: stableWordIds,
        visualType: "a-roll-plus-card",
        description: "保留真实口播 A-roll，在中段插入一张可逐帧 seek 的产品卡片。",
        aspectRatio: "4:3",
      }],
    };
    const visualText = `${JSON.stringify(visualPlan, null, 2)}\n`;
    await writeFile(join(proposalDir, "visual-plan.json"), visualText, "utf8");
    const visualResult = await publishArtifact(taskDir, "visual-plan", visualText);
    const visualSnapshot = await readKouboWorkflow(taskDir);
    checkpoint(stages, "storyboard-published", visualSnapshot, "storyboard_review_ready", null);
    evidence.visualPlan = {
      segmentCount: visualPlan.segments.length,
      stableWordIdCount: stableWordIds.length,
      artifactRevision: visualResult.artifactRevision,
    };

    const storyboardConfirmed = await transitionKouboWorkflow(taskDir, "confirm-storyboard", {
      confirmed: true,
      expectedRevision: visualSnapshot.revision,
    });
    checkpoint(stages, "storyboard-confirmed", storyboardConfirmed, "codex_continue_required", "animation");

    const animationRelative = "动画/real-media-e2e-card.html";
    await mkdir(join(taskDir, "动画"), { recursive: true });
    await writeFile(join(taskDir, animationRelative), animationModuleHtml(), "utf8");
    const animationManifest = {
      schemaVersion: 1,
      modules: [{
        id: "real-media-e2e-card",
        src: animationRelative,
        cue: { wordIds: stableWordIds.slice(0, 6), intent: "强调真实音画保留" },
        beats: [
          { at: 0, step: 0, label: "产品名" },
          { at: 0.55, step: 1, label: "音画完整" },
        ],
        checks: ["offline", "seek-safe", "4:3", "no-external-assets"],
      }],
    };
    const manifestText = `${JSON.stringify(animationManifest, null, 2)}\n`;
    await writeFile(join(proposalDir, "animation-manifest.json"), manifestText, "utf8");
    const manifestResult = await publishArtifact(taskDir, "animation-manifest", manifestText);
    const manifestSnapshot = await readKouboWorkflow(taskDir);
    checkpoint(stages, "animation-published", manifestSnapshot, "animation_review_ready", null);
    evidence.animation = {
      moduleCount: animationManifest.modules.length,
      module: animationRelative,
      artifactRevision: manifestResult.artifactRevision,
    };

    const animationConfirmed = await transitionKouboWorkflow(taskDir, "confirm-animation", {
      confirmed: true,
      expectedRevision: manifestSnapshot.revision,
    });
    checkpoint(stages, "animation-confirmed", animationConfirmed, "codex_continue_required", "timeline");

    const totalDuration = Number(cut.probe.duration.toFixed(3));
    const htmlStart = Number(Math.max(1, totalDuration * 0.28).toFixed(3));
    const htmlEnd = Number(Math.min(totalDuration - 1, htmlStart + 1.2).toFixed(3));
    if (htmlEnd <= htmlStart + 0.5) throw new Error("Cut fixture is too short for the HTML module scene");
    const timeline = {
      schemaVersion: 1,
      totalDuration,
      scenes: [
        {
          id: "real-a-roll-before",
          kind: "video",
          start: 0,
          end: htmlStart,
          src: "source_cut.mp4",
          sourceStart: 0,
        },
        {
          id: "real-media-e2e-card",
          kind: "html",
          start: htmlStart,
          end: htmlEnd,
          src: animationRelative,
          cueSteps: [
            { at: htmlStart, step: 0 },
            { at: Number((htmlStart + 0.55).toFixed(3)), step: 1 },
          ],
        },
        {
          id: "real-a-roll-after",
          kind: "video",
          start: htmlEnd,
          end: totalDuration,
          src: "source_cut.mp4",
          sourceStart: htmlEnd,
        },
      ],
    };
    const timelineText = `${JSON.stringify(timeline, null, 2)}\n`;
    await writeFile(join(proposalDir, "timeline.json"), timelineText, "utf8");
    const timelineResult = await publishArtifact(taskDir, "timeline", timelineText);
    const timelineSnapshot = await readKouboWorkflow(taskDir);
    checkpoint(stages, "timeline-published", timelineSnapshot, "timeline_review_ready", null);
    const finalPlayer = await readFile(join(taskDir, "final-player.html"), "utf8");
    const captionContract = {
      canonicalCueCount: parseKouboSrt(await readFile(join(taskDir, "subtitles.srt"), "utf8")).length,
      exposesSeekTo: finalPlayer.includes("window.seekTo"),
      exposesFinalVideo: finalPlayer.includes("window.finalVideo"),
      exposesFinalCaptions: finalPlayer.includes("window.finalCaptions"),
      embedsRealFirstCue: finalPlayer.includes(cues[0].text.replaceAll("<", "\\u003c")),
    };
    if (Object.values(captionContract).some((value) => value === false) || captionContract.canonicalCueCount === 0) {
      throw new Error(`Final player caption contract failed: ${JSON.stringify(captionContract)}`);
    }
    evidence.timeline = {
      sceneCount: timeline.scenes.length,
      htmlSceneCount: 1,
      duration: totalDuration,
      artifactRevision: timelineResult.artifactRevision,
      captionContract,
    };

    const renderRequested = await transitionKouboWorkflow(taskDir, "confirm-timeline", {
      confirmed: true,
      expectedRevision: timelineSnapshot.revision,
    });
    checkpoint(stages, "timeline-confirmed", renderRequested, "codex_continue_required", "render");

    if (options.render) {
      const render = await runKouboRender(taskDir, {
        confirmed: true,
        expectedRevision: renderRequested.revision,
        rendererPath: options.renderer,
      });
      checkpoint(stages, "render-verified", render, "done", null);
      const finalProbe = await probeKouboRenderMedia(render.finalVideoPath);
      if (!render.verification.passed || !finalProbe.hasAudio || !finalProbe.hasVideo ||
          finalProbe.width !== 1440 || finalProbe.height !== 1080 ||
          Math.abs(finalProbe.fps - 30) > 0.01) {
        throw new Error(`Final render contract failed: ${JSON.stringify(finalProbe)}`);
      }
      evidence.render = {
        status: render.status,
        finalVideo: render.finalVideoPath,
        verification: render.verificationPath,
        probe: finalProbe,
        passed: render.verification.passed,
        globalFrameCount: render.verification.frames.global.length,
        htmlSceneFrameCount: render.verification.frames.htmlScenes.length,
        uniqueFrameCount: render.verification.frames.unique.length,
        checks: render.verification.checks,
      };
      if (!options.keepRenderFrames) {
        await rm(join(taskDir, "renders/final-video-frames"), { recursive: true, force: true });
        await rm(join(taskDir, "renders/final-video-only.mp4"), { force: true });
        evidence.renderIntermediatesRemoved = true;
      }
    } else {
      evidence.render = {
        skipped: true,
        reason: "--no-render",
        status: renderRequested.status,
        stage: "render",
      };
    }

    const after = await snapshotReadOnlyInputs(options);
    const readOnlyUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!readOnlyUnchanged) throw new Error("A read-only source or original-task fingerprint changed during the run");
    evidence.readOnlyInputsAfter = after;
    evidence.readOnlyInputsUnchanged = true;
    evidence.stages = stages;
    evidence.passed = options.render;
    evidence.completedAt = new Date().toISOString();
    const reportPath = join(outputRoot, "e2e-report.json");
    await writeJson(reportPath, evidence);
    const finalOutput = {
      passed: options.render,
      renderSkipped: !options.render,
      runRoot: outputRoot,
      taskDir,
      reportPath,
      finalVideo: options.render ? join(taskDir, "renders/final.mp4") : null,
      status: options.render ? "done" : "codex_continue_required",
      readOnlyInputsUnchanged: true,
      stages: stages.map((stage) => `${stage.label}:${stage.status}${stage.stage ? `(${stage.stage})` : ""}`),
    };
    process.stdout.write(`${JSON.stringify(finalOutput, null, options.json ? 0 : 2)}\n`);
  } catch (error) {
    evidence.passed = false;
    evidence.stages = stages;
    evidence.failedAt = new Date().toISOString();
    evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    await writeJson(join(outputRoot, "e2e-report.json"), evidence).catch(() => undefined);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nIsolated evidence: ${outputRoot}`,
      { cause: error },
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
