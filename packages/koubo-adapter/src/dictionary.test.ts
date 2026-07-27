import { describe, expect, it } from "bun:test";
import { matchDictionary, parseDictionary } from "./dictionary";

describe("parseDictionary", () => {
  it("reads the table the product already maintains, one row to many rules", () => {
    // `| 正确写法 | 常见误识别 |` is the shape a person is already keeping up to
    // date, and it groups a name's five mishearings where they belong.
    const { entries, ignored } = parseDictionary([
      "| 正确写法 | 常见误识别 |",
      "| --- | --- |",
      "| Grok | grok / Clock / 格罗克 |",
      "| Codex | CodeX / codex |",
    ].join("\n"));
    expect(entries).toEqual([
      { from: "grok", to: "Grok" },
      { from: "Clock", to: "Grok" },
      { from: "格罗克", to: "Grok" },
      { from: "CodeX", to: "Codex" },
      { from: "codex", to: "Codex" },
    ]);
    // The header and the separator are not broken rules.
    expect(ignored).toEqual([]);
  });

  it("drops the reader's parenthetical notes rather than matching on them", () => {
    const { entries } = parseDictionary([
      "| X | 叉 / 推特（说话人说「叉」时按原文保留，不换） |",
    ].join("\n"));
    expect(entries).toEqual([
      { from: "叉", to: "X" },
      { from: "推特", to: "X" },
    ]);
  });

  it("never turns a row into a rule that renames something to itself", () => {
    const { entries } = parseDictionary("| Agent | agent / Agent |\n");
    expect(entries).toEqual([{ from: "agent", to: "Agent" }]);
  });

  it("lets the first rule for a word win", () => {
    const { entries } = parseDictionary("| X | 叉 |\n| 交叉 | 叉 |\n");
    expect(entries).toEqual([{ from: "叉", to: "X" }]);
  });

  it("ignores prose, including prose written as a bullet list", () => {
    // This project's own dictionary explains its rules in a bullet list. Those
    // bullets are not rules, and reporting them as broken ones is noise that
    // trains people to ignore the report.
    const { entries, ignored } = parseDictionary([
      "转录会把名字听错，而且是固定地听错。",
      "",
      "- **只改文字，不改时间。** 改了时间，所有已做的删除都会砍在错误位置。",
      "- 同一族里选出现次数最多的正确写法做基准；次数相同时选官方写法。",
      "",
      "| Grok | grok |",
    ].join("\n"));
    expect(entries).toEqual([{ from: "grok", to: "Grok" }]);
    expect(ignored).toEqual([]);
  });

  it("reports a table row it could not read", () => {
    const { entries, ignored } = parseDictionary("| Grok | grok |\n| 只有一半 |  |\n");
    expect(entries).toEqual([{ from: "grok", to: "Grok" }]);
    expect(ignored).toEqual([{ line: 2, text: "| 只有一半 |  |" }]);
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
