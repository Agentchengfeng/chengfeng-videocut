// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SUBTITLE_STYLE, type SubtitleDocument } from "@video-workbench/core";
import type { SkillResultState } from "@video-workbench/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSubtitles, type ProjectSubtitles } from "./useProjectSubtitles";
import { SubtitlesApiError, type SubtitleResource } from "./subtitlesApi";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
}));
vi.mock("./subtitlesApi", async (importOriginal) => ({
  ...await importOriginal<typeof import("./subtitlesApi")>(),
  getProjectSubtitles: mocks.get,
  putProjectSubtitles: mocks.put,
}));
vi.mock("../product/projectEvents", () => ({
  subscribeProjectFileChanges: (listener: (payload: unknown) => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
let current: ProjectSubtitles;

function documentFixture(text = "原始显示字", projectId = "p"): SubtitleDocument {
  return {
    schemaVersion: 1, projectId, baseTranscriptRevision: "b".repeat(64),
    style: DEFAULT_SUBTITLE_STYLE,
    cues: [{ id: "sub-1", wordIds: ["w-1", "w-2"], text }],
  };
}
function state(revision: string): SkillResultState {
  return {
    schemaVersion: 1, kind: "subtitles", revision, status: "current", sourceStale: false,
    changedSources: [], sources: { transcriptSha256: "b".repeat(64), editListSha256: "c".repeat(64) },
    provenance: { generator: "test-skill" }, acceptedAt: "2026-09-05T01:00:00.000Z",
    review: { editCount: 0, noteCount: 0, lastReviewedAt: null },
  };
}
function resource(text = "原始显示字", revision = "a".repeat(64), projectId = "p"): SubtitleResource {
  return {
    schemaVersion: 1, projectId, exists: true, revision,
    document: documentFixture(text, projectId), timings: [], stale: [],
    transcriptRevision: "b".repeat(64), resultState: state(revision),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Harness({ projectId }: { projectId: string }) {
  current = useProjectSubtitles(projectId);
  return <div>{current.document?.cues[0]?.text}</div>;
}
async function render(projectId = "p") {
  if (!root) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => { root!.render(<Harness projectId={projectId} />); });
}
async function advance(ms = 600) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function type(text: string) {
  await act(async () => { current.setCueText("sub-1", text); });
}
async function immediate(text: string) {
  await act(async () => { current.save(documentFixture(text, current.projectId), { immediate: true }); });
}
async function change(path = "subtitles.json", projectId = "p") {
  await act(async () => {
    for (const listener of mocks.listeners) listener({ projectId, path });
  });
}
function unloadIsBlocked() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.get.mockReset().mockImplementation(async (projectId: string) => resource("原始显示字", "a".repeat(64), projectId));
  mocks.put.mockReset();
  mocks.listeners.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("useProjectSubtitles draft and version safety", () => {
  it("exposes result provenance and saves settled text against the displayed revision", async () => {
    await render();
    expect(current.resultState).toEqual(state("a".repeat(64)));
    mocks.put.mockResolvedValue(resource("人工显示字", "d".repeat(64)));
    await type("人工显示字");
    expect(current.saveState).toBe("saving");
    await advance(599);
    expect(mocks.put).not.toHaveBeenCalled();
    await advance(1);
    expect(mocks.put).toHaveBeenCalledWith("p", "a".repeat(64), documentFixture("人工显示字"), undefined);
    expect(current.document?.cues[0]?.text).toBe("人工显示字");
    expect(current.revision).toBe("d".repeat(64));
    expect(current.saveState).toBe("saved");
  });

  it("does not replace newer typing with a slow save response before the next debounce fires", async () => {
    const first = deferred<SubtitleResource>();
    mocks.put.mockReturnValueOnce(first.promise).mockResolvedValueOnce(resource("甲乙", "e".repeat(64)));
    await render();
    await type("甲");
    await advance();
    await type("甲乙");
    await act(async () => first.resolve(resource("甲", "d".repeat(64))));
    expect(current.document?.cues[0]?.text).toBe("甲乙");
    expect(current.saveState).toBe("saving");
    expect(unloadIsBlocked()).toBe(true);
    await advance();
    expect(mocks.put.mock.calls[1]).toEqual(["p", "d".repeat(64), documentFixture("甲乙"), undefined]);
    expect(current.document?.cues[0]?.text).toBe("甲乙");
    expect(current.saveState).toBe("saved");
  });

  it("keeps immediate saves serialized while newer drafts remain visible", async () => {
    const first = deferred<SubtitleResource>();
    const second = deferred<SubtitleResource>();
    mocks.put.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await immediate("第一个");
    await immediate("第二个");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(resource("第一个", "d".repeat(64))));
    expect(current.document?.cues[0]?.text).toBe("第二个");
    expect(mocks.put.mock.calls[1]?.[1]).toBe("d".repeat(64));
    await act(async () => second.resolve(resource("第二个", "e".repeat(64))));
    expect(current.saveState).toBe("saved");
  });

  it("defers watcher reloads during debounce and refreshes source status once the draft is saved", async () => {
    await render();
    await type("还在输入");
    await change("edit-list.json");
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(current.document?.cues[0]?.text).toBe("还在输入");
    const saved = resource("还在输入", "d".repeat(64));
    saved.resultState = { ...state(saved.revision), status: "stale", sourceStale: true, changedSources: ["edit-list"] };
    mocks.put.mockResolvedValue(saved);
    mocks.get.mockResolvedValue(saved);
    await advance();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(current.resultState?.changedSources).toEqual(["edit-list"]);
  });

  it("does not apply a watcher GET which began before local typing", async () => {
    await render();
    const watching = deferred<SubtitleResource>();
    mocks.get.mockReturnValueOnce(watching.promise);
    await change();
    await type("本地草稿");
    await act(async () => watching.resolve(resource("外部文字", "d".repeat(64))));
    expect(current.document?.cues[0]?.text).toBe("本地草稿");
    expect(current.revision).toBe("a".repeat(64));
  });

  it("pauses after conflict, preserves the newest draft, and never rebases queued writes", async () => {
    const first = deferred<SubtitleResource>();
    mocks.put.mockReturnValueOnce(first.promise);
    await render();
    await immediate("旧排队稿");
    await immediate("最新草稿");
    await act(async () => first.reject(new SubtitlesApiError("另一处已更新", { status: 409, code: "revision_conflict" })));
    expect(current.saveState).toBe("conflict");
    expect(current.document?.cues[0]?.text).toBe("最新草稿");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
    await change();
    await type("冲突后仍可复制的草稿");
    await advance(1500);
    expect(current.document?.cues[0]?.text).toBe("冲突后仍可复制的草稿");
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(unloadIsBlocked()).toBe(true);
    mocks.get.mockResolvedValueOnce(resource("明确重读外部版本", "e".repeat(64)));
    await act(async () => current.reload());
    expect(current.document?.cues[0]?.text).toBe("明确重读外部版本");
    expect(current.saveState).toBe("idle");
    expect(unloadIsBlocked()).toBe(false);
    mocks.put.mockResolvedValueOnce(resource("重读后编辑", "f".repeat(64)));
    await immediate("重读后编辑");
    expect(mocks.put.mock.calls[1]?.[1]).toBe("e".repeat(64));
  });

  it("also pauses on uncertain network failure without silently retrying a whole document", async () => {
    mocks.put.mockRejectedValueOnce(new SubtitlesApiError("离线", { status: 0, code: "service_unavailable" }));
    await render();
    await immediate("待确认是否送达的文字");
    expect(current.saveState).toBe("error");
    expect(current.document?.cues[0]?.text).toBe("待确认是否送达的文字");
    await type("继续保留但不重试");
    await advance(1000);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(unloadIsBlocked()).toBe(true);
  });

  it("does not let old project saves or queued writes affect the new project", async () => {
    const old = deferred<SubtitleResource>();
    mocks.put.mockReturnValueOnce(old.promise);
    await render("p");
    await immediate("旧项目发送中");
    await immediate("旧项目未发送");
    await render("other");
    expect(current.projectId).toBe("other");
    await act(async () => old.resolve(resource("旧项目发送中", "d".repeat(64), "p")));
    expect(current.document?.projectId).toBe("other");
    expect(current.document?.cues[0]?.text).toBe("原始显示字");
    expect(current.revision).toBe("a".repeat(64));
    expect(current.saveState).toBe("idle");
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("ignores an old project's delayed initial read", async () => {
    const old = deferred<SubtitleResource>();
    mocks.get.mockReturnValueOnce(old.promise);
    await render("p");
    await render("other");
    await act(async () => old.resolve(resource("旧项目", "d".repeat(64), "p")));
    expect(current.document?.projectId).toBe("other");
    expect(current.ready).toBe(true);
  });

  it("warns before unload while debouncing or saving, and clears the warning only after acknowledgement", async () => {
    const saving = deferred<SubtitleResource>();
    mocks.put.mockReturnValueOnce(saving.promise);
    await render();
    expect(unloadIsBlocked()).toBe(false);
    await type("未保存");
    expect(unloadIsBlocked()).toBe(true);
    await advance();
    expect(unloadIsBlocked()).toBe(true);
    await act(async () => saving.resolve(resource("未保存", "d".repeat(64))));
    expect(unloadIsBlocked()).toBe(false);
  });

  it("submits an explicit review note together with the latest local text and exposes the acknowledgement", async () => {
    const acknowledged = resource("本地修正", "d".repeat(64));
    acknowledged.resultState = { ...state(acknowledged.revision), review: { editCount: 1, noteCount: 1, lastReviewedAt: "2026-09-05T02:00:00.000Z" } };
    mocks.put.mockResolvedValueOnce(acknowledged);
    await render();
    await type("本地修正");
    await act(async () => current.addReviewNote?.("  保留这个专名  "));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledWith("p", "a".repeat(64), documentFixture("本地修正"), "保留这个专名");
    expect(current.resultState?.review.noteCount).toBe(1);
    await advance();
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it("explicit discard waits for in-flight writes and skips queued drafts before reading the server", async () => {
    const saving = deferred<SubtitleResource>();
    mocks.put.mockReturnValueOnce(saving.promise);
    await render();
    await immediate("已开始发送");
    await immediate("尚未发送");
    let reload!: Promise<void>;
    await act(async () => { reload = current.reload(); });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValueOnce(resource("已开始发送", "d".repeat(64)));
    await act(async () => {
      saving.resolve(resource("已开始发送", "d".repeat(64)));
      await reload;
    });
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(current.document?.cues[0]?.text).toBe("已开始发送");
    expect(current.saveState).toBe("idle");
    expect(unloadIsBlocked()).toBe(false);
  });

  it("exposes a failed explicit reload as paused and retains the draft until readback succeeds", async () => {
    await render();
    await type("需要保留的草稿");
    mocks.get.mockRejectedValueOnce(new Error("重读失败"));
    await act(async () => current.reload());
    expect(current.saveState).toBe("error");
    expect(current.error).toBe("重读失败");
    expect(current.loading).toBe(false);
    expect(current.document?.cues[0]?.text).toBe("需要保留的草稿");
    await type("仍是本地草稿");
    await advance();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(unloadIsBlocked()).toBe(true);
    await act(async () => current.reload());
    expect(current.saveState).toBe("idle");
    expect(unloadIsBlocked()).toBe(false);
  });
});
