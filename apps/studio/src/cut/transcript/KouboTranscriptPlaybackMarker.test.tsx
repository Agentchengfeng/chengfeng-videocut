// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  applyKouboTranscriptPlaybackMarker,
  followScrollTarget,
  isFollowScrollStep,
} from "./KouboTranscriptPlaybackMarker";

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

  it("keeps the list still while the playing line is inside the reading band", () => {
    const { owner, cue } = scrollFixture({ scrollTop: 400, cueTop: 200, cueHeight: 40 });
    expect(followScrollTarget(owner, cue)).toBeNull();
  });

  it("brings a line that left the band to about a third of the way down", () => {
    const below = scrollFixture({ scrollTop: 400, cueTop: 700, cueHeight: 40 });
    // 400 + 700 - 0.3 * 1000
    expect(followScrollTarget(below.owner, below.cue)).toBe(800);
    const above = scrollFixture({ scrollTop: 400, cueTop: -300, cueHeight: 40 });
    expect(followScrollTarget(above.owner, above.cue)).toBe(0);
  });

  it("clamps to the end of the transcript and skips no-op scrolls", () => {
    const end = scrollFixture({ scrollTop: 1900, cueTop: 950, cueHeight: 40, scrollHeight: 3000 });
    expect(followScrollTarget(end.owner, end.cue)).toBe(2000);
    const atEnd = scrollFixture({ scrollTop: 2000, cueTop: 950, cueHeight: 40, scrollHeight: 3000 });
    expect(followScrollTarget(atEnd.owner, atEnd.cue)).toBeNull();
  });

  it("treats a slow follow scroll as ours and anything else as the person", () => {
    const down = { from: 0, last: 0, target: 5000, until: 10_000 };
    expect(isFollowScrollStep(down, 700, 2_000)).toBe(true);
    down.last = 700;
    expect(isFollowScrollStep(down, 5000, 2_500)).toBe(true);
    // Wheel up in the middle of our scroll down.
    expect(isFollowScrollStep(down, 300, 2_600)).toBe(false);
    // Overshoot or a stale marker is not ours either.
    expect(isFollowScrollStep(down, 5200, 2_600)).toBe(false);
    expect(isFollowScrollStep(down, 5000, 10_001)).toBe(false);
    const up = { from: 4000, last: 4000, target: 1000, until: 10_000 };
    expect(isFollowScrollStep(up, 2500, 100)).toBe(true);
    expect(isFollowScrollStep(up, 4300, 100)).toBe(false);
  });
});

function scrollFixture({
  scrollTop,
  cueTop,
  cueHeight,
  scrollHeight = 5000,
}: { scrollTop: number; cueTop: number; cueHeight: number; scrollHeight?: number }) {
  const owner = document.createElement("div");
  const cue = document.createElement("article");
  owner.append(cue);
  document.body.append(owner);
  Object.defineProperty(owner, "clientHeight", { configurable: true, value: 1000 });
  Object.defineProperty(owner, "scrollHeight", { configurable: true, value: scrollHeight });
  owner.scrollTop = scrollTop;
  Object.defineProperty(owner, "scrollTop", { configurable: true, value: scrollTop, writable: true });
  owner.getBoundingClientRect = () => ({ top: 100, bottom: 1100 }) as DOMRect;
  cue.getBoundingClientRect = () => ({ top: 100 + cueTop, bottom: 100 + cueTop + cueHeight }) as DOMRect;
  return { owner, cue };
}
