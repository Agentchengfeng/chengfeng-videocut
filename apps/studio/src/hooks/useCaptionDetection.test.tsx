// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useCaptionDetection } from "./useCaptionDetection";
import { useCaptionProjectIsolation } from "./useCaptionProjectIsolation";
import { useCaptionStore } from "../captions/store";
import { resolveCaptionSource } from "./captionSourceResolver";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => { vi.unstubAllGlobals(); useCaptionStore.getState().reset(); });
test("project isolation and real detection reject an old project's late caption response", async () => {
  const resolvers: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(yes => resolvers.push(yes))));
  const host = document.createElement("div"), iframe = document.createElement("iframe");
  document.body.append(host, iframe);
  iframe.contentDocument!.body.innerHTML = '<main data-composition-id="captions" data-width="1920" data-height="1080" data-duration="3"><div class="caption-group"><span class="word" data-start="0" data-end="1">new</span></div></main>';
  const previewIframeRef = createRef<HTMLIFrameElement>(); previewIframeRef.current = iframe;
  const map = new Map([["captions", "captions.html"]]);
  const first = { save: vi.fn(async () => {}), loadOverrides: vi.fn(async () => {}) };
  const second = { save: vi.fn(async () => {}), loadOverrides: vi.fn(async () => {}) };
  const collapse = vi.fn();
  function Harness({ pid }: { pid: string }) {
    useCaptionProjectIsolation(pid);
    useCaptionDetection({ projectId: pid, activeCompPath: "captions.html", compIdToSrc: map,
      captionEditMode: false, captionHasSelection: false, previewIframeRef, captionSync: pid === "a" ? first : second, setRightCollapsed: collapse });
    return null;
  }
  const root = createRoot(host);
  try {
    act(() => root.render(<Harness pid="a" />));
    act(() => root.render(<Harness pid="b" />));
    expect(resolvers).toHaveLength(2);
    await act(async () => resolvers[0](Response.json({ content: 'const TRANSCRIPT = [{text:"old",start:0,end:1}];' })));
    expect(useCaptionStore.getState().model).toBeNull(); expect(first.loadOverrides).not.toHaveBeenCalled();
    const content = 'const TRANSCRIPT = [{text:"new",start:0,end:1}];';
    await act(async () => resolvers[1](Response.json({ content })));
    expect(useCaptionStore.getState().model?.segments.get("segment-0")?.text).toBe("new");
    expect(second.loadOverrides).toHaveBeenCalledWith(content);
  } finally { act(() => root.unmount()); host.remove(); iframe.remove(); }
});

const composition = (id: string) => `<main data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="3"><div class="caption-group"><span class="word" id="w1">${id}</span></div></main>`;
const captionSource = (text: string) => `const TRANSCRIPT = [{id:"w1",text:${JSON.stringify(text)},start:0,end:1}];`;

function mountDetection(html: string, map: Map<string, string>, active: string | null) {
  const host = document.createElement("div"), iframe = document.createElement("iframe");
  document.body.append(host, iframe); iframe.contentDocument!.body.innerHTML = html;
  const previewIframeRef = createRef<HTMLIFrameElement>(); previewIframeRef.current = iframe;
  const sync = { save: vi.fn(async () => {}), loadOverrides: vi.fn(async () => {}) };
  const onError = vi.fn(), collapse = vi.fn();
  function Harness({ path }: { path: string | null }) {
    useCaptionDetection({ projectId: "test", activeCompPath: path, compIdToSrc: map, captionEditMode: false,
      captionHasSelection: false, previewIframeRef, captionSync: sync, setRightCollapsed: collapse, onError });
    return null;
  }
  const root = createRoot(host);
  const render = (path: string | null) => act(() => root.render(<Harness path={path} />));
  render(active);
  return { iframe, previewIframeRef, onError, sync, render, dispose: () => { act(() => root.unmount()); host.remove(); iframe.remove(); } };
}

test("multiple caption sources reject even with explicit active source until shown alone", async () => {
  const fetchMock = vi.fn(async () => Response.json({ content: captionSource("b") })); vi.stubGlobal("fetch", fetchMock);
  const h = mountDetection(composition("a") + composition("b"), new Map([["a", "captions-a.html"], ["b", "captions-b.html"]]), null);
  try {
    expect(fetchMock).not.toHaveBeenCalled(); expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("唯一"));
    await act(async () => h.render("captions-b.html"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining("独立字幕画面"));
    expect(useCaptionStore.getState().isEditMode).toBe(false);
    h.iframe.contentDocument!.body.innerHTML = composition("b");
    h.render(null);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("captions-b.html"));
    expect(useCaptionStore.getState().sourceFilePath).toBe("captions-b.html");
    expect(useCaptionStore.getState().model?.segments.get("segment-0")?.text).toBe("b");
  } finally { h.dispose(); }
});

test.each([404, 500])("HTTP %s failure is visible and does not activate editing", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("error", { status })));
  const h = mountDetection(composition("a"), new Map([["a", "captions-a.html"]]), "captions-a.html");
  try {
    await act(async () => {});
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining(String(status)));
    expect(useCaptionStore.getState().isEditMode).toBe(false); expect(h.sync.loadOverrides).not.toHaveBeenCalled();
  } finally { h.dispose(); }
});

test("malformed or mismatched source is visible instead of creating a model", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: captionSource("wrong") })));
  const h = mountDetection(composition("a"), new Map([["a", "captions-a.html"]]), "captions-a.html");
  try { await act(async () => {}); expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("无法对应")); expect(useCaptionStore.getState().model).toBeNull(); }
  finally { h.dispose(); }
});

test("same-project source switch disables editing and retains old draft until return", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: captionSource("a") })));
  const h = mountDetection(composition("a"), new Map([["a", "captions-a.html"], ["b", "captions-b.html"]]), "captions-a.html");
  try {
    await act(async () => {});
    act(() => useCaptionStore.getState().updateSegmentTiming("segment-0", 0.2, 1.2));
    const draft = useCaptionStore.getState().model;
    h.iframe.contentDocument!.body.innerHTML = composition("b");
    h.render("captions-b.html");
    expect(useCaptionStore.getState().isEditMode).toBe(false);
    expect(useCaptionStore.getState().model).toBe(draft);
    expect(useCaptionStore.getState().sourceFilePath).toBe("captions-a.html");
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining("已保留原字幕草稿"));
    h.iframe.contentDocument!.body.innerHTML = composition("a");
    h.render("captions-a.html");
    await act(async () => {});
    expect(useCaptionStore.getState().isEditMode).toBe(true);
    expect(useCaptionStore.getState().model).toBe(draft);
    expect(h.sync.loadOverrides).toHaveBeenCalledTimes(1);
  } finally { h.dispose(); }
});

test.each(["changed-source", "changed-dom", "http-failure"])("same-path reload rejects %s and retains the existing draft", async kind => {
  const original = captionSource("a");
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({content: original}))
    .mockResolvedValueOnce(kind === "http-failure" ? new Response("error", {status:500})
      : Response.json({content: kind === "changed-source" ? original + "\n// updated" : original}));
  vi.stubGlobal("fetch", fetchMock);
  const h = mountDetection(composition("a"),new Map([["a","captions-a.html"]]),"captions-a.html");
  const replacement = document.createElement("iframe"); document.body.append(replacement);
  try {
    await act(async () => {});
    act(() => useCaptionStore.getState().updateSegmentTiming("segment-0",0.2,1.2));
    const draft = useCaptionStore.getState().model;
    replacement.contentDocument!.body.innerHTML = composition("a");
    if(kind === "changed-dom") replacement.contentDocument!.querySelector(".word")!.textContent="different";
    h.previewIframeRef.current=replacement;
    await act(async () => window.dispatchEvent(new MessageEvent("message",{data:{source:"hf-preview",type:"state"}})));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useCaptionStore.getState().isEditMode).toBe(false);
    expect(useCaptionStore.getState().model).toBe(draft);
    expect(h.onError).toHaveBeenCalled();
    expect(h.sync.loadOverrides).toHaveBeenCalledTimes(1);
  } finally { h.dispose(); replacement.remove(); }
});

test("unchanged same-path reload revalidates once without replacing the edited draft",async()=>{
  const fetchMock=vi.fn(async()=>Response.json({content:captionSource("a")}));vi.stubGlobal("fetch",fetchMock);
  const h=mountDetection(composition("a"),new Map([["a","captions-a.html"]]),"captions-a.html");
  const replacement=document.createElement("iframe");document.body.append(replacement);
  try {
    await act(async()=>{});
    act(()=>useCaptionStore.getState().updateSegmentTiming("segment-0",0.2,1.2));
    const draft=useCaptionStore.getState().model;
    replacement.contentDocument!.body.innerHTML=composition("a");h.previewIframeRef.current=replacement;
    const tick=()=>window.dispatchEvent(new MessageEvent("message",{data:{source:"hf-preview",type:"state"}}));
    await act(async()=>tick()); await act(async()=>tick());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useCaptionStore.getState().isEditMode).toBe(true);
    expect(useCaptionStore.getState().model).toBe(draft);
    expect(h.sync.loadOverrides).toHaveBeenCalledTimes(1);
    expect(h.onError).not.toHaveBeenCalled();
  } finally {h.dispose();replacement.remove();}
});

test("a late revalidation response cannot reopen editing after switching sources",async()=>{
  let complete!: (value: Response)=>void;
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json({content:captionSource("a")}))
    .mockImplementationOnce(()=>new Promise<Response>(resolve=>{complete=resolve;})));
  const h=mountDetection(composition("a"),new Map([["a","captions-a.html"],["b","captions-b.html"]]),"captions-a.html");
  const replacement=document.createElement("iframe");document.body.append(replacement);
  try {
    await act(async()=>{});const draft=useCaptionStore.getState().model;
    replacement.contentDocument!.body.innerHTML=composition("a");h.previewIframeRef.current=replacement;
    act(()=>window.dispatchEvent(new MessageEvent("message",{data:{source:"hf-preview",type:"state"}})));
    expect(useCaptionStore.getState().isEditMode).toBe(false);
    replacement.contentDocument!.body.innerHTML=composition("b");h.render("captions-b.html");
    await act(async()=>complete(Response.json({content:captionSource("a")})));
    expect(useCaptionStore.getState().isEditMode).toBe(false);
    expect(useCaptionStore.getState().model).toBe(draft);
    expect(useCaptionStore.getState().sourceFilePath).toBe("captions-a.html");
    expect(h.sync.loadOverrides).toHaveBeenCalledTimes(1);
  } finally {h.dispose();replacement.remove();}
});

test("duplicate instances and parent scopes containing other sources are rejected", () => {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = composition("a") + composition("a");
  expect(() => resolveCaptionSource(doc, "a.html", new Map([["a", "a.html"]]))).toThrow("多个");
  doc.body.innerHTML = `<main data-composition-id="root">${composition("a")}${composition("b")}</main>`;
  expect(() => resolveCaptionSource(doc, "index.html", new Map([["root", "index.html"], ["a", "a.html"], ["b", "b.html"]]))).toThrow("其他来源");
});
test("same failing context is bounded across rerenders; a new source context can retry", async () => {
  const fetchMock = vi.fn(async () => new Response("error", { status: 500 })); vi.stubGlobal("fetch", fetchMock);
  const map = new Map([["a", "captions-a.html"], ["b", "captions-b.html"]]);
  const h = mountDetection(composition("a"), map, "captions-a.html");
  try {
    await act(async () => {}); h.render("captions-a.html"); await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(h.onError).toHaveBeenCalledTimes(1);
    h.iframe.contentDocument!.body.innerHTML = composition("b");
    await act(async () => h.render("captions-b.html"));
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(h.onError).toHaveBeenCalledTimes(2);
  } finally { h.dispose(); }
});
test("a new iframe document at the same path retries after an earlier failure", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response("error", { status: 500 }))
    .mockResolvedValueOnce(Response.json({ content: captionSource("a") }));
  vi.stubGlobal("fetch", fetchMock);
  const h = mountDetection(composition("a"), new Map([["a", "captions-a.html"]]), "captions-a.html");
  const replacement = document.createElement("iframe"); document.body.append(replacement);
  try {
    await act(async () => {}); expect(h.onError).toHaveBeenCalledTimes(1);
    replacement.contentDocument!.body.innerHTML = composition("a");
    h.previewIframeRef.current = replacement;
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data: { source: "hf-preview", type: "state" } })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useCaptionStore.getState().isEditMode).toBe(true);
    expect(h.onError).toHaveBeenCalledTimes(1);
  } finally { h.dispose(); replacement.remove(); }
});
test("loader host duration survives its same-source inner root metadata stripping", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: captionSource("a") })));
  const html = '<main data-composition-id="master" data-duration="99"><section data-composition-file="captions-a.html" data-duration="5"><main data-composition-id="a" data-hf-inner-root="true" data-width="720" data-height="1280"><div class="caption-group"><span class="word" id="w1">a</span></div></main></section></main>';
  const h = mountDetection(html, new Map([["master", "index.html"], ["a", "captions-a.html"]]), "captions-a.html");
  try {
    await act(async () => {});
    expect(h.onError).not.toHaveBeenCalled();
    expect(useCaptionStore.getState().model).toMatchObject({ width: 720, height: 1280, duration: 5 });
    expect(useCaptionStore.getState().isEditMode).toBe(true);
  } finally { h.dispose(); }
});
test("unrelated ancestor duration is never borrowed for an inner caption root", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ content: captionSource("a") })));
  const html = '<main data-composition-id="master" data-duration="99"><section><main data-composition-id="a" data-hf-inner-root="true" data-width="720" data-height="1280"><div class="caption-group"><span class="word" id="w1">a</span></div></main></section></main>';
  const h = mountDetection(html, new Map([["master", "index.html"], ["a", "captions-a.html"]]), "captions-a.html");
  try {
    await act(async () => {});
    expect(h.onError).toHaveBeenCalled();
    expect(useCaptionStore.getState().model).toBeNull();
  } finally { h.dispose(); }
});
test("duplicate errors across new documents notify once, and success resets notification dedupe", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response("error", { status: 500 }))
    .mockResolvedValueOnce(new Response("error", { status: 500 }))
    .mockResolvedValueOnce(Response.json({ content: captionSource("a") }))
    .mockResolvedValueOnce(new Response("error", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  const h = mountDetection(composition("a"), new Map([["a", "captions-a.html"]]), "captions-a.html");
  const replacements: HTMLIFrameElement[] = [];
  const reload = async () => {
    const iframe = document.createElement("iframe"); document.body.append(iframe); replacements.push(iframe);
    iframe.contentDocument!.body.innerHTML = composition("a"); h.previewIframeRef.current = iframe;
    await act(async () => window.dispatchEvent(new MessageEvent("message", { data: { source: "hf-preview", type: "state" } })));
  };
  try {
    await act(async () => {}); expect(h.onError).toHaveBeenCalledTimes(1);
    await reload(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(h.onError).toHaveBeenCalledTimes(1);
    await reload(); expect(useCaptionStore.getState().isEditMode).toBe(true);
    act(() => useCaptionStore.getState().reset());
    await reload(); expect(fetchMock).toHaveBeenCalledTimes(4); expect(h.onError).toHaveBeenCalledTimes(2);
  } finally { h.dispose(); replacements.forEach(iframe => iframe.remove()); }
});
