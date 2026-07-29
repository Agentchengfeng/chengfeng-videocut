/**
 * The overlay page: everything the film draws *on* the footage, as one HTML
 * document that can be asked for any instant.
 *
 * It is a deliberate re-statement of the workbench player's overlay stack —
 * same DOM shape, same class semantics, same CSS, subtitles above modules —
 * built as a standalone page so it can be rendered without a React app, a
 * video element or a dev server.
 *
 * Three things in here are not style choices but repairs, and removing any of
 * them breaks the picture in a way that is hard to trace back:
 *
 * ```text
 * color-scheme: dark   the workbench host declares it, and a module that does
 *                      not match gets an opaque white backdrop composited
 *                      under it by Chromium. The export has to present the
 *                      same host condition or modules written for the preview
 *                      render differently here
 * 常驻挂载             every module's frame is mounted up front and only its
 *                      visibility changes. A frame mounted at its own start
 *                      needs ~0.1s to parse before it first paints, which in a
 *                      frame-by-frame export is not a flicker but a wrong frame
 * 绝对定位叠放          block-level iframes queue vertically; the "visible" one
 *                      ends up physically below the picture
 * ```
 */

import {
  declarationsToCssText,
  subtitleTextCss,
  type ExportPlan,
} from "@video-workbench/core";

export const OVERLAY_PAGE_NAME = "__videocut-export-overlay.html";

/** What a module is told, verbatim what the preview sends. */
export const VISUAL_SEEK_MESSAGE = "videocut:seek";

/**
 * Rows above the picture reserved for the frame marker, cropped off by ffmpeg.
 *
 * Every seek paints its own number into this strip as a colour, and the
 * renderer refuses any capture whose strip does not name the frame it asked
 * for. This is the only reliable answer we found to one question: *is this
 * screenshot of this seek?* Everything indirect — a plain capture, rAF waits,
 * counted flushes, capture-until-identical — was a guess about a compositor
 * that presents on its own schedule, and each guess failed a boundary. The
 * marker is not a guess; the picture itself testifies.
 *
 * The strip also hosts a permanently spinning square: continuous damage keeps
 * headless producing frames, so a pending commit always lands within a few
 * captures instead of waiting for one.
 */
export const MARKER_STRIP_HEIGHT = 8;

/** The blue channel that marks a strip colour as a frame token. */
export const MARKER_MAGIC_BLUE = 199;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The page, with the plan baked into it.
 *
 * The plan travels as JSON inside the document rather than being pushed in
 * over the protocol frame by frame: the page then holds one immutable
 * description of the film, and every seek is a pure function of a number.
 */
export function renderOverlayPage(plan: ExportPlan, moduleBase: string): string {
  const { width, height } = plan.output;
  const style = plan.subtitleStyle;

  // Percentages become pixels once, here, against the output frame — the same
  // thing `cqh` does against the picture in the preview. Writing them out as
  // pixels rather than declaring a size container keeps the export independent
  // of container-query support and makes the numbers inspectable in the file.
  const subtitleCss = style
    ? declarationsToCssText(
        subtitleTextCss(
          style,
          `${((style.fontSize / 100) * height).toFixed(3)}px`,
          `${((style.maxLineWidth / 100) * width).toFixed(3)}px`,
        ),
      )
    : "";
  const offsetPx = style ? ((style.offsetY / 100) * height).toFixed(3) : "0";
  const anchor = style?.anchor ?? "bottom";

  const frames = plan.layers
    .map((layer) => {
      const src = `${moduleBase}${layer.module.split("/").map(encodeURIComponent).join("/")}`;
      return `    <iframe class="ov-frame" data-layer="${escapeHtml(layer.layerId)}" src="${escapeHtml(src)}" scrolling="no"></iframe>`;
    })
    .join("\n");

  const data = JSON.stringify({
    cues: plan.subtitleCues.map((cue) => ({ text: cue.text, start: cue.start, end: cue.end })),
    layers: plan.layers.map((layer) => ({
      layerId: layer.layerId,
      start: layer.start,
      end: layer.end,
      duration: layer.duration,
      zoom: layer.zoom,
      cues: layer.cues,
    })),
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>导出画面层</title>
<style>
  /* The workbench host declares dark. A module document that defaults to light
     gets an opaque white backdrop composited under it, which is how every
     pushed-in layer once came out blank. Match the host exactly. */
  :root { color-scheme: dark; }
  html, body {
    margin: 0;
    padding: 0;
    width: ${width}px;
    height: ${height + MARKER_STRIP_HEIGHT}px;
    background: transparent;
    overflow: hidden;
  }
  /* The marker strip lives above the picture and is cropped off by ffmpeg.
     The film's own rows start at ${MARKER_STRIP_HEIGHT}px. */
  #ov-marker {
    position: absolute;
    top: 0;
    left: 0;
    width: 64px;
    height: ${MARKER_STRIP_HEIGHT}px;
  }
  #ov-pulse {
    position: absolute;
    top: 0;
    left: 72px;
    width: ${MARKER_STRIP_HEIGHT}px;
    height: ${MARKER_STRIP_HEIGHT}px;
    background: #808080;
    animation: ov-spin 0.12s linear infinite;
  }
  @keyframes ov-spin { to { transform: rotate(360deg); } }
  .ov-stage { position: relative; top: ${MARKER_STRIP_HEIGHT}px; width: ${width}px; height: ${height}px; }
  /* Absolutely stacked and permanently mounted — see the file comment.
     Hidden by opacity, never by visibility: a visibility-hidden layer is not
     painted at all, so unhiding it costs a full re-raster of the frame — close
     to ten capture cycles at export size, during which every screenshot showed
     the previous layer. An opacity-0 layer stays rastered and the flip to 1 is
     a compositor-only change that lands on the next frame. */
  .ov-frame {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
    opacity: 0;
  }
  .ov-subs { position: absolute; inset: 0; width: ${width}px; height: ${height}px; }
  /* Full-width band, shrink-to-fit box centred in it. Centring with left: 50%
     instead caps the box's automatic width at the half-frame to its right, and
     a line that fits across the frame wraps to three. */
  .ov-subs__text {
    position: absolute;
    right: 0;
    left: 0;
    width: fit-content;
    margin: 0 auto;
    text-align: center;
    text-wrap: balance;
    visibility: hidden;
  }
  .ov-subs[data-anchor="bottom"] .ov-subs__text { bottom: ${offsetPx}px; }
  .ov-subs[data-anchor="top"] .ov-subs__text { top: ${offsetPx}px; }
  .ov-subs[data-anchor="middle"] .ov-subs__text { top: 50%; transform: translateY(-50%); }
</style>
</head>
<body>
<div class="ov-stage">
${frames}
  <div class="ov-subs" data-anchor="${escapeHtml(anchor)}">
    <span class="ov-subs__text" id="ov-text" style="${escapeHtml(subtitleCss)}"></span>
  </div>
</div>
<div id="ov-marker"></div>
<div id="ov-pulse"></div>
<script>
const PLAN = ${data};
const SEEK = ${JSON.stringify(VISUAL_SEEK_MESSAGE)};
const MARKER_BLUE = ${MARKER_MAGIC_BLUE};
const marker = document.getElementById("ov-marker");
const text = document.getElementById("ov-text");
const frames = new Map();
const acked = new Map();

for (const frame of document.querySelectorAll(".ov-frame")) {
  frames.set(frame.dataset.layer, frame);
}

/**
 * Ready when every module has loaded and has been given an acknowledgement
 * hook inside its own window.
 *
 * The hook is the whole trick. A module's seek handler is registered while its
 * document is parsing; a listener the parent adds afterwards therefore runs
 * *after* it for the same event. So "our listener saw the message" means "the
 * module has already processed it" — a handshake that needs no cooperation
 * from the module and no change to the contract it was written against.
 */
const ready = Promise.all(Array.from(frames.entries()).map(([id, frame]) => new Promise((resolve) => {
  const attach = () => {
    try {
      frame.contentWindow.addEventListener("message", (event) => {
        const data = event.data;
        if (data && data.type === SEEK) acked.set(id, data.token);
      });
    } catch (error) {
      // Cross-origin would mean the module is not being served from this
      // origin, which is a setup fault worth surfacing rather than hiding.
      window.__overlayError = String(error);
    }
    resolve();
  };
  if (frame.contentDocument && frame.contentDocument.readyState === "complete") attach();
  else frame.addEventListener("load", attach, { once: true });
})));

let token = 0;

function activeLayer(time) {
  let active = null;
  for (const layer of PLAN.layers) {
    if (time >= layer.start && time < layer.end) active = layer;
  }
  return active;
}

function activeCue(time) {
  for (const cue of PLAN.cues) {
    if (time >= cue.start && time < cue.end) return cue;
  }
  return null;
}

/**
 * Readiness is a flag the renderer polls, not a promise it awaits: under
 * begin-frame control a page waiting on fonts needs frames to make progress,
 * and a renderer blocked inside an evaluate cannot drive them. Poll + drive.
 */
window.__isReady = false;
(async () => {
  await ready;
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  window.__isReady = true;
})();

/**
 * Put the page at one instant of the film and resolve once it is applied,
 * with this seek's number painted into the marker strip.
 *
 * Applied is not captured: the module acknowledging a seek proves its code
 * ran, not that pixels came out. The renderer keeps capturing until the strip
 * in the picture names this seek — the marker changes in the same commit as
 * everything else here, so a capture that carries it carries the rest.
 *
 * Returns the token the caller must find in the strip.
 */
window.__seek = async (time) => {
  const mine = ++token;
  marker.style.backgroundColor = "rgb(" + (mine & 255) + "," + ((mine >> 8) & 255) + "," + MARKER_BLUE + ")";

  const cue = activeCue(time);
  if (cue) {
    text.textContent = cue.text;
    text.style.visibility = "visible";
  } else {
    text.textContent = "";
    text.style.visibility = "hidden";
  }

  const layer = activeLayer(time);
  for (const [id, frame] of frames) {
    frame.style.opacity = layer && layer.layerId === id ? "1" : "0";
  }
  if (!layer) return mine;

  const frame = frames.get(layer.layerId);
  frame.contentWindow.postMessage({
    type: SEEK,
    time: Math.max(0, time - layer.start),
    duration: layer.duration,
    cues: layer.cues,
    zoom: layer.zoom,
    token: mine,
  }, "*");

  const deadline = performance.now() + 5000;
  while (acked.get(layer.layerId) !== mine) {
    if (performance.now() > deadline) throw new Error("module did not answer a seek: " + layer.layerId);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return mine;
};
</script>
</body>
</html>
`;
}
