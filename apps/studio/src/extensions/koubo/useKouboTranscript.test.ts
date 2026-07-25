import { describe, expect, it } from "vitest";
import { isKouboTranscriptFileChange } from "./useKouboTranscript";

describe("isKouboTranscriptFileChange", () => {
  it("recognizes both supported transcript documents", () => {
    expect(isKouboTranscriptFileChange({ path: "transcript.json" })).toBe(true);
    expect(isKouboTranscriptFileChange({
      data: JSON.stringify({ path: "/projects/demo/subtitles_words.json" }),
    })).toBe(true);
  });

  it("ignores cut and edit-list writes", () => {
    expect(isKouboTranscriptFileChange({ path: "cut-selection.json" })).toBe(false);
    expect(isKouboTranscriptFileChange({ path: "edit-list.json" })).toBe(false);
  });
});
