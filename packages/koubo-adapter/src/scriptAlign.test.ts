import { describe, expect, it } from "bun:test";
import { alignScriptToWords, scriptSpeech, scriptTerms } from "./scriptAlign";

const words = (...texts: string[]) =>
  texts.map((text, index) => ({ id: `w-${index}`, text }));

describe("correcting a transcript from the script the speaker wrote", () => {
  it("finds a term by its neighbours, without knowing how it sounds", () => {
    // 「X」 comes back from transcription as 「叉」 — the character for a cross. No
    // dictionary derives that from the audio, but the script has 「刷 X 了」 and the
    // transcript has 「刷 叉 了」, and the two characters either side settle it.
    const result = alignScriptToWords(
      "我现在很少刷 X 了。",
      words("我", "现", "在", "很", "少", "刷", "叉", "了"),
    );
    expect(result.corrections).toEqual([{ wordId: "w-6", from: "叉", to: "X" }]);
  });

  it("corrects a misspelling the same way", () => {
    const result = alignScriptToWords(
      "找到了 Tibo 刚发的消息。",
      words("找", "到", "了", "Tibbo", "刚", "发", "的", "消", "息"),
    );
    expect(result.corrections).toEqual([{ wordId: "w-3", from: "Tibbo", to: "Tibo" }]);
  });

  it("says nothing when the same context appears twice in what was heard", () => {
    // 「刷 ? 了」 matches in two places. Which one the script's 「X」 belongs to is not
    // decidable from position, so the term is reported rather than guessed at —
    // exactly what happened to 「Grok」 and 「Codex」 on a real recording.
    const result = alignScriptToWords(
      "刷 X 了",
      words("刷", "叉", "了", "我", "刷", "嗯", "了"),
    );
    expect(result.corrections).toEqual([]);
    expect(result.unmatched.map((item) => item.text)).toContain("X");
  });

  it("never rewrites half a word", () => {
    // The gap between anchors covers only part of what the transcript calls one
    // word. Replacing it would leave the rest of that word stranded.
    const result = alignScriptToWords(
      "打开 X 页面",
      words("打", "开", "叉页", "面"),
    );
    expect(result.corrections).toEqual([]);
  });

  it("leaves a term the transcript already spelled right alone", () => {
    const result = alignScriptToWords(
      "我让 Grok 跟踪。",
      words("我", "让", "Grok", "跟", "踪"),
    );
    expect(result.corrections).toEqual([]);
  });

  it("reads only what was spoken out of the document", () => {
    const speech = scriptSpeech("# 标题\n\n![图](assets/a.png)\n\n正文 `代码` [链接](http://x)\n\n///\n\n结尾");
    expect(speech).not.toContain("assets");
    expect(speech).not.toContain("http");
    expect(speech).not.toContain("///");
    expect(speech).toContain("正文");
    expect(speech).toContain("链接");
  });

  it("collects the terms worth correcting", () => {
    expect(scriptTerms("我让 Grok 调用 Codex CLI 刷 X。").sort())
      .toEqual(["CLI", "Codex", "Grok", "X"]);
  });
});
