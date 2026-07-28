import { describe, expect, it } from "bun:test";
import type { EditListDocument } from "@video-workbench/contracts";
import type { TimedWord } from "./cuts";
import {
  activeVisualLayer,
  assertVisualDocument,
  createVisualDocument,
  visualLayerTimings,
  type VisualDocument,
} from "./visuals";

function editList(segments: Array<[number, number, number]>): EditListDocument {
  return {
    schemaVersion: 1,
    projectId: "visual-contract",
    sourceDuration: 100,
    baseCutsRevision: "b".repeat(64),
    baseTranscriptRevision: "a".repeat(64),
    mode: "manual",
    duration: segments.reduce((total, [start, end]) => total + (end - start), 0),
    segments: segments.map(([sourceStart, sourceEnd, timelineStart], index) => ({
      id: `seg-${index}`,
      sourceStart,
      sourceEnd,
      timelineStart,
      playbackRate: 1,
    })),
  } as EditListDocument;
}

const words: TimedWord[] = [
  { id: "w-1", text: "每", start: 0, end: 1 },
  { id: "w-2", text: "天", start: 1, end: 2 },
  { id: "w-3", text: "早", start: 2, end: 3 },
  { id: "w-4", text: "上", start: 3, end: 4 },
];

function documentWith(wordIds: string[]): VisualDocument {
  return {
    ...createVisualDocument("visual-contract", "a".repeat(64)),
    layers: [{ id: "vis-0001", wordIds, module: "modules/demo/index.html" }],
  };
}

describe("visual layers", () => {
  it("takes its moment from the words, not from a stored number", () => {
    // Everything retained: the layer sits where the words are.
    const whole = visualLayerTimings(documentWith(["w-2", "w-3"]), words, editList([[0, 4, 0]]));
    expect(whole[0]).toMatchObject({ start: 1, end: 3, orphaned: false });

    // Cut the first second away and the same layer moves, with no edit to it.
    const trimmed = visualLayerTimings(documentWith(["w-2", "w-3"]), words, editList([[1, 4, 0]]));
    expect(trimmed[0]).toMatchObject({ start: 0, end: 2, orphaned: false });
  });

  it("reports a layer whose words are all gone rather than dropping it", () => {
    const timings = visualLayerTimings(documentWith(["w-1"]), words, editList([[2, 4, 0]]));
    expect(timings[0]).toMatchObject({ orphaned: true, duration: 0 });
    // An orphaned layer is never drawn — it has no honest place to be.
    expect(activeVisualLayer(timings, 0)).toBeNull();
  });

  it("survives a word disappearing from the middle", () => {
    const timings = visualLayerTimings(
      documentWith(["w-1", "w-2", "w-3"]),
      words,
      editList([[0, 1, 0], [2, 4, 1]]),
    );
    expect(timings[0]).toMatchObject({ start: 0, orphaned: false });
    expect(timings[0]!.end).toBeGreaterThan(0);
  });

  it("refuses two layers that claim the same word", () => {
    const document = createVisualDocument("visual-contract", "a".repeat(64));
    expect(() => assertVisualDocument({
      ...document,
      layers: [
        { id: "vis-0001", wordIds: ["w-1"], module: "a/index.html" },
        { id: "vis-0002", wordIds: ["w-1"], module: "b/index.html" },
      ],
    })).toThrow(/claimed by two visual layers/);
  });

  it("refuses a module path that leaves the project", () => {
    const document = createVisualDocument("visual-contract", "a".repeat(64));
    for (const module of ["/etc/passwd.html", "../../secrets.html", "https://x/y.html"]) {
      expect(() => assertVisualDocument({
        ...document,
        layers: [{ id: "vis-0001", wordIds: ["w-1"], module }],
      })).toThrow();
    }
  });

  it("requires a style so a project cannot end up with five different looks", () => {
    const document = createVisualDocument("visual-contract", "a".repeat(64));
    expect(document.animationStyle).toBe("xiaohei");
    expect(() => assertVisualDocument({ ...document, animationStyle: "" })).toThrow(/animationStyle/);
  });
});

describe("layer gap absorption", () => {
  it("carries a layer through the breath before the next one", () => {
    const document: VisualDocument = {
      ...createVisualDocument("visual-contract", "a".repeat(64)),
      layers: [
        { id: "vis-0001", wordIds: ["w-1"], module: "a/index.html" },
        { id: "vis-0002", wordIds: ["w-3"], module: "b/index.html" },
      ],
    };
    // A 0.4s breath between the sentences, well inside the absorb window.
    const paced: TimedWord[] = [
      { id: "w-1", text: "前", start: 0, end: 1 },
      { id: "w-3", text: "后", start: 1.4, end: 2.4 },
    ];
    const timings = visualLayerTimings(document, paced, editList([[0, 4, 0]]));
    // The first layer holds until the second begins…
    expect(timings[0]!.end).toBeCloseTo(1.4, 5);
    // …and the second is untouched.
    expect(timings[1]!.start).toBeCloseTo(1.4, 5);
  });
});
