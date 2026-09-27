import { resolve } from "node:path";
import type { ExportProfile } from "@video-workbench/contracts";
import { VideocutError, assertInsertDocument, buildExportPlan, parseCanvasBackground, parseTranscriptWords } from "@video-workbench/core";
import {
  readEditList,
  readSoundEffects,
  readOptionalProjectDocument,
  readSubtitles,
  readVisuals,
  type ResolvedProject,
} from "@video-workbench/core/node";
import { exportFilm, probeMedia, resolveExportProfile, resolveMainSources } from "@video-workbench/koubo-adapter";
import { exportSource } from "./export-source";

export interface ExecuteExportOptions {
  project: ResolvedProject;
  /** Live read-only root used for HTML/CSS/JS/assets referenced by snapshot docs. */
  assetProjectDirectory?: string;
  /** Live immutable source corresponding to the snapshot's inputVideo field. */
  sourcePathOverride?: string;
  outputPath: string;
  workDirectory: string;
  scale?: number;
  fps?: number;
  profile?: ExportProfile;
  keepWork?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: string, done: number, total: number) => void;
}
export async function executeExport(options: ExecuteExportOptions): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const { project } = options;
  const [subtitles, transcript, editList, visuals, insertsRaw] = await Promise.all([
    readSubtitles(project),
    readOptionalProjectDocument(project, "transcript.json"),
    readEditList(project),
    readVisuals(project),
    readOptionalProjectDocument(project, "inserts.json"),
  ]);
  const inserts = insertsRaw ? assertInsertDocument(insertsRaw.value) : null;
  const inputVideo = (project.project as Record<string, unknown>).inputVideo;
  const mainSources = editList?.value.schemaVersion === 2 ? editList.value.sources : undefined;
  if (!mainSources && (typeof inputVideo !== "string" || !inputVideo.trim())) {
    throw new VideocutError("invalid_project", "This project has no inputVideo to export");
  }
  const sourcePaths = mainSources ? await resolveMainSources(options.assetProjectDirectory ?? project.directory, mainSources) : undefined;
  const sourcePath = sourcePaths ? Object.values(sourcePaths)[0]! : options.sourcePathOverride ?? resolve(project.directory, inputVideo as string);
  const probe = await probeMedia(sourcePath);
  const media = exportSource(probe, (project.project.config as { aspectRatio?: unknown } | undefined)?.aspectRatio);
  const canvasBackground = parseCanvasBackground((project.project.config as { canvasBackground?: unknown } | undefined)?.canvasBackground);
  const resolvedProfile = resolveExportProfile({
    profile: options.profile,
    sourceWidth: media.canvas.width,
    sourceHeight: media.canvas.height,
    sourceFrameRate: media.source.frameRate,
    scale: options.scale,
    fps: options.fps,
  });
  const plan = buildExportPlan({
    editList: editList?.value ?? null,
    words: transcript ? parseTranscriptWords(transcript.value) : [],
    subtitles: subtitles?.value ?? null,
    visuals: visuals?.value ?? null,
    source: media.source,
    canvas: media.canvas,
    scale: resolvedProfile.scale ?? media.defaultScale,
    fps: resolvedProfile.fps,
    inserts,
  });
  const soundEffects = await readSoundEffects(project.directory, true);
  if (soundEffects.document.cues.length) plan.soundEffects = soundEffects.document.cues;
  const summary = {
    projectId: project.projectId,
    profile: resolvedProfile.profile,
    output: options.outputPath,
    duration: plan.duration,
    fps: plan.fps,
    frameCount: plan.frameCount,
    source: plan.source,
    audioOnly: media.audioOnly,
    outputSize: plan.output,
    cutSegments: plan.spans.length,
    subtitleScreens: plan.subtitleCues.length,
    visualLayers: plan.layers.length,
    soundEffectCues: plan.soundEffects?.length ?? 0,
    zoomSpans: plan.zoomSpans.filter((span) => span.box).length,
    warnings: plan.warnings,
  };
  const result = await exportFilm({
    soundEffectsAssetDirectory: project.directory,
    projectDirectory: options.assetProjectDirectory ?? project.directory,
    sourcePath,
    audioOnly: media.audioOnly,
    ...(canvasBackground ? { background: canvasBackground } : {}),
    plan,
    outputPath: options.outputPath,
    workDirectory: options.workDirectory,
    profile: resolvedProfile.profile,
    keepWork: options.keepWork,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const data = {
    ...summary,
    width: result.probe.width,
    height: result.probe.height,
    actualDuration: result.probe.duration,
    hasAudio: result.probe.hasAudio,
    renderedFrames: result.frameCount,
    problems: result.problems,
  };
  if (result.problems.length > 0) {
    throw new VideocutError("readback_mismatch", "成片和导出计划对不上", data);
  }
  return data;
}
