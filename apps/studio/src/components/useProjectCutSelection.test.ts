import { describe, expect, it } from "vitest";
import { shouldSyncCutSelectionAfterFileChange } from "./useProjectCutSelection";

const OWN_CUT_CHANGE = {
  data: JSON.stringify({ projectId: "demo", path: "cut-selection.json" }),
};

describe("shouldSyncCutSelectionAfterFileChange", () => {
  it("ignores the file watcher event emitted by an in-flight optimistic save", () => {
    expect(
      shouldSyncCutSelectionAfterFileChange(OWN_CUT_CHANGE, "demo", 1),
    ).toBe(false);
  });

  it("silently syncs a late or external cut-selection change", () => {
    expect(
      shouldSyncCutSelectionAfterFileChange(OWN_CUT_CHANGE, "demo", 0),
    ).toBe(true);
  });

  it("ignores changes from another project or another file", () => {
    expect(
      shouldSyncCutSelectionAfterFileChange(OWN_CUT_CHANGE, "other", 0),
    ).toBe(false);
    expect(
      shouldSyncCutSelectionAfterFileChange(
        { data: JSON.stringify({ projectId: "demo", path: "transcript.json" }) },
        "demo",
        0,
      ),
    ).toBe(false);
  });
});
