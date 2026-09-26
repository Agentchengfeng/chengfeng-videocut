import { extname } from "node:path";
import { VideocutError } from "@video-workbench/core";
import { probeMedia } from "./mediaCut";

/** Shared by ingest (before ASR) and create (before publishing project state). */
export function sourceMediaKind(path: string): "audio" | "video" {
  const extension = extname(path).toLowerCase();
  if (extension === ".wav") return "audio";
  if ([".mp4", ".mov", ".m4v", ".mkv", ".webm"].includes(extension)) return "video";
  throw new VideocutError("invalid_argument", `Unsupported task media extension: ${extension || "none"}`);
}

export async function validateAudioSource(path: string): Promise<void> {
  const media = await probeMedia(path);
  if (media.hasVideo || !media.hasAudio || !Number.isFinite(media.duration) || media.duration <= 0) {
    throw new VideocutError("invalid_argument", "WAV input requires a readable audio stream and positive duration");
  }
}
