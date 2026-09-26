// @vitest-environment happy-dom
import { afterEach, expect, test } from "vitest";
import { extractTranscript, parseCaptionComposition } from "./parser";
const entries = [{ id: "a", text: "a];", start: 0, end: 1 }, { id: "b", text: "b", start: 1, end: 2 }, { id: "c", text: "c", start: 2, end: 3 }];
const source = `const TRANSCRIPT = ${JSON.stringify(entries)};`;
afterEach(() => { document.body.replaceChildren(); });
function fixture() {
  const scope = document.createElement("main");
  scope.innerHTML = '<div class="caption-group" style="font-size:32px"><span class="word" id="a" style="font-size:32px">a];</span><span class="word" id="b" style="font-size:40px">b</span></div><div class="caption-group" style="font-size:64px"><span class="word" id="c" style="font-size:64px">c</span></div>';
  document.body.append(scope);
  return scope;
}
const parse = (scope: Element, text = source) => parseCaptionComposition(scope, window, text, 1920, 1080, 4);
test("literal reader preserves delimiters, quotes, slashes and escaped Unicode without executing source", () => {
  const text = `quote ' and " slash \\ ];`;
  expect(extractTranscript(`const TRANSCRIPT = ${JSON.stringify([{ text, start: 0, end: 1 }])};`)[0].text).toBe(text);
  expect(extractTranscript(String.raw`const script = [{text:'it\'s \\ \u4e2d ];', start:0,end:1,}];`)[0].text).toBe("it's \\ 中 ];");
  expect(extractTranscript('const TRANSCRIPT = [{text:danger(),start:0,end:1}];')).toEqual([]);
  expect(extractTranscript('// const TRANSCRIPT = [];\nconst script = [{text:"ok",start:0,end:1}];')[0].text).toBe("ok");
  expect(extractTranscript(source + source)).toEqual([]);
});
test("AST rejects regex lookalikes and declarations in uncalled or conditional scopes", () => {
  expect(extractTranscript('if (ready) /const TRANSCRIPT = [{id:"w1",text:"same",start:0,end:1}];x/.test(input);')).toEqual([]);
  expect(extractTranscript(`function unused() { ${source} }`)).toEqual([]);
  expect(extractTranscript(`if (ready) { ${source} }`)).toEqual([]);
  expect(extractTranscript(`(function () { if (ready) { ${source} } })();`)).toEqual([]);
  expect(extractTranscript(`(async function () { ${source} })();`)).toEqual([]);
  expect(extractTranscript(`(function (value) { ${source} })(1);`)).toEqual([]);
  expect(extractTranscript(`const html = '<script>${source}</script>';`)).toEqual([]);
  expect(extractTranscript(`(function () { ${source} })();`)).toHaveLength(3);
  expect(extractTranscript(source + '\nconst ratio = total / count; const label = `words ${ratio}`;')).toHaveLength(3);
});
test("actual uneven groups and per-word styles are preserved", () => {
  const model = parse(fixture())!;
  expect(model.groupOrder.map(id => model.groups.get(id)!.segmentIds.length)).toEqual([2, 1]);
  expect([...model.segments.values()].map(word => word.style.fontSize)).toEqual([32, 40, 64]);
  expect([...model.segments.values()].map(word => word.wordId)).toEqual(["a", "b", "c"]);
});
test("HTML comments and template scripts are not running transcript sources", () => {
  expect(extractTranscript(`<!-- <script>${source}</script> -->`)).toEqual([]);
  expect(extractTranscript(`<template><script>${source}</script></template>`)).toEqual([]);
  expect(extractTranscript(`<html><!-- <script>${source}</script> --><script>${source}</script></html>`)).toHaveLength(3);
});
test("HTML accepts real inline classic JavaScript only, without executing it", () => {
  expect(extractTranscript(`<script type="application/json">${source}</script>`)).toEqual([]);
  expect(extractTranscript(`<script src="captions.js">${source}</script>`)).toEqual([]);
  expect(extractTranscript(`<script nomodule>${source}</script>`)).toEqual([]);
  expect(extractTranscript(`<script type="module">${source}</script>`)).toEqual([]);
  Reflect.deleteProperty(window, "__captionReaderExecuted");
  expect(extractTranscript(`<script type="text/javascript">${source} window.__captionReaderExecuted = true;</script>`)).toHaveLength(3);
  expect(Reflect.get(window, "__captionReaderExecuted")).toBeUndefined();
});
test("rejection diagnostics identify HTML, AST and DOM stages without source text", () => {
  const reasons: string[] = [];
  expect(extractTranscript('<!-- <script>private text</script> -->', reason => reasons.push(reason))).toEqual([]);
  expect(reasons.pop()).toBe("HTML_NO_SUPPORTED_INLINE_SCRIPT");
  expect(extractTranscript('const TRANSCRIPT = [private text', reason => reasons.push(reason))).toEqual([]);
  expect(reasons.pop()).toBe("AST_PARSE_FAILED");
  const scope = fixture(); scope.querySelector(".word")!.textContent = "private changed text";
  expect(parseCaptionComposition(scope, window, source, 1920, 1080, 4, reason => reasons.push(reason))).toBeNull();
  expect(reasons.pop()).toBe("DOM_WORD_TEXT_MISMATCH");
  expect(parseCaptionComposition(fixture(), window, source, 1920, 1080, 0, reason => reasons.push(reason))).toBeNull();
  expect(reasons.pop()).toBe("DOM_METADATA_INVALID(width=1920,height=1080,duration=0)");
});
test("two plus three words retain actual grouping instead of rounding average size", () => {
  const scope = fixture();
  scope.querySelectorAll(".caption-group")[1].insertAdjacentHTML("beforeend", '<span class="word" id="d">d</span><span class="word" id="e">e</span>');
  const words = [...entries, { id: "d", text: "d", start: 3, end: 3.5 }, { id: "e", text: "e", start: 3.5, end: 4 }];
  const model = parse(scope, `const TRANSCRIPT=${JSON.stringify(words)};`)!;
  expect(model.groupOrder.map(id => model.groups.get(id)!.segmentIds.length)).toEqual([2, 3]);
});
test("duplicate, missing, mismatching and reordered DOM identities reject the model", () => {
  for (const ids of [["a", "a", "c"], ["a", "", "c"], ["a", "b", "other"], ["b", "a", "c"]]) {
    const scope = fixture(); [...scope.querySelectorAll(".word")].forEach((word, i) => word.id = ids[i]);
    expect(parse(scope)).toBeNull();
  }
  expect(parse(fixture(), `const TRANSCRIPT=${JSON.stringify([entries[0], entries[0], entries[2]])};`)).toBeNull();
});
test("legacy no-id DOM requires exact text and timing in real order", () => {
  const scope = fixture();
  [...scope.querySelectorAll<HTMLElement>(".word")].forEach((word, i) => { word.removeAttribute("id"); word.dataset.start = String(entries[i].start); word.dataset.end = String(entries[i].end); });
  expect(parse(scope)).not.toBeNull();
  scope.querySelector<HTMLElement>(".word")!.dataset.end = "9";
  expect(parse(scope)).toBeNull();
});
test("verified runtime full-composition autostamps are not authored word start times", () => {
  const scope = fixture();
  for (const word of scope.querySelectorAll<HTMLElement>(".word")) {
    word.dataset.start = "0"; word.dataset.duration = "4"; word.dataset.hfAutostamped = "1";
  }
  expect(parse(scope)).not.toBeNull();
  scope.querySelectorAll<HTMLElement>(".word")[1].dataset.start = "0.5";
  expect(parse(scope)).toBeNull();
});
test("unmarked, malformed and no-ID stamps do not bypass timing validation", () => {
  for (const kind of ["unmarked", "duration", "authored-end", "no-id"]) {
    const scope = fixture();
    for (const word of scope.querySelectorAll<HTMLElement>(".word")) {
      word.dataset.start = "0"; word.dataset.duration = "4"; word.dataset.hfAutostamped = "1";
      if (kind === "unmarked") word.removeAttribute("data-hf-autostamped");
      if (kind === "duration") word.dataset.duration = "99";
      if (kind === "authored-end") word.dataset.end = "99";
      if (kind === "no-id") word.removeAttribute("id");
    }
    expect(parse(scope)).toBeNull();
  }
});
test("orphan and nested groups reject rather than guessing ownership", () => {
  const scope = fixture(); scope.append(scope.querySelector(".word")!); expect(parse(scope)).toBeNull();
  const nested = fixture(); nested.querySelector(".caption-group")!.append(nested.querySelectorAll(".caption-group")[1]); expect(parse(nested)).toBeNull();
});
