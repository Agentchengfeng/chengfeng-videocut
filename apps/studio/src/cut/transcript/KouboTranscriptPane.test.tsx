// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEditListState } from "../../components/useProjectEditList";
import type { TranscriptCue } from "../../components/kouboTranscript";
import type { ProjectReviewPasses } from "../review/useProjectReviewPasses";
import { KouboTranscriptPane } from "./KouboTranscriptPane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const revision = "a".repeat(64);
const cues: TranscriptCue[] = [{
  id: "cue-1",
  start: 0,
  end: 2,
  words: [
    { id: "w1", text: "一", start: 0, end: 1, isGap: false },
    { id: "w2", text: "二", start: 1, end: 2, isGap: false },
  ],
}];

function editListFixture(mode: "cuts-derived" | "manual"): ProjectEditListState {
  return {
    projectId: "transcript-contract",
    document: {
      schemaVersion: 1,
      projectId: "transcript-contract",
      sourceDuration: 10,
      baseCutsRevision: revision,
      baseTranscriptRevision: revision,
      mode,
      duration: 10,
      segments: [{
        id: "a-roll-0001",
        source: "input/source.mp4",
        sourceStart: 0,
        sourceEnd: 10,
        timelineStart: 0,
        trackId: "a-roll",
        playbackRate: 1,
      }],
    },
    revision,
    loading: false,
    ready: true,
    saveState: "idle",
    reload: vi.fn(async () => true),
    patchOperation: vi.fn(),
    canUndo: false,
    undoLastEditListChange: vi.fn(async () => undefined),
  };
}

function pointerEvent(
  type: string,
  options: {
    clientX: number;
    clientY: number;
    pointerType?: string;
    shiftKey?: boolean;
  },
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: options.clientX,
    clientY: options.clientY,
    pointerType: options.pointerType ?? "mouse",
    shiftKey: options.shiftKey ?? false,
  });
}

function renderPane(
  mode: "cuts-derived" | "manual" = "manual",
  options: {
    editList?: ProjectEditListState;
    cutWordIds?: ReadonlySet<string>;
    cues?: TranscriptCue[];
    reviewPasses?: ProjectReviewPasses;
  } = {},
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSeek = vi.fn();
  const updateCutWordIds = vi.fn();
  act(() => root.render(
    <KouboTranscriptPane
      projectId="transcript-contract"
      editList={options.editList ?? editListFixture(mode)}
      transcript={{ cues: options.cues ?? cues, loading: false, error: null }}
      cutSelection={{
        cutWordIds: options.cutWordIds ?? new Set<string>(),
        saveState: "idle",
        selectionLoading: false,
        selectionReady: true,
        updateCutWordIds,
        canUndo: false,
        undoLastCutChange: vi.fn(),
      }}
      reviewPasses={options.reviewPasses}
      onSeek={onSeek}
    />,
  ));
  return { host, root, onSeek, updateCutWordIds };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("KouboTranscriptPane sidebar contract", () => {
  it("uses the borderless full-width cue density contract", () => {
    const css = readFileSync(resolve(process.cwd(), "src/cut/cut.css"), "utf8");
    const cueRule = css.match(/\.cut-transcript-cue \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(cueRule).toContain("grid-template-columns: 24px minmax(0, 1fr);");
    expect(cueRule).toContain("column-gap: 4px;");
    expect(cueRule).toContain("padding: 6px 16px 6px 8px;");
    expect(cueRule).not.toContain("border-bottom");
  });

  it("uses static cue numbers without restoring source-time labels", () => {
    const rendered = renderPane("cuts-derived", {
      cues: [
        ...cues,
        {
          id: "cue-2",
          start: 2,
          end: 3,
          words: [{ id: "w3", text: "三", start: 2, end: 3, isGap: false }],
        },
      ],
    });
    expect(rendered.host.querySelector(".cut-transcript-cue__time")).toBeNull();
    expect(Array.from(rendered.host.querySelectorAll<HTMLElement>(".cut-transcript-cue"))
      .map((cue) => cue.dataset.cueIndex)).toEqual(["1", "2"]);
    expect(Array.from(rendered.host.querySelectorAll(".cut-transcript-cue__index"))
      .map((cue) => cue.textContent?.trim())).toEqual(["01", "02"]);
    expect(rendered.host.querySelector(".cut-transcript-cue")?.getAttribute("aria-label"))
      .toBe("文稿第 1 段");
    expect(rendered.host.querySelector<HTMLElement>(".cut-transcript-pane__body")?.dataset.cutTranscriptScrollOwner)
      .toBe("true");
    act(() => rendered.root.unmount());
  });

  it("renders a two-pass virtual new transcript without a repeat review card or edit action", () => {
    const rendered = renderPane("cuts-derived", {
      cues: [{
        id: "cue-removed",
        start: 0,
        end: 2,
        words: [
          { id: "w1", text: "一", start: 0, end: 1, isGap: false },
          { id: "w2", text: "二", start: 1, end: 2, isGap: false },
        ],
      }, {
        id: "cue-kept",
        start: 2,
        end: 4,
        words: [
          { id: "g1", text: "", start: 2, end: 2.6, isGap: true },
          { id: "w3", text: "我", start: 2, end: 3, isGap: false },
          { id: "w4", text: "看", start: 3, end: 4, isGap: false },
        ],
      }],
      reviewPasses: {
        state: "current",
        reason: null,
        removedWordIds: ["w1"],
        candidates: [{
          id: "repeat-1",
          kind: "repeat",
          decision: "listen_then_decide",
          removeWordIds: ["w2"],
          keepWordIds: ["w3", "w4"],
          reason: "后一句更完整，需试听确认",
        }],
      },
    });
    expect(rendered.host.querySelector("[data-review-pass=repeat]")).toBeNull();
    expect(rendered.host.querySelector('[data-word-id="w1"]')).toBeNull();
    expect(rendered.host.querySelector('[data-word-id="w2"]')).toBeNull();
    expect(rendered.host.querySelector('[data-word-id="w3"]')?.textContent).toBe("我");
    expect(rendered.host.querySelector('[data-word-id="w4"]')?.textContent).toBe("看");
    expect(rendered.host.querySelector('[data-word-id="g1"]')).toBeNull();
    expect(rendered.host.querySelectorAll(".cut-transcript-cue")).toHaveLength(1);
    expect(rendered.host.querySelector(".cut-transcript-cue")?.getAttribute("data-cue-index")).toBe("1");
    expect(rendered.onSeek).not.toHaveBeenCalled();
    expect(rendered.updateCutWordIds).not.toHaveBeenCalled();
    act(() => rendered.root.unmount());
  });

  it("keeps mouse vertical drag scrolling after its first seek-and-play request", () => {
    const rendered = renderPane("cuts-derived");
    const body = rendered.host.querySelector<HTMLDivElement>(".cut-transcript-pane__body");
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!body || !firstWord) throw new Error("Expected transcript scroll body and word");
    body.scrollTop = 100;

    act(() => {
      const down = pointerEvent("pointerdown", { clientX: 20, clientY: 100 });
      firstWord.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(false);
      document.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 140 }));
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
      document.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 160 }));
      document.dispatchEvent(pointerEvent("pointerup", { clientX: 20, clientY: 140 }));
    });

    expect(body.scrollTop).toBe(40);
    expect(rendered.onSeek).toHaveBeenCalledTimes(1);
    expect(rendered.onSeek).toHaveBeenCalledWith(0, { keepPlaying: true });
    expect(rendered.host.querySelector("[data-cut-transcript-selection=true]")).toBeNull();
    act(() => rendered.root.unmount());
  });

  it("keeps touch vertical pan out of the desktop selection path", () => {
    const rendered = renderPane("cuts-derived");
    const body = rendered.host.querySelector<HTMLDivElement>(".cut-transcript-pane__body");
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!body || !firstWord) throw new Error("Expected transcript scroll body and word");
    body.scrollTop = 100;

    act(() => {
      firstWord.dispatchEvent(pointerEvent("pointerdown", {
        clientX: 20,
        clientY: 100,
        pointerType: "touch",
      }));
      document.dispatchEvent(pointerEvent("pointermove", {
        clientX: 20,
        clientY: 140,
        pointerType: "touch",
      }));
      document.dispatchEvent(pointerEvent("pointerup", {
        clientX: 20,
        clientY: 140,
        pointerType: "touch",
      }));
    });

    expect(body.scrollTop).toBe(100);
    expect(rendered.onSeek).not.toHaveBeenCalled();
    expect(rendered.host.querySelector("[data-cut-transcript-selection=true]")).toBeNull();
    act(() => rendered.root.unmount());
  });

  it("keeps desktop horizontal drag-to-select available", () => {
    const rendered = renderPane("cuts-derived");
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    const secondWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w2"]');
    if (!firstWord || !secondWord) throw new Error("Expected transcript words");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(secondWord);

    act(() => {
      firstWord.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 20 }));
      document.dispatchEvent(pointerEvent("pointermove", { clientX: 28, clientY: 21 }));
      document.dispatchEvent(pointerEvent("pointerup", { clientX: 28, clientY: 21 }));
    });

    expect(rendered.host.querySelector("[data-cut-transcript-selection=true]")).not.toBeNull();
    expect(rendered.host.querySelector<HTMLButtonElement>("button.is-delete")).not.toBeNull();
    expect(rendered.onSeek).toHaveBeenCalledTimes(1);
    expect(rendered.onSeek).toHaveBeenCalledWith(0, { keepPlaying: true });
    act(() => rendered.root.unmount());
  });

  it("seeks and starts playback for a plain desktop word on pointerdown only", () => {
    const rendered = renderPane("cuts-derived");
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!firstWord) throw new Error("Expected first transcript word");

    act(() => {
      firstWord.dispatchEvent(pointerEvent("pointerdown", { clientX: 10, clientY: 20 }));
    });
    expect(rendered.onSeek).toHaveBeenCalledTimes(1);
    expect(rendered.onSeek).toHaveBeenCalledWith(0, { keepPlaying: true });

    act(() => {
      document.dispatchEvent(pointerEvent("pointerup", { clientX: 10, clientY: 20 }));
    });
    expect(rendered.onSeek).toHaveBeenCalledTimes(1);
    expect(rendered.host.querySelector("[data-cut-transcript-selection=true]")).toBeNull();
    act(() => rendered.root.unmount());
  });

  it("keeps Shift pointer selection explicit and out of the immediate seek path", () => {
    const rendered = renderPane("manual");
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!firstWord) throw new Error("Expected first transcript word");

    act(() => {
      firstWord.dispatchEvent(pointerEvent("pointerdown", {
        clientX: 10,
        clientY: 20,
        shiftKey: true,
      }));
      document.dispatchEvent(pointerEvent("pointerup", {
        clientX: 10,
        clientY: 20,
        shiftKey: true,
      }));
    });

    expect(rendered.onSeek).not.toHaveBeenCalled();
    expect(rendered.host.querySelector("[data-cut-transcript-selection=true]")).not.toBeNull();
    act(() => rendered.root.unmount());
  });

  it("removes duplicate local chrome while manual words still seek and delete the current EDL", async () => {
    const editList = editListFixture("manual");
    const patchOperation = vi.fn(async () => editList.document!);
    editList.patchOperation = patchOperation;
    const rendered = renderPane("manual", { editList });
    expect(rendered.host.textContent).not.toContain("文稿剪辑");
    expect(rendered.host.textContent).not.toContain("已进入手动精剪 · 文稿只读");
    expect(rendered.host.textContent).not.toContain("撤销");

    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!firstWord) throw new Error("Expected first transcript word");
    act(() => {
      firstWord.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });
    expect(rendered.onSeek).toHaveBeenCalledWith(0);

    await act(async () => {
      firstWord.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }));
      await Promise.resolve();
    });
    expect(rendered.updateCutWordIds).not.toHaveBeenCalled();
    const remove = rendered.host.querySelector<HTMLButtonElement>("button.is-delete");
    if (!remove) throw new Error("Expected manual delete confirmation button");
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    expect(patchOperation).toHaveBeenCalledWith({
      type: "delete-range",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 1,
    });

    act(() => rendered.root.unmount());
  });

  it("keeps cuts-derived word delete available", () => {
    const rendered = renderPane("cuts-derived");
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!firstWord) throw new Error("Expected first transcript word");

    act(() => {
      firstWord.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }));
    });

    expect(rendered.updateCutWordIds).toHaveBeenCalledWith(new Set(["w1"]));
    act(() => rendered.root.unmount());
  });

  it("restores a manual deleted word through the Product EditList facade", async () => {
    const editList = editListFixture("manual");
    const document = editList.document;
    if (!document) throw new Error("Expected edit list");
    editList.document = {
      ...document,
      duration: 9,
      segments: [{
        ...document.segments[0],
        sourceStart: 1,
        timelineStart: 0,
      }],
    };
    const patchOperation = vi.fn(async () => editList.document!);
    editList.patchOperation = patchOperation;
    const rendered = renderPane("manual", { editList });
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!firstWord) throw new Error("Expected first transcript word");

    await act(async () => {
      firstWord.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }));
      await Promise.resolve();
    });

    const restore = rendered.host.querySelector<HTMLButtonElement>('button.is-restore');
    if (!restore) throw new Error("Expected restore confirmation button");
    expect(patchOperation).not.toHaveBeenCalled();
    await act(async () => {
      restore.click();
      await Promise.resolve();
    });

    expect(patchOperation).toHaveBeenCalledWith({
      type: "restore",
      sourceStart: 0,
      sourceEnd: 1,
      nextSegmentId: "a-roll-0001",
    });
    expect(rendered.updateCutWordIds).not.toHaveBeenCalled();
    act(() => rendered.root.unmount());
  });

  it("keeps a manual restore selection with a Chinese retry message after failure", async () => {
    const editList = editListFixture("manual");
    const document = editList.document;
    if (!document) throw new Error("Expected edit list");
    editList.document = {
      ...document,
      duration: 9,
      segments: [{ ...document.segments[0], sourceStart: 1, timelineStart: 0 }],
    };
    editList.patchOperation = vi.fn(async () => {
      const error = new Error("Restore anchors must be adjacent in the current timeline");
      Object.assign(error, { code: "invalid_edit_list" });
      throw error;
    });
    const rendered = renderPane("manual", { editList });
    const firstWord = rendered.host.querySelector<HTMLElement>('[data-word-id="w1"]');
    if (!firstWord) throw new Error("Expected first transcript word");

    await act(async () => {
      firstWord.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }));
      await Promise.resolve();
    });
    const restore = rendered.host.querySelector<HTMLButtonElement>('button.is-restore');
    if (!restore) throw new Error("Expected restore confirmation button");
    await act(async () => {
      restore.click();
      await Promise.resolve();
    });

    expect(rendered.host.textContent).toContain("恢复位置已变化，请重新选择后重试");
    expect(rendered.host.querySelector('button.is-restore')).not.toBeNull();
    act(() => rendered.root.unmount());
  });
});
