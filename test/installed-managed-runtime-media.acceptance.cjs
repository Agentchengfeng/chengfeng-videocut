"use strict";

// This is deliberately an opt-in *installed-product* acceptance test.  It is
// not a source-tree test and it must never discover or use the user's normal
// Runtime.  CI/release work supplies a freshly-installed candidate root under
// the OS temporary directory via CHENGFENG_VIDEOCUT_TEST_INSTALL_ROOT.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require("node:path");
const test = require("node:test");

const ROOT = resolve(__dirname, "..");
const FIXTURE = join(ROOT, "apps", "studio", "tests", "e2e", "fixtures", "design-panel-qa", "assets", "test.mp4");
const FIXTURE_SHA256 = "4662cef1ee4423640d4db8b8880ea889d6e0af6e4466d88f5ee15f2dc6d18030";
const ROOT_ENV = "CHENGFENG_VIDEOCUT_TEST_INSTALL_ROOT";
const KEEP_EVIDENCE_ENV = "CHENGFENG_VIDEOCUT_KEEP_ACCEPTANCE_EVIDENCE";
const IS_WINDOWS = process.platform === "win32";
const TOOL_SUFFIX = IS_WINDOWS ? ".exe" : "";
const LAUNCHER_NAME = IS_WINDOWS ? "chengfeng-videocut.cmd" : "chengfeng-videocut";
const MAX_OUTPUT = 64_000;

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function appendOutput(current, chunk) {
  return `${current}${chunk}`.slice(-MAX_OUTPUT);
}

function pathIsInside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function comparablePath(value) {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireRegularFile(path, label) {
  const info = await stat(path);
  assert.equal(info.isFile(), true, `${label} must be a regular file: ${path}`);
  if (!IS_WINDOWS) {
    assert.notEqual(info.mode & 0o111, 0, `${label} must be executable: ${path}`);
  }
}

async function requireManagedTool(toolsDir, name) {
  const tool = await realpath(join(toolsDir, `${name}${TOOL_SUFFIX}`));
  assert.equal(pathIsInside(toolsDir, tool), true, `${name} escaped the managed tools directory`);
  await requireRegularFile(tool, `managed ${name}`);
  return tool;
}

async function temporaryRoots() {
  // macOS frequently gives Node a per-user /var/folders/.../T directory while
  // release smoke scripts use /private/tmp.  Both are OS temporary roots; do
  // not mistake that difference for permission to point at a user Runtime.
  const candidates = [tmpdir(), ...(IS_WINDOWS ? [] : ["/tmp", "/private/tmp"])];
  const resolved = await Promise.all(candidates.map(async (candidate) => {
    try { return await realpath(candidate); }
    catch { return null; }
  }));
  return [...new Set(resolved.filter(Boolean))];
}

async function requireIsolatedCandidate(rawRoot) {
  assert.equal(typeof rawRoot, "string", `${ROOT_ENV} must be set`);
  assert.equal(rawRoot.trim(), rawRoot, `${ROOT_ENV} must not include leading or trailing whitespace`);
  assert.equal(isAbsolute(rawRoot), true, `${ROOT_ENV} must be an absolute path`);

  const [installRoot, systemTemporaryRoots] = await Promise.all([realpath(rawRoot), temporaryRoots()]);
  assert.equal(systemTemporaryRoots.length > 0, true, "could not resolve an OS temporary directory");
  assert.equal(
    systemTemporaryRoots.some((temporaryRoot) => comparablePath(installRoot) === comparablePath(temporaryRoot)),
    false,
    `${ROOT_ENV} cannot be a temporary directory root itself`,
  );
  assert.equal(
    systemTemporaryRoots.some((temporaryRoot) => pathIsInside(temporaryRoot, installRoot)),
    true,
    `${ROOT_ENV} must point below an OS temporary root (${systemTemporaryRoots.join(", ")}); refusing a user Runtime`,
  );
  const defaultRuntime = resolve(homedir(), ".chengfeng-videocut");
  assert.notEqual(
    comparablePath(installRoot),
    comparablePath(defaultRuntime),
    `${ROOT_ENV} must not be the user's normal Product Runtime root`,
  );

  const launcher = join(installRoot, "bin", LAUNCHER_NAME);
  const [appDir, toolsDir] = await Promise.all([
    realpath(join(installRoot, "app", "current")),
    realpath(join(installRoot, "tools", "current")),
  ]);
  assert.equal(pathIsInside(installRoot, appDir), true, "app/current resolved outside the candidate root");
  assert.equal(pathIsInside(installRoot, toolsDir), true, "tools/current resolved outside the candidate root");
  await requireRegularFile(launcher, "candidate stable launcher");

  const [bun, ffmpeg, ffprobe] = await Promise.all([
    requireManagedTool(toolsDir, "bun"),
    requireManagedTool(toolsDir, "ffmpeg"),
    requireManagedTool(toolsDir, "ffprobe"),
  ]);
  return { installRoot, launcher, appDir, toolsDir, bun, ffmpeg, ffprobe };
}

async function isolatedEnvironment(toolsDir, runRoot) {
  const home = join(runRoot, "home");
  const temporary = join(runRoot, "tmp");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temporary, { recursive: true })]);

  if (IS_WINDOWS) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    return {
      PATH: [toolsDir, join(systemRoot, "System32"), systemRoot].join(delimiter),
      HOME: home,
      USERPROFILE: home,
      TMP: temporary,
      TEMP: temporary,
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: join(systemRoot, "System32", "cmd.exe"),
      NO_COLOR: "1",
    };
  }
  return {
    PATH: [toolsDir, "/usr/bin", "/bin"].join(delimiter),
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
}

function commandFailure(label, file, args, result) {
  const command = [file, ...args].map((value) => JSON.stringify(value)).join(" ");
  const detail = [
    `${label} failed (${result.timedOut ? "timed out" : `exit ${result.code ?? result.signal ?? "unknown"}`}): ${command}`,
    result.stdout ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr ? `stderr:\n${result.stderr.trim()}` : "",
  ].filter(Boolean).join("\n");
  return new Error(detail);
}

function runCommand(label, file, args, options = {}) {
  const timeout = options.timeout ?? 30_000;
  return new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.once("error", finish(rejectResult));
    child.once("close", finish((code, signal) => {
      const result = { code, signal, stdout, stderr, timedOut };
      if (code === 0 && !timedOut) resolveResult(result);
      else rejectResult(commandFailure(label, file, args, result));
    }));
  });
}

function assertWindowsArgumentSafe(value) {
  assert.equal(
    /[\0\r\n"&|<>()^%!]/.test(value),
    false,
    `Windows candidate paths and arguments must not contain cmd metacharacters: ${JSON.stringify(value)}`,
  );
}

function spawnLauncher(launcher, args, options) {
  if (!IS_WINDOWS) {
    return spawn(launcher, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  // A .cmd stable launcher is not a native executable.  Use cmd.exe explicitly
  // and reject command metacharacters rather than inheriting a shell from the
  // user.  All accepted temporary roots generated by the installer are plain
  // filesystem paths, so this is a deliberate fail-closed safety check.
  for (const value of [launcher, ...args]) assertWindowsArgumentSafe(value);
  const command = `""${launcher}" ${args.map((value) => `"${value}"`).join(" ")}"`;
  return spawn(options.env.ComSpec, ["/d", "/v:off", "/s", "/c", command], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function startCandidateRuntime(launcher, environment, runRoot, dataDir, projectsDir) {
  const args = [
    "start",
    "--host", "127.0.0.1",
    "--port", "0",
    "--data-dir", dataDir,
    "--projects-dir", projectsDir,
    "--json",
  ];
  const child = spawnLauncher(launcher, args, { cwd: runRoot, env: environment });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
  child.stderr?.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });

  let url;
  try {
    url = await new Promise((resolveUrl, rejectUrl) => {
      let settled = false;
      const finish = (callback) => (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const parseUrl = () => {
        for (const line of stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const payload = JSON.parse(line);
            const value = payload?.data?.url;
            if (typeof value === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(value)) {
              finish(resolveUrl)(value);
              return;
            }
          } catch {
            // The stable launcher may split one JSON line across chunks.
          }
        }
      };
      const timer = setTimeout(() => finish(rejectUrl)(new Error(
        `candidate Runtime did not print its random loopback URL within 20 seconds\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )), 20_000);
      child.stdout?.on("data", parseUrl);
      child.once("error", finish(rejectUrl));
      child.once("close", (code, signal) => finish(rejectUrl)(new Error(
        `candidate Runtime exited before readiness (${code ?? signal ?? "unknown"})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )));
      parseUrl();
    });
  } catch (error) {
    // `server = await startCandidateRuntime(...)` has not assigned the caller's
    // cleanup handle yet.  Own startup failures here so a hung launcher can
    // never leave a foreground candidate behind.
    await stopCandidateRuntime({ child }, environment).catch(() => undefined);
    throw error;
  }
  return {
    child,
    url,
    diagnostics: () => ({ stdout, stderr }),
  };
}

function waitForChildClose(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveClose) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", finish);
      child.off("error", finish);
      resolveClose();
    };
    timer = setTimeout(finish, timeout);
    // Register before signalling the process so a very fast exit cannot make
    // us miss the event.  Clear the timeout on close: an orphaned sleep would
    // otherwise keep the Node acceptance runner alive after a successful stop.
    child.once("close", finish);
    child.once("error", finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

async function stopCandidateRuntime(server, environment) {
  const { child } = server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = waitForChildClose(child, 5_000);

  if (IS_WINDOWS && child.pid) {
    const taskkill = join(environment.SystemRoot, "System32", "taskkill.exe");
    try {
      await runCommand("candidate Runtime process-tree cleanup", taskkill, ["/PID", String(child.pid), "/T", "/F"], {
        cwd: dirname(taskkill), env: environment, timeout: 10_000,
      });
    } catch {
      // The foreground server may have already stopped between the check and
      // taskkill.  The close wait below remains the authoritative cleanup step.
    }
  } else {
    child.kill("SIGTERM");
  }

  await closed;
  if (child.exitCode === null && child.signalCode === null) {
    const killed = waitForChildClose(child, 5_000);
    child.kill("SIGKILL");
    await killed;
  }
}

async function jsonResponse(response, label) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}: ${body.slice(0, 4_000)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${body.slice(0, 4_000)}`);
  }
}

async function waitFor(label, check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await check();
    if (latest) return latest;
    await sleep(200);
  }
  throw new Error(`${label} did not reach the expected state within ${timeout}ms`);
}

function previewUrl(baseUrl, projectId, source) {
  return `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/preview/${source
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

async function verifyMedia(label, ffprobe, ffmpeg, file, environment, runRoot) {
  const probe = await runCommand(`${label} candidate ffprobe`, ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt,avg_frame_rate,nb_read_frames,width,height",
    "-of", "json",
    file,
  ], { cwd: runRoot, env: environment });
  let metadata;
  try {
    metadata = JSON.parse(probe.stdout);
  } catch {
    throw new Error(`${label} candidate ffprobe returned invalid JSON: ${probe.stdout}`);
  }
  const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  assert.equal(video?.codec_name, "h264", `${label} must be encoded as H.264`);
  assert.equal(audio?.codec_name, "aac", `${label} must contain AAC audio`);
  const frames = Number(video?.nb_read_frames);
  assert.equal(Number.isFinite(frames) && frames > 0, true, `${label} must contain decoded video frames`);
  const duration = Number(metadata.format?.duration);
  assert.equal(Number.isFinite(duration) && duration > 0.8 && duration < 1.8, true, `${label} duration must reflect the 1.3s edit list (got ${metadata.format?.duration})`);

  await runCommand(`${label} candidate ffmpeg decode`, ffmpeg, [
    "-v", "error",
    "-i", file,
    "-map", "0:v:0",
    "-map", "0:a:0",
    "-f", "null",
    "-",
  ], { cwd: runRoot, env: environment });
  return {
    path: file,
    codec: { video: video.codec_name, audio: audio.codec_name },
    frames,
    duration,
  };
}

async function createFreshProject(projectsDir) {
  const projectId = "smoke";
  const projectDir = join(projectsDir, projectId);
  const input = join(projectDir, "input.mp4");
  await mkdir(projectDir, { recursive: true });
  await copyFile(FIXTURE, input);
  const sourceSha256 = sha256(await readFile(input));
  assert.equal(sourceSha256, FIXTURE_SHA256, "the checked-in A/V fixture changed; update this acceptance contract deliberately");
  await Promise.all([
    writeFile(join(projectDir, "project.json"), `${JSON.stringify({ jobId: projectId, inputVideo: "input.mp4" })}\n`),
    // No ready previewProxy: this is intentionally the canonical, encoded
    // preview branch rather than ledger playback of an already-made proxy.
    writeFile(join(projectDir, "workbench.json"), `${JSON.stringify({ sourceSha256 })}\n`),
    writeFile(join(projectDir, "edit-list.json"), `${JSON.stringify({
      schemaVersion: 1,
      projectId,
      sourceDuration: 2,
      baseCutsRevision: "a".repeat(64),
      baseTranscriptRevision: "b".repeat(64),
      mode: "manual",
      duration: 1.3,
      segments: [
        {
          id: "a-roll-0001", source: "input.mp4", sourceStart: 0.1, sourceEnd: 0.7,
          timelineStart: 0, trackId: "a-roll", playbackRate: 1,
        },
        {
          id: "a-roll-0002", source: "input.mp4", sourceStart: 1.0, sourceEnd: 1.7,
          timelineStart: 0.6, trackId: "a-roll", playbackRate: 1,
        },
      ],
    })}\n`),
  ]);
  return { projectId, projectDir, input, sourceSha256 };
}

const requestedRoot = process.env[ROOT_ENV];
const skipReason = `Set ${ROOT_ENV} to a freshly-installed candidate below an OS temporary directory to run this installed Runtime media acceptance test.`;

test(
  "installed managed Runtime uses its bundled FFmpeg/x264 for encoded preview and export",
  { skip: requestedRoot ? false : skipReason, timeout: 180_000 },
  async () => {
    const candidate = await requireIsolatedCandidate(requestedRoot);
    const runRoot = await realpath(await mkdtemp(join(tmpdir(), "videocut-installed-media-acceptance-")));
    const keepEvidence = process.env[KEEP_EVIDENCE_ENV] === "1";
    let server = null;
    let environment = null;
    let passed = false;
    try {
      const [dataDir, projectsDir] = [join(runRoot, "data"), join(runRoot, "projects")];
      await mkdir(projectsDir, { recursive: true });
      environment = await isolatedEnvironment(candidate.toolsDir, runRoot);

      // This capability assertion is intentionally direct to the managed file;
      // later preview/export calls use only its containing directory in PATH.
      const encoders = await runCommand("managed FFmpeg encoder list", candidate.ffmpeg, ["-hide_banner", "-encoders"], {
        cwd: runRoot, env: environment,
      });
      assert.match(`${encoders.stdout}\n${encoders.stderr}`, /\blibx264\b/, "candidate FFmpeg does not provide libx264");

      const project = await createFreshProject(projectsDir);
      const originalBefore = sha256(await readFile(project.input));
      server = await startCandidateRuntime(candidate.launcher, environment, runRoot, dataDir, projectsDir);

      const health = await jsonResponse(await fetch(`${server.url}/api/health`), "candidate Runtime health");
      assert.equal(health.ok, true, "candidate Runtime health must be ok");
      assert.equal(health.runtimeMode, "foreground", "acceptance must not use a managed service");
      assert.equal(Array.isArray(health.mediaToolsMissing) && health.mediaToolsMissing.length > 0, false,
        `candidate Runtime cannot see its bundled media tools: ${JSON.stringify(health.mediaToolsMissing)}`);

      await jsonResponse(await fetch(`${server.url}/api/v1/projects/${project.projectId}/preview-artifact`, {
        method: "POST",
        headers: { Accept: "application/json" },
      }), "start encoded preview artifact");
      const preview = await waitFor("encoded preview artifact", async () => {
        const state = await jsonResponse(await fetch(
          `${server.url}/api/v1/projects/${project.projectId}/preview-artifact`,
          { headers: { Accept: "application/json" } },
        ), "poll encoded preview artifact");
        if (state.phase === "failed") {
          throw new Error(`encoded preview artifact failed: ${state.error ?? JSON.stringify(state)}`);
        }
        return state.phase === "current" ? state : null;
      });
      assert.equal(preview.profile, "sharp-canonical-v1", "preview must exercise the canonical encoded profile");
      assert.equal(preview.sourceKind, "canonical", "preview must not silently fall back to a proxy or ledger");
      assert.equal(preview.stream ?? null, null, "preview must be one encoded MP4, not stream fragments");
      assert.equal(typeof preview.source, "string", "encoded preview must report a project-relative source");
      const previewFile = resolve(project.projectDir, preview.source);
      assert.equal(pathIsInside(project.projectDir, previewFile), true, "preview source escaped the temporary project");

      const previewMedia = await fetch(previewUrl(server.url, project.projectId, preview.source), {
        headers: { Range: "bytes=0-0" },
      });
      assert.equal(previewMedia.status, 206, "encoded preview route must serve a byte range");
      assert.match(previewMedia.headers.get("content-type") ?? "", /^video\/mp4\b/i, "encoded preview route must be MP4");
      assert.equal(previewMedia.headers.get("accept-ranges"), "bytes", "encoded preview route must advertise byte ranges");
      assert.match(previewMedia.headers.get("content-range") ?? "", /^bytes 0-0\/\d+$/, "encoded preview route must honor bytes=0-0");
      await previewMedia.arrayBuffer();
      const verifiedPreview = await verifyMedia("encoded preview", candidate.ffprobe, candidate.ffmpeg, previewFile, environment, runRoot);

      const output = join(runRoot, "exported.mp4");
      const started = await jsonResponse(await fetch(`${server.url}/api/v1/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          kind: "export",
          target: project.projectId,
          params: { outputPath: output, scale: 1, fps: 15 },
        }),
      }), "start export job");
      assert.equal(typeof started.jobId, "string", "export start must return a jobId");
      const completed = await waitFor("export job", async () => {
        const job = await jsonResponse(await fetch(`${server.url}/api/v1/jobs/${encodeURIComponent(started.jobId)}`), "poll export job");
        if (["failed", "cancelled", "recovery_blocked"].includes(job.state)) {
          throw new Error(`export job stopped in ${job.state}: ${JSON.stringify(job.error ?? job)}`);
        }
        return job.state === "succeeded" ? job : null;
      }, 75_000);
      assert.equal(completed.phase, "published", "export job must reach published state");
      assert.equal(completed.result?.hasAudio, true, "export result must report audio");
      assert.deepEqual(completed.result?.problems, [], "export must not report readback problems");
      assert.equal(Number(completed.result?.renderedFrames) > 0, true, "export must render at least one frame");
      const verifiedExport = await verifyMedia("export", candidate.ffprobe, candidate.ffmpeg, output, environment, runRoot);

      const originalAfter = sha256(await readFile(project.input));
      assert.equal(originalAfter, originalBefore, "preview/export must not modify the input fixture");

      const evidence = {
        schemaVersion: 1,
        acceptance: "installed-managed-runtime-media",
        candidateRoot: candidate.installRoot,
        launcher: candidate.launcher,
        tools: { bun: candidate.bun, ffmpeg: candidate.ffmpeg, ffprobe: candidate.ffprobe },
        runtimeUrl: server.url,
        health: { runtimeMode: health.runtimeMode, mediaToolsMissing: health.mediaToolsMissing ?? [] },
        preview: verifiedPreview,
        export: { jobId: started.jobId, ...verifiedExport },
        fixtureSha256: originalAfter,
      };
      await writeFile(join(runRoot, "acceptance-result.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`[installed-managed-runtime-media] PASS ${JSON.stringify(evidence)}`);
      passed = true;
    } catch (error) {
      await writeFile(join(runRoot, "acceptance-failure.txt"), `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => undefined);
      throw error;
    } finally {
      if (server && environment) await stopCandidateRuntime(server, environment).catch(() => undefined);
      if (passed && !keepEvidence) {
        await rm(runRoot, { recursive: true, force: true });
      } else {
        console.log(`[installed-managed-runtime-media] evidence retained at ${runRoot}`);
      }
    }
  },
);
