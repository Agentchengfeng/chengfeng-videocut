import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { startStudioServer } from "./server/start";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// Opt-in integration dependency is a sibling Skill source, never a Runtime import.
// CI/clean Runtime checkouts must explicitly supply the real candidate entrypoint.
const candidateScript = process.env.VIDEOCUT_E2E_CANDIDATE_SCRIPT;
const cliEntrypoint = process.env.VIDEOCUT_E2E_CLI ?? resolve(import.meta.dir, "cli.ts");
test.skipIf(!candidateScript)("production workbench CLI (external Skill): real WAV ingest, cuts CAS, Skill candidate, visuals and durable MP4", async () => {
  expect(candidateScript, "Set VIDEOCUT_E2E_CANDIDATE_SCRIPT to the actual Skill candidate.mjs").toBeTruthy();
  expect(isAbsolute(cliEntrypoint), "VIDEOCUT_E2E_CLI must be an explicit absolute entrypoint").toBe(true);
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbench-cli-e2e-")));
  const projectsDir = join(root, "registry"), client = join(root, "client"), staticDir = join(root, "static");
  const task = join(root, "isolated-speech"), source = join(root, "voice.wav");
  for (const directory of [projectsDir, client, staticDir, task]) await mkdir(directory);
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>isolated workbench</title>");
  await writeFile(join(staticDir, "chengfeng-videocut-capabilities.json"), JSON.stringify({ schemaVersion: 1, product: "chengfeng-videocut", studioVersion: "0.2.0", features: { topLevelViews: ["storyboard", "preview", "koubo"], legacyWorkbenchPanel: false, managedTimelineEditing: true } }));
  let server: Awaited<ReturnType<typeof startStudioServer>> | undefined;
  let bundleServer: ReturnType<typeof Bun.spawn> | undefined;
  let bundleStderr: Promise<string> | undefined;
  let staged: string | undefined;
  let providerCalls = 0, sequence = 0;
  const run = async (argv: string[], cwd = client) => {
    const process = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...globalThis.process.env, CHENGFENG_VIDEOCUT_PROJECTS_DIR: join(client, "missing-registry"), VIDEO_WORKBENCH_PROJECTS_DIR: join(client, "missing-registry-two") } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    return { stdout, stderr, exitCode };
  };
  try {
    const media = await run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", source]);
    expect(media.exitCode, media.stderr).toBe(0);
    const sourceSha256 = sha(await readFile(source));
    server = await startStudioServer({ host: "127.0.0.1", port: 0, projectsDir, dataDir: join(root, "data"), staticDir, installSignalHandlers: false,
      ingest: { runTranscription: async (directory, options) => {
        providerCalls++;
        const output = join(directory, options.output!);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify({ schemaVersion: 1, provider: "volcengine", language: "zh-CN", media: { source: options.video, sha256: sourceSha256, duration: 1.5 }, cues: [{ id: "cue", words: [{ id: "one", text: "你好", start: 0, end: .4 }, { id: "two", text: "继续", start: .5, end: 1 }, { id: "three", text: "测试", start: 1.1, end: 1.5 }] }] }));
        return { provider: "volcengine", source, output, cueCount: 1, wordCount: 3, duration: 1.5 };
      } },
    });
    let origin = new URL(server.url).origin;
    expect([15192, 15197, 4186]).not.toContain(server.port);
    const call = async (operation: string, input?: unknown, confirmed = false, project = "isolated-speech") => {
      let file: string | undefined;
      if (input !== undefined) { file = join(root, `request-${sequence++}.json`); await writeFile(file, JSON.stringify(input)); }
      const response = await run([process.execPath, cliEntrypoint, "workbench", operation, "--api-base", origin, "--json", ...(project ? ["--project", project] : []), ...(file ? ["--file", file] : []), ...(confirmed ? ["--confirmed"] : [])]);
      expect(response.stderr, operation).toBe("");
      const parsed = JSON.parse(response.stdout);
      console.log(JSON.stringify({ operation, exitCode: response.exitCode, ok: parsed.ok, error: parsed.error, state: parsed.data?.state }));
      return { ...parsed, exitCode: response.exitCode };
    };
    const good = async (operation: string, input?: unknown, confirmed = false, project = "isolated-speech") => {
      const response = await call(operation, input, confirmed, project);
      expect(response.exitCode, JSON.stringify(response)).toBe(0); return response.data;
    };
    await good("connect", undefined, false, "");
    const ingest = { operationId: "e2e-ingest", sourcePath: source, taskDirectory: task, expectedSourceSha256: sourceSha256 };
    expect((await call("ingest-start", ingest, false, "")).error.code).toBe("confirmation_required");
    expect(providerCalls).toBe(0);
    await good("ingest-start", ingest, true, "");
    let ingested: any;
    for (let i = 0; i < 100; i++) {
      ingested = await good("ingest-status", { operationId: ingest.operationId }, false, "");
      if (ingested.status !== "running") break;
      await Bun.sleep(30);
    }
    expect(ingested.status, JSON.stringify(ingested)).toBe("succeeded");
    expect(providerCalls).toBe(1);
    await good("ingest-status", { operationId: ingest.operationId }, false, "");
    expect(providerCalls).toBe(1);
    const headTask = join(root, "isolated-head"); await mkdir(headTask);
    await good("ingest-start", { ...ingest, operationId: "e2e-head", taskDirectory: headTask }, true, "");
    let head: any;
    for (let i = 0; i < 100; i++) {
      head = await good("ingest-status", { operationId: "e2e-head" }, false, "");
      if (head.status !== "running") break;
      await Bun.sleep(30);
    }
    expect(head.status).toBe("succeeded");
    if (process.env.VIDEOCUT_E2E_CLI) {
      // ASR-only preparation is complete. All remaining product operations and
      // real export workers now run against a separate packaged service process.
      const sourceOrigin = origin;
      await server.stop(); server = undefined;
      await expect(fetch(`${sourceOrigin}/api/health`)).rejects.toThrow();
      const env = { ...process.env };
      delete env.CHENGFENG_VIDEOCUT_STATIC_DIR;
      bundleServer = Bun.spawn([process.execPath, cliEntrypoint, "start", "--host", "127.0.0.1", "--port", "0", "--projects-dir", projectsDir, "--data-dir", join(root, "data"), "--json"], { cwd: client, env, stdout: "pipe", stderr: "pipe" });
      bundleStderr = new Response(bundleServer.stderr as ReadableStream<Uint8Array>).text();
      const reader = (bundleServer.stdout as ReadableStream<Uint8Array>).getReader();
      let output = "";
      try {
        while (!output.includes("\n")) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(Error("Bundle service readiness timed out after 15 seconds")), 15_000);
          })]).finally(() => clearTimeout(timeout));
          if (chunk.done) throw Error(`Bundle service exited before ready: ${output} ${await bundleStderr}`);
          output += new TextDecoder().decode(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const started = JSON.parse(output.split("\n")[0]!);
      expect(started.ok, output).toBe(true);
      expect(started.data.pid).toBe(bundleServer.pid);
      expect(started.data.pid).not.toBe(process.pid);
      expect([15192, 15197, 4186]).not.toContain(started.data.port);
      origin = new URL(started.data.url).origin;
      const identity = await good("connect", undefined, false, "");
      expect((await fetch(`${origin}/`)).status).toBe(200);
      console.log(JSON.stringify({ test: "bundle-service-started", pid: bundleServer.pid, origin, identity }));
      expect((await good("ingest-status", { operationId: ingest.operationId }, false, "")).status).toBe("succeeded");
      expect(providerCalls).toBe(2);
    }
    await good("workflow-get");
    await good("playback", { limit: 64 });
    const config = await good("config-get");
    await good("config-set", { expectedRevision: config.projectRevision, config: { aspectRatio: "4:3" } }, true);
    expect((await good("config-get")).config.aspectRatio).toBe("4:3");
    const cuts = await good("cuts-get");
    const cutInput = { operationId: "e2e-cuts", expectedRevision: cuts.revision, cutWordIds: ["one"], mode: "full-selection" };
    const beforeCuts = await readFile(join(task, "cut-selection.json"));
    expect((await call("cuts-put", cutInput)).error.code).toBe("confirmation_required");
    expect((await call("cuts-put", { ...cutInput, operationId: "e2e-rejected-cuts", expectedRevision: "0".repeat(64) }, true)).exitCode).not.toBe(0);
    expect(await readFile(join(task, "cut-selection.json"))).toEqual(beforeCuts);
    await good("cuts-put", cutInput, true);
    expect((await good("cuts-get")).document.cutWordIds).toContain("one");
    const inputs = await good("subtitle-inputs");
    staged = inputs.inputDirectory;
    expect(staged).toBeTruthy();
    const candidate = join(root, "candidate");
    const scriptArgs = ["--transcript", join(staged!, "transcript.json"), "--edit-list", join(staged!, "edit-list.json"), "--project-id", "isolated-speech"];
    if (inputs.files["subtitles.json"]) scriptArgs.push("--reviewed-subtitles", join(staged!, "subtitles.json"));
    const generated = await run([process.execPath, candidateScript!, "generate", ...scriptArgs, "--out", candidate]);
    expect(generated.exitCode, generated.stderr).toBe(0);
    const validated = await run([process.execPath, candidateScript!, "validate", ...scriptArgs, "--subtitles", join(candidate, "subtitles.json")]);
    expect(validated.exitCode, validated.stderr).toBe(0);
    const currentSubtitles = await good("subtitles-get");
    const submit = { expectedRevision: currentSubtitles.revision, candidateDirectory: candidate };
    expect((await call("subtitle-submit", submit)).error.code).toBe("confirmation_required");
    await good("subtitle-submit", submit, true);
    const subtitles = await good("subtitles-get");
    expect(subtitles.document.cues.length).toBeGreaterThan(0);
    const moduleDir = join(root, "module"); await mkdir(moduleDir);
    const html = '<!doctype html><html><body style="margin:0;background:transparent"><div style="color:white">CLI E2E</div><script>window.__setTime = function(t){};</script></body></html>';
    await writeFile(join(moduleDir, "index.html"), html);
    await writeFile(join(moduleDir, "module-manifest.json"), JSON.stringify({ schemaVersion: 1, moduleId: "e2e", version: "v1", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(html), sha256: sha(html) }] }));
    const published = await run([process.execPath, cliEntrypoint, "module", "publish", "isolated-speech", "--file", join(moduleDir, "module-manifest.json"), "--api-base", origin, "--confirmed", "--json"]);
    expect(published.exitCode, published.stdout + published.stderr).toBe(0);
    const publication = JSON.parse(published.stdout).data;
    const servedModule = await fetch(`${origin}/api/v1/projects/isolated-speech/visuals/module/${publication.entryPath}`);
    expect(servedModule.status).toBe(200);
    expect(await servedModule.text()).toBe(html);
    const broll = join(root, "broll.mp4");
    const brollGenerated = await run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=15:d=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", broll]);
    expect(brollGenerated.exitCode, brollGenerated.stderr).toBe(0);
    const imported = await good("media-import", { sourcePath: broll, expectedSourceSha256: sha(await readFile(broll)) }, true);
    expect((await good("media-get", { assetId: imported.manifest.assetId })).manifest.assetId).toBe(imported.manifest.assetId);
    const visual = { schemaVersion: 1, projectId: "isolated-speech", baseTranscriptRevision: sha(await readFile(join(task, "transcript.json"))), animationStyle: "xiaohei", layers: [{ id: "card", wordIds: ["three"], module: publication.entryPath }, { id: "broll", wordIds: ["two"], media: { assetId: imported.manifest.assetId, sourceIn: 0, sourceOut: .5, fit: "contain", muted: true } }] };
    await good("visuals-put", { expectedRevision: (await good("visuals-get")).revision, document: visual }, true);
    expect((await good("visuals-get")).document.layers).toHaveLength(2);
    const plan = await good("export-plan", { profile: "fast" });
    const outputPath = join(root, "final.mp4");
    const exportInput = { operationId: "e2e-export", expectedSnapshot: plan.snapshotFingerprint, outputPath, profile: "fast" };
    expect((await call("export-start", exportInput)).error.code).toBe("confirmation_required");
    const job = await good("export-start", exportInput, true);
    let finished: any;
    for (let i = 0; i < 150; i++) {
      finished = await good("job-by-operation", { operationId: exportInput.operationId });
      if (["succeeded", "failed", "recovery_blocked", "cancelled"].includes(finished.job?.state)) break;
      await Bun.sleep(100);
    }
    expect(finished.job.state, JSON.stringify(finished)).toBe("succeeded");
    expect(finished.job.jobId).toBe(job.jobId);
    const probe = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", outputPath]);
    expect(probe.exitCode, probe.stderr).toBe(0);
    const metadata = JSON.parse(probe.stdout);
    expect(Number(metadata.format.duration)).toBeGreaterThan(.5);
    expect(metadata.streams.map((s: any) => s.codec_type).sort()).toEqual(["audio", "video"]);
    expect((await call("job-by-operation", { operationId: "never-submitted" })).exitCode).not.toBe(0);
    // Exercise v2 only through its supported two-stage transaction routes.
    // This happens after the v1 candidate/export: the current Skill generator
    // explicitly rejects multiple-source inputs rather than silently flattening.
    const targetSources = await good("sources-get");
    const headSources = await good("sources-get", undefined, false, "isolated-head");
    const prepend = { operationId: "e2e-prepend", expectedTargetRevision: targetSources.revision, expectedSourceRevision: headSources.revision, sourceProjectId: "isolated-head", confirmed: false };
    const prependPlan = await good("prepend-plan", prepend);
    expect(prependPlan.committed).toBe(false);
    expect((await call("prepend-commit", { ...prepend, confirmed: true, planRevision: prependPlan.planRevision })).error.code).toBe("confirmation_required");
    await good("prepend-commit", { ...prepend, confirmed: true, planRevision: prependPlan.planRevision }, true);
    expect((await good("operation-get", { operationId: prepend.operationId })).state).toBe("committed");
    const v2Sources = await good("sources-get");
    const v2Transcript = JSON.parse(await readFile(join(task, "transcript.json"), "utf8"));
    const headWordId = v2Transcript.cues[0].words[0].id;
    const wordCut = { operationId: "e2e-word-cut", expectedTargetRevision: v2Sources.revision, wordIds: [headWordId], confirmed: false };
    const wordPlan = await good("word-cuts-plan", wordCut);
    expect(wordPlan.committed).toBe(false);
    await good("word-cuts-commit", { ...wordCut, confirmed: true, planRevision: wordPlan.planRevision }, true);
    const transaction = await good("operation-get", { operationId: wordCut.operationId });
    expect(transaction.state).toBe("committed");
    expect((await good("operation-get", { operationId: wordCut.operationId })).state).toBe("committed");
    expect(providerCalls).toBe(2);
    expect(sha(await readFile(source))).toBe(sourceSha256);
    expect(await readdir(client)).toEqual([]);
    console.log(JSON.stringify({ test: "workbench-production-e2e", origin, providerCalls, candidateScript, cliEntrypoint, outputSha256: sha(await readFile(outputPath)), duration: metadata.format.duration, jobId: job.jobId, clientRegistryCreated: false, mcpUsed: false }));
    if (bundleServer) {
      bundleServer.kill("SIGTERM");
      expect(await bundleServer.exited).toBe(143);
      expect(await bundleStderr).toBe("");
      bundleServer = undefined;
    }
    if (server) { await server.stop(); server = undefined; }
    await expect(fetch(`${origin}/api/health`)).rejects.toThrow();
  } finally {
    if (bundleServer) { bundleServer.kill("SIGTERM"); await bundleServer.exited; }
    if (server) await server.stop();
    if (staged) await rm(staged, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
