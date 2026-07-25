/**
 * Runtime iframe integration utilities.
 *
 * Handles the boundary between the studio host page and the preview iframe:
 * - Viewport normalisation on load
 * - Auto-healing missing data-composition-id attributes
 * - Unmuting media via postMessage
 * - Resolving the underlying <iframe> from any wrapper element
 * - Scanning the DOM for composition hosts the manifest missed
 *   (element-reference starts that the CDN runtime fails to resolve)
 */

import type { TimelineElement } from "../store/playerStore";
import type { IframeWindow } from "./playbackTypes";
import {
  getTimelineElementSelector,
  getTimelineElementSourceFile,
  getTimelineElementSelectorIndex,
  getTimelineElementDisplayLabel,
  buildTimelineElementIdentity,
  readTimelineElementZIndex,
} from "./timelineElementHelpers";
import { postRuntimeControlMessage } from "./runtimeProtocol";

// ---------------------------------------------------------------------------
// Viewport / DOM normalisation
// ---------------------------------------------------------------------------

export function normalizePreviewViewport(doc: Document, win: Window): void {
  if (doc.documentElement) {
    doc.documentElement.style.overflow = "hidden";
    doc.documentElement.style.margin = "0";
  }
  if (doc.body) {
    doc.body.style.overflow = "hidden";
    doc.body.style.margin = "0";
  }
  win.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

export function autoHealMissingCompositionIds(doc: Document): void {
  const compositionIdRe = /data-composition-id=["']([^"']+)["']/gi;
  const referencedIds = new Set<string>();
  const scopedNodes = Array.from(doc.querySelectorAll("style, script"));
  for (const node of scopedNodes) {
    const text = node.textContent || "";
    if (!text) continue;
    let match: RegExpExecArray | null;
    while ((match = compositionIdRe.exec(text)) !== null) {
      const id = (match[1] || "").trim();
      if (id) referencedIds.add(id);
    }
  }

  if (referencedIds.size === 0) return;

  const existingIds = new Set<string>();
  const existingNodes = Array.from(doc.querySelectorAll<HTMLElement>("[data-composition-id]"));
  for (const node of existingNodes) {
    const id = node.getAttribute("data-composition-id");
    if (id) existingIds.add(id);
  }

  for (const compId of referencedIds) {
    if (compId === "root" || existingIds.has(compId)) continue;
    const host =
      doc.getElementById(`${compId}-layer`) ||
      doc.getElementById(`${compId}-comp`) ||
      doc.getElementById(compId);
    if (!host) continue;
    if (!host.getAttribute("data-composition-id")) {
      host.setAttribute("data-composition-id", compId);
    }
  }
}

// ---------------------------------------------------------------------------
// Audio / iframe resolution
// ---------------------------------------------------------------------------

type PreviewPlayerHost = HTMLElement & {
  muted?: boolean;
  playbackRate?: number;
};

function isPreviewPlayerHost(value: unknown): value is PreviewPlayerHost {
  return value instanceof HTMLElement;
}

function resolvePreviewPlayerHost(iframe: HTMLIFrameElement): PreviewPlayerHost | null {
  const root = iframe.getRootNode();
  if (
    typeof ShadowRoot !== "undefined" &&
    root instanceof ShadowRoot &&
    isPreviewPlayerHost(root.host)
  ) {
    return root.host;
  }
  return null;
}

function postPreviewControl(
  iframe: HTMLIFrameElement,
  action: string,
  payload: Record<string, unknown>,
): void {
  postRuntimeControlMessage(iframe.contentWindow, action, payload);
}

export function shouldMutePreviewAudio(audioMuted: boolean, _playbackRate: number): boolean {
  return audioMuted;
}

export function setPreviewMediaMuted(iframe: HTMLIFrameElement | null, muted: boolean): void {
  if (!iframe) return;
  try {
    const host = resolvePreviewPlayerHost(iframe);
    if (host && typeof host.muted === "boolean") {
      host.muted = muted;
      return;
    }
    postPreviewControl(iframe, "set-muted", { muted });
  } catch {}
}

export function setPreviewPlaybackRate(
  iframe: HTMLIFrameElement | null,
  playbackRate: number,
): void {
  if (!iframe) return;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  try {
    const win = iframe.contentWindow as IframeWindow | null;
    const extensionAdapter = win?.__studioPlaybackAdapter as
      | { setPlaybackRate?: (rate: number) => void }
      | undefined;
    extensionAdapter?.setPlaybackRate?.(rate);
    const host = resolvePreviewPlayerHost(iframe);
    if (host && typeof host.playbackRate === "number") {
      host.playbackRate = rate;
      return;
    }
    postPreviewControl(iframe, "set-playback-rate", { playbackRate: rate });
  } catch {}
}

/**
 * Start a product EDL's parent-owned audio output from Studio's synchronous
 * user gesture. Calling play() in this parent realm is what avoids iframe
 * autoplay rejection; ordinary HyperFrames compositions simply return null.
 */
export function playPreviewEdlAudio(
  iframe: HTMLIFrameElement | null,
): Promise<void> | null {
  if (!iframe) return null;
  const audioId = iframe.getAttribute("data-videocut-edl-audio-id");
  const candidate = audioId ? iframe.ownerDocument.getElementById(audioId) : null;
  const audio = candidate as HTMLAudioElement | null;
  if (
    !audio ||
    audio.ownerDocument !== iframe.ownerDocument ||
    typeof audio.play !== "function"
  ) {
    iframe.setAttribute("data-videocut-edl-audio-play", "missing");
    return null;
  }
  const errorName = (error: unknown): string =>
    error && typeof error === "object" && "name" in error && typeof error.name === "string"
      ? error.name
      : "UnknownError";
  const requestedMuted = audio.muted;
  const markError = (error: unknown) => {
    iframe.setAttribute("data-videocut-edl-audio-play", `error:${errorName(error)}`);
  };
  const retryMuted = (error: unknown): Promise<void> => {
    if (errorName(error) === "NotAllowedError" && requestedMuted) {
      // Muted preview does not need a running audio clock. Let the visual EDL
      // continue instead of failing the whole transport on an inaudible node.
      iframe.setAttribute("data-videocut-edl-audio-play", "muted-skip");
      return Promise.resolve();
    }
    if (errorName(error) !== "NotAllowedError") {
      markError(error);
      return Promise.reject(error);
    }
    // Muted media is autoplay-safe even when the host forwards a synthetic or
    // delayed transport command without transient user activation. Restore the
    // requested audible state immediately after playback has started.
    audio.muted = true;
    iframe.setAttribute("data-videocut-edl-audio-play", "retry-muted");
    return Promise.resolve(audio.play()).then(
      () => {
        audio.muted = requestedMuted;
        iframe.setAttribute("data-videocut-edl-audio-play", "playing:muted-bootstrap");
      },
      (retryError: unknown) => {
        audio.muted = requestedMuted;
        markError(retryError);
        throw retryError;
      },
    );
  };
  try {
    const activation = iframe.ownerDocument.defaultView?.navigator.userActivation;
    iframe.setAttribute(
      "data-videocut-edl-user-activation",
      activation ? (activation.isActive ? "active" : "inactive") : "unknown",
    );
    iframe.setAttribute("data-videocut-edl-audio-play", "requested");
    return Promise.resolve(audio.play()).then(
      () => {
        iframe.setAttribute("data-videocut-edl-audio-play", "playing");
      },
      retryMuted,
    );
  } catch (error) {
    return retryMuted(error);
  }
}

const VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE = "data-videocut-edl-audio-id";
const VIDEOCUT_EDL_AUDIO_STATE_ATTRIBUTES = [
  "data-videocut-edl-audio-play",
  "data-videocut-edl-user-activation",
] as const;

function releasePreviewEdlAudioById(doc: Document, audioId: string | null): boolean {
  if (!audioId) return false;
  const candidate = doc.getElementById(audioId);
  if (!candidate || candidate.tagName.toLowerCase() !== "audio") return false;
  const audio = candidate as HTMLAudioElement;
  if (audio.ownerDocument !== doc) return false;

  // pause + clear the source + load is the browser-supported way to release
  // the media resource and its decoder. Removing only the DOM node can leave
  // the decoder alive until the detached element is garbage-collected.
  try {
    audio.pause();
  } catch {}
  try {
    if ("srcObject" in audio) audio.srcObject = null;
  } catch {}
  try {
    audio.removeAttribute("src");
    audio.load();
  } catch {}
  audio.remove();
  return true;
}

/**
 * Release the parent-owned audio associated with an EDL preview iframe.
 *
 * This is intentionally idempotent: the iframe runtime normally releases the
 * node on pagehide, while Studio calls the same cleanup when the Player is
 * removed. Whichever side wins also clears the cross-realm association.
 */
export function disposePreviewEdlAudio(iframe: HTMLIFrameElement | null): boolean {
  if (!iframe) return false;
  const audioId = iframe.getAttribute(VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE);
  const released = releasePreviewEdlAudioById(iframe.ownerDocument, audioId);
  iframe.removeAttribute(VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE);
  for (const attribute of VIDEOCUT_EDL_AUDIO_STATE_ATTRIBUTES) {
    iframe.removeAttribute(attribute);
  }
  return released;
}

/**
 * Keep the parent-owned EDL audio lifetime bounded by the preview Player.
 *
 * Child `pagehide` is not guaranteed when a custom element or its iframe is
 * removed directly. Observe the iframe association plus the current ancestor
 * chain so an abnormal detach releases the media decoder from the parent
 * realm. Audio-id replacement also releases the previous node, covering an
 * iframe reload whose old document never completed its pagehide cleanup.
 */
export function installPreviewEdlAudioCleanup(
  iframe: HTMLIFrameElement,
  playerHost: Element | null = null,
): () => void {
  const doc = iframe.ownerDocument;
  const win = doc.defaultView;
  let activeAudioId = iframe.getAttribute(VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE);
  let disposed = false;
  let observer: MutationObserver | null = null;

  const releaseSupersededAudio = (records: MutationRecord[]): void => {
    const currentAudioId = iframe.getAttribute(VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE);
    const staleAudioIds = new Set<string>();
    if (activeAudioId && activeAudioId !== currentAudioId) staleAudioIds.add(activeAudioId);
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.target === iframe &&
        record.attributeName === VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE &&
        record.oldValue &&
        record.oldValue !== currentAudioId
      ) {
        staleAudioIds.add(record.oldValue);
      }
    }
    for (const staleAudioId of staleAudioIds) {
      releasePreviewEdlAudioById(doc, staleAudioId);
    }
    activeAudioId = currentAudioId;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const pendingRecords = observer?.takeRecords() ?? [];
    observer?.disconnect();
    observer = null;
    win?.removeEventListener("pagehide", dispose);
    releaseSupersededAudio(pendingRecords);
    disposePreviewEdlAudio(iframe);
    activeAudioId = null;
  };

  const MutationObserverCtor = win?.MutationObserver;
  if (MutationObserverCtor) {
    observer = new MutationObserverCtor((records) => {
      releaseSupersededAudio(records);
      if (!iframe.isConnected || (playerHost !== null && !playerHost.isConnected)) {
        dispose();
      }
    });
    observer.observe(iframe, {
      attributes: true,
      attributeFilter: [VIDEOCUT_EDL_AUDIO_ID_ATTRIBUTE],
      attributeOldValue: true,
    });

    // Observe only each current ancestor's direct child list instead of the
    // whole document subtree. Removing any ancestor from its parent triggers
    // one of these observations and makes `isConnected` false.
    let ancestor: Node | null = playerHost ?? iframe;
    const observedAncestors = new Set<Node>();
    while (ancestor?.parentNode) {
      ancestor = ancestor.parentNode;
      if (observedAncestors.has(ancestor)) continue;
      observedAncestors.add(ancestor);
      observer.observe(ancestor, { childList: true });
    }
    if (playerHost?.shadowRoot) {
      observer.observe(playerHost.shadowRoot, { childList: true, subtree: true });
    }
  }

  win?.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}

/**
 * Resolve the underlying iframe from any host element. Supports:
 * - Direct `<iframe>` element (most common — studio's own `Player.tsx`)
 * - Custom elements (e.g. `<hyperframes-player>`) whose shadow DOM contains an iframe
 * - Wrapper elements whose light DOM contains a descendant iframe
 *
 * Exported so web-component consumers can pre-resolve the iframe before
 * assigning it to `iframeRef` returned by `useTimelinePlayer`. Returns `null`
 * when the element has no associated iframe yet.
 *
 * @example
 * ```tsx
 * const { iframeRef } = useTimelinePlayer();
 * const playerElRef = useRef<HyperframesPlayer>(null);
 *
 * useEffect(() => {
 *   iframeRef.current = resolveIframe(playerElRef.current);
 * }, [iframeRef]);
 * ```
 */
export function resolveIframe(el: Element | null): HTMLIFrameElement | null {
  if (!el) return null;
  if (el instanceof HTMLIFrameElement) return el;
  return el.shadowRoot?.querySelector("iframe") ?? el.querySelector("iframe") ?? null;
}

// ---------------------------------------------------------------------------
// Audio scrubbing
// ---------------------------------------------------------------------------
// Plays a brief slice of the music track while the user drags the playhead,
// like an NLE scrub. Repeated calls keep playback alive; it auto-pauses shortly
// after scrubbing stops and restores the element's prior muted state.

const SCRUB_VOLUME = 0.25;

let scrubAudioEl: HTMLAudioElement | null = null;
let scrubStopTimer: ReturnType<typeof setTimeout> | null = null;
let scrubPrevMuted: boolean | null = null;
let scrubPrevVolume: number | null = null;

// Resolve the SAME element the store identified as music: prefer its id, then
// the role attribute, and only fall back to the first <audio> (which could be a
// voiceover, so the id hint matters).
function resolveScrubAudioEl(doc: Document, musicId?: string | null): HTMLAudioElement | null {
  if (musicId) {
    const byId = doc.getElementById(musicId);
    if (byId instanceof HTMLAudioElement) return byId;
  }
  return (
    doc.querySelector<HTMLAudioElement>("audio[data-timeline-role='music']") ??
    doc.querySelector<HTMLAudioElement>("audio")
  );
}

function applyScrub(el: HTMLAudioElement, audioFileTime: number): void {
  if (scrubAudioEl && scrubAudioEl !== el) stopScrubPreviewAudio();
  if (scrubPrevMuted === null) scrubPrevMuted = el.muted;
  if (scrubPrevVolume === null) scrubPrevVolume = el.volume;
  scrubAudioEl = el;
  try {
    el.muted = false;
    el.volume = SCRUB_VOLUME;
    if (Math.abs(el.currentTime - audioFileTime) > 0.04) el.currentTime = audioFileTime;
    if (el.paused) void el.play().catch(() => {});
  } catch {
    /* element not ready */
  }
  if (scrubStopTimer) clearTimeout(scrubStopTimer);
  scrubStopTimer = setTimeout(stopScrubPreviewAudio, 140);
}

/**
 * Scrub the preview music audio to `audioFileTime` (seconds into the source
 * file). Pass `null` to stop. Safe to call rapidly during a playhead drag.
 */
export function scrubPreviewAudio(
  iframe: HTMLIFrameElement | null,
  audioFileTime: number | null,
  musicId?: string | null,
): void {
  if (!iframe) return;
  if (audioFileTime === null) {
    stopScrubPreviewAudio();
    return;
  }
  let doc: Document | null = null;
  try {
    doc = iframe.contentDocument;
  } catch {
    return;
  }
  if (!doc) return;
  const el = resolveScrubAudioEl(doc, musicId);
  if (el) applyScrub(el, audioFileTime);
}

export function stopScrubPreviewAudio(): void {
  if (scrubStopTimer) {
    clearTimeout(scrubStopTimer);
    scrubStopTimer = null;
  }
  const el = scrubAudioEl;
  scrubAudioEl = null;
  if (!el) return;
  try {
    el.pause();
    if (scrubPrevMuted !== null) el.muted = scrubPrevMuted;
    if (scrubPrevVolume !== null) el.volume = scrubPrevVolume;
  } catch {
    /* ignore */
  }
  scrubPrevMuted = null;
  scrubPrevVolume = null;
}

// ---------------------------------------------------------------------------
// Enrich missing compositions from DOM
// ---------------------------------------------------------------------------

/**
 * Scan the iframe DOM for composition hosts missing from the current
 * timeline elements and add them.  The CDN runtime often fails to resolve
 * element-reference starts (`data-start="intro"`) so composition hosts
 * are silently dropped from `__clipManifest`.  This pass reads the DOM +
 * GSAP timeline registry directly to fill the gaps.
 */
export function buildMissingCompositionElements(
  doc: Document,
  iframeWin: IframeWindow,
  currentEls: readonly TimelineElement[],
  rootDuration: number,
): { missing: TimelineElement[]; updatedEls: TimelineElement[]; patched: boolean } {
  const existingIds = new Set(currentEls.map((e) => e.id));
  const rootComp = doc.querySelector("[data-composition-id]");
  const rootCompId = rootComp?.getAttribute("data-composition-id");
  // Use [data-composition-id][data-start] — the composition loader strips
  // data-composition-src after loading, so we can't rely on it.
  const hosts = doc.querySelectorAll("[data-composition-id][data-start]");
  const missing: TimelineElement[] = [];

  hosts.forEach((host) => {
    const el = host as HTMLElement;
    const compId = el.getAttribute("data-composition-id");
    if (!compId || compId === rootCompId) return;
    if (existingIds.has(el.id) || existingIds.has(compId)) return;

    // Resolve start: numeric or element-reference
    const startAttr = el.getAttribute("data-start") ?? "0";
    let start = parseFloat(startAttr);
    if (isNaN(start)) {
      const ref =
        doc.getElementById(startAttr) ||
        doc.querySelector(`[data-composition-id="${CSS.escape(startAttr)}"]`);
      if (ref) {
        const refStartAttr = ref.getAttribute("data-start") ?? "0";
        let refStart = parseFloat(refStartAttr);
        // Recursively resolve one level of reference for the ref's own start
        if (isNaN(refStart)) {
          const refRef =
            doc.getElementById(refStartAttr) ||
            doc.querySelector(`[data-composition-id="${CSS.escape(refStartAttr)}"]`);
          const rrStart = parseFloat(refRef?.getAttribute("data-start") ?? "0") || 0;
          const rrCompId = refRef?.getAttribute("data-composition-id");
          const rrDur =
            parseFloat(refRef?.getAttribute("data-duration") ?? "") ||
            (rrCompId
              ? ((
                  iframeWin.__timelines?.[rrCompId] as { duration?: () => number } | undefined
                )?.duration?.() ?? 0)
              : 0);
          refStart = rrStart + rrDur;
        }
        const refCompId = ref.getAttribute("data-composition-id");
        const refDur =
          parseFloat(ref.getAttribute("data-duration") ?? "") ||
          (refCompId
            ? ((
                iframeWin.__timelines?.[refCompId] as { duration?: () => number } | undefined
              )?.duration?.() ?? 0)
            : 0);
        start = refStart + refDur;
      } else {
        start = 0;
      }
    }

    // Resolve duration from data-duration or GSAP timeline
    let dur = parseFloat(el.getAttribute("data-duration") ?? "");
    if (isNaN(dur) || dur <= 0) {
      dur =
        (
          iframeWin.__timelines?.[compId] as { duration?: () => number } | undefined
        )?.duration?.() ?? 0;
    }
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (!Number.isFinite(start)) start = 0;
    if (Number.isFinite(rootDuration) && rootDuration > 0) {
      if (start >= rootDuration) return;
      dur = Math.min(dur, Math.max(0, rootDuration - start));
      if (dur <= 0) return;
    }

    const trackStr = el.getAttribute("data-track-index");
    const track = trackStr != null ? parseInt(trackStr, 10) : 0;
    // fallow-ignore-next-line code-duplication
    const compSrc =
      el.getAttribute("data-composition-src") || el.getAttribute("data-composition-file");
    const selector = getTimelineElementSelector(el);
    const sourceFile = getTimelineElementSourceFile(el);
    const selectorIndex = getTimelineElementSelectorIndex(doc, el, selector);
    const label = getTimelineElementDisplayLabel({
      id: el.id || compId || null,
      label: el.getAttribute("data-timeline-label") ?? el.getAttribute("data-label"),
      tag: el.tagName,
    });
    const identity = buildTimelineElementIdentity({
      preferredId: el.id || compId || null,
      label,
      fallbackIndex: missing.length,
      domId: el.id || undefined,
      selector,
      selectorIndex,
      sourceFile,
    });
    const entry: TimelineElement = {
      id: identity.id,
      label,
      key: identity.key,
      tag: el.tagName.toLowerCase(),
      start,
      duration: dur,
      track: isNaN(track) ? 0 : track,
      domId: el.id || undefined,
      hfId: el.getAttribute("data-hf-id") || undefined,
      selector,
      selectorIndex,
      sourceFile,
      zIndex: readTimelineElementZIndex(el),
    };
    if (compSrc) {
      entry.compositionSrc = compSrc;
    } else {
      // Inline composition — expose inner video for thumbnails
      const innerVideo = el.querySelector("video[src]");
      if (innerVideo) {
        entry.src = innerVideo.getAttribute("src") || undefined;
        entry.tag = "video";
      }
    }
    missing.push(entry);
  });

  // Patch existing elements that are missing compositionSrc
  let patched = false;
  const updatedEls = (currentEls as TimelineElement[]).map((existing) => {
    if (existing.compositionSrc) return existing;
    // Find the matching DOM host by element id or composition id
    const host =
      doc.getElementById(existing.id) ??
      doc.querySelector(`[data-composition-id="${CSS.escape(existing.id)}"]`);
    if (!host) return existing;
    const compSrc =
      host.getAttribute("data-composition-src") || host.getAttribute("data-composition-file");
    if (compSrc) {
      patched = true;
      return { ...existing, compositionSrc: compSrc };
    }
    return existing;
  });

  return { missing, updatedEls, patched };
}
