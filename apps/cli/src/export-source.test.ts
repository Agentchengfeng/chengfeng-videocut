import { expect, test } from "bun:test";
import { resolveExportProfile, type MediaProbe } from "@video-workbench/koubo-adapter";
import { buildExportPlan } from "@video-workbench/core";
import { exportSource } from "./export-source";

const audio: MediaProbe = {
  hasVideo: false, hasAudio: true, duration: 311.88,
  width: 0, height: 0, videoBitrate: 0, videoProfile: "", pixelFormat: "",
};
test("WAV uses a project-ratio canvas and a defined render clock", () => {
  expect(exportSource(audio, "4:3")).toEqual({
    audioOnly: true, defaultScale: 1,
    canvas: { width: 1440, height: 1080 },
    source: { width: 1440, height: 1080, duration: 311.88, frameRate: 30 },
  });
  expect(exportSource(audio, "9:16").source).toMatchObject({ width: 1080, height: 1920 });
});
test("video source metadata and legacy scaling are unchanged", () => {
  expect(exportSource({ ...audio, hasVideo: true, width: 960, height: 720, frameRate: 60 }, undefined)).toEqual({
    audioOnly: false, defaultScale: undefined,
    canvas: { width: 960, height: 720 },
    source: { width: 960, height: 720, duration: 311.88, frameRate: 60 },
  });
});
test("chosen video canvas does not masquerade as source geometry", () => {
  const probe = {...audio,hasVideo:true,width:1920,height:1080,frameRate:30};
  const media=exportSource(probe,"4:5");
  expect(media.source).toMatchObject({width:1920,height:1080});
  expect(media.canvas).toEqual({width:1080,height:1350});
  expect(media.defaultScale).toBe(1);
  expect(exportSource(probe,"16:9").defaultScale).toBeUndefined();
  expect(exportSource(probe,"0:1").canvas).toEqual({width:1920,height:1080});
});
test("unreadable sources fail closed and legacy invalid canvases use media-specific defaults", () => {
  for (const duration of [0, -1, NaN, Infinity]) expect(() => exportSource({ ...audio, duration }, "4:3")).toThrow();
  expect(() => exportSource({ ...audio, hasAudio: false }, "4:3")).toThrow();
  for (const ratio of [undefined, "", "no", "0:4", "1:999999999"]) {
    expect(exportSource(audio, ratio).canvas).toEqual({width:1920,height:1080});
    expect(exportSource({...audio,hasVideo:true,width:1440,height:1080},ratio).canvas).toEqual({width:1440,height:1080});
  }
});

test("audio canvas defaults do not bypass fast-profile size caps", () => {
  for (const [ratio, width, height] of [["16:9", 1440, 810], ["9:16", 608, 1080], ["4:3", 1440, 1080]] as const) {
    const media = exportSource(audio, ratio);
    const profile = resolveExportProfile({ profile: "fast", sourceWidth: media.source.width, sourceHeight: media.source.height, sourceFrameRate: media.source.frameRate });
    const plan = buildExportPlan({
      editList: { schemaVersion: 1, projectId: "fixture", baseCutsRevision: "a".repeat(64), baseTranscriptRevision: "b".repeat(64), mode: "manual", sourceDuration: 311.88, duration: 1,
        segments: [{ id: "one", source: "source.wav", sourceStart: 0, sourceEnd: 1, timelineStart: 0, trackId: "a-roll", playbackRate: 1 }] },
      words: [], subtitles: null, visuals: null, source: media.source,
      scale: profile.scale ?? media.defaultScale, fps: profile.fps,
    });
    expect(plan.output).toEqual({ width, height });
  }
});
