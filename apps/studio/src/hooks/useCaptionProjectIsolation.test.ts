import { afterEach, describe, expect, it } from "vitest";
import { buildCaptionModel } from "../captions/parser";
import { useCaptionStore } from "../captions/store";
import { resetCaptionStoreForProjectChange } from "./useCaptionProjectIsolation";

afterEach(() => {
  useCaptionStore.getState().reset();
});

describe("resetCaptionStoreForProjectChange", () => {
  it("clears every project-scoped caption field", () => {
    const model = buildCaptionModel(
      [{ id: "word-a", text: "旧项目", start: 0, end: 1 }],
      { width: 1920, height: 1080, duration: 1 },
    );
    const segmentId = model.segments.keys().next().value as string;
    const store = useCaptionStore.getState();
    store.setModel(model);
    store.setSourceFilePath("captions/old.html");
    store.setEditMode(true);
    store.selectSegment(segmentId);

    resetCaptionStoreForProjectChange();

    const state = useCaptionStore.getState();
    expect(state.model).toBeNull();
    expect(state.sourceFilePath).toBeNull();
    expect(state.isEditMode).toBe(false);
    expect(state.selectedSegmentIds.size).toBe(0);
    expect(state.selectedGroupId).toBeNull();
  });
});
