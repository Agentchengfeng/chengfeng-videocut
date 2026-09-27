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

test("narration gain raises only its own source and a limiter stops peaks at -1 dBFS", () => {
  const spans = [{ source: "voice", sourceStart: 0, sourceEnd: 0.5 }, { source: "clip", sourceStart: 0, sourceEnd: 0.5 }];
  const filter = mainAudioFilter(spans, ["voice", "clip"], 0, { voice: 12 });
  const out = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=48000",
    "-filter_complex", filter, "-map", "[outa]", "-f", "s16le", "-ac", "1", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const samples = new Int16Array(out.buffer, out.byteOffset, out.length / 2);
  expect(samples.length / 48000).toBeCloseTo(1, 3);
  const peak = (from: number, to: number) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(samples[i]!)); return m / 32768; };
  // +12 dB is 3.98×, below the limit; the clip keeps its own level.
  expect(peak(4800, 19200) / peak(28800, 43200)).toBeCloseTo(3.98, 1);
  expect(peak(4800, 19200)).toBeLessThanOrEqual(0.892);
  const loud = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=48000",
    "-filter_complex", mainAudioFilter(spans, ["voice", "clip"], 0, { voice: 24 }), "-map", "[outa]", "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const ls = new Int16Array(loud.buffer, loud.byteOffset, loud.length / 2);
  let m = 0; for (let i = 9600; i < 38400; i++) m = Math.max(m, Math.abs(ls[i]!));
  expect(m / 32768).toBeLessThanOrEqual(0.9);
});
