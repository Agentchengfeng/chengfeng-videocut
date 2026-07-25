// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { applyKouboTranscriptPlaybackMarker } from "./KouboTranscriptPlaybackMarker";

function appendCue(root: HTMLElement, cueId: string, wordId: string): void {
  const cue = document.createElement("article");
  cue.dataset.cueId = cueId;
  const word = document.createElement("span");
  word.dataset.wordId = wordId;
  cue.append(word);
  root.append(cue);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("KouboTranscriptPlaybackMarker", () => {
  it("moves the playback marker between only the previous and current cue words", () => {
    const root = document.createElement("section");
    appendCue(root, "cue-1", "word-1");
    appendCue(root, "cue-2", "word-2");
    document.body.append(root);

    const staleCue = root.querySelector<HTMLElement>('[data-cue-id="cue-2"]');
    const staleWord = root.querySelector<HTMLElement>('[data-word-id="word-2"]');
    staleCue?.classList.add("is-active");
    staleWord?.setAttribute("aria-current", "true");

    applyKouboTranscriptPlaybackMarker(root, { cueId: null, wordId: null }, {
      cueId: "cue-1",
      wordId: "word-1",
    });
    const firstCue = root.querySelector<HTMLElement>('[data-cue-id="cue-1"]');
    const firstWord = root.querySelector<HTMLElement>('[data-word-id="word-1"]');
    expect(firstCue?.classList.contains("is-active")).toBe(true);
    expect(firstWord?.classList.contains("is-current")).toBe(true);
    expect(firstWord?.getAttribute("aria-current")).toBe("true");
    expect(staleCue?.classList.contains("is-active")).toBe(false);
    expect(staleWord?.classList.contains("is-current")).toBe(false);
    expect(staleWord?.hasAttribute("aria-current")).toBe(false);

    applyKouboTranscriptPlaybackMarker(root, { cueId: "cue-1", wordId: "word-1" }, {
      cueId: "cue-2",
      wordId: "word-2",
    });
    const secondCue = root.querySelector<HTMLElement>('[data-cue-id="cue-2"]');
    const secondWord = root.querySelector<HTMLElement>('[data-word-id="word-2"]');
    expect(firstCue?.classList.contains("is-active")).toBe(false);
    expect(firstWord?.classList.contains("is-current")).toBe(false);
    expect(firstWord?.hasAttribute("aria-current")).toBe(false);
    expect(secondCue?.classList.contains("is-active")).toBe(true);
    expect(secondWord?.classList.contains("is-current")).toBe(true);
  });
});
