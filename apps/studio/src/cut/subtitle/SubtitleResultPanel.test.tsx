// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SUBTITLE_STYLE } from "@video-workbench/core";
import type { ProjectSubtitles } from "../../components/useProjectSubtitles";
import { SubtitleResultPanel } from "./SubtitleResultPanel";
import { SubtitlePane } from "./SubtitlePane";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function fixture(overrides: Partial<ProjectSubtitles> = {}): ProjectSubtitles {
  return {
    projectId: "p", revision: "a".repeat(64), saveState: "idle", loading: false, ready: true,
    document: { schemaVersion: 1, projectId: "p", baseTranscriptRevision: "b".repeat(64),
      cues: [{ id: "sub-1", wordIds: ["w-1"], text: "字幕" }], style: DEFAULT_SUBTITLE_STYLE },
    timings: [], stale: [], error: null,
    addReviewNote: vi.fn(), reload: vi.fn(async () => undefined), save: vi.fn(), setCueText: vi.fn(),
    setStyle: vi.fn(), mergeWithPrevious: vi.fn(), splitAt: vi.fn(),
    resultState: { schemaVersion: 1, kind: "subtitles", revision: "a".repeat(64), status: "legacy",
      sourceStale: null, changedSources: [], sources: null, provenance: null, acceptedAt: null,
      review: { editCount: 0, noteCount: 0, lastReviewedAt: null } },
    ...overrides,
  };
}
function render(model: ProjectSubtitles, pane = false) {
  if (!root) {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  }
  act(() => root!.render(pane
    ? <SubtitlePane subtitles={model} transcriptCues={[]} selectedCueId={null} onSelectCue={vi.fn()} onSeek={vi.fn()} />
    : <SubtitleResultPanel subtitles={model} />));
}
function enterNote(text: string) {
  const input = host.querySelector<HTMLTextAreaElement>("#subtitle-review-note")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() {
  act(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
function unloadIsBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
function noteValue() { return host.querySelector<HTMLTextAreaElement>("#subtitle-review-note")!.value; }

it("keeps legacy review usable without technical provenance notices or claiming verified origin", () => {
  const model = fixture();
  render(model);
  expect(host.querySelector("summary")!.textContent).toBe("审核意见");
  expect(host.querySelector("details")!.dataset.status).toBe("legacy");
  expect(host.textContent).not.toContain("来源未记录");
  expect(host.textContent).not.toContain("不能证明");
  expect(host.textContent).not.toContain("来源版本已绑定");
  expect(host.textContent).toContain("意见不会自动改动画或字幕");
  expect(host.querySelector("button")!.disabled).toBe(true);
  enterNote("  保留专名修正  ");
  submit();
  expect(model.addReviewNote).toHaveBeenCalledWith("保留专名修正");
  expect(noteValue()).toBe("  保留专名修正  ");
});

it("reports timing source changes even without deleted words", () => {
  const model = fixture();
  model.resultState = { ...model.resultState!, status: "stale", sourceStale: true, changedSources: ["edit-list"],
    provenance: { generator: "subtitle-candidate" },
    sources: { transcriptSha256: "b".repeat(64), editListSha256: "c".repeat(64) },
    review: { editCount: 2, noteCount: 1, lastReviewedAt: null } };
  render(model);
  expect(host.querySelector("summary")!.textContent).toContain("剪辑时间线已变更");
  expect(host.textContent).toContain("2 次审核修改、1 条意见");
});

it.each([
  { loading: true }, { saveState: "saving" as const }, { saveState: "conflict" as const }, { saveState: "error" as const },
])("blocks review submission while editor is unavailable: %s", (overrides) => {
  const model = fixture(overrides);
  render(model);
  enterNote("不要丢掉这条意见");
  expect(host.querySelector("button")!.disabled).toBe(true);
  submit();
  expect(model.addReviewNote).not.toHaveBeenCalled();
  expect(noteValue()).toBe("不要丢掉这条意见");
});

it("warns for unsaved notes until acknowledgement, and prevents duplicate pending submission", () => {
  const model = fixture(); render(model);
  expect(unloadIsBlocked()).toBe(false);
  enterNote("保留人工修正");
  expect(unloadIsBlocked()).toBe(true);
  submit(); submit();
  expect(model.addReviewNote).toHaveBeenCalledTimes(1);
  render({ ...model, saveState: "saving" });
  expect(unloadIsBlocked()).toBe(true);
  render({ ...model, saveState: "saved", revision: "d".repeat(64) });
  expect(noteValue()).toBe("");
  expect(unloadIsBlocked()).toBe(false);
});

it("retains newly typed notes when an earlier submission is acknowledged", () => {
  const model = fixture(); render(model);
  enterNote("第一条意见"); submit();
  render({ ...model, saveState: "saving" });
  enterNote("第二条未提交意见");
  render({ ...model, saveState: "saved", revision: "d".repeat(64) });
  expect(noteValue()).toBe("第二条未提交意见");
  expect(unloadIsBlocked()).toBe(true);
});

it.each(["error", "conflict"] as const)("retains a failed note after unrelated later save: %s", (saveState) => {
  const model = fixture(); render(model);
  enterNote("失败后不能误清除"); submit();
  render({ ...model, saveState });
  render({ ...model, saveState: "saved", revision: "d".repeat(64) });
  expect(noteValue()).toBe("失败后不能误清除");
  expect(unloadIsBlocked()).toBe(true);
});

it.each(["error", "conflict"] as const)("states that autosave is paused and asks before discarding text and notes: %s", (saveState) => {
  const model = fixture({ saveState, error: "测试保存失败" }); render(model, true);
  expect(host.textContent).toContain("自动保存已暂停，本地草稿已保留");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const discard = [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("放弃本地草稿"))!;
  act(() => discard.click());
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("字幕草稿和审核意见"));
  expect(model.reload).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  act(() => discard.click());
  expect(model.reload).toHaveBeenCalledTimes(1);
});
