// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClipboard, isEditListManagedClipboardHtml } from "./useClipboard";
import { usePlayerStore } from "../player";
import type { DomEditSelection } from "../components/editor/domEditing";
import type { ClipboardPayload } from "../utils/clipboardPayload";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Seed a pre-upgrade internal clipboard. No production setter or system-HTML inlet is added.
const legacy = vi.hoisted(() => ({ payload: null as ClipboardPayload | null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useRef: (initial: unknown) => {
    const ref = actual.useRef(initial);
    if (initial === null && legacy.payload) { ref.current = legacy.payload; legacy.payload = null; }
    return ref;
  } };
});
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterEach(() => { usePlayerStore.getState().reset(); document.body.replaceChildren(); vi.unstubAllGlobals(); legacy.payload = null; });

function mount(html: string, selectionId = "selected") {
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  iframe.contentDocument!.body.innerHTML = html;
  const writes = vi.fn(async (_path: string, _content: string) => {});
  const deleteDom = vi.fn(async () => {});
  const toast = vi.fn();
  let hook: ReturnType<typeof useClipboard>;
  function Probe() {
    hook = useClipboard({ projectId: "fixture", activeCompPath: "index.html",
      domEditSelectionRef: { current: { id: selectionId, selector: `#${selectionId}` } as DomEditSelection },
      previewIframeRef: { current: iframe }, showToast: toast, writeProjectFile: writes,
      recordEdit: vi.fn(async () => {}), domEditSaveTimestampRef: { current: 0 }, reloadPreview: vi.fn(),
      handleTimelineElementDelete: vi.fn(async () => {}), handleDomEditElementDelete: deleteDom });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  return { hook: hook!, writes, deleteDom, toast, close: () => act(() => root.unmount()) };
}

describe("managed DOM clipboard boundaries", () => {
  it.each([
    '<div id="selected" data-edl-segment-id="renamed"></div>',
    '<div id="selected"><video data-videocut-edl-backing></video></div>',
    '<div data-edl-segment-id="x"><span id="selected">child</span></div>',
    '<main id="selected" data-videocut-projection-schema="1"><div>project</div></main>',
    '<div id="selected"><template><div data-edl-segment-id="x"></div></template></div>',
    '<div id="selected"><!-- chengfeng-videocut:a-roll:start --><video></video></div>',
    '<div id="selected"><script data-chengfeng-videocut-edl-payload="1">{}</script></div>',
  ])("rejects copy/cut of managed root, ancestor or descendant: %s", async (html) => {
    const fixture = mount(html);
    try {
      expect(fixture.hook.handleCopy()).toBe(false);
      expect(await fixture.hook.handleCut()).toBe(false);
      expect(fixture.deleteDom).not.toHaveBeenCalled();
      expect(fixture.writes).not.toHaveBeenCalled();
    } finally { fixture.close(); }
  });

  it("rejects a stale nested managed payload before fetching or deduplicating IDs", async () => {
    legacy.payload = { kind: "dom-element", sourceFile: "old-project.html", html: '<section id="renamed"><div data-edl-segment-id="x"></div></section>' };
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const fixture = mount('<div id="selected">ordinary</div>');
    try {
      await fixture.hook.handlePaste();
      expect(fetch).not.toHaveBeenCalled();
      expect(fixture.writes).not.toHaveBeenCalled();
      expect(fixture.toast).toHaveBeenCalledWith(expect.stringContaining("cannot be pasted"), "info");
    } finally { fixture.close(); }
  });

  it("blocks a timeline wrapper with managed descendants even without an adapter", () => {
    const fixture = mount('<div id="selected"><video data-edl-segment-id="x"></video></div>');
    usePlayerStore.getState().setElements([{ id: "selected", domId: "selected", tag: "div", start: 0, duration: 1, track: 0 }]);
    usePlayerStore.getState().setSelectedElementId("selected");
    try { expect(fixture.hook.handleCopy()).toBe(false); } finally { fixture.close(); }
  });

  it("keeps ordinary DOM HTML copy/paste usable", async () => {
    const html = '<main data-composition-id="main" data-videocut-projection-schema="1"><div id="selected"><video src="ordinary.mp4"></video></div></main>';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: html }))));
    const fixture = mount(html);
    try {
      const directory = await mkdtemp(join(tmpdir(), "studio-clipboard-"));
      const path = join(directory, "index.html");
      await writeFile(path, html);
      fixture.writes.mockImplementation(async (_path, content) => { await writeFile(path, content); });
      expect(fixture.hook.handleCopy()).toBe(true);
      await fixture.hook.handlePaste();
      expect(fixture.writes).toHaveBeenCalledOnce();
      const saved = String(fixture.writes.mock.calls[0]?.[1]);
      expect(saved.match(/ordinary.mp4/g)).toHaveLength(2);
      expect(await readFile(path, "utf8")).toBe(saved);
      expect(isEditListManagedClipboardHtml('<video src="ordinary.mp4"></video>')).toBe(false);
    } finally { fixture.close(); }
  });
});
