import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mainAudioFilter } from "./sources";

test("a span keeps its exact length when the source audio ends early", () => {
  // Source audio is 1.00s; the span asks for 1.05s (a clip whose audio decodes a little short).
  const filter = mainAudioFilter([{ source: "a", sourceStart: 0, sourceEnd: 1.05 }, { source: "a", sourceStart: 0, sourceEnd: 0.5 }], ["a"]);
  const out = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=48000",
    "-filter_complex", filter, "-map", "[outa]", "-f", "s16le", "-ac", "1", "-"], { maxBuffer: 64 * 1024 * 1024 });
  expect(out.length / 2 / 48000).toBeCloseTo(1.55, 3);
});
