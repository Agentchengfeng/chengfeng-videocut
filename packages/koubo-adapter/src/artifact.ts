import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VideocutError } from "@video-workbench/core";
import { appendKouboEvent, atomicWriteJson, frameDimensions } from "./project";
import { serializeKouboProjectOperation } from "./projectLock";

type JsonObject = Record<string, unknown>;

export type KouboArtifactType =
  | "subtitles"
  | "visual-plan"
  | "animation-manifest"
  | "timeline";

export interface PutKouboArtifactOptions {
  type: KouboArtifactType;
  content: string | Uint8Array;
  expectedProjectRevision: string;
  expectedArtifactRevision: string;
  now?: () => Date;
}

export interface PutKouboArtifactResult {
  type: KouboArtifactType;
  target: string;
  artifactRevision: string;
  previousArtifactRevision: string;
  projectRevision: string;
  status: string;
  changed: boolean;
}

interface TimelineScene extends JsonObject {
  id: string;
  kind: "video" | "html" | "image";
  start: number;
  end: number;
  src: string;
  sourceStart?: number;
  cueSteps?: Array<{ at: number; step: number }>;
}

interface TimelineDocument extends JsonObject {
  schemaVersion: 1;
  totalDuration: number;
  scenes: TimelineScene[];
}

export interface KouboSubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(path: string): Promise<{ value: JsonObject; raw: string; revision: string }> {
  const raw = await readFile(path, "utf8");
  const value = JSON.parse(raw) as unknown;
  if (!isObject(value)) throw new Error(`${basename(path)} must contain a JSON object`);
  return { value, raw, revision: sha256(raw) };
}

async function optionalRevision(path: string): Promise<string> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return "none";
    throw error;
  }
}

async function atomicWriteText(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

function requireRevision(actual: string, expected: string, label: string): void {
  if (!/^(?:none|[a-f0-9]{64})$/.test(expected)) {
    throw new VideocutError(
      "invalid_argument",
      `${label} expected revision must be 'none' or SHA-256`,
    );
  }
  if (actual !== expected) {
    throw new VideocutError(
      "revision_conflict",
      `${label} revision conflict: expected ${expected}, current ${actual}`,
      { expectedRevision: expected, currentRevision: actual, document: label },
    );
  }
}

function parseJsonContent(content: string | Uint8Array, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(typeof content === "string" ? content : new TextDecoder().decode(content));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}

function taskRelativePath(jobDir: string, value: string): string {
  if (!value || isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Artifact path must be task-relative: ${value}`);
  }
  const normalized = relative(jobDir, resolve(jobDir, value));
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    throw new Error(`Artifact path escapes the task: ${value}`);
  }
  return normalized.split(sep).join("/");
}

async function requireTaskFile(jobDir: string, value: string): Promise<string> {
  const local = taskRelativePath(jobDir, value);
  const path = await realpath(join(jobDir, local));
  const normalized = relative(jobDir, path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    throw new Error(`Artifact resolves outside the task: ${value}`);
  }
  return local;
}

async function validateSubtitles(jobDir: string, content: string | Uint8Array): Promise<string> {
  if (!existsSync(join(jobDir, "source_cut.mp4")) &&
      !existsSync(join(jobDir, "剪口播/3_审核/source_cut.mp4"))) {
    throw new Error("subtitles require a physically cut source video");
  }
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  if (text.includes("\0") ||
      !/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(text)) {
    throw new Error("subtitles must be a non-empty SRT document");
  }
  return text.replaceAll("\r\n", "\n").trimEnd() + "\n";
}

async function transcriptWordIds(jobDir: string): Promise<Set<string>> {
  const transcript = (await readJson(join(jobDir, "transcript.json"))).value;
  const cues = Array.isArray(transcript.cues) ? transcript.cues : [];
  const ids = new Set<string>();
  for (const cue of cues) {
    if (!isObject(cue) || !Array.isArray(cue.words)) continue;
    for (const word of cue.words) {
      if (isObject(word) && typeof word.id === "string") ids.add(word.id);
    }
  }
  return ids;
}

async function currentCutWordIds(jobDir: string): Promise<string[]> {
  try {
    const selection = (await readJson(join(jobDir, "cut-selection.json"))).value;
    if (!Array.isArray(selection.cutWordIds)) return [];
    return [...new Set(
      selection.cutWordIds
        .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
        .map((id) => id.trim()),
    )].sort();
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function validateVisualPlan(
  jobDir: string,
  value: JsonObject,
  appliedAt: string,
): Promise<JsonObject> {
  if (value.schemaVersion !== 2 || !Array.isArray(value.segments) || value.segments.length === 0) {
    throw new Error("visual-plan must use schemaVersion 2 and contain segments");
  }
  const knownWords = await transcriptWordIds(jobDir);
  const seen = new Set<string>();
  for (const [index, segment] of value.segments.entries()) {
    if (!isObject(segment) || typeof segment.id !== "string" || !segment.id.trim()) {
      throw new Error(`visual-plan segment ${index} requires an id`);
    }
    if (seen.has(segment.id)) throw new Error(`visual-plan id is duplicated: ${segment.id}`);
    seen.add(segment.id);
    if (!Array.isArray(segment.wordIds) || segment.wordIds.length === 0) {
      throw new Error(`visual-plan segment ${segment.id} requires stable wordIds`);
    }
    const unknown = segment.wordIds.filter((id) => typeof id !== "string" || !knownWords.has(id));
    if (unknown.length > 0) {
      throw new Error(`visual-plan segment ${segment.id} references unknown wordIds`);
    }
  }
  return {
    ...value,
    cutSync: {
      schemaVersion: 1,
      cutWordIds: await currentCutWordIds(jobDir),
      appliedAt,
    },
  };
}

async function validateAnimationManifest(jobDir: string, value: JsonObject): Promise<JsonObject> {
  const modules = Array.isArray(value.modules) ? value.modules : [];
  if (modules.length === 0) {
    const noAnimationReason = String(
      value.noAnimationReason ?? value.skippedReason ?? "",
    ).trim();
    if (!noAnimationReason) {
      throw new Error(
        "an empty animation manifest requires noAnimationReason instead of inventing a module",
      );
    }
    return {
      ...value,
      schemaVersion: Number(value.schemaVersion ?? 1),
      modules: [],
      noAnimationReason,
    };
  }
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (!isObject(module)) throw new Error(`animation module ${index} must be an object`);
    const id = typeof module.id === "string" ? module.id.trim() : "";
    const src = typeof module.src === "string" ? module.src.trim() : "";
    if (!id || !src) throw new Error(`animation module ${index} requires id and src`);
    if (ids.has(id) || sources.has(src)) {
      throw new Error(`animation modules require unique id and src: ${id}`);
    }
    ids.add(id);
    sources.add(src);
    if (!module.cue || !Array.isArray(module.beats) || module.beats.length === 0 ||
        !Array.isArray(module.checks) || module.checks.length === 0) {
      throw new Error(`animation module ${id} requires cue, beats, and checks`);
    }
    const local = await requireTaskFile(jobDir, src);
    if (!local.toLowerCase().endsWith(".html")) {
      throw new Error(`animation module ${id} must reference an HTML file`);
    }
  }
  return { ...value, schemaVersion: Number(value.schemaVersion ?? 1), modules };
}

async function validateTimeline(jobDir: string, value: JsonObject): Promise<TimelineDocument> {
  if (value.schemaVersion !== 1 || !Array.isArray(value.scenes) || value.scenes.length === 0) {
    throw new Error("timeline must use schemaVersion 1 and contain scenes");
  }
  const ids = new Set<string>();
  const manifest = await readJson(join(jobDir, "动画/manifest.json"));
  const manifestModules = Array.isArray(manifest.value.modules) ? manifest.value.modules : [];
  const manifestSources = new Set<string>();
  for (const [index, module] of manifestModules.entries()) {
    if (!isObject(module) || typeof module.src !== "string") {
      throw new Error(`animation manifest module ${index} requires src`);
    }
    manifestSources.add(await requireTaskFile(jobDir, module.src));
  }
  const usedHtmlSources = new Set<string>();
  let cursor = 0;
  const scenes: TimelineScene[] = [];
  for (const [index, raw] of value.scenes.entries()) {
    if (!isObject(raw)) throw new Error(`timeline scene ${index} must be an object`);
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const kind = raw.kind;
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (!id || ids.has(id)) throw new Error(`timeline scene ${index} requires a unique id`);
    if (kind !== "video" && kind !== "html" && kind !== "image") {
      throw new Error(`timeline scene ${id} has an unsupported kind`);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error(`timeline scene ${id} has an invalid range`);
    }
    if (Math.abs(start - cursor) > 0.01) {
      throw new Error(`timeline must be contiguous at scene ${id}`);
    }
    const defaultSource = kind === "video" ? "source_cut.mp4" : "";
    const src = await requireTaskFile(jobDir, String(raw.src ?? defaultSource));
    if (kind === "html") {
      if (!manifestSources.has(src)) {
        throw new Error(`timeline HTML scene ${id} was not reviewed in 动画/manifest.json`);
      }
      usedHtmlSources.add(src);
    }
    const cueSteps = Array.isArray(raw.cueSteps)
      ? raw.cueSteps.map((cue, cueIndex) => {
          if (!isObject(cue) || !Number.isFinite(Number(cue.at)) ||
              !Number.isInteger(Number(cue.step))) {
            throw new Error(`timeline scene ${id} cueSteps[${cueIndex}] is invalid`);
          }
          return { at: Number(cue.at), step: Number(cue.step) };
        }).sort((left, right) => left.at - right.at)
      : undefined;
    scenes.push({
      ...raw,
      id,
      kind,
      start,
      end,
      src,
      ...(Number.isFinite(Number(raw.sourceStart)) ? { sourceStart: Number(raw.sourceStart) } : {}),
      ...(cueSteps ? { cueSteps } : {}),
    });
    ids.add(id);
    cursor = end;
  }
  const totalDuration = Number(value.totalDuration ?? cursor);
  if (!Number.isFinite(totalDuration) || Math.abs(totalDuration - cursor) > 0.01) {
    throw new Error("timeline totalDuration must match the final scene end");
  }
  const unusedModules = [...manifestSources].filter((src) => !usedHtmlSources.has(src));
  if (unusedModules.length > 0) {
    throw new Error(`timeline omits reviewed animation modules: ${unusedModules.join(", ")}`);
  }
  return { ...value, schemaVersion: 1, totalDuration, scenes };
}

function htmlEscape(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function srtTime(value: string): number | null {
  const match = value.trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  const result = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) +
    Number(milliseconds) / 1000;
  return Number.isFinite(result) ? result : null;
}

/** Parse the canonical SRT without browser or Studio dependencies. */
export function parseKouboSrt(content: string): KouboSubtitleCue[] {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (!normalized) return [];
  const cues: KouboSubtitleCue[] = [];
  for (const [blockIndex, block] of normalized.split(/\n{2,}/).entries()) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(
      /^\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/,
    );
    if (!timing) continue;
    const start = srtTime(timing[1]);
    const end = srtTime(timing[2]);
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (start === null || end === null || end <= start || !text) continue;
    const rawId = timingIndex > 0 ? lines[timingIndex - 1].trim() : "";
    cues.push({
      id: rawId || `caption-${blockIndex + 1}`,
      start,
      end,
      text,
    });
  }
  return cues.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function renderFinalPlayer(input: {
  title: string;
  width: number;
  height: number;
  timeline: TimelineDocument;
  captions?: readonly KouboSubtitleCue[];
}): string {
  const payload = JSON.stringify(input.timeline).replaceAll("<", "\\u003c");
  const captions = JSON.stringify(input.captions ?? []).replaceAll("<", "\\u003c");
  const captionFontSize = Math.max(34, Math.round(input.height * 0.046));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=${input.width},height=${input.height}">
<title>${htmlEscape(input.title)}</title>
<style>
*{box-sizing:border-box}html,body,#stage{width:${input.width}px;height:${input.height}px;margin:0;overflow:hidden;background:#111}
#stage{position:relative}#scene-layer{position:absolute;inset:0;overflow:hidden;background:#111}
#scene-layer video,#scene-layer img,#scene-layer iframe{position:absolute;inset:0;width:100%;height:100%;border:0;object-fit:contain;background:#111}
#caption-layer{position:absolute;z-index:20;left:5%;right:5%;bottom:7%;display:none;justify-content:center;pointer-events:none;text-align:center}
#caption-text{display:inline-block;max-width:100%;padding:.12em .34em;color:#fff;font:800 ${captionFontSize}px/1.25 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-text-stroke:2px rgba(0,0,0,.9);paint-order:stroke fill;text-shadow:0 3px 10px rgba(0,0,0,.95)}
</style></head><body><main id="stage"><div id="scene-layer"></div><div id="caption-layer" data-timeline-role="captions" aria-hidden="true"><span id="caption-text"></span></div></main><script>
const finalVideo=${payload};
const finalCaptions=${captions};
const sceneLayer=document.getElementById("scene-layer");const captionLayer=document.getElementById("caption-layer");const captionText=document.getElementById("caption-text");let active=null;let node=null;
function sceneAt(t){return finalVideo.scenes.find(s=>t>=s.start&&t<s.end)||finalVideo.scenes.at(-1)}
function captionAt(t){return finalCaptions.find(c=>t>=c.start&&t<c.end)||null}
function showCaption(t){const cue=captionAt(t);captionText.textContent=cue?cue.text:"";captionLayer.style.display=cue?"flex":"none";captionLayer.setAttribute("aria-hidden",cue?"false":"true");return cue}
function load(scene){return new Promise((resolve,reject)=>{sceneLayer.replaceChildren();active=scene;
  if(scene.kind==="video"){node=document.createElement("video");node.src=scene.src;node.muted=true;node.playsInline=true;node.preload="auto";node.addEventListener("loadedmetadata",resolve,{once:true});node.addEventListener("error",reject,{once:true});}
  else if(scene.kind==="image"){node=document.createElement("img");node.src=scene.src;node.addEventListener("load",resolve,{once:true});node.addEventListener("error",reject,{once:true});}
  else{node=document.createElement("iframe");const u=new URL(scene.src,location.href);u.searchParams.set("timeline","1");u.searchParams.set("render","1");node.src=u.href;node.addEventListener("load",resolve,{once:true});node.addEventListener("error",reject,{once:true});}
  sceneLayer.append(node);
})}
window.seekTo=async function(time){const t=Math.max(0,Math.min(Number(time)||0,finalVideo.totalDuration));const scene=sceneAt(t);if(!active||active.id!==scene.id)await load(scene);
  let step=0;if(scene.kind==="video"){const target=(scene.sourceStart||0)+(t-scene.start);if(Math.abs(node.currentTime-target)>.001){await new Promise(r=>{node.addEventListener("seeked",r,{once:true});node.currentTime=Math.max(0,target)})}node.pause();}
  if(scene.kind==="html"){for(const cue of scene.cueSteps||[])if(t>=cue.at)step=cue.step;node.contentWindow?.postMessage({type:"set-step",step,time:t},"*");}
  const caption=showCaption(t);return{scene:scene.id,kind:scene.kind,time:t,step,caption:caption?.id||null};
};
window.finalVideo=finalVideo;window.finalCaptions=finalCaptions;window.seekTo(0);
</script></body></html>\n`;
}

function artifactTarget(jobDir: string, type: KouboArtifactType): string {
  if (type === "subtitles") return join(jobDir, "subtitles.srt");
  if (type === "visual-plan") return join(jobDir, "visual-plan.json");
  if (type === "animation-manifest") return join(jobDir, "动画/manifest.json");
  return join(jobDir, "timeline.json");
}

function requiredStage(project: JsonObject, type: KouboArtifactType): void {
  const status = String(project.status ?? "");
  const continuation = isObject(project.codexContinue) ? project.codexContinue : {};
  const stage = String(continuation.stage ?? "");
  const allowed = type === "subtitles"
    ? stage === "subtitle_rebuild" || ["subtitle_rebuild_running", "subtitle_ready", "failed"].includes(status)
    : type === "visual-plan"
      ? stage === "storyboard" || ["storyboard_running", "failed"].includes(status)
      : type === "animation-manifest"
        ? stage === "animation" || ["animation_running", "failed"].includes(status)
        : stage === "timeline" || ["timeline_running", "failed"].includes(status);
  if (!allowed) {
    throw new VideocutError(
      "invalid_argument",
      `Cannot publish ${type} while project status is ${status || "unset"}`,
      { artifactType: type, status, stage },
    );
  }
}

export async function putKouboArtifact(
  inputDirectory: string,
  options: PutKouboArtifactOptions,
): Promise<PutKouboArtifactResult> {
  const jobDir = await realpath(resolve(inputDirectory));
  return serializeKouboProjectOperation(jobDir, async () => {
    const projectPath = join(jobDir, "project.json");
    const projectDocument = await readJson(projectPath);
    requireRevision(projectDocument.revision, options.expectedProjectRevision, "project.json");
    requiredStage(projectDocument.value, options.type);
    const target = artifactTarget(jobDir, options.type);
    const previousArtifactRevision = await optionalRevision(target);
    requireRevision(previousArtifactRevision, options.expectedArtifactRevision, options.type);
    const now = (options.now ?? (() => new Date()))();
    let normalized: string;
    let timelineCaptions: KouboSubtitleCue[] | null = null;
    if (options.type === "subtitles") {
      normalized = await validateSubtitles(jobDir, options.content);
      await atomicWriteText(join(jobDir, "字幕/3_输出/video.srt"), normalized);
      await atomicWriteText(target, normalized);
    } else {
      const input = parseJsonContent(options.content, options.type);
      const value = options.type === "visual-plan"
        ? await validateVisualPlan(jobDir, input, now.toISOString())
        : options.type === "animation-manifest"
          ? await validateAnimationManifest(jobDir, input)
          : await validateTimeline(jobDir, input);
      normalized = jsonText(value);
      if (options.type === "timeline") {
        try {
          timelineCaptions = parseKouboSrt(
            await readFile(join(jobDir, "subtitles.srt"), "utf8"),
          );
        } catch {
          throw new Error("timeline requires the canonical subtitles.srt artifact");
        }
        if (timelineCaptions.length === 0) {
          throw new Error("timeline requires at least one valid canonical subtitle cue");
        }
      }
      await atomicWriteText(target, normalized);
      if (options.type === "timeline") {
        const config = isObject(projectDocument.value.config) ? projectDocument.value.config : {};
        const ratio = String(config.aspectRatio ?? "3:4");
        await atomicWriteText(join(jobDir, "final-player.html"), renderFinalPlayer({
          title: String(projectDocument.value.title ?? projectDocument.value.jobId ?? basename(jobDir)),
          ...frameDimensions(ratio),
          timeline: value as TimelineDocument,
          captions: timelineCaptions ?? [],
        }));
      }
    }
    const artifactRevision = sha256(normalized);
    const changed = artifactRevision !== previousArtifactRevision;
    const artifacts = isObject(projectDocument.value.artifacts)
      ? { ...projectDocument.value.artifacts }
      : {};
    const artifactPath = relative(jobDir, target).split(sep).join("/");
    if (options.type === "subtitles") artifacts.subtitles = artifactPath;
    if (options.type === "visual-plan") artifacts.visualPlan = artifactPath;
    if (options.type === "animation-manifest") artifacts.animationManifest = artifactPath;
    if (options.type === "timeline") {
      artifacts.timeline = artifactPath;
      artifacts.finalPlayer = "final-player.html";
    }
    const status = options.type === "subtitles"
      ? "final_config_ready"
      : options.type === "visual-plan"
        ? "storyboard_review_ready"
        : options.type === "animation-manifest"
          ? "animation_review_ready"
          : "timeline_review_ready";
    const nextProject = {
      ...projectDocument.value,
      status,
      artifacts,
      codexContinue: null,
      updatedAt: now.toISOString(),
    };
    await atomicWriteJson(projectPath, nextProject);
    const projectRevision = sha256(jsonText(nextProject));
    await appendKouboEvent(jobDir, "artifact_published", {
      artifactType: options.type,
      path: artifactPath,
      artifactRevision,
      status,
    }, now);
    return {
      type: options.type,
      target,
      artifactRevision,
      previousArtifactRevision,
      projectRevision,
      status,
      changed,
    };
  });
}
