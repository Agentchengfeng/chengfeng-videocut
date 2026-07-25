import type { EditListDocument } from "@video-workbench/core";

export interface EdlPreviewSegment {
  id: string;
  source: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  playbackRate: number;
}

export interface EdlPreviewPosition {
  index: number;
  segment: EdlPreviewSegment;
  sourceTime: number;
}

export interface EdlPreviewPayload {
  schemaVersion: 1;
  duration: number;
  segments: EdlPreviewSegment[];
}

/**
 * Survives HyperFrames' script coalescing so the production preview patcher
 * can distinguish the already-bundled Product runtime from a missing one.
 */
export const EDL_PREVIEW_RUNTIME_CONTRACT =
  "chengfeng-videocut:edl-preview-runtime-v5";

/**
 * HyperFrames preserves non-JavaScript script elements while coalescing the
 * executable body scripts. Keeping mutable EDL data here lets Studio swap the
 * canonical source for a browser proxy without creating a second runtime.
 */
export const EDL_PREVIEW_PAYLOAD_ATTRIBUTE =
  "data-chengfeng-videocut-edl-payload";

export function buildEdlPreviewSegments(
  editList: EditListDocument,
): EdlPreviewSegment[] {
  return editList.segments.map((segment) => ({
    id: segment.id,
    source: segment.source,
    sourceStart: segment.sourceStart,
    sourceEnd: segment.sourceEnd,
    timelineStart: segment.timelineStart,
    playbackRate: segment.playbackRate,
  }));
}

/** Map the magnetic edit timeline onto the retained source frame. */
export function resolveEdlPreviewPosition(
  segments: readonly EdlPreviewSegment[],
  timelineTime: number,
): EdlPreviewPosition | null {
  if (segments.length === 0 || !Number.isFinite(timelineTime)) return null;
  const time = Math.max(0, timelineTime);
  let low = 0;
  let high = segments.length - 1;
  let index = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (segments[middle].timelineStart <= time) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const segment = segments[index];
  const rate = Math.max(segment.playbackRate, 0.000001);
  const timelineDuration = (segment.sourceEnd - segment.sourceStart) / rate;
  const localTime = Math.max(0, Math.min(timelineDuration, time - segment.timelineStart));
  return {
    index,
    segment,
    sourceTime: Math.max(
      segment.sourceStart,
      Math.min(segment.sourceEnd, segment.sourceStart + localTime * rate),
    ),
  };
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function buildEdlPreviewPayload(
  editList: EditListDocument,
): EdlPreviewPayload {
  return {
    schemaVersion: 1,
    duration: editList.duration,
    segments: buildEdlPreviewSegments(editList),
  };
}

export function renderEdlPreviewPayload(editList: EditListDocument): string {
  return inlineJson(buildEdlPreviewPayload(editList));
}

/**
 * Product preview adapter. HyperFrames keeps ownership of its clock/GSAP
 * timeline; this adapter only maps that clock onto one untimed backing video.
 * Studio opts into it through window.__studioPlaybackAdapter.
 */
export function renderEdlPreviewRuntime(_editList?: EditListDocument): string {
  return `(() => {
  const runtimeContract = ${inlineJson(EDL_PREVIEW_RUNTIME_CONTRACT)};
  const payloadElement = typeof document.querySelector === "function"
    ? document.querySelector('script[${EDL_PREVIEW_PAYLOAD_ATTRIBUTE}="1"]')
    : null;
  let payload = null;
  try {
    payload = JSON.parse(payloadElement?.textContent || "null");
  } catch {}
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const duration = Number(payload?.duration);
  const video = document.getElementById("a-roll-preview");
  if (
    !(video instanceof HTMLVideoElement) ||
    segments.length === 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) return;
  // A user gesture in Studio's parent frame does not grant autoplay to an
  // unmuted media element inside this iframe. Keep picture playback in the
  // iframe, but create the single audio output in the parent document so the
  // same Play click can start it synchronously. This is an internal transport
  // detail only: audio and picture remain one magnetic A-roll in the editor.
  const frameElement = (() => {
    try { return window.frameElement; } catch { return null; }
  })();
  const parentDocument = (() => {
    try { return frameElement?.ownerDocument || null; } catch { return null; }
  })();
  const playerHost = (() => {
    try {
      const root = frameElement?.getRootNode?.();
      return root && typeof root === "object" && "host" in root ? root.host : null;
    } catch {
      return null;
    }
  })();
  const audioOutput = (() => {
    if (!parentDocument || typeof parentDocument.createElement !== "function") return null;
    const audio = parentDocument.createElement("audio");
    const usesPreviewProxy = typeof video.hasAttribute === "function" &&
      video.hasAttribute("data-videocut-preview-proxy");
    audio.preload = usesPreviewProxy ? "auto" : "metadata";
    audio.setAttribute("data-videocut-edl-audio", "");
    audio.setAttribute("aria-hidden", "true");
    audio.style.display = "none";
    parentDocument.body?.appendChild(audio);
    return audio;
  })();
  const audioOutputId = audioOutput && frameElement && parentDocument?.body
    ? (() => {
        const body = parentDocument.body;
        const counter = Number(body.dataset.videocutEdlAudioCounter || 0) + 1;
        body.dataset.videocutEdlAudioCounter = String(counter);
        return "videocut-edl-audio-" + counter;
      })()
    : null;
  if (audioOutput && frameElement && audioOutputId) {
    // Parent Studio starts this exact element inside its own user-activation
    // stack before invoking the iframe adapter. A shared DOM id/attribute keeps
    // the association visible across the parent and child JavaScript realms.
    audioOutput.id = audioOutputId;
    frameElement.setAttribute("data-videocut-edl-audio-id", audioOutputId);
  }
  if (!audioOutput) {
    // A directly opened composition has no iframe boundary, so its own media
    // element may remain the audible owner after the user's local Play click.
    video.removeAttribute("muted");
    video.muted = false;
  }
  // The HyperFrames compiler assigns untimed media data-start=0. This video is
  // instead driven by the magnetic EDL mapping below, so remove any generated
  // timing attributes before the framework runtime discovers managed media.
  video.removeAttribute("data-start");
  video.removeAttribute("data-hf-auto-start");
  document.documentElement.dataset.videocutEdlAdapter = "waiting";
  document.documentElement.dataset.videocutEdlRuntime = runtimeContract;
  document.documentElement.dataset.videocutEdlAudioOwner = audioOutput ? "parent" : "iframe";

  let installed = false;
  let animationFrame = 0;
  let activeIndex = -1;
  let pendingTimelineTime = 0;
  let loadGeneration = 0;
  let videoLoadPendingSource = null;
  let playRequested = false;
  let playbackGeneration = 0;
  let playPromise = null;
  // Browser media seeks are asynchronous. A cut boundary can land inside an
  // already-decoded AAC packet, so the audible parent element must be gated
  // before the source clock is moved and remain gated until seeked.
  const audioBoundaryGateSeconds = 0.04;
  let audioBoundaryGateIndex = -1;
  let audioBoundarySeekGeneration = 0;
  let audioBoundarySeekPending = false;
  let audioBoundarySeekTarget = null;

  const syncAudioOutputSettings = () => {
    if (!audioOutput) return;
    // HyperFrames reflects Studio's mute/rate controls onto its player host.
    // Read that state directly so mute and 2x playback stay deterministic.
    const muted = playerHost && typeof playerHost.muted === "boolean"
      ? playerHost.muted
      : false;
    const volume = playerHost && typeof playerHost.volume === "number"
      ? playerHost.volume
      : 1;
    const parentPlayState = frameElement?.getAttribute("data-videocut-edl-audio-play");
    // Studio may briefly bootstrap the parent audio as muted when a synthetic
    // transport command has no transient user activation. Do not overwrite
    // that state until the parent reports playback has actually started.
    audioOutput.muted = audioBoundaryGateIndex >= 0 ||
      parentPlayState === "retry-muted"
      ? true
      : muted;
    audioOutput.volume = Math.max(0, Math.min(1, volume));
    // The parent audio element is the only audible owner. The iframe video is
    // always visual-only, which also makes its play() autoplay-safe.
    video.muted = true;
  };

  syncAudioOutputSettings();
  const hostSettingsObserver = audioOutput && playerHost && typeof MutationObserver === "function"
    ? new MutationObserver(syncAudioOutputSettings)
    : null;
  hostSettingsObserver?.observe(playerHost, {
    attributes: true,
    attributeFilter: ["muted", "volume", "playback-rate"],
  });

  const hasSourceDiscontinuity = (fromIndex, toIndex) => {
    const from = segments[fromIndex];
    const to = segments[toIndex];
    if (!from || !to) return true;
    if (toIndex !== fromIndex + 1) return true;
    return from.source !== to.source || Math.abs(from.sourceEnd - to.sourceStart) > 0.0005;
  };

  const armAudioBoundaryGate = (targetIndex) => {
    if (!audioOutput || targetIndex < 0) return;
    if (audioBoundaryGateIndex === targetIndex) return;
    audioBoundaryGateIndex = targetIndex;
    document.documentElement.dataset.videocutEdlAudioGate = "armed";
    // This must happen before assigning currentTime. Muting after the seek has
    // started still allows Chromium to drain the old decoded AAC packet.
    syncAudioOutputSettings();
  };

  const clearAudioBoundaryGate = () => {
    audioBoundarySeekGeneration += 1;
    audioBoundarySeekPending = false;
    audioBoundarySeekTarget = null;
    audioBoundaryGateIndex = -1;
    delete document.documentElement.dataset.videocutEdlAudioGate;
    syncAudioOutputSettings();
  };

  const releaseAudioBoundaryGate = (generation) => {
    if (generation !== audioBoundarySeekGeneration) return;
    audioBoundaryGateIndex = -1;
    delete document.documentElement.dataset.videocutEdlAudioGate;
    syncAudioOutputSettings();
  };

  const finishAudioBoundarySeek = (generation) => {
    if (generation !== audioBoundarySeekGeneration) return;
    audioBoundarySeekPending = false;
    audioBoundarySeekTarget = null;
    if (!playRequested) {
      releaseAudioBoundaryGate(generation);
      return;
    }
    // If load()/seek paused either media element, restart it while the audio
    // gate is still closed. Only a successful resume may make audio audible.
    requestProductMediaPlay({
      resumeParentAudio: true,
      onStarted: () => releaseAudioBoundaryGate(generation),
    });
  };

  const beginAudioBoundarySeek = (targetIndex, sourceTime) => {
    if (!audioOutput) return false;
    armAudioBoundaryGate(targetIndex);
    // Supersede any play() promise created for the previous media position.
    // Its completion must not block or change the latest boundary transition.
    playbackGeneration += 1;
    playPromise = null;
    const generation = ++audioBoundarySeekGeneration;
    audioBoundarySeekPending = true;
    audioBoundarySeekTarget = sourceTime;
    document.documentElement.dataset.videocutEdlAudioGate = "seeking";
    try {
      audioOutput.currentTime = sourceTime;
      return true;
    } catch {
      // HAVE_NOTHING: loadedmetadata will retry the authoritative seek. Keep
      // the gate closed so a stale decoder can never become audible meanwhile.
      if (generation === audioBoundarySeekGeneration) {
        audioBoundarySeekPending = false;
        audioBoundarySeekTarget = null;
      }
      return false;
    }
  };

  const settleAudioBoundarySeekIfReady = () => {
    if (
      !audioOutput ||
      !audioBoundarySeekPending ||
      audioBoundarySeekTarget === null ||
      audioOutput.seeking !== false ||
      Math.abs((audioOutput.currentTime || 0) - audioBoundarySeekTarget) > 0.03
    ) return;
    finishAudioBoundarySeek(audioBoundarySeekGeneration);
  };
  // Keep one listener for this audio owner. Chromium may coalesce rapid media
  // seeks, so multiple once-listeners can otherwise all fire on one event and
  // let an obsolete transition release the newest gate.
  audioOutput?.addEventListener("seeked", settleAudioBoundarySeekIfReady);

  const updateUpcomingAudioBoundaryGate = (timelineTime, index, playbackRate) => {
    if (!audioOutput || !playRequested || audioBoundarySeekPending) return;
    // Only arm while still inside the current retained segment. Once locate()
    // moves to the next segment, syncVideo() consumes the already-armed gate.
    if (activeIndex !== index) return;
    const nextIndex = index + 1;
    const next = segments[nextIndex];
    if (!next || !hasSourceDiscontinuity(index, nextIndex)) {
      if (audioBoundaryGateIndex >= 0) clearAudioBoundaryGate();
      return;
    }
    const remaining = next.timelineStart - timelineTime;
    // Scale composition-time lookahead by transport rate so the audible wall-
    // clock gate stays about 40 ms at 0.5x, 1x, or accelerated preview speeds.
    const gateWindow = audioBoundaryGateSeconds * Math.max(playbackRate, 0.0625);
    if (remaining > 0 && remaining <= gateWindow) {
      armAudioBoundaryGate(nextIndex);
    } else if (audioBoundaryGateIndex === nextIndex && remaining > gateWindow) {
      clearAudioBoundaryGate();
    }
  };

  const locate = (timelineTime) => {
    const time = Math.max(0, Math.min(duration, Number(timelineTime) || 0));
    let low = 0;
    let high = segments.length - 1;
    let index = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (segments[middle].timelineStart <= time) {
        index = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const segment = segments[index];
    const rate = Math.max(Number(segment.playbackRate) || 1, 0.000001);
    const timelineDuration = (segment.sourceEnd - segment.sourceStart) / rate;
    const localTime = Math.max(0, Math.min(timelineDuration, time - segment.timelineStart));
    return {
      index,
      segment,
      sourceTime: Math.max(
        segment.sourceStart,
        Math.min(segment.sourceEnd, segment.sourceStart + localTime * rate),
      ),
    };
  };

  const playbackErrorName = (error) =>
    error && typeof error === "object" && typeof error.name === "string"
      ? error.name
      : "UnknownError";

  const postPlaybackIssue = (type, error) => {
    window.parent?.postMessage(
      {
        source: "chengfeng-videocut",
        type,
        errorName: playbackErrorName(error),
      },
      "*",
    );
  };

  const stopProductPlayback = (state) => {
    playRequested = false;
    clearAudioBoundaryGate();
    video.pause();
    audioOutput?.pause();
    const adapter = Reflect.get(window, "__studioPlaybackAdapter");
    if (adapter && typeof adapter.pause === "function") adapter.pause();
    document.documentElement.dataset.videocutEdlAdapter = state;
  };

  const handleVideoPlayFailure = (error, generation) => {
    // pause(), a newer play request, or a source load may settle an older
    // play() promise. Those stale completions must never change audio owner.
    if (generation !== playbackGeneration || !playRequested) return;
    const name = playbackErrorName(error);
    document.documentElement.dataset.videocutEdlPlayError = name;
    // load(), seek and pause commonly interrupt a pending play(). The next
    // animation frame retries against the current EDL source position.
    if (name === "AbortError") return;
    if (name === "NotAllowedError") {
      // The product-owned parent audio output should normally preserve the
      // user's activation. If the host still rejects it, fail closed instead
      // of silently switching to muted playback.
      stopProductPlayback("audio-blocked");
      postPlaybackIssue("videocut-audio-gesture-required", error);
      return;
    }
    stopProductPlayback("media-error");
    postPlaybackIssue("videocut-media-play-error", error);
  };

  const requestProductMediaPlay = (options = {}) => {
    const resumeParentAudio = options.resumeParentAudio === true;
    const onStarted = typeof options.onStarted === "function" ? options.onStarted : null;
    const mediaNeedsPlay = video.paused || Boolean(audioOutput?.paused);
    if (!playRequested) return;
    if (!mediaNeedsPlay) {
      onStarted?.();
      return;
    }
    if (playPromise) return;
    const generation = playbackGeneration;
    const pending = [];
    try {
      syncAudioOutputSettings();
      // Start parent-owned audio first while the user's activation is still in
      // the synchronous Play call stack, then start the muted picture stream.
      // Once Studio marks the parent request, the iframe must not call play()
      // on that same audio again from a different realm and lose activation.
      const parentOwnsAudioStart = Boolean(
        audioOutput && frameElement?.getAttribute("data-videocut-edl-audio-play"),
      ) && !resumeParentAudio;
      if (audioOutput?.paused && !parentOwnsAudioStart) pending.push(audioOutput.play());
      if (video.paused) pending.push(video.play());
    } catch (error) {
      handleVideoPlayFailure(error, generation);
      return;
    }
    if (pending.length === 0) return;
    const tracked = Promise.all(pending.map((result) => Promise.resolve(result)))
      .then(() => {
        if (generation !== playbackGeneration) return;
        delete document.documentElement.dataset.videocutEdlPlayError;
        onStarted?.();
      })
      .catch((error) => handleVideoPlayFailure(error, generation))
      .finally(() => {
        if (playPromise !== tracked) return;
        playPromise = null;
        if (playRequested && (video.paused || audioOutput?.paused)) {
          requestAnimationFrame(() => requestProductMediaPlay(options));
        }
      });
    playPromise = tracked;
  };

  const syncVideo = (timelineTime, force = false, playbackRate = 1) => {
    const normalizedTimelineTime = Math.max(
      0,
      Math.min(duration, Number(timelineTime) || 0),
    );
    // Product-owned seeks are authoritative even while HyperFrames' base
    // player is paused. The base runtime can asynchronously publish its stale
    // pre-seek clock (commonly 0) after the EDL picture/audio have already
    // landed. Preserve the last confirmed EDL timeline position until active
    // playback supplies a new clock sample.
    pendingTimelineTime = normalizedTimelineTime;
    const position = locate(normalizedTimelineTime);
    if (!position) return;
    const { index, segment, sourceTime } = position;
    const previousIndex = activeIndex;
    const crossedBoundary = previousIndex !== index;
    const requiresSourceJump = previousIndex >= 0 &&
      crossedBoundary &&
      hasSourceDiscontinuity(previousIndex, index);
    updateUpcomingAudioBoundaryGate(normalizedTimelineTime, index, playbackRate);
    if (playRequested && requiresSourceJump) armAudioBoundaryGate(index);
    const videoSourceChanged = video.dataset.edlSource !== segment.source;
    // Generated markup already contains the first segment src and source
    // marker. Chromium can still leave that backing video at HAVE_NOTHING
    // inside the preview iframe, so a matching marker alone is not proof that
    // metadata loading has started. Track the in-flight source to issue one
    // explicit load without restarting it on every animation frame.
    const videoHasMetadata = typeof video.readyState !== "number" || video.readyState >= 1;
    const videoNeedsInitialLoad =
      !videoHasMetadata && videoLoadPendingSource !== segment.source;
    const shouldLoadVideo = videoSourceChanged || videoNeedsInitialLoad;
    const audioSourceChanged = Boolean(
      audioOutput && audioOutput.dataset.edlSource !== segment.source,
    );
    if (shouldLoadVideo || audioSourceChanged) {
      activeIndex = -1;
      const generation = ++loadGeneration;
      const handleLoadedMetadata = () => {
        if (generation !== loadGeneration) return;
        syncVideo(pendingTimelineTime, true, playbackRate);
        if (audioBoundaryGateIndex < 0) requestProductMediaPlay();
      };
      if (shouldLoadVideo) {
        videoLoadPendingSource = segment.source;
        video.dataset.edlSource = segment.source;
        video.setAttribute("src", segment.source);
        video.addEventListener("loadedmetadata", () => {
          if (generation !== loadGeneration) return;
          videoLoadPendingSource = null;
          handleLoadedMetadata();
        }, { once: true });
        video.load();
      }
      if (audioOutput && audioSourceChanged) {
        audioOutput.dataset.edlSource = segment.source;
        audioOutput.setAttribute("src", new URL(segment.source, document.baseURI).href);
        audioOutput.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
        audioOutput.load();
      }
    }
    const rate = Math.max(Number(segment.playbackRate) || 1, 0.000001);
    const targetRate = Math.max(0.0625, Math.min(16, playbackRate * rate));
    if (Math.abs(video.playbackRate - targetRate) > 0.0001) {
      video.playbackRate = targetRate;
    }
    if (audioOutput && Math.abs(audioOutput.playbackRate - targetRate) > 0.0001) {
      audioOutput.playbackRate = targetRate;
    }
    const videoDrift = Math.abs((video.currentTime || 0) - sourceTime);
    if (force || requiresSourceJump || videoDrift > 0.18) {
      try {
        video.currentTime = sourceTime;
      } catch {
        // HAVE_NOTHING: loadedmetadata will apply the pending seek.
      }
    }
    const audioDrift = audioOutput
      ? Math.abs((audioOutput.currentTime || 0) - sourceTime)
      : 0;
    if (audioOutput && (force || requiresSourceJump || audioDrift > 0.18)) {
      const gatedBoundarySeek = playRequested &&
        (requiresSourceJump || audioBoundaryGateIndex === index);
      if (gatedBoundarySeek) {
        const supersedesPendingSeek = !audioBoundarySeekPending ||
          audioBoundarySeekTarget === null ||
          Math.abs(audioBoundarySeekTarget - sourceTime) > 0.001;
        if (supersedesPendingSeek) beginAudioBoundarySeek(index, sourceTime);
      } else {
        try {
          audioOutput.currentTime = sourceTime;
        } catch {
          // HAVE_NOTHING: loadedmetadata will apply the pending seek.
        }
      }
    }
    settleAudioBoundarySeekIfReady();
    syncAudioOutputSettings();
    activeIndex = index;
  };

  const install = () => {
    if (installed) return;
    const base = Reflect.get(window, "__player");
    if (!base || typeof base.play !== "function" || typeof base.getTime !== "function") {
      requestAnimationFrame(install);
      return;
    }
    // Core may annotate media after this script first runs. Strip those
    // attributes again at the exact hand-off point so only the EDL adapter
    // owns the backing video's clock inside Studio.
    video.removeAttribute("data-start");
    video.removeAttribute("data-hf-auto-start");
    // Snapshot bound transport methods before publishing the wrapper. The
    // HyperFrames runtime may expose its player through accessors; retaining a
    // live prototype/reference can make the wrapper resolve back to itself and
    // recurse after publication.
    const basePlay = base.play.bind(base);
    const basePause = typeof base.pause === "function" ? base.pause.bind(base) : () => {};
    const baseSeek = typeof base.seek === "function" ? base.seek.bind(base) : () => {};
    const baseRenderSeek = typeof base.renderSeek === "function"
      ? base.renderSeek.bind(base)
      : null;
    const baseGetTime = base.getTime.bind(base);
    const baseIsPlaying = typeof base.isPlaying === "function"
      ? base.isPlaying.bind(base)
      : () => false;
    const baseSetPlaybackRate = typeof base.setPlaybackRate === "function"
      ? base.setPlaybackRate.bind(base)
      : null;
    const baseGetPlaybackRate = typeof base.getPlaybackRate === "function"
      ? base.getPlaybackRate.bind(base)
      : null;
    const initialPlaybackRate = baseGetPlaybackRate ? Number(baseGetPlaybackRate()) : 1;
    let transportPlaybackRate = Number.isFinite(initialPlaybackRate) && initialPlaybackRate > 0
      ? initialPlaybackRate
      : 1;
    const getPlaybackRate = () => transportPlaybackRate;
    const isPlaying = () => Boolean(baseIsPlaying());

    const stopLoop = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };
    const tick = () => {
      if (!isPlaying()) {
        playRequested = false;
        clearAudioBoundaryGate();
        video.pause();
        audioOutput?.pause();
        stopLoop();
        return;
      }
      playRequested = true;
      const baseTimelineTime = Number(baseGetTime());
      syncVideo(
        Number.isFinite(baseTimelineTime) ? baseTimelineTime : pendingTimelineTime,
        false,
        getPlaybackRate(),
      );
      requestProductMediaPlay();
      animationFrame = requestAnimationFrame(tick);
    };
    const startLoop = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(tick);
    };
    const seek = (time, options) => {
      const shouldKeepPlaying = options?.keepPlaying === true || isPlaying();
      playRequested = shouldKeepPlaying;
      if (!shouldKeepPlaying) clearAudioBoundaryGate();
      baseSeek(time, options);
      syncVideo(time, true, getPlaybackRate());
      if (playRequested) {
        requestProductMediaPlay();
        startLoop();
      } else {
        video.pause();
        audioOutput?.pause();
      }
    };
    const renderSeek = (time, options) => {
      clearAudioBoundaryGate();
      if (baseRenderSeek) baseRenderSeek(time, options);
      else baseSeek(time, options);
      syncVideo(time, true, getPlaybackRate());
    };

    const adapter = {
      play() {
        playbackGeneration += 1;
        // Re-anchor the base clock to the Product-confirmed paused position
        // before starting it. A late base-runtime reset must not make Play
        // restart from 0 while the EDL picture/audio remain at the requested
        // timeline frame.
        baseSeek(pendingTimelineTime);
        basePlay();
        document.documentElement.dataset.videocutEdlAdapter = "playing";
        playRequested = true;
        syncVideo(pendingTimelineTime, true, getPlaybackRate());
        requestProductMediaPlay();
        startLoop();
      },
      pause() {
        playbackGeneration += 1;
        basePause();
        document.documentElement.dataset.videocutEdlAdapter = "paused";
        playRequested = false;
        clearAudioBoundaryGate();
        stopLoop();
        video.pause();
        audioOutput?.pause();
        syncVideo(pendingTimelineTime, true, getPlaybackRate());
      },
      seek,
      renderSeek,
      getTime: () => pendingTimelineTime,
      getDuration: () => duration,
      isPlaying,
      setPlaybackRate(rate) {
        const nextRate = Number(rate);
        transportPlaybackRate = Number.isFinite(nextRate) && nextRate > 0 ? nextRate : 1;
        baseSetPlaybackRate?.(transportPlaybackRate);
        syncVideo(pendingTimelineTime, true, transportPlaybackRate);
      },
      getPlaybackRate,
    };
    if (!Reflect.set(window, "__studioPlaybackAdapter", adapter)) {
      document.documentElement.dataset.videocutEdlAdapter = "error";
      requestAnimationFrame(install);
      return;
    }
    installed = true;
    document.documentElement.dataset.videocutEdlAdapter = "ready";
    syncVideo(baseGetTime(), true, getPlaybackRate());
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", () => {
      hostSettingsObserver?.disconnect();
      clearAudioBoundaryGate();
      audioOutput?.removeEventListener("seeked", settleAudioBoundarySeekIfReady);
      audioOutput?.pause();
      if (audioOutput) {
        if (
          frameElement &&
          frameElement.getAttribute("data-videocut-edl-audio-id") === audioOutputId
        ) {
          frameElement.removeAttribute("data-videocut-edl-audio-id");
        }
        audioOutput.removeAttribute("src");
        audioOutput.load();
        audioOutput.remove();
      }
    }, { once: true });
  }
})();`;
}
