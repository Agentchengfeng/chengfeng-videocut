import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildNaturalPausePlan, type NaturalPausePlan } from "./naturalPause";

type JsonObject = Record<string, unknown>;

export interface KouboTranscriptWord {
  id: string;
  text: string;
  start: number;
  end: number;
  isGap: boolean;
  suggestion?: "silence" | "filler" | "repeat" | "stutter" | "incomplete";
}

export interface KouboTranscriptCue {
  id: string;
  start: number;
  end: number;
  words: KouboTranscriptWord[];
}

export interface KouboTranscript {
  schemaVersion: 1;
  cues: KouboTranscriptCue[];
}

export interface PrepareKouboProjectOptions {
  video?: string;
  transcript?: string;
  duration?: number;
  forceIndex?: boolean;
  refreshTranscript?: boolean;
  now?: () => Date;
}

export interface PreparedKouboProject {
  projectId: string;
  directory: string;
  metadata: JsonObject;
  transcript: KouboTranscript;
  cutWordIds: string[];
  indexWritten: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function appendKouboEvent(
  jobDir: string,
  type: string,
  payload: JsonObject = {},
  now: Date = new Date(),
): Promise<void> {
  await appendFile(
    join(jobDir, "events.jsonl"),
    `${JSON.stringify({ ts: now.toISOString(), type, payload })}\n`,
    "utf8",
  );
}

export async function resolveKouboJobDirectory(value: string): Promise<string> {
  const directory = await realpath(resolve(value));
  if (!existsSync(join(directory, "project.json"))) {
    throw new Error(`Koubo job is missing project.json: ${directory}`);
  }
  return directory;
}

function projectRelativePath(jobDir: string, path: string): string {
  const value = relative(jobDir, path);
  if (!value || value === "") return basename(path);
  if (value.startsWith(`..${sep}`) || value === ".." || isAbsolute(value)) {
    throw new Error(`Project files must stay inside the job directory: ${path}`);
  }
  return value.split(sep).join("/");
}

function normalizeSuggestion(
  value: unknown,
  isGap: boolean,
  duration: number,
): KouboTranscriptWord["suggestion"] {
  const text = String(value ?? "").toLowerCase();
  if (/silence|静音|停顿/.test(text) || (isGap && duration >= 0.5)) return "silence";
  if (/filler|口头禅|语气词/.test(text)) return "filler";
  if (/repeat|重说|重复/.test(text)) return "repeat";
  if (/stutter|卡顿|结巴/.test(text)) return "stutter";
  if (/incomplete|残句/.test(text)) return "incomplete";
  return undefined;
}

function normalizeWord(
  raw: unknown,
  index: number,
  fallbackStart = 0,
  fallbackEnd = 0,
): KouboTranscriptWord {
  const value = isObject(raw) ? raw : {};
  const text = String(value.text ?? "");
  const start = Math.max(0, finite(value.start, fallbackStart));
  const end = Math.max(start, finite(value.end, fallbackEnd));
  const isGap = Boolean(value.isGap) || (!text.trim() && end > start);
  const suggestion = normalizeSuggestion(
    value.suggestion ?? value.reason ?? value.kind,
    isGap,
    end - start,
  );
  return {
    id: String(value.id ?? value.wordId ?? `w-${String(index + 1).padStart(6, "0")}`),
    text,
    start,
    end,
    isGap,
    ...(suggestion ? { suggestion } : {}),
  };
}

function groupWords(words: KouboTranscriptWord[]): KouboTranscriptCue[] {
  const cues: KouboTranscriptCue[] = [];
  let current: KouboTranscriptWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    cues.push({
      id: `cue-${String(cues.length + 1).padStart(4, "0")}`,
      start: current[0].start,
      end: current.at(-1)?.end ?? current[0].end,
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    current.push(word);
    const longGap = word.isGap && word.end - word.start >= 0.5;
    const sentenceEnd = !word.isGap && /[。！？!?]$/.test(word.text);
    if (longGap || sentenceEnd || current.length >= 24) flush();
  }
  flush();
  return cues;
}

function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9][A-Za-z0-9+.#_-]*|[\u3400-\u9fff]|[^\s]/gu) ?? [];
}

function parseSrtTime(value: string): number {
  const match = value.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function transcriptFromSrt(content: string): KouboTranscript {
  const cues: KouboTranscriptCue[] = [];
  let wordIndex = 0;
  for (const block of content.replaceAll("\r", "").trim().split(/\n{2,}/)) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [left, right] = lines[timingIndex].split("-->").map((part) => part.trim());
    const start = parseSrtTime(left);
    const end = Math.max(start, parseSrtTime(right));
    const tokens = tokenize(lines.slice(timingIndex + 1).join(" ").trim());
    const step = tokens.length > 0 ? (end - start) / tokens.length : 0;
    const words = tokens.map((token, index) => {
      const normalized = normalizeWord({
        id: `w-${String(++wordIndex).padStart(6, "0")}`,
        text: token,
        start: start + index * step,
        end: index === tokens.length - 1 ? end : start + (index + 1) * step,
      }, wordIndex - 1);
      return normalized;
    });
    if (words.length > 0) {
      cues.push({
        id: `cue-${String(cues.length + 1).padStart(4, "0")}`,
        start,
        end,
        words,
      });
    }
  }
  return { schemaVersion: 1, cues };
}

export function normalizeKouboTranscript(payload: unknown): KouboTranscript {
  if (Array.isArray(payload)) {
    const words = payload.map((word, index) => normalizeWord(word, index));
    return { schemaVersion: 1, cues: groupWords(words) };
  }
  const source = isObject(payload) ? payload : {};
  const rawCues = Array.isArray(source.cues) ? source.cues : [];
  const cues: KouboTranscriptCue[] = [];
  let wordIndex = 0;
  rawCues.forEach((rawCue, cueIndex) => {
    const cue = isObject(rawCue) ? rawCue : {};
    let words: KouboTranscriptWord[];
    if (Array.isArray(cue.words)) {
      words = cue.words.map((word) => normalizeWord(word, wordIndex++, finite(cue.start), finite(cue.end)));
    } else {
      const tokens = tokenize(String(cue.text ?? ""));
      const start = finite(cue.start);
      const end = Math.max(start, finite(cue.end, start));
      const step = tokens.length > 0 ? (end - start) / tokens.length : 0;
      words = tokens.map((token, index) => normalizeWord({
        text: token,
        start: start + index * step,
        end: index === tokens.length - 1 ? end : start + (index + 1) * step,
      }, wordIndex++));
    }
    if (words.length === 0) return;
    cues.push({
      id: String(cue.id ?? `cue-${String(cueIndex + 1).padStart(4, "0")}`),
      start: words[0].start,
      end: words.at(-1)?.end ?? words[0].end,
      words,
    });
  });
  return { schemaVersion: 1, cues };
}

async function findFile(jobDir: string, candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const path = resolve(jobDir, candidate);
    if (existsSync(path)) return realpath(path);
  }
  return null;
}

async function loadTranscript(path: string): Promise<KouboTranscript> {
  if (extname(path).toLowerCase() === ".srt") {
    return transcriptFromSrt(await readFile(path, "utf8"));
  }
  return normalizeKouboTranscript(await readJson(path));
}

function normalizedIndexes(value: unknown, length: number): number[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(Number).filter(
    (index) => Number.isInteger(index) && index >= 0 && index < length,
  ))].sort((left, right) => left - right);
}

function existingSelectionIndexes(selection: unknown, words: readonly KouboTranscriptWord[]): number[] {
  const record = isObject(selection) ? selection : {};
  const ids = new Set(
    Array.isArray(record.cutWordIds) ? record.cutWordIds.map(String) : [],
  );
  return words.flatMap((word, index) => ids.has(word.id) ? [index] : []);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function applyManualSelectionDelta(input: {
  baselineCutWordIds: readonly string[];
  previousBaselineCutWordIds: readonly string[];
  previousCutWordIds: readonly string[];
  availableWordIds: ReadonlySet<string>;
}): string[] {
  const previousBaseline = new Set(input.previousBaselineCutWordIds);
  const previousSelection = new Set(input.previousCutWordIds);
  const removedByUser = new Set(
    input.previousBaselineCutWordIds.filter((id) => !previousSelection.has(id)),
  );
  const addedByUser = input.previousCutWordIds.filter((id) => !previousBaseline.has(id));
  const result = new Set(
    input.baselineCutWordIds.filter((id) => !removedByUser.has(id)),
  );
  for (const id of addedByUser) {
    if (input.availableWordIds.has(id)) result.add(id);
  }
  return [...result];
}

function materializeCutTranscript(
  transcript: KouboTranscript,
  deleteSegments: readonly { start: number; end: number }[],
): { transcript: KouboTranscript; cutWordIds: string[] } {
  const splitWords: KouboTranscriptWord[] = [];
  const cutWordIds: string[] = [];
  const epsilon = 0.0005;
  for (const word of transcript.cues.flatMap((cue) => cue.words)) {
    const boundaries = [word.start, word.end];
    if (word.isGap) {
      for (const segment of deleteSegments) {
        if (segment.start > word.start + epsilon && segment.start < word.end - epsilon) {
          boundaries.push(segment.start);
        }
        if (segment.end > word.start + epsilon && segment.end < word.end - epsilon) {
          boundaries.push(segment.end);
        }
      }
    }
    boundaries.sort((left, right) => left - right);
    const unique = boundaries.filter(
      (value, index) => index === 0 || value - boundaries[index - 1] > epsilon,
    );
    for (let index = 0; index < unique.length - 1; index += 1) {
      const start = unique[index];
      const end = unique[index + 1];
      if (end <= start + epsilon) continue;
      const midpoint = start + (end - start) / 2;
      const cut = deleteSegments.some(
        (segment) => midpoint >= segment.start - epsilon && midpoint < segment.end + epsilon,
      );
      const split = unique.length > 2;
      const id = split && index > 0
        ? `${word.id}__part_${Math.round(start * 1000)}_${Math.round(end * 1000)}`
        : word.id;
      const { suggestion: _suggestion, ...rest } = word;
      splitWords.push({ ...rest, id, start, end });
      if (cut) cutWordIds.push(id);
    }
  }
  return { transcript: { schemaVersion: 1, cues: groupWords(splitWords) }, cutWordIds };
}

function buildRanges(
  words: readonly KouboTranscriptWord[],
  cutWordIds: readonly string[],
): Array<{ start: number; end: number }> {
  const ids = new Set(cutWordIds);
  const ranges: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;
  for (const word of words) {
    if (!ids.has(word.id)) {
      if (current) ranges.push(current);
      current = null;
      continue;
    }
    if (!current) current = { start: word.start, end: word.end };
    else current.end = Math.max(current.end, word.end);
  }
  if (current) ranges.push(current);
  return ranges;
}

export function frameDimensions(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === "3:4") return { width: 1080, height: 1440 };
  if (aspectRatio === "4:3") return { width: 1440, height: 1080 };
  if (aspectRatio === "9:16") return { width: 1080, height: 1920 };
  return { width: 1920, height: 1080 };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderKouboProjectIndex(input: {
  title: string;
  width: number;
  height: number;
  duration: number;
  videoSource: string;
}): string {
  const duration = Math.max(0, input.duration).toFixed(3);
  const title = escapeHtml(input.title);
  const videoSource = escapeHtml(input.videoSource);
  return `<!DOCTYPE html>
<!-- generated-by: chengfeng-videocut -->
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=${input.width}, height=${input.height}">
    <title>${title}</title>
    <script src="/api/vendor/gsap.min.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${input.width}px; height: ${input.height}px; margin: 0; overflow: hidden; background: #111; }
      #root { position: relative; width: ${input.width}px; height: ${input.height}px; overflow: hidden; background: #111; }
      #a-roll-main { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #111; }
    </style>
  </head>
  <body>
    <main data-hf-id="hf-root" id="root" data-composition-id="main" data-start="0" data-width="${input.width}" data-height="${input.height}" data-duration="${duration}">
      <video data-hf-id="hf-a-roll" id="a-roll-main" src="${videoSource}" data-start="0" data-duration="${duration}" data-track-index="1" data-timeline-role="a-roll" data-timeline-label="A-roll 口播原片（音画一体）" preload="auto" playsinline></video>
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

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} failed (${code ?? "signal"}): ${stderr.trim().slice(-2000)}`));
    });
  });
}

async function probeDuration(path: string): Promise<number> {
  try {
    const output = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `file:${path}`,
    ]);
    return Math.max(0, finite(output.trim()));
  } catch {
    return 0;
  }
}

async function resolveJobFile(jobDir: string, value: string): Promise<string> {
  const path = resolve(jobDir, value);
  if (!existsSync(path)) throw new Error(`File does not exist: ${path}`);
  const resolved = await realpath(path);
  projectRelativePath(jobDir, resolved);
  return resolved;
}

function generatedIndex(content: string): boolean {
  return content.includes("generated-by: chengfeng-videocut") ||
    content.includes("generated-by: koubo-video-workbench");
}

export async function prepareKouboProject(
  inputDirectory: string,
  options: PrepareKouboProjectOptions = {},
): Promise<PreparedKouboProject> {
  const jobDir = await resolveKouboJobDirectory(inputDirectory);
  const projectPath = join(jobDir, "project.json");
  const project = await readJson<JsonObject>(projectPath);
  const metadataPath = join(jobDir, "workbench.json");
  const previous = existsSync(metadataPath) ? await readJson<JsonObject>(metadataPath) : {};
  const videoCandidates = options.video
    ? [options.video]
    : [
        typeof previous.videoSource === "string" ? previous.videoSource : "",
        typeof project.inputVideo === "string" ? project.inputVideo : "",
        isObject(project.artifacts) && typeof project.artifacts.sourceCut === "string"
          ? project.artifacts.sourceCut
          : "",
        "source_cut.mp4",
      ].filter(Boolean);
  let videoPath: string | null = null;
  for (const candidate of videoCandidates) {
    try {
      videoPath = await resolveJobFile(jobDir, candidate);
      break;
    } catch {
      // Try the next explicit task-local source. Demo/default media is never used.
    }
  }
  if (!videoPath) {
    throw new Error(`No real task video found. Checked: ${videoCandidates.join(", ") || "none"}`);
  }

  const transcriptPath = options.transcript
    ? await resolveJobFile(jobDir, options.transcript)
    : await findFile(jobDir, [
        "剪口播/1_转录/subtitles_words.json",
        "transcript.json",
        "subtitles_words.json",
        "subtitles.srt",
        "字幕/3_输出/video.srt",
      ]);
  if (!transcriptPath) throw new Error("No transcript source was found for this task");
  const sourceTranscript = await loadTranscript(transcriptPath);
  if (sourceTranscript.cues.length === 0) throw new Error(`Transcript is empty: ${transcriptPath}`);
  const sourceWords = sourceTranscript.cues.flatMap((cue) => cue.words);
  const duration = finite(options.duration) ||
    await probeDuration(videoPath) ||
    Math.max(0, ...sourceWords.map((word) => word.end));
  if (!(duration > 0)) throw new Error("Could not determine video duration");

  const autoSelectionPath = await findFile(jobDir, [
    "剪口播/2_分析/auto_selected.json",
    "auto_selected.json",
  ]);
  const autoSelectionIndexes = autoSelectionPath
    ? normalizedIndexes(await readJson(autoSelectionPath), sourceWords.length)
    : [];
  const autoSelectionFingerprint = createHash("sha256")
    .update(JSON.stringify(autoSelectionIndexes))
    .digest("hex");
  const transcriptOutput = join(jobDir, "transcript.json");
  const cutSelectionPath = join(jobDir, "cut-selection.json");
  const pausePlanPath = join(jobDir, "剪口播/3_审核/natural_pause_plan.json");
  let existingSelection: unknown = existsSync(cutSelectionPath)
    ? await readJson(cutSelectionPath)
    : null;
  if (!existingSelection) {
    const legacyPath = join(jobDir, "剪口播/3_审核/saved_selection.json");
    const legacyIndexes = existsSync(legacyPath) ? await readJson<unknown[]>(legacyPath) : [];
    const sourceIds = sourceWords.map((word) => word.id);
    const legacyIds = Array.isArray(legacyIndexes)
      ? legacyIndexes.map((index) => sourceIds[Number(index)]).filter((id): id is string => Boolean(id))
      : [];
    existingSelection = {
      schemaVersion: 3,
      cutWordIds: legacyIds,
      cutRanges: buildRanges(sourceWords, legacyIds),
    };
  }
  const existingRecord = isObject(existingSelection) ? existingSelection : {};
  const initialization = isObject(existingRecord.initialization)
    ? existingRecord.initialization
    : {};
  const initialized = initialization.mode === "delete-or-keep-v2";
  const initializeSelection = !existsSync(transcriptOutput) ||
    Boolean(options.transcript) ||
    Boolean(options.refreshTranscript) ||
    !initialized;
  const now = (options.now ?? (() => new Date()))();
  let transcript: KouboTranscript;
  let cutWordIds: string[];
  let pausePlan: NaturalPausePlan | null = existsSync(pausePlanPath)
    ? await readJson<NaturalPausePlan>(pausePlanPath)
    : null;
  if (initializeSelection) {
    // Only import exact source-word ids on the first migration. A split gap id
    // such as `gap__part_...` represents a derived pause-compression slice and
    // must never be mapped back to the whole source gap.
    const selectedIndexes = [...new Set([
      ...autoSelectionIndexes,
      ...(!initialized ? existingSelectionIndexes(existingSelection, sourceWords) : []),
    ])].sort((left, right) => left - right);
    pausePlan = buildNaturalPausePlan(sourceWords, selectedIndexes, {
      timelineStart: 0,
      timelineEnd: duration,
    });
    const materialized = materializeCutTranscript(sourceTranscript, pausePlan.deleteSegments);
    transcript = materialized.transcript;
    const words = transcript.cues.flatMap((cue) => cue.words);
    const baselineCutWordIds = materialized.cutWordIds;
    cutWordIds = initialized
      ? applyManualSelectionDelta({
          baselineCutWordIds,
          previousBaselineCutWordIds: stringArray(initialization.baselineCutWordIds),
          previousCutWordIds: stringArray(existingRecord.cutWordIds),
          availableWordIds: new Set(words.map((word) => word.id)),
        })
      : baselineCutWordIds;
    await atomicWriteJson(transcriptOutput, transcript);
    const nextInitialization = {
      ...initialization,
      mode: "delete-or-keep-v2",
      autoSelectionSource: autoSelectionPath
        ? projectRelativePath(jobDir, autoSelectionPath)
        : null,
      autoSelectionFingerprint,
      naturalPausePolicy: pausePlan.policy.version,
      baselineCutWordIds,
      initializedAt: typeof initialization.initializedAt === "string"
        ? initialization.initializedAt
        : now.toISOString(),
    };
    const nextSelection: JsonObject = {
      ...existingRecord,
      schemaVersion: 3,
      cutWordIds,
      cutRanges: buildRanges(words, cutWordIds),
      initialization: nextInitialization,
      updatedAt: now.toISOString(),
    };
    const previousWithoutTime = { ...existingRecord, updatedAt: undefined };
    const nextWithoutTime = { ...nextSelection, updatedAt: undefined };
    if (JSON.stringify(previousWithoutTime) === JSON.stringify(nextWithoutTime)) {
      nextSelection.updatedAt = existingRecord.updatedAt;
    }
    await atomicWriteJson(cutSelectionPath, nextSelection);
    await atomicWriteJson(pausePlanPath, pausePlan);
  } else {
    transcript = await readJson<KouboTranscript>(transcriptOutput);
    cutWordIds = Array.isArray(existingRecord.cutWordIds)
      ? existingRecord.cutWordIds.map(String)
      : [];
  }

  const visualPlanPath = join(jobDir, "visual-plan.json");
  const config = isObject(project.config) ? project.config : {};
  const ratio = String(config.aspectRatio ?? previous.aspectRatio ?? "3:4");
  const dimensions = frameDimensions(ratio);
  const videoSource = projectRelativePath(jobDir, videoPath);
  const indexPath = join(jobDir, "index.html");
  const existingIndex = existsSync(indexPath) ? await readFile(indexPath, "utf8") : "";
  const indexWritten = !existingIndex || generatedIndex(existingIndex) || Boolean(options.forceIndex);
  if (indexWritten) {
    await writeFile(indexPath, renderKouboProjectIndex({
      title: String(project.title ?? project.jobId ?? basename(jobDir)),
      ...dimensions,
      duration,
      videoSource,
    }), "utf8");
  }

  const projectId = String(project.jobId ?? basename(jobDir));
  const metadata: JsonObject = {
    schemaVersion: 1,
    projectId,
    jobDir,
    videoSource,
    transcriptSource: projectRelativePath(jobDir, transcriptPath),
    autoSelectionSource: autoSelectionPath ? projectRelativePath(jobDir, autoSelectionPath) : null,
    autoSelectionCount: autoSelectionIndexes.length,
    naturalPausePolicy: pausePlan?.policy.version ?? null,
    plannedDeleteSeconds: pausePlan?.summary.totalDeletedSeconds ?? 0,
    aspectRatio: ratio,
    ...dimensions,
    duration,
    createdAt: String(previous.createdAt ?? now.toISOString()),
    updatedAt: now.toISOString(),
  };
  await atomicWriteJson(metadataPath, metadata);

  const artifacts = isObject(project.artifacts) ? { ...project.artifacts } : {};
  Object.assign(artifacts, {
    workbenchEntry: "index.html",
    workbenchTranscript: "transcript.json",
    workbenchNaturalPausePlan: projectRelativePath(jobDir, pausePlanPath),
    workbenchCutSelection: "cut-selection.json",
  });
  if (existsSync(visualPlanPath)) artifacts.workbenchVisualPlan = "visual-plan.json";
  else delete artifacts.workbenchVisualPlan;
  if (autoSelectionPath) {
    artifacts.workbenchAutoSelection = projectRelativePath(jobDir, autoSelectionPath);
  }
  delete artifacts.workbenchSuggestions;
  project.artifacts = artifacts;
  project.workbench = { projectId, url: `http://127.0.0.1:5190/#project/${encodeURIComponent(projectId)}` };
  project.updatedAt = now.toISOString();
  await atomicWriteJson(projectPath, project);
  await appendKouboEvent(jobDir, "workbench_project_prepared", {
    projectId,
    autoSelectionCount: autoSelectionIndexes.length,
    naturalPausePolicy: pausePlan?.policy.version ?? null,
    plannedDeleteSeconds: pausePlan?.summary.totalDeletedSeconds ?? 0,
  }, now);

  return { projectId, directory: jobDir, metadata, transcript, cutWordIds, indexWritten };
}

export async function copyTaskVideo(input: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  await copyFile(input, output);
  await stat(output);
}
