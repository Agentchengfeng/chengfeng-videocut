/**
 * 导出：把标注变成一个文件。
 *
 * Everything before this point in the product is annotation — the edit list
 * marks which words play, the subtitle document marks what is written, the
 * visual document marks what is drawn — and the preview assembles those marks
 * live, sixty times a second, without producing anything. This is the one
 * place that renders, and it is the only place where "the film" exists as a
 * thing you can hand to someone.
 *
 * Which makes the standard it has to meet exact: **the file must be the
 * preview.** Not close to it. The same word timings, the same subtitle CSS,
 * the same module HTML in the same browser engine, the same push-in geometry —
 * every one of them is shared code rather than a second implementation, and
 * where the export had to choose (an out-of-frame push-in gets clamped) the
 * choice is written down.
 */

import { rm, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ExportProfile } from "@video-workbench/contracts";
import type { ExportPlan } from "@video-workbench/core";
import { validateVisualMedia } from "@video-workbench/core/node";
import { assembleCut, composeFilm, intermediatePath, verifyFilm } from "./compose";
import { renderOverlayFrames } from "./overlayRenderer";
import type { MediaProbe } from "../mediaCut";
import { mixSoundEffects } from "./soundEffects";
export * from "./soundEffects";
import { resolveMainSources } from "./sources";

export * from "./chrome";
export * from "./compose";
export * from "./overlayPage";
export * from "./overlayRenderer";
export * from "./profile";
export * from "./sources";

export type ExportStage = "assemble" | "overlay" | "compose" | "verify";

export interface ExportFilmInput {
  /** The project directory — modules are served from here, and only from here. */
  projectDirectory: string;
  soundEffectsAssetDirectory?: string;
  /** The immutable source. Never written to. */
  sourcePath: string;
  /** Render a plain canvas at the planned size for an audio-only source. */
  audioOnly?: boolean;
  /** #RRGGBB for that canvas; white when absent. */
  background?: string;
  /** dB applied to the narration recording (project config narrationGainDb). */
  narrationGainDb?: number;
  plan: ExportPlan;
  outputPath: string;
  workDirectory: string;
  profile?: ExportProfile;
  /** Leave the intermediate and the PNG frames behind for inspection. */
  keepWork?: boolean;
  signal?: AbortSignal;
  onProgress?: (stage: ExportStage, done: number, total: number) => void;
}

export interface ExportFilmResult {
  outputPath: string;
  probe: MediaProbe;
  /** Empty when the file matched the plan. */
  problems: string[];
  frameCount: number;
  workDirectory: string;
}

export async function exportFilm(input: ExportFilmInput): Promise<ExportFilmResult> {
  const { plan } = input;
  for (const layer of plan.layers) if (layer.media) await validateVisualMedia(input.projectDirectory, layer.media);
  const assembled = intermediatePath(input.workDirectory);
  const framesDirectory = join(input.workDirectory, "overlay");

  input.onProgress?.("assemble", 0, 1);
  input.signal?.throwIfAborted();
  await assembleCut({
    source: input.sourcePath,
    projectDirectory: input.projectDirectory,
    output: assembled,
    plan,
    audioOnly: input.audioOnly,
    ...(input.background ? { background: input.background } : {}),
    ...(input.narrationGainDb ? { narrationGainDb: input.narrationGainDb } : {}),
    signal: input.signal,
  });
  if (plan.soundEffects?.some(c => !c.mute)) {
    const mixed = `${assembled}.sfx.mkv`;
    try {
      await mixSoundEffects({ source: assembled, output: mixed, projectDirectory: input.soundEffectsAssetDirectory ?? input.projectDirectory,
        cues: plan.soundEffects, duration: plan.duration, lossless: true, signal: input.signal });
      await rename(mixed, assembled);
    } finally { await rm(mixed, {force:true}); }
  }
  input.onProgress?.("assemble", 1, 1);

  // The overlay is rendered after the cut rather than beside it on purpose:
  // if the assembly is wrong there is no point spending several minutes
  // drawing frames that will be thrown away.
  //
  // A project with nothing written and nothing drawn skips the browser
  // entirely rather than rendering thousands of transparent sheets to lay over
  // the footage and change nothing.
  const hasOverlay = plan.subtitleCues.length > 0 || plan.layers.some(layer => !layer.media);
  const frames = hasOverlay
    ? await renderOverlayFrames({
      plan,
      projectDirectory: input.projectDirectory,
      framesDirectory,
      signal: input.signal,
      onProgress: (done, total) => input.onProgress?.("overlay", done, total),
    })
    : null;

  input.onProgress?.("compose", 0, plan.zoomSpans.length);
  await composeFilm({
    projectDirectory: input.projectDirectory,
    assembled,
    framePattern: frames?.pattern ?? null,
    output: input.outputPath,
    workDirectory: join(input.workDirectory, "spans"),
    plan,
    profile: input.profile,
    signal: input.signal,
    onSpan: (done, total) => input.onProgress?.("compose", done, total),
  });

  input.onProgress?.("verify", 0, 1);
  input.signal?.throwIfAborted();
  const { probe, frames: filmFrames, problems } = await verifyFilm(input.outputPath, plan, input.signal);
  if (plan.sources) await resolveMainSources(input.projectDirectory, plan.sources);
  for (const layer of plan.layers) if (layer.media) await validateVisualMedia(input.projectDirectory, layer.media);
  input.onProgress?.("verify", 1, 1);

  if (!input.keepWork) {
    await rm(input.workDirectory, { recursive: true, force: true });
  }

  return {
    outputPath: input.outputPath,
    probe,
    problems,
    frameCount: filmFrames,
    workDirectory: input.workDirectory,
  };
}
