// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { containedPicture, projectCanvasAspect } from "./useContainedPicture";

function video(width: number, height: number, videoWidth = 0, videoHeight = 0): HTMLVideoElement {
  return { offsetWidth: width, offsetHeight: height, videoWidth, videoHeight } as HTMLVideoElement;
}

describe("containedPicture audio canvas", () => {
  it("uses the saved 4:3 project ratio and tolerates invalid legacy config", () => {
    expect(projectCanvasAspect("4:3")).toBe(4 / 3);
    expect(projectCanvasAspect(" 3：4 ")).toBe(3 / 4);
    for (const value of [undefined, null, "0:3", "4:0", "wide", "1:999999999"]) expect(projectCanvasAspect(value)).toBeUndefined();
    expect(containedPicture(video(1280, 960), projectCanvasAspect("4:3"))).toEqual({width:1280,height:960});
  });
  it("letterboxes audio into an explicit landscape canvas", () => {
    expect(containedPicture(video(1280, 900), 16 / 9)).toEqual({ width: 1280, height: 720 });
  });
  it("fits a wide host and supports an explicit portrait canvas", () => {
    expect(containedPicture(video(1600, 720), 16 / 9)).toEqual({ width: 1280, height: 720 });
    expect(containedPicture(video(1000, 800), 9 / 16)).toEqual({ width: 450, height: 800 });
  });
  it("does not invent a video canvas without an audio fallback", () => {
    expect(containedPicture(video(1280, 900))).toBeNull();
  });
  it("preserves intrinsic video sizing even when a fallback is supplied", () => {
    expect(containedPicture(video(1280, 900, 960, 720), 16 / 9)).toEqual({ width: 1200, height: 900 });
  });
  it("distinguishes output canvas from an intrinsic source picture", () => {
    const media = video(450, 800, 1920, 1080);
    expect(containedPicture(media, 9 / 16, true)).toEqual({ width: 450, height: 800 });
    expect(containedPicture(media, 9 / 16)).toEqual({ width: 450, height: 253.125 });
  });
  it("rejects unmeasurable hosts and invalid aspect ratios", () => {
    expect(containedPicture(video(0, 900), 16 / 9)).toBeNull();
    for (const aspect of [0, -1, NaN, Infinity]) expect(containedPicture(video(1280, 900), aspect)).toBeNull();
  });
});
