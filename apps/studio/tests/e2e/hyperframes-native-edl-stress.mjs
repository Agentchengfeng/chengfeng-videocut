#!/usr/bin/env node

/**
 * Browser experiment for representing a chengfeng-videocut EDL with only the
 * public HyperFrames media contract: data-start, data-duration,
 * data-media-start, and data-track-index.
 *
 * The fixture must already be registered in an isolated Studio projects dir.
 * This runner never mutates the project or the running Studio.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, true);
    }
  }
  const requiredPath = (name) => {
    const value = values.get(name);
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
    return resolve(value);
  };
  const studioUrl = new URL(String(values.get("studio-url") ?? "http://127.0.0.1:5191"));
  if (!/^https?:$/.test(studioUrl.protocol)) throw new Error("--studio-url must use http or https");
  const projectDir = requiredPath("project-dir");
  return {
    studioUrl: studioUrl.origin,
    projectDir,
    projectId: String(values.get("project-id") ?? basename(projectDir)),
    reportPath: requiredPath("report"),
    chrome: resolve(String(values.get("chrome") ?? DEFAULT_CHROME)),
    randomSeeks: Math.max(1, Number(values.get("random-seeks") ?? 24)),
    boundarySamples: Math.max(1, Number(values.get("boundary-samples") ?? 12)),
  };
}

function assert(condition, message, details = {}) {
  if (condition) return;
  const suffix = Object.keys(details).length ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function waitFor(read, accept, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
  }
  throw new Error(`Timed out waiting for ${label}\nLatest: ${JSON.stringify(latest, null, 2)}`);
}

function ordinal(index) {
  return String(index + 1).padStart(4, "0");
}

function sourceTime(segment, timelineTime) {
  return Number(segment.sourceStart) +
    (timelineTime - Number(segment.timelineStart)) * (Number(segment.playbackRate) || 1);
}

function segmentAt(editList, timelineTime) {
  const segments = editList.segments;
  for (let index = 0; index < segments.length; index += 1) {
    const start = Number(segments[index].timelineStart);
    const end = index + 1 < segments.length
      ? Number(segments[index + 1].timelineStart)
      : Number(editList.duration);
    if (timelineTime >= start && (timelineTime < end || index === segments.length - 1)) {
      return { index, segment: segments[index] };
    }
  }
  throw new Error(`No EDL segment at ${timelineTime}`);
}

function deterministicSeekTimes(editList, count) {
  let state = 0x5eed1234;
  const duration = Number(editList.duration);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(0.02 + (state / 0x100000000) * Math.max(0.02, duration - 0.06));
  }
  return values;
}

function representativeBoundaries(editList, count) {
  const boundaries = editList.segments.slice(1).map((segment, index) => ({
    nextIndex: index + 1,
    timelineTime: Number(segment.timelineStart),
    sourceJump: Number(segment.sourceStart) - Number(editList.segments[index].sourceEnd),
  }));
  const selected = new Map();
  const add = (value) => selected.set(value.nextIndex, value);
  [...boundaries]
    .sort((left, right) => right.sourceJump - left.sourceJump)
    .slice(0, Math.ceil(count / 2))
    .forEach(add);
  for (let index = 0; selected.size < count && index < count * 2; index += 1) {
    add(boundaries[Math.round(index * (boundaries.length - 1) / Math.max(1, count * 2 - 1))]);
  }
  return [...selected.values()]
    .sort((left, right) => left.timelineTime - right.timelineTime)
    .slice(0, count);
}

async function shellSnapshot(page) {
  return await page.evaluate(() => {
    const player = document.querySelector("hyperframes-player");
    const iframe = player?.iframeElement ?? player?.shadowRoot?.querySelector("iframe");
    const frameDocument = iframe?.contentDocument;
    const runtime = iframe?.contentWindow?.__player;
    return {
      ready: Boolean(player?.ready),
      paused: player?.paused ?? null,
      currentTime: Number(player?.currentTime),
      duration: Number(player?.duration),
      runtimeTime: Number(typeof runtime?.getTime === "function" ? runtime.getTime() : NaN),
      runtimeDuration: Number(typeof runtime?.getDuration === "function" ? runtime.getDuration() : NaN),
      runtimePlaying: typeof runtime?.isPlaying === "function" ? runtime.isPlaying() : null,
      hasIframe: Boolean(iframe),
      hasExperimentRoot: Boolean(frameDocument?.querySelector("[data-native-edl-experiment='1']")),
      nativeMediaMode: frameDocument?.querySelector("[data-native-edl-experiment='1']")
        ?.getAttribute("data-native-edl-mode") ?? null,
      videoCount: frameDocument?.querySelectorAll("video[data-start]").length ?? 0,
      audioCount: frameDocument?.querySelectorAll("audio[data-start]").length ?? 0,
      readyVideos: [...(frameDocument?.querySelectorAll("video[data-start]") ?? [])]
        .filter((media) => media.readyState >= 1).length,
      readyAudios: [...(frameDocument?.querySelectorAll("audio[data-start]") ?? [])]
        .filter((media) => media.readyState >= 1).length,
      hasBasePlayer: Boolean(iframe?.contentWindow?.__player),
      hasCustomAdapter: Boolean(iframe?.contentWindow?.__studioPlaybackAdapter),
      bodyTextLength: document.body?.innerText?.length ?? 0,
    };
  });
}

async function mediaSnapshot(page, index) {
  return await page.evaluate((segmentOrdinal) => {
    const player = document.querySelector("hyperframes-player");
    const iframe = player?.iframeElement ?? player?.shadowRoot?.querySelector("iframe");
    const frameDocument = iframe?.contentDocument;
    const runtime = iframe?.contentWindow?.__player;
    const video = frameDocument?.querySelector(`#native-video-${segmentOrdinal}`);
    const audio = frameDocument?.querySelector(`#native-audio-${segmentOrdinal}`);
    const computed = video ? getComputedStyle(video) : null;
    return {
      outerTime: Number(player?.currentTime),
      outerPaused: player?.paused ?? null,
      runtimeTime: Number(typeof runtime?.getTime === "function" ? runtime.getTime() : NaN),
      runtimePlaying: typeof runtime?.isPlaying === "function" ? runtime.isPlaying() : null,
      videoTime: Number(video?.currentTime),
      videoPaused: video?.paused ?? null,
      videoReadyState: video?.readyState ?? 0,
      videoWidth: video?.videoWidth ?? 0,
      decodedFrames: Number(video?.webkitDecodedFrameCount ?? 0),
      audioTime: Number(audio?.currentTime),
      audioPaused: audio?.paused ?? null,
      audioReadyState: audio?.readyState ?? 0,
      visibility: computed?.visibility ?? null,
      display: computed?.display ?? null,
      opacity: computed?.opacity ?? null,
    };
  }, ordinal(index));
}

async function seekAndVerify(page, editList, nativeMediaMode, timelineTime) {
  const target = segmentAt(editList, timelineTime);
  const mediaIndex = nativeMediaMode === "flattened" ? 0 : target.index;
  const expectedSourceTime = nativeMediaMode === "flattened"
    ? timelineTime
    : sourceTime(target.segment, timelineTime);
  const startedAt = performance.now();
  await page.evaluate((time) => {
    const player = document.querySelector("hyperframes-player");
    const iframe = player?.iframeElement ?? player?.shadowRoot?.querySelector("iframe");
    const runtime = iframe?.contentWindow?.__player;
    runtime.pause();
    runtime.seek(time);
  }, timelineTime);
  const snapshot = await waitFor(
    () => mediaSnapshot(page, mediaIndex),
    (value) => (
      Math.abs(value.runtimeTime - timelineTime) < 0.12 &&
      value.videoReadyState >= 2 &&
      value.videoWidth > 0 &&
      Math.abs(value.videoTime - expectedSourceTime) < 0.45 &&
      value.audioReadyState >= 1 &&
      Math.abs(value.audioTime - expectedSourceTime) < 0.45
    ),
    `native media seek at ${timelineTime.toFixed(3)}`,
    15_000,
  );
  return {
    timelineTime: Number(timelineTime.toFixed(3)),
    segmentIndex: target.index,
    mediaIndex,
    expectedSourceTime: Number(expectedSourceTime.toFixed(3)),
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    snapshot,
  };
}

async function crossBoundary(page, editList, nativeMediaMode, boundary) {
  const previous = editList.segments[boundary.nextIndex - 1];
  const previousStart = Number(previous.timelineStart);
  const before = Math.max(previousStart + 0.01, boundary.timelineTime - 0.18);
  await seekAndVerify(page, editList, nativeMediaMode, before);
  const startedAt = performance.now();
  await page.evaluate(() => {
    const player = document.querySelector("hyperframes-player");
    player.muted = false;
    const iframe = player?.iframeElement ?? player?.shadowRoot?.querySelector("iframe");
    iframe?.contentWindow?.__player?.play();
  });
  const next = editList.segments[boundary.nextIndex];
  const mediaIndex = nativeMediaMode === "flattened" ? 0 : boundary.nextIndex;
  const expectedAtThreshold = nativeMediaMode === "flattened"
    ? boundary.timelineTime + 0.08
    : Number(next.sourceStart) + 0.08;
  const snapshot = await waitFor(
    () => mediaSnapshot(page, mediaIndex),
    (value) => (
      value.runtimeTime > boundary.timelineTime + 0.08 &&
      value.runtimePlaying === true &&
      value.videoReadyState >= 2 &&
      value.videoTime >= expectedAtThreshold - 0.4 &&
      value.audioReadyState >= 1 &&
      Math.abs(value.audioTime - value.videoTime) < 0.45
    ),
    `playback to cross native boundary ${boundary.nextIndex}`,
    15_000,
  );
  await page.evaluate(() => {
    const player = document.querySelector("hyperframes-player");
    const iframe = player?.iframeElement ?? player?.shadowRoot?.querySelector("iframe");
    iframe?.contentWindow?.__player?.pause();
  });
  return {
    nextIndex: boundary.nextIndex,
    mediaIndex,
    timelineTime: boundary.timelineTime,
    sourceJump: Number(boundary.sourceJump.toFixed(3)),
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
    snapshot,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [editList, experiment] = await Promise.all([
    readJson(resolve(options.projectDir, "native-edl-source.json")),
    readJson(resolve(options.projectDir, "experiment.json")),
  ]);
  assert(Array.isArray(editList.segments) && editList.segments.length > 0, "Native EDL sidecar is empty");
  const nativeMediaMode = experiment.nativeMediaMode === "flattened" ? "flattened" : "segments";
  const mediaElements = Number(experiment.mediaElementCount);
  assert(Number.isInteger(mediaElements) && mediaElements >= 2 && mediaElements % 2 === 0,
    "Experiment has an invalid media element count", { experiment });
  const report = {
    schemaVersion: 1,
    kind: "hyperframes-native-edl-browser-stress",
    startedAt: new Date().toISOString(),
    studioUrl: options.studioUrl,
    projectId: options.projectId,
    expected: {
      duration: Number(editList.duration),
      segments: editList.segments.length,
      mediaElements,
      nativeMediaMode,
    },
    coldLoad: null,
    randomSeeks: [],
    boundaries: [],
    resources: { proxyRequests: 0, proxyRangeRequests: 0, failures: [] },
    browserErrors: [],
    metrics: null,
    ok: false,
    failure: null,
  };
  let browser;
  try {
    const healthResponse = await fetch(`${options.studioUrl}/api/health`);
    const health = await healthResponse.json();
    assert(
      healthResponse.ok && health.ok === true && health.product === "chengfeng-videocut",
      "Isolated Studio health check failed",
      { health },
    );

    browser = await puppeteer.launch({
      executablePath: options.chrome,
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--no-first-run",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => report.browserErrors.push(`pageerror: ${error.message}`));
    page.on("error", (error) => report.browserErrors.push(`page-crash: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") report.browserErrors.push(`console: ${message.text()}`);
    });
    page.on("request", (request) => {
      if (!/source-proxy\.mp4(?:\?|$)/.test(request.url())) return;
      report.resources.proxyRequests += 1;
      if (request.headers().range) report.resources.proxyRangeRequests += 1;
    });
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText ?? "unknown";
      if (!/ERR_ABORTED/.test(reason)) report.resources.failures.push(`${reason}: ${request.url()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        report.resources.failures.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });

    const url = `${options.studioUrl}/#project/${encodeURIComponent(options.projectId)}` +
      `?v=native-edl-${Date.now()}&t=0&tab=design&rc=0`;
    const loadStartedAt = performance.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const ready = await waitFor(
      () => shellSnapshot(page),
      (value) => (
        value.ready &&
        value.hasBasePlayer &&
        value.hasExperimentRoot &&
        value.nativeMediaMode === nativeMediaMode &&
        value.videoCount === mediaElements / 2 &&
        value.audioCount === mediaElements / 2 &&
        value.readyVideos > 0 &&
        value.readyAudios > 0
      ),
      "198-segment native HyperFrames project",
      60_000,
    );
    report.coldLoad = {
      elapsedMs: Number((performance.now() - loadStartedAt).toFixed(1)),
      snapshot: ready,
    };
    // HyperFrames exposes its player clock on the 30 fps grid, so the final
    // duration may be ceiled by one frame relative to the millisecond EDL.
    assert(Math.abs(ready.duration - Number(editList.duration)) < 0.05, "Player duration differs from EDL", {
      ready,
    });
    assert(!ready.hasCustomAdapter, "Experiment accidentally loaded the product EDL adapter", { ready });

    for (const time of deterministicSeekTimes(editList, options.randomSeeks)) {
      report.randomSeeks.push(await seekAndVerify(page, editList, nativeMediaMode, time));
    }
    for (const boundary of representativeBoundaries(editList, options.boundarySamples)) {
      report.boundaries.push(await crossBoundary(page, editList, nativeMediaMode, boundary));
    }

    report.metrics = await page.metrics();
    const unexpectedErrors = report.browserErrors.filter((message) =>
      !/favicon|net::ERR_ABORTED|ResizeObserver loop/i.test(message));
    assert(unexpectedErrors.length === 0, "Browser emitted errors", { unexpectedErrors });
    assert(report.resources.failures.length === 0, "Media requests failed", {
      failures: report.resources.failures.slice(0, 20),
    });
    report.ok = true;
  } catch (error) {
    report.failure = error?.stack ?? error?.message ?? String(error);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await browser?.close();
  }

  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    report: options.reportPath,
    coldLoadMs: report.coldLoad?.elapsedMs ?? null,
    randomSeeks: report.randomSeeks.length,
    boundaries: report.boundaries.length,
    proxyRequests: report.resources.proxyRequests,
    failure: report.failure?.split("\n")[0] ?? null,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
