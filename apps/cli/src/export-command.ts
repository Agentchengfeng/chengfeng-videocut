import { resolve } from "node:path";
import { VideocutError, buildExportPlan, parseTranscriptWords } from "@video-workbench/core";
import {
  readEditList,
  readOptionalProjectDocument,
  readSubtitles,
  readVisuals,
  type ResolvedProject,
} from "@video-workbench/core/node";
import { exportFilm, probeMedia } from "@video-workbench/koubo-adapter";

export interface ExecuteExportOptions {
  project: ResolvedProject;
  outputPath: string;
  workDirectory: string;
  scale?: number;
  fps?: number;
  keepWork?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: string, done: number, total: number) => void;
}
export async function executeExport(options: ExecuteExportOptions): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const { project } = options;
  const [subtitles, transcript, editList, visuals] = await Promise.all([
    readSubtitles(project),
    readOptionalProjectDocument(project, "transcript.json"),
    readEditList(project),
    readVisuals(project),
  ]);
  const inputVideo = (project.project as Record<string, unknown>).inputVideo;
  if (typeof inputVideo !== "string" || !inputVideo.trim()) {
    throw new VideocutError("invalid_project", "This project has no inputVideo to export");
  }
  const sourcePath = resolve(project.directory, inputVideo);
  const probe = await probeMedia(sourcePath);
  if (!probe.hasVideo) {
    throw new VideocutError("invalid_project", "The source is not a readable video", { sourcePath });
  }
  const plan = buildExportPlan({
    editList: editList?.value ?? null,
    words: transcript ? parseTranscriptWords(transcript.value) : [],
    subtitles: subtitles?.value ?? null,
    visuals: visuals?.value ?? null,
    source: {
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      frameRate: probe.frameRate ?? 30,
    },
    scale: options.scale,
    fps: options.fps,
  });
  const summary = {
    projectId: project.projectId,
    output: options.outputPath,
    duration: plan.duration,
    fps: plan.fps,
    frameCount: plan.frameCount,
    source: plan.source,
    outputSize: plan.output,
    cutSegments: plan.spans.length,
    subtitleScreens: plan.subtitleCues.length,
    visualLayers: plan.layers.length,
    zoomSpans: plan.zoomSpans.filter((span) => span.box).length,
    warnings: plan.warnings,
  };
  const result = await exportFilm({
    projectDirectory: project.directory,
    sourcePath,
    plan,
    outputPath: options.outputPath,
    workDirectory: options.workDirectory,
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
