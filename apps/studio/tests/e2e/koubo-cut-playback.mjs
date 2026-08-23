#!/usr/bin/env node

/**
 * Real-browser regression for the two playback seams that previously stalled
 * a talking-head project:
 *   1. A retained EDL boundary must stay continuous in the assembled stream.
 *   2. Saving a new cut while playing may rebuild the stream, but must resume.
 *
 * The source project is read-only. The runner creates a temporary project next
 * to it, hard-links input/source.mp4 (no 344 MB copy), registers that scratch
 * project in the running Studio, then removes both paths on exit.
 *
 * Usage:
 *   node apps/studio/tests/e2e/koubo-cut-playback.mjs \
 *     --studio-url http://127.0.0.1:5190 \
 *     --project-dir /absolute/path/to/product-e2e \
 *     --projects-dir /absolute/path/to/studio-projects
 *
 * Target the retained-segment boundary closest to a known timeline time with
 * --boundary-time 29.48 or VIDEOCUT_E2E_BOUNDARY_TIME=29.48. Without either,
 * the historical first-boundary selection remains unchanged.
 *
 * Add --keep-scratch to retain a failed fixture for manual inspection.
 */

import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import puppeteer from "puppeteer-core";

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REQUIRED_PROJECT_FILES = [
  "project.json",
  "workbench.json",
  "transcript.json",
  "cut-selection.json",
  "edit-list.json",
  "index.html",
];

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
  const required = (name) => {
    const value = values.get(name);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`--${name} is required`);
    }
    return resolve(value);
  };
  const studioUrl = String(values.get("studio-url") ?? "http://127.0.0.1:5190");
  const parsedStudioUrl = new URL(studioUrl);
  if (!/^https?:$/.test(parsedStudioUrl.protocol)) {
    throw new Error("--studio-url must use http or https");
  }
  const boundaryTimeValue = values.get("boundary-time") ??
    process.env.VIDEOCUT_E2E_BOUNDARY_TIME;
  let boundaryTime = null;
  if (boundaryTimeValue !== undefined) {
    if (boundaryTimeValue === true) {
      throw new Error("--boundary-time requires a numeric value");
    }
    boundaryTime = Number(boundaryTimeValue);
    if (!Number.isFinite(boundaryTime) || boundaryTime < 0) {
      throw new Error("--boundary-time must be a finite non-negative number");
    }
  }
  return {
    studioUrl: parsedStudioUrl.origin,
    projectDir: required("project-dir"),
    projectsDir: required("projects-dir"),
    chrome: resolve(String(values.get("chrome") ?? DEFAULT_CHROME)),
    keepScratch: values.has("keep-scratch"),
    boundaryTime,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

function assert(condition, message, details = {}) {
  if (condition) return;
  const suffix = Object.keys(details).length ? `\n${JSON.stringify(details, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
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

function projectUrl(studioUrl, projectId, time) {
  // `t` belongs to the project hash. Add an outer query nonce as well so each
  // probe is a real page load: navigating to the same hash route only updates
  // browser history and leaves the already-mounted transport at its old time.
  return `${studioUrl}/?view=koubo&e2e=${Date.now()}#project/${encodeURIComponent(projectId)}` +
    `?v=e2e-${Date.now()}&t=${time.toFixed(3)}&tab=design&rc=0`;
}

function allTranscriptWords(transcript) {
  const cues = Array.isArray(transcript?.cues) ? transcript.cues : [];
  return cues.flatMap((cue) => Array.isArray(cue?.words) ? cue.words : []);
}

function quantile(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentile;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return Number(
    (sorted[low] + (sorted[high] - sorted[low]) * (position - low)).toFixed(3),
  );
}

function auditFinalAudiblePauses(transcript, editList) {
  const words = allTranscriptWords(transcript)
    .sort((left, right) => Number(left.start) - Number(right.start));
  const pauseGroups = [];
  for (let index = 0; index < words.length;) {
    if (!words[index]?.isGap) {
      index += 1;
      continue;
    }
    const firstGapIndex = index;
    let end = Number(words[index].end);
    while (
      index + 1 < words.length &&
      words[index + 1]?.isGap &&
      Number(words[index + 1].start) <= end + 0.001
    ) {
      index += 1;
      end = Math.max(end, Number(words[index].end));
    }
    const hasSpeechBefore = words.slice(0, firstGapIndex).some((word) => !word.isGap);
    const hasSpeechAfter = words.slice(index + 1).some((word) => !word.isGap);
    if (hasSpeechBefore && hasSpeechAfter) {
      pauseGroups.push({ start: Number(words[firstGapIndex].start), end });
    }
    index += 1;
  }

  const segments = Array.isArray(editList?.segments) ? editList.segments : [];
  const retainedDurations = pauseGroups.map((pause) => Number(segments.reduce(
    (duration, segment) => duration + Math.max(
      0,
      Math.min(pause.end, Number(segment.sourceEnd)) -
        Math.max(pause.start, Number(segment.sourceStart)),
    ),
    0,
  ).toFixed(3)));
  const audible = retainedDurations.filter((duration) => duration > 0.001);
  const total = audible.reduce((sum, duration) => sum + duration, 0);
  return {
    sourcePauseGroups: pauseGroups.length,
    audiblePauseGroups: audible.length,
    fullyRemoved: retainedDurations.length - audible.length,
    totalSeconds: Number(total.toFixed(3)),
    mean: Number((total / Math.max(1, audible.length)).toFixed(3)),
    median: quantile(audible, 0.5),
    p90: quantile(audible, 0.9),
    max: audible.length ? Number(Math.max(...audible).toFixed(3)) : null,
    percentAtMost022: Number(
      (100 * audible.filter((duration) => duration <= 0.22).length /
        Math.max(1, audible.length)).toFixed(1),
    ),
    percentAtMost028: Number(
      (100 * audible.filter((duration) => duration <= 0.28).length /
        Math.max(1, audible.length)).toFixed(1),
    ),
    percentAtLeast035: Number(
      (100 * audible.filter((duration) => duration >= 0.35).length /
        Math.max(1, audible.length)).toFixed(1),
    ),
  };
}

async function printNaturalPauseAudit(projectDir) {
  const [transcript, editList] = await Promise.all([
    readJson(join(projectDir, "transcript.json")),
    readJson(join(projectDir, "edit-list.json")),
  ]);
  const finalAudit = auditFinalAudiblePauses(transcript, editList);
  const planPath = join(projectDir, "剪口播/3_审核/natural_pause_plan.json");
  const plan = await pathExists(planPath) ? await readJson(planPath) : null;
  const planSummary = plan ? {
    policy: plan.policy?.version ?? null,
    maxNaturalPauseSeconds: plan.policy?.maxNaturalPauseSeconds ?? null,
    pausesKept: plan.summary?.pausesKept ?? null,
    pausesCompressed: plan.summary?.pausesCompressed ?? null,
  } : null;
  console.log(`AUDIT natural-pause ${JSON.stringify({ plan: planSummary, final: finalAudit })}`);
}

function numericSummary(values) {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    min: Number(Math.min(...values).toFixed(3)),
    median: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    max: Number(Math.max(...values).toFixed(3)),
    mean: Number((total / values.length).toFixed(3)),
  };
}

function printEdlFragmentationAudit(editList) {
  const segments = Array.isArray(editList?.segments) ? editList.segments : [];
  const durations = segments.map((segment) => (
    (Number(segment.sourceEnd) - Number(segment.sourceStart)) /
      Math.max(Number(segment.playbackRate) || 1, 0.000001)
  ));
  const sourceJumps = segments.slice(1).map((segment, index) => (
    Number(segment.sourceStart) - Number(segments[index].sourceEnd)
  ));
  const duration = Number(editList?.duration) || durations.reduce((sum, value) => sum + value, 0);
  console.log(`AUDIT edl-fragmentation ${JSON.stringify({
    duration,
    segments: segments.length,
    boundaries: Math.max(0, segments.length - 1),
    boundariesPerMinute: Number(
      ((Math.max(0, segments.length - 1) * 60) / Math.max(duration, 0.001)).toFixed(1),
    ),
    segmentDuration: numericSummary(durations),
    tinySegments: {
      below015: durations.filter((value) => value < 0.15).length,
      below025: durations.filter((value) => value < 0.25).length,
      below050: durations.filter((value) => value < 0.5).length,
    },
    sourceJump: numericSummary(sourceJumps),
    largeJumps: {
      above1: sourceJumps.filter((value) => value > 1).length,
      above3: sourceJumps.filter((value) => value > 3).length,
      above10: sourceJumps.filter((value) => value > 10).length,
    },
  })}`);
}

function findCutBoundary(editList, preferredTimelineTime = null) {
  const segments = Array.isArray(editList?.segments) ? editList.segments : [];
  const candidates = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const previous = segments[index];
    const next = segments[index + 1];
    const deletedSourceSeconds = Number(next.sourceStart) - Number(previous.sourceEnd);
    const timelineBoundary = Number(next.timelineStart);
    if (
      Number.isFinite(deletedSourceSeconds) &&
      Number.isFinite(timelineBoundary) &&
      deletedSourceSeconds > 0.05 &&
      timelineBoundary >= 1
    ) {
      candidates.push({
        index,
        previous,
        next,
        deletedSourceSeconds,
        timelineBoundary,
      });
    }
  }

  if (preferredTimelineTime !== null) {
    const closest = candidates.sort((left, right) => (
      Math.abs(left.timelineBoundary - preferredTimelineTime) -
        Math.abs(right.timelineBoundary - preferredTimelineTime)
    ))[0];
    if (closest) return closest;
    throw new Error("Fixture has no retained-segment boundary near the requested timeline time");
  }

  // Preserve the original default: the first boundary that skips at least
  // three source seconds. Targeted runs may select any real discontinuity.
  const historicalDefault = candidates.find((candidate) => candidate.deletedSourceSeconds >= 3);
  if (historicalDefault) return historicalDefault;
  throw new Error("Fixture has no retained-segment boundary with at least 3 deleted source seconds");
}

function chooseFarFutureRetainedWord(transcript, cutSelection, sourceDuration) {
  const cutWordIds = new Set(Array.isArray(cutSelection?.cutWordIds)
    ? cutSelection.cutWordIds.map(String)
    : []);
  const candidates = allTranscriptWords(transcript).filter((word) => {
    const start = Number(word?.start);
    const end = Number(word?.end);
    return (
      word &&
      typeof word.id === "string" &&
      !cutWordIds.has(word.id) &&
      !word.isGap &&
      String(word.text ?? "").trim() &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start + 0.05 &&
      start > sourceDuration * 0.75
    );
  });
  // Large fixtures should change a late word so the running preview has real
  // future media to preserve. Tiny smoke fixtures may not contain a word past
  // the 75% mark, so their last retained word is still a valid live-refresh
  // probe rather than a reason to silently skip the regression.
  const word = candidates.at(-1) ?? allTranscriptWords(transcript).filter((candidate) => {
    const start = Number(candidate?.start);
    const end = Number(candidate?.end);
    return (
      candidate &&
      typeof candidate.id === "string" &&
      !cutWordIds.has(candidate.id) &&
      !candidate.isGap &&
      String(candidate.text ?? "").trim() &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start + 0.05
    );
  }).at(-1);
  if (!word) throw new Error("Fixture has no far-future retained speech word for mutation test");
  return word;
}

function isPathInside(parent, candidate) {
  const value = relative(parent, candidate);
  return Boolean(value) && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function requiredPreviewProxy(projectDir) {
  const [workbench, project] = await Promise.all([
    readJson(join(projectDir, "workbench.json")),
    readJson(join(projectDir, "project.json")),
  ]);
  const previewProxy = workbench?.previewProxy;
  assert(
    previewProxy && typeof previewProxy === "object" && previewProxy.status === "ready",
    "Fixture must have a ready previewProxy; refusing to fall back to the original source video",
    { status: previewProxy?.status ?? null },
  );
  assert(
    typeof previewProxy.source === "string" && previewProxy.source.trim(),
    "Ready previewProxy is missing its project-relative source path",
  );
  const digestPattern = /^[a-f0-9]{64}$/;
  const projectSourceSha256 = project?.source?.sha256;
  assert(
    digestPattern.test(previewProxy.sourceSha256) &&
      digestPattern.test(previewProxy.cacheKey) &&
      previewProxy.sourceSha256 === workbench.sourceSha256 &&
      previewProxy.sourceSha256 === projectSourceSha256 &&
      previewProxy.source.endsWith(`${previewProxy.cacheKey}.mp4`) &&
      typeof previewProxy.revision === "string" &&
      previewProxy.revision.startsWith(`${previewProxy.cacheKey}-`) &&
      Number.isFinite(Number(previewProxy.duration)) &&
      Number.isFinite(Number(workbench.duration)) &&
      Math.abs(Number(previewProxy.duration) - Number(workbench.duration)) <= 0.12 &&
      Number.isFinite(Number(previewProxy.startTime)) &&
      Math.abs(Number(previewProxy.startTime)) <= 0.05,
    "Fixture previewProxy metadata does not satisfy the Studio preview contract",
    {
      source: previewProxy.source,
      sourceSha256: previewProxy.sourceSha256 ?? null,
      workbenchSourceSha256: workbench.sourceSha256 ?? null,
      projectSourceSha256: projectSourceSha256 ?? null,
      cacheKey: previewProxy.cacheKey ?? null,
      revision: previewProxy.revision ?? null,
      proxyDuration: previewProxy.duration ?? null,
      projectDuration: workbench.duration ?? null,
      startTime: previewProxy.startTime ?? null,
    },
  );
  assert(
    !isAbsolute(previewProxy.source),
    "Ready previewProxy source must be relative to the fixture project",
    { source: previewProxy.source },
  );

  const declaredSource = resolve(projectDir, previewProxy.source);
  assert(
    isPathInside(projectDir, declaredSource),
    "Ready previewProxy source escapes the fixture project",
    { source: previewProxy.source },
  );
  assert(
    await pathExists(declaredSource),
    "Ready previewProxy file is missing; refusing to exercise the original source video",
    { source: previewProxy.source },
  );

  const sourcePath = await realpath(declaredSource);
  assert(
    isPathInside(await realpath(projectDir), sourcePath),
    "Ready previewProxy resolves outside the fixture project",
    { source: previewProxy.source, resolvedSource: sourcePath },
  );
  const info = await stat(sourcePath);
  assert(
    info.isFile() && info.size > 0 && extname(sourcePath).toLowerCase() === ".mp4",
    "Ready previewProxy is not a non-empty MP4 file",
    {
      source: previewProxy.source,
      byteLength: info.size,
    },
  );
  assert(
    Number(previewProxy.byteLength) === info.size,
    "Ready previewProxy byteLength does not match the file on disk",
    {
      source: previewProxy.source,
      declaredByteLength: previewProxy.byteLength ?? null,
      actualByteLength: info.size,
    },
  );

  return {
    relativePath: previewProxy.source,
    sourcePath,
    byteLength: info.size,
  };
}

async function materializePreviewProxy(proxy, scratchDir) {
  const targetPath = resolve(scratchDir, proxy.relativePath);
  assert(
    isPathInside(scratchDir, targetPath),
    "Ready previewProxy target escapes the scratch project",
    { source: proxy.relativePath },
  );
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await link(proxy.sourcePath, targetPath);
    return "hard-link";
  } catch (linkError) {
    try {
      await copyFile(proxy.sourcePath, targetPath);
      return "copy";
    } catch (copyError) {
      throw new Error(
        `Cannot materialize ready previewProxy in scratch project: ` +
          `link=${linkError.message}; copy=${copyError.message}`,
      );
    }
  }
}

async function createScratchFixture(options) {
  for (const file of REQUIRED_PROJECT_FILES) {
    assert(await pathExists(join(options.projectDir, file)), `Missing fixture file: ${file}`);
  }
  const sourceMedia = join(options.projectDir, "input/source.mp4");
  assert(await pathExists(sourceMedia), "Missing fixture media: input/source.mp4");
  const previewProxy = await requiredPreviewProxy(options.projectDir);

  const scratchDir = await mkdtemp(join(dirname(options.projectDir), ".koubo-playback-e2e-"));
  const projectId = basename(scratchDir);
  await mkdir(join(scratchDir, "input"), { recursive: true });
  for (const file of REQUIRED_PROJECT_FILES) {
    await copyFile(join(options.projectDir, file), join(scratchDir, file));
  }
  try {
    await link(sourceMedia, join(scratchDir, "input/source.mp4"));
  } catch (error) {
    throw new Error(
      `Cannot hard-link fixture media; keep the scratch project on the same volume: ${error.message}`,
    );
  }
  const previewProxyMaterialization = await materializePreviewProxy(previewProxy, scratchDir);

  const project = await readJson(join(scratchDir, "project.json"));
  project.jobId = projectId;
  project.title = projectId;
  project.workbench = {
    ...(project.workbench && typeof project.workbench === "object" ? project.workbench : {}),
    projectId,
    url: `${options.studioUrl}/#project/${encodeURIComponent(projectId)}`,
  };
  await writeJson(join(scratchDir, "project.json"), project);

  const workbench = await readJson(join(scratchDir, "workbench.json"));
  workbench.projectId = projectId;
  workbench.jobDir = scratchDir;
  await writeJson(join(scratchDir, "workbench.json"), workbench);

  const editList = await readJson(join(scratchDir, "edit-list.json"));
  editList.projectId = projectId;
  const editListRaw = `${JSON.stringify(editList, null, 2)}\n`;
  await writeFile(join(scratchDir, "edit-list.json"), editListRaw);

  // The copied index already contains the same segment projection, but its
  // revision belongs to the source project's edit-list.json.  Changing only
  // projectId changes that revision, and Studio intentionally refuses to run
  // a stale projection. Keep the scratch fixture internally consistent.
  const editListRevision = createHash("sha256").update(editListRaw).digest("hex");
  const indexPath = join(scratchDir, "index.html");
  const index = await readFile(indexPath, "utf8");
  const patchedIndex = index.replace(
    /data-edit-list-revision=("|')[^"']*\1/,
    `data-edit-list-revision="${editListRevision}"`,
  );
  assert(patchedIndex !== index, "Scratch index has no edit-list revision marker");
  await writeFile(indexPath, patchedIndex);

  await mkdir(options.projectsDir, { recursive: true });
  const registrationCandidate = join(options.projectsDir, projectId);
  const registration = resolve(registrationCandidate) === resolve(scratchDir)
    ? null
    : registrationCandidate;
  if (registration) {
    assert(!(await pathExists(registration)), `Scratch project id already registered: ${projectId}`);
    await symlink(scratchDir, registration, "dir");
  }
  console.log(
    `FIXTURE preview-proxy=${previewProxy.relativePath} ` +
      `bytes=${previewProxy.byteLength} via=${previewProxyMaterialization}`,
  );
  return { scratchDir, registration, projectId, editList };
}

async function playbackSnapshot(page) {
  return await page.evaluate(() => {
    const workspace = document.querySelector("[data-chengfeng-koubo-editor]");
    const artifact = document.querySelector("[data-preview-artifact-phase]");
    const video = document.querySelector("video[data-koubo-media-owner=\"video\"]");
    const stream = artifact?.getAttribute("data-preview-artifact-profile") === "ledger-proxy-v1";
    return {
      // The Product transport plays an assembled stream: media time and cut
      // timeline time are intentionally one clock, with no source-time jump.
      outerTime: Number(video?.currentTime),
      mediaTime: Number(video?.currentTime),
      videoPaused: video?.paused ?? null,
      readyState: video?.readyState ?? 0,
      duration: Number(video?.duration),
      previewPhase: artifact?.getAttribute("data-preview-artifact-phase") ?? null,
      previewCurrent: artifact?.getAttribute("data-preview-artifact-current") === "true",
      playsAssembledLedgerStream: stream,
      mediaOwnerCount: document.querySelectorAll("video[data-koubo-media-owner=\"video\"]").length,
      hasPreview: Boolean(workspace && video),
      playButton: Boolean(document.querySelector('button[aria-label="播放"]')),
      pauseButton: Boolean(document.querySelector('button[aria-label="暂停"]')),
      bodyTextLength: document.body?.innerText?.length ?? 0,
    };
  });
}

async function openReadyProject(page, url, expected = null) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return await waitFor(
    () => playbackSnapshot(page),
    (snapshot) => (
      snapshot.hasPreview &&
      snapshot.readyState >= 1 &&
      snapshot.previewCurrent &&
      snapshot.playsAssembledLedgerStream &&
      snapshot.mediaOwnerCount === 1 &&
      snapshot.playButton &&
      (!expected || (
        Math.abs(snapshot.outerTime - expected.timelineTime) < 0.2
      ))
    ),
    expected ? "ready paused EDL preview at requested timeline time" : "ready paused EDL preview",
    30_000,
  );
}

async function clickTransport(page, label) {
  const selector = `button[aria-label="${label}"]`;
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.click(selector);
}

async function verifyExistingCutBoundary(page, options, fixture) {
  const boundary = findCutBoundary(fixture.editList, options.boundaryTime);
  if (options.boundaryTime !== null) {
    console.log(
      `TARGET boundary requested=${options.boundaryTime.toFixed(3)} ` +
        `selected=${boundary.timelineBoundary.toFixed(3)} ` +
        `distance=${Math.abs(boundary.timelineBoundary - options.boundaryTime).toFixed(3)}`,
    );
  }
  const startTime = Math.max(0, boundary.timelineBoundary - 0.45);
  const before = await openReadyProject(
    page,
    projectUrl(options.studioUrl, fixture.projectId, startTime),
    { timelineTime: startTime },
  );
  assert(
    before.mediaOwnerCount === 1 && before.playsAssembledLedgerStream,
    "Preview did not load the single assembled Product media stream",
    { before, boundary },
  );

  await clickTransport(page, "播放");
  const after = await waitFor(
    () => playbackSnapshot(page),
    (snapshot) => (
      snapshot.outerTime > boundary.timelineBoundary + 0.25 &&
      snapshot.pauseButton &&
      !snapshot.videoPaused
    ),
    "assembled playhead to cross an existing deleted range",
  );
  assert(
    Math.abs(after.outerTime - after.mediaTime) < 0.02,
    "Assembled media clock diverged from the cut timeline at an EDL boundary",
    { before, after, boundary },
  );
  assert(
    after.mediaOwnerCount === 1 && after.playsAssembledLedgerStream,
    "Playback crossed an EDL boundary without the one continuous Product stream",
    { before, after, boundary },
  );
  await clickTransport(page, "暂停");
  console.log(
    `PASS existing-cut-boundary timeline=${boundary.timelineBoundary.toFixed(3)} ` +
      `assembled=${before.mediaTime.toFixed(3)}->${after.mediaTime.toFixed(3)}`,
  );
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed (${response.status}): ` +
      JSON.stringify(payload));
  }
  return payload;
}

async function verifyLiveCutRefresh(page, options, fixture) {
  const transcript = await readJson(join(fixture.scratchDir, "transcript.json"));
  const storedCuts = await readJson(join(fixture.scratchDir, "cut-selection.json"));
  const sourceDuration = Number(fixture.editList.sourceDuration);
  const targetWord = chooseFarFutureRetainedWord(transcript, storedCuts, sourceDuration);
  const cutsUrl = `${options.studioUrl}/api/v1/projects/` +
    `${encodeURIComponent(fixture.projectId)}/cuts`;

  const liveMutationStart = 1;
  await openReadyProject(
    page,
    projectUrl(options.studioUrl, fixture.projectId, liveMutationStart),
    { timelineTime: liveMutationStart },
  );
  await clickTransport(page, "播放");
  const playingBefore = await waitFor(
    () => playbackSnapshot(page),
    (snapshot) => snapshot.pauseButton && !snapshot.videoPaused && snapshot.outerTime > 1.2,
    "playback before live cut mutation",
  );
  const resource = await fetchJson(cutsUrl);
  const cutWordIds = Array.isArray(resource.document?.cutWordIds)
    ? resource.document.cutWordIds.map(String)
    : [];
  assert(!cutWordIds.includes(targetWord.id), "Chosen mutation word is already deleted", {
    targetWord,
  });
  const changed = await fetchJson(cutsUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      expectedRevision: resource.revision,
      cutWordIds: [...cutWordIds, targetWord.id],
      mode: "full-selection",
    }),
  });
  assert(changed.changed === true, "Live cut mutation did not change the fixture", { changed });
  assert(
    typeof changed.editListRevision === "string" && changed.editListRevision.length === 64,
    "Live cut mutation did not return a materialized edit-list revision",
    { changed },
  );

  const previewArtifactUrl = `${options.studioUrl}/api/v1/projects/` +
    `${encodeURIComponent(fixture.projectId)}/preview-artifact`;
  const resumedState = await waitFor(
    async () => ({
      snapshot: await playbackSnapshot(page),
      artifact: await fetchJson(previewArtifactUrl),
    }),
    ({ snapshot, artifact }) => (
      snapshot.hasPreview &&
      artifact.artifactRevision === changed.editListRevision &&
      snapshot.previewCurrent &&
      snapshot.pauseButton &&
      !snapshot.videoPaused &&
      snapshot.outerTime > playingBefore.outerTime + 0.25
    ),
    "preview reload to preserve and resume playback after deletion",
    30_000,
  );
  const resumed = resumedState.snapshot;
  assert(
    resumed.outerTime >= playingBefore.outerTime - 0.25,
    "Preview reset behind the confirmed playhead after deletion",
    { playingBefore, resumed, targetWord },
  );
  assert(resumed.bodyTextLength > 100, "Studio became blank after live cut refresh", { resumed });
  await clickTransport(page, "暂停");
  console.log(
    `PASS live-cut-refresh word=${targetWord.id} ` +
      `timeline=${playingBefore.outerTime.toFixed(3)}->${resumed.outerTime.toFixed(3)}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const health = await fetchJson(`${options.studioUrl}/api/health`);
  assert(health.ok === true && health.product === "chengfeng-videocut", "Studio health check failed", {
    health,
  });
  await printNaturalPauseAudit(options.projectDir);
  const sourceEditList = await readJson(join(options.projectDir, "edit-list.json"));
  printEdlFragmentationAudit(sourceEditList);

  let fixture;
  let browser;
  const browserErrors = [];
  try {
    fixture = await createScratchFixture(options);
    // Let the running registry watcher discover the new symlink before opening it.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
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
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });

    await verifyExistingCutBoundary(page, options, fixture);
    await verifyLiveCutRefresh(page, options, fixture);
    const unexpectedErrors = browserErrors.filter((message) =>
      !/favicon|net::ERR_ABORTED|ResizeObserver loop/i.test(message));
    assert(unexpectedErrors.length === 0, "Browser emitted errors during playback regression", {
      errors: unexpectedErrors,
    });
    console.log(`ALL PASS build=${health.studioBuildId} scratch=${fixture.projectId}`);
  } finally {
    await browser?.close().catch(() => undefined);
    if (fixture && !options.keepScratch) {
      if (fixture.registration) await rm(fixture.registration, { force: true });
      await rm(fixture.scratchDir, { recursive: true, force: true });
    } else if (fixture) {
      console.log(
        `KEPT scratch=${fixture.scratchDir} registration=${fixture.registration ?? "direct"}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
