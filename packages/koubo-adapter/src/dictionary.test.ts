import { describe, expect, it } from "bun:test";
import { matchDictionary, parseDictionary } from "./dictionary";

describe("parseDictionary", () => {
  it("reads a rule from each list item, in any of the usual arrows", () => {
    const { entries } = parseDictionary([
      "# 我常说的专名",
      "",
      "- 叉 → X            # 从来不是「叉子」的意思",
      "* `Tibbo` => `Tibo`",
      "  + tibor = Tibo",
    ].join("\n"));
    expect(entries).toEqual([
      { from: "叉", to: "X" },
      { from: "Tibbo", to: "Tibo" },
      { from: "tibor", to: "Tibo" },
    ]);
  });

  it("ignores prose, however much of it there is", () => {
    // The real dictionary is a document that explains itself. Treating every
    // line as a candidate rule reported thirty lines of prose as broken.
    const { entries, ignored } = parseDictionary([
      "转录会把名字听错，而且是固定地听错。",
      "",
      "```text",
      "词典    永远这么写",
      "```",
      "",
      "- 叉 -> X",
    ].join("\n"));
    expect(entries).toEqual([{ from: "叉", to: "X" }]);
    expect(ignored).toEqual([]);
  });

  it("never reads a sentence as a rule just because it contains a separator", () => {
    // A prose line with a tab or an `=` has the shape of `from = to`.
    const { entries } = parseDictionary("先看看会改什么就加 --dry-run = 这样\n");
    expect(entries).toEqual([]);
  });

  it("reports a list item it could not read instead of dropping it", () => {
    const { entries, ignored } = parseDictionary("- 叉 -> X\n- 这条没有箭头\n");
    expect(entries).toHaveLength(1);
    expect(ignored).toEqual([{ line: 2, text: "- 这条没有箭头" }]);
  });

  it("ignores a rule that changes nothing", () => {
    const { entries, ignored } = parseDictionary("- X -> X\n");
    expect(entries).toEqual([]);
    expect(ignored).toHaveLength(1);
  });

  it("lets the first rule for a word win", () => {
    const { entries } = parseDictionary("- 叉 -> X\n- 叉 -> 交叉\n");
    expect(entries).toEqual([{ from: "叉", to: "X" }]);
  });
});

describe("matchDictionary", () => {
  const entries = [{ from: "叉", to: "X" }];

  it("matches a whole word and reports what is around it", () => {
    const words = [
      { id: "w-1", text: "刷" },
      { id: "w-2", text: "叉" },
      { id: "w-3", text: "了" },
    ];
    const matches = matchDictionary(entries, words);
    expect(matches).toEqual([{ wordId: "w-2", from: "叉", to: "X", context: "刷叉了" }]);
  });

  it("never rewrites inside a longer word", () => {
    // Rewriting substrings would turn 交叉 into 交X, silently.
    expect(matchDictionary(entries, [{ id: "w-1", text: "交叉" }])).toEqual([]);
  });

  it("skips gaps", () => {
    expect(matchDictionary(entries, [{ id: "g-1", text: "", isGap: true }])).toEqual([]);
  });

  it("matches a word the cut removed, because the cut can change back", () => {
    const matches = matchDictionary(entries, [{ id: "w-9", text: "叉" }]);
    expect(matches).toHaveLength(1);
  });
});
