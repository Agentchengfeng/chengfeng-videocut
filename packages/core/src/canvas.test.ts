import { expect, test } from "bun:test";
import { canvasDimensions, parseCanvasAspect, CANVAS_ASPECT_PRESETS } from "./canvas";
test("canvas presets and bounded custom shapes", () => {
  for (const value of [...CANVAS_ASPECT_PRESETS, "4:5", "32：18"]) expect(parseCanvasAspect(value)).not.toBeNull();
  expect(canvasDimensions("4:5")).toEqual({width:1080,height:1350});
  for (const value of [null, "", "0:1", "1:-2", "1:999999", "Infinity:1", "99999999999999999:1"]) {
    expect(parseCanvasAspect(value)).toBeNull(); expect(() => canvasDimensions(value)).toThrow();
  }
});
