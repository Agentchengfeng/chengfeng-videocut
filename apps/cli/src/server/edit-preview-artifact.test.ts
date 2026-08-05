import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { serializeProjectOperation } from "@video-workbench/core/node";
import {
  EditPreviewArtifactManager,
  createEditPreviewArtifactHandler,
  editPreviewArtifactCacheKey,
  editPreviewArtifactConfig,
  generatePreviewArtifactVideo,
  resetCanonicalVerificationCacheForTest,
  projectInput,
  verifyCanonicalSource,
  type ProjectInput,
} from "./edit-preview-artifact";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(options: { frameRate?: number | null } = {}) {
  const projectsDir = await mkdtemp(join(tmpdir(), "preview-artifact-test-"));
  const projectId = "demo";
  const projectDir = join(projectsDir, projectId);
  await mkdir(join(projectDir, ".chengfeng-videocut", "preview"), { recursive: true });
  await writeFile(join(projectDir, ".chengfeng-videocut", "preview", "source.mp4"), "proxy");
  await writeFile(join(projectDir, "workbench.json"), JSON.stringify({
    sourceSha256: "a".repeat(64),
    previewProxy: {
      source: ".chengfeng-videocut/preview/source.mp4",
      revision: "proxy-revision-1",
      cacheKey: "proxy-cache-1",
      ...(options.frameRate === null ? {} : { frameRate: options.frameRate ?? 30 }),
    },
  }));
  const writeEdit = async (end: number) => {
    const raw = `${JSON.stringify({
      schemaVersion: 1, projectId, mode: "manual", sourceDuration: 10, duration: end,
      baseCutsRevision: "b".repeat(64), baseTranscriptRevision: "c".repeat(64),
      segments: [{ id: "a", source: "input/source.mp4", sourceStart: 0, sourceEnd: end,
        timelineStart: 0, trackId: "a-roll", playbackRate: 1 }],
    }, null, 2)}\n`;
    await writeFile(join(projectDir, "edit-list.json"), raw);
    return digest(raw);
  };
  return { projectsDir, projectId, projectDir, writeEdit };
}

async function command(name: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(name, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`${name} exited with ${code}`)));
  });
}

async function commandOutput(name: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout || stderr)
      : reject(new Error(`${name} exited with ${code}: ${stderr.trim()}`)));
  });
}

function signalStats(output: string): Record<string, number> {
  return Object.fromEntries(
    Array.from(output.matchAll(/lavfi\.signalstats\.([A-Z]+)=([0-9.]+)/g))
      .map((match) => [match[1] ?? "", Number(match[2])]),
  );
}

async function waitFor(manager: EditPreviewArtifactManager, projectId: string, phase: string) {
  for (let index = 0; index < 100; index += 1) {
    const state = await manager.status(projectId);
    if (state.phase === phase) return state;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${phase}`);
}

test("preview-artifact API rejects decoded traversal before manager or external paths", async () => {
  const f = await fixture();
  const outside = join(dirname(f.projectsDir), "preview-artifact-api-victim.txt");
  await writeFile(outside, "sentinel");
  const manager = {
    ensure: async () => { throw new Error("manager must not be called"); },
    retry: () => { throw new Error("manager must not be called"); },
  } as unknown as EditPreviewArtifactManager;
  const handler = createEditPreviewArtifactHandler(manager);
  let ensureCalls = 0;
  let retryCalls = 0;
  (manager as unknown as { ensure: () => Promise<never> }).ensure = async () => {
    ensureCalls += 1;
    throw new Error("manager must not be called");
  };
  (manager as unknown as { retry: () => void }).retry = () => { retryCalls += 1; };

  for (const encodedId of ["%2e%2e%2Fvictim", "%2Fprivate%2Ftmp", "%5Cvictim", "..%252Fvictim", "%252Fprivate"]) {
    for (const method of ["GET", "POST"] as const) {
      const response = await handler(new Request(`http://localhost/api/v1/projects/${encodedId}/preview-artifact`, { method }));
      if (!response) throw new Error("preview-artifact route must match");
      expect(response.status).toBe(400);
    }
  }
  expect(ensureCalls).toBe(0);
  expect(retryCalls).toBe(0);
  expect(await readFile(outside, "utf8")).toBe("sentinel");
  await rm(outside, { force: true });
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("preview artifacts accept an explicitly registered external project symlink", async () => {
  const f = await fixture();
  await f.writeEdit(3);
  const externalRoot = await mkdtemp(join(tmpdir(), "preview-artifact-external-project-"));
  const externalProject = join(externalRoot, f.projectId);
  await rename(f.projectDir, externalProject);
  await symlink(externalProject, join(f.projectsDir, f.projectId), "dir");

  const input = await projectInput(f.projectsDir, f.projectId);
  expect(input.projectDir).toBe(await realpath(externalProject));
  expect(input.sourceProxy).toBe(await realpath(join(externalProject, ".chengfeng-videocut", "preview", "source.mp4")));

  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) { await writeFile(output, "external-artifact"); return {} as never; },
    async probe() {
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });
  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  expect(current.phase).toBe("current");
  expect(current.source).toMatch(/^\.chengfeng-videocut\/preview-edited\/[a-f0-9]{64}\.mp4$/);

  await rm(f.projectsDir, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
});

test("sharp preview quality scales to a verified 960x720 canonical source", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const input: ProjectInput = {
    projectId: f.projectId, projectDir: f.projectDir, editRevision: revision, sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, "input", "source.mp4"), sourceKind: "canonical", previewProfile: "sharp-canonical-v1",
    sourceWidth: 960, sourceHeight: 720, previewFrameRate: 60,
    previewProxyRevision: "unused", previewProxyCacheKey: "unused", duration: 3,
    segments: [{ source: "input/source.mp4", start: 0, end: 3, playbackRate: 1 }],
  };
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => input,
    async generate({ output }) { await writeFile(output, "low-resolution-sharp-preview"); return {} as never; },
    async probe() {
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 2_884_508,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720, frameRate: 60 };
    },
  });
  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  expect(current.phase).toBe("current");
  expect(current.width).toBe(960);
  expect(current.height).toBe(720);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("canonical fallback is allowed only when canonical lineage is absent", async () => {
  const f = await fixture();
  await f.writeEdit(3);
  const fast = await projectInput(f.projectsDir, f.projectId);
  expect(fast.sourceKind).toBe("fast-proxy");
  expect(fast.previewProfile).toBe("fast-proxy-v1");

  const cases: Array<{ name: string; source: string; setup?: () => Promise<void> }> = [
    { name: "escape", source: "../outside.mp4" },
    { name: "missing", source: "input/missing.mp4" },
    { name: "directory", source: "input/directory", setup: async () => { await mkdir(join(f.projectDir, "input", "directory"), { recursive: true }); } },
    { name: "invalid-media", source: "input/invalid.mp4", setup: async () => { await mkdir(join(f.projectDir, "input"), { recursive: true }); await writeFile(join(f.projectDir, "input", "invalid.mp4"), "not a video"); } },
  ];
  for (const scenario of cases) {
    await scenario.setup?.();
    await writeFile(join(f.projectDir, "project.json"), JSON.stringify({ source: { path: scenario.source } }));
    await expect(projectInput(f.projectsDir, f.projectId)).rejects.toThrow();
  }
  await expect(projectInput(f.projectsDir, "../victim")).rejects.toThrow("Invalid project id");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("cache key binds source, edit revision and config", () => {
  const base = { sourceSha256: "a".repeat(64), editRevision: "b".repeat(64) };
  expect(editPreviewArtifactCacheKey(base)).not.toBe(editPreviewArtifactCacheKey({ ...base, editRevision: "c".repeat(64) }));
  expect(editPreviewArtifactCacheKey(base)).not.toBe(editPreviewArtifactCacheKey({ ...base, config: { profile: "other" } }));
  expect(editPreviewArtifactCacheKey({ ...base, config: { previewProxyRevision: "a" } }))
    .not.toBe(editPreviewArtifactCacheKey({ ...base, config: { previewProxyRevision: "b" } }));
  expect(editPreviewArtifactCacheKey({ ...base, config: { previewProxyCacheKey: "a" } }))
    .not.toBe(editPreviewArtifactCacheKey({ ...base, config: { previewProxyCacheKey: "b" } }));
});

test("artifact content key follows normalized playback projection, not unrelated edit revision fields", () => {
  const base: ProjectInput = {
    projectId: "demo", projectDir: "/tmp/demo", editRevision: "r1", sourceSha256: "a".repeat(64),
    sourceProxy: "/tmp/demo/input/source.mp4", sourceKind: "canonical", previewProfile: "sharp-canonical-v1",
    previewFrameRate: 60, previewProxyRevision: "unused", previewProxyCacheKey: "unused", duration: 3,
    segments: [{ source: "input/source.mp4", start: 0, end: 3, playbackRate: 1 }],
  };
  const key = (input: ProjectInput) => editPreviewArtifactCacheKey({
    sourceSha256: input.sourceSha256, editRevision: input.editRevision, config: editPreviewArtifactConfig(input),
  });
  expect(key({ ...base, editRevision: "r2" })).toBe(key(base));
  expect(key({ ...base, segments: [{ ...base.segments[0], end: 2.9 }] })).not.toBe(key(base));
  expect(key({ ...base, segments: [{ ...base.segments[0], playbackRate: 1.25 }] })).not.toBe(key(base));
  expect(key({ ...base, segments: [{ ...base.segments[0], start: 1, end: 3 }, { ...base.segments[0], start: 0, end: 1 }] })).not.toBe(key(base));
});

test("canonical verification single-flights concurrent probes, revalidates a changed fingerprint, and clears failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "canonical-verification-"));
  const source = join(root, "source.mp4");
  await writeFile(source, "first");
  resetCanonicalVerificationCacheForTest();
  let probeCalls = 0;
  let hashCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const dependencies = {
    async probe() { probeCalls += 1; await gate; return { frameRate: 60 }; },
    async hash() { hashCalls += 1; await gate; return "a".repeat(64); },
  };
  const concurrent = Array.from({ length: 6 }, () =>
    verifyCanonicalSource(source, "a".repeat(64), dependencies));
  await Bun.sleep(5);
  expect(probeCalls).toBe(1);
  expect(hashCalls).toBe(1);
  release();
  await Promise.all(concurrent);
  expect(probeCalls).toBe(1);
  expect(hashCalls).toBe(1);

  await writeFile(source, "second-fingerprint");
  await verifyCanonicalSource(source, "a".repeat(64), {
    async probe() { probeCalls += 1; return { frameRate: 30 }; },
    async hash() { hashCalls += 1; return "a".repeat(64); },
  });
  expect(probeCalls).toBe(2);
  expect(hashCalls).toBe(2);

  resetCanonicalVerificationCacheForTest();
  let failedCalls = 0;
  await expect(verifyCanonicalSource(source, "a".repeat(64), {
    async probe() { failedCalls += 1; throw new Error("probe failed"); },
    async hash() { return "a".repeat(64); },
  })).rejects.toThrow("probe failed");
  await verifyCanonicalSource(source, "a".repeat(64), {
    async probe() { failedCalls += 1; return { frameRate: 60 }; },
    async hash() { return "a".repeat(64); },
  });
  expect(failedCalls).toBe(2);
  await rm(root, { recursive: true, force: true });
});

test("canonical verification does not memoize a source whose fingerprint changes during probe/hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "canonical-fingerprint-race-"));
  const source = join(root, "source.mp4");
  await writeFile(source, "first");
  resetCanonicalVerificationCacheForTest();
  const firstHash = digest("first");
  await expect(verifyCanonicalSource(source, firstHash, {
    async probe() { return { frameRate: 60 }; },
    async hash(path) {
      const value = await readFile(path, "utf8");
      const before = await stat(path);
      await writeFile(path, "other");
      await utimes(path, before.atime, new Date(before.mtimeMs + 2_000));
      return digest(value);
    },
  })).rejects.toThrow("changed during verification");

  await expect(verifyCanonicalSource(source, digest("other"), {
    async probe() { return { frameRate: 60 }; },
    async hash(path) { return digest(await readFile(path, "utf8")); },
  })).resolves.toMatchObject({ frameRate: 60 });
  await rm(root, { recursive: true, force: true });
});

test("late r17 cannot publish over r18 and same revision hits cache", async () => {
  const f = await fixture();
  const r17 = await f.writeEdit(3);
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let calls = 0;
  const frameRates: number[] = [];
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output, frameRate }) {
      calls += 1;
      frameRates.push(frameRate);
      if (calls === 1) {
        markFirstStarted();
        await first;
      }
      await writeFile(output, `artifact-${calls}`);
      return {} as never;
    },
    async probe(path) {
      const body = await readFile(path, "utf8");
      return { duration: body === "artifact-1" ? 3 : 4, hasVideo: true, hasAudio: true,
        videoBitrate: 1, videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });
  manager.schedule(f.projectId);
  await firstStarted;
  const r18 = await f.writeEdit(4);
  manager.schedule(f.projectId);
  releaseFirst();
  const current = await waitFor(manager, f.projectId, "current");
  expect(current.editRevision).toBe(r18);
  expect(current.artifactRevision).toBe(r18);
  expect(current.artifactRevision).not.toBe(r17);
  expect(calls).toBe(2);
  expect(frameRates).toEqual([30, 30]);
  const cached = await manager.ensure(f.projectId);
  expect(cached).toMatchObject({
    phase: "current",
    editRevision: r18,
    artifactRevision: r18,
  });
  expect(calls).toBe(2);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("late schedule input cannot overwrite a newer desired revision", async () => {
  const f = await fixture();
  const r17 = await f.writeEdit(3);
  const r18 = await f.writeEdit(4);
  let releaseOld!: () => void;
  const oldInput = new Promise<ProjectInput>((resolve) => {
    releaseOld = () => resolve({
      projectId: f.projectId,
      projectDir: f.projectDir,
      editRevision: r17,
      sourceSha256: "a".repeat(64),
      sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
      previewFrameRate: 30,
      previewProxyRevision: "proxy-revision-1",
      previewProxyCacheKey: "proxy-cache-1",
      duration: 3,
      segments: [{ start: 0, end: 3 }],
    });
  });
  const newerInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: r18,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 4,
    segments: [{ start: 0, end: 4 }],
  };
  let reads = 0;
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => {
      reads += 1;
      if (reads === 1) return await oldInput;
      return newerInput;
    },
    async generate({ output }) {
      calls += 1;
      await writeFile(output, `artifact-${calls}`);
      return {} as never;
    },
    async probe() {
      return { duration: 4, hasVideo: true, hasAudio: true,
        videoBitrate: 1, videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });
  manager.schedule(f.projectId);
  await Bun.sleep(5);
  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  releaseOld();
  await Bun.sleep(30);
  expect(current.editRevision).toBe(r18);
  expect(calls).toBe(1);
  const stillCurrent = await manager.status(f.projectId);
  expect(stillCurrent.editRevision).toBe(r18);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("same edit revision becomes stale when preview proxy lineage changes", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  let proxyCacheKey = "proxy-cache-1";
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) { await writeFile(output, "ok"); return {} as never; },
    async probe() { return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
      videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 }; },
  });
  manager.schedule(f.projectId);
  await waitFor(manager, f.projectId, "current");
  await writeFile(join(f.projectDir, "workbench.json"), JSON.stringify({
    sourceSha256: "a".repeat(64),
    previewProxy: {
      source: ".chengfeng-videocut/preview/source.mp4",
      revision: "proxy-revision-1",
      cacheKey: proxyCacheKey = "proxy-cache-2",
      frameRate: 30,
    },
  }));
  const state = await manager.status(f.projectId);
  expect(revision).toBeTruthy();
  expect(proxyCacheKey).toBe("proxy-cache-2");
  expect(state.phase).toBe("stale");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("warm current is stale when its artifact file is missing", async () => {
  const f = await fixture();
  await f.writeEdit(3);
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) { await writeFile(output, "ok"); return {} as never; },
    async probe() { return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
      videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 }; },
  });
  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  if (!current.source) throw new Error("expected current source");
  await rm(join(f.projectDir, current.source), { force: true });

  const stale = await manager.status(f.projectId);

  expect(stale.phase).toBe("stale");
  expect(stale.cacheKey).toBe(current.cacheKey);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("warm current rejects wrong phase, source hash, and source path even when size matches", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) { await writeFile(output, "ok"); return {} as never; },
    async probe() { return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
      videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 }; },
  });
  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  if (!current.source) throw new Error("expected current source");
  const wrongSource = ".chengfeng-videocut/preview-edited/wrong.mp4";
  await writeFile(join(f.projectDir, wrongSource), await readFile(join(f.projectDir, current.source)));
  await writeFile(join(f.projectDir, ".chengfeng-videocut", "preview-edited", "current.json"), `${JSON.stringify({
    ...current,
    phase: "failed",
    sourceSha256: "b".repeat(64),
    source: wrongSource,
    byteLength: current.byteLength,
    editRevision: revision,
    artifactRevision: revision,
    cacheKey: current.cacheKey,
  }, null, 2)}\n`);

  const stale = await manager.status(f.projectId);

  expect(stale.phase).toBe("stale");
  expect(stale.source).toBe(wrongSource);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("warm current rejects wrong schema version and project id", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) { await writeFile(output, "ok"); return {} as never; },
    async probe() { return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
      videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 }; },
  });
  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  await writeFile(join(f.projectDir, ".chengfeng-videocut", "preview-edited", "current.json"), `${JSON.stringify({
    ...current,
    schemaVersion: 2,
    projectId: "other-project",
    editRevision: revision,
    artifactRevision: revision,
  }, null, 2)}\n`);

  const stale = await manager.status(f.projectId);

  expect(stale.phase).toBe("stale");
  expect(Number((stale as unknown as { schemaVersion: number }).schemaVersion)).toBe(2);
  expect(stale.projectId).toBe("other-project");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("publish CAS rejects a generated artifact when same-revision proxy lineage changes mid-flight", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const sourceProxy = join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4");
  const firstInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy,
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const secondInput: ProjectInput = {
    ...firstInput,
    previewProxyRevision: "proxy-revision-2",
    previewProxyCacheKey: "proxy-cache-2",
  };
  let currentInput = firstInput;
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => currentInput,
    async generate({ output }) {
      calls += 1;
      if (calls === 1) currentInput = secondInput;
      await writeFile(output, `artifact-${calls}`);
      return {} as never;
    },
    async probe() {
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  const expected = editPreviewArtifactCacheKey({
    sourceSha256: secondInput.sourceSha256,
    editRevision: secondInput.editRevision,
    config: editPreviewArtifactConfig(secondInput),
  });

  expect(calls).toBe(2);
  expect(current.cacheKey).toBe(expected);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("publish CAS rejects lineage changes in the write-to-rename window", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const sourceProxy = join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4");
  const firstInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy,
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const secondInput: ProjectInput = {
    ...firstInput,
    previewProxyRevision: "proxy-revision-2",
    previewProxyCacheKey: "proxy-cache-2",
  };
  let reads = 0;
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => {
      reads += 1;
      return reads <= 3 ? firstInput : secondInput;
    },
    async generate({ output }) {
      calls += 1;
      await writeFile(output, `artifact-${calls}`);
      return {} as never;
    },
    async probe() {
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  const oldKey = editPreviewArtifactCacheKey({
    sourceSha256: firstInput.sourceSha256,
    editRevision: firstInput.editRevision,
    config: editPreviewArtifactConfig(firstInput),
  });
  const expected = editPreviewArtifactCacheKey({
    sourceSha256: secondInput.sourceSha256,
    editRevision: secondInput.editRevision,
    config: editPreviewArtifactConfig(secondInput),
  });

  expect(calls).toBe(2);
  expect(current.cacheKey).toBe(expected);
  expect(current.cacheKey).not.toBe(oldKey);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("saved manifest becomes stale when generator config changes the cache key", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const artifactDir = join(f.projectDir, ".chengfeng-videocut", "preview-edited");
  await mkdir(artifactDir, { recursive: true });
  const source = ".chengfeng-videocut/preview-edited/old-cache.mp4";
  const artifact = join(f.projectDir, source);
  await writeFile(artifact, "old artifact");
  const info = await stat(artifact);
  await writeFile(join(artifactDir, "current.json"), `${JSON.stringify({
    schemaVersion: 2,
    projectId: f.projectId,
    phase: "current",
    editRevision: revision,
    artifactRevision: revision,
    cacheKey: "old-cache",
    sourceSha256: "a".repeat(64),
    source,
    duration: 3,
    byteLength: info.size,
    hasVideo: true,
    hasAudio: true,
    generatedAt: "2026-07-22T00:00:00.000Z",
    generationMs: 1,
    error: null,
  }, null, 2)}\n`);

  const manager = new EditPreviewArtifactManager(f.projectsDir);
  const state = await manager.status(f.projectId);

  expect(state.phase).toBe("stale");
  expect(state.cacheKey).toBe("old-cache");
  expect(state.editRevision).toBe(revision);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("generation failure preserves last current artifact as failed stale state", async () => {
  const f = await fixture();
  await f.writeEdit(3);
  let fail = false;
  let mediaDuration = 3;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) { if (fail) throw new Error("ffmpeg failed"); await writeFile(output, "ok"); return {} as never; },
    async probe() { return { duration: mediaDuration, hasVideo: true, hasAudio: true, videoBitrate: 1,
      videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 }; },
  });
  manager.schedule(f.projectId);
  const previous = await waitFor(manager, f.projectId, "current");
  fail = true;
  mediaDuration = 4;
  const revision = await f.writeEdit(4);
  manager.schedule(f.projectId);
  const failed = await waitFor(manager, f.projectId, "failed");
  expect(failed.editRevision).toBe(revision);
  expect(failed.source).toBe(previous.source);
  expect(failed.artifactRevision).toBe(previous.artifactRevision);
  expect(failed.error).toContain("ffmpeg failed");
  await Bun.sleep(30);
  expect(await manager.status(f.projectId)).toMatchObject({ phase: "failed", editRevision: revision });
  fail = false;
  manager.retry(f.projectId);
  const recovered = await waitFor(manager, f.projectId, "current");
  expect(recovered.editRevision).toBe(revision);
  expect(recovered.source).not.toBe(previous.source);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("retry regenerates when validation failed after a bad cacheKey file was written", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const expectedInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const expectedCacheKey = editPreviewArtifactCacheKey({
    sourceSha256: expectedInput.sourceSha256,
    editRevision: expectedInput.editRevision,
    config: editPreviewArtifactConfig(expectedInput),
  });
  const expectedOutput = join(f.projectDir, ".chengfeng-videocut", "preview-edited", `${expectedCacheKey}.mp4`);
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) {
      calls += 1;
      await writeFile(output, calls === 1 ? "bad" : "good");
      return {} as never;
    },
    async probe(path) {
      const body = await readFile(path, "utf8");
      return { duration: body === "bad" ? 1 : 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  manager.schedule(f.projectId);
  const failed = await waitFor(manager, f.projectId, "failed");
  expect(failed.error).toContain("Generated preview validation failed");
  expect(calls).toBe(1);
  await expect(stat(expectedOutput)).rejects.toThrow();

  manager.retry(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");

  expect(calls).toBe(2);
  expect(current.phase).toBe("current");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("retry regenerates when probe throws after a bad cacheKey file was written", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const expectedInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const expectedCacheKey = editPreviewArtifactCacheKey({
    sourceSha256: expectedInput.sourceSha256,
    editRevision: expectedInput.editRevision,
    config: editPreviewArtifactConfig(expectedInput),
  });
  const expectedOutput = join(f.projectDir, ".chengfeng-videocut", "preview-edited", `${expectedCacheKey}.mp4`);
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    async generate({ output }) {
      calls += 1;
      await writeFile(output, calls === 1 ? "bad" : "good");
      return {} as never;
    },
    async probe(path) {
      const body = await readFile(path, "utf8");
      if (body === "bad") throw new Error("probe exploded");
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  manager.schedule(f.projectId);
  const failed = await waitFor(manager, f.projectId, "failed");
  expect(failed.error).toContain("probe exploded");
  expect(calls).toBe(1);
  await expect(stat(expectedOutput)).rejects.toThrow();

  manager.retry(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");

  expect(calls).toBe(2);
  expect(current.phase).toBe("current");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("cached failed state is ignored when same revision proxy identity changes", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  let input: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => input,
    async generate({ output }) { await writeFile(output, "bad"); return {} as never; },
    async probe() { throw new Error("probe failed"); },
  });

  manager.schedule(f.projectId);
  const failed = await waitFor(manager, f.projectId, "failed");
  expect(failed.phase).toBe("failed");
  const oldCacheKey = failed.cacheKey;
  input = {
    ...input,
    previewProxyRevision: "proxy-revision-2",
    previewProxyCacheKey: "proxy-cache-2",
  };

  const next = await manager.status(f.projectId);

  expect(next.phase).not.toBe("failed");
  expect(next.cacheKey).not.toBe(oldCacheKey);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("cached generating state is ignored when same revision proxy identity changes", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  let input: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 60_000,
    readProjectInput: async () => input,
  });

  manager.schedule(f.projectId);
  await Bun.sleep(5);
  const generating = await manager.status(f.projectId);
  input = {
    ...input,
    previewProxyRevision: "proxy-revision-2",
    previewProxyCacheKey: "proxy-cache-2",
  };

  const next = await manager.status(f.projectId);

  expect(generating.phase).toBe("generating");
  expect(next.phase).not.toBe("generating");
  expect(next.cacheKey).not.toBe(generating.cacheKey);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("a legacy manifest upgrades once to schema 2 generating without polling duplicate writers", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const realProjectDir = await realpath(f.projectDir);
  const input: ProjectInput = {
    projectId: f.projectId,
    projectDir: realProjectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const legacyKey = "b".repeat(64);
  const artifactDir = join(f.projectDir, ".chengfeng-videocut", "preview-edited");
  const legacySource = `.chengfeng-videocut/preview-edited/${legacyKey}.mp4`;
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(f.projectDir, legacySource), "legacy-preview");
  await writeFile(join(artifactDir, "current.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId: f.projectId,
    phase: "current",
    editRevision: "legacy-revision",
    artifactRevision: "legacy-revision",
    cacheKey: legacyKey,
    sourceSha256: input.sourceSha256,
    source: legacySource,
  })}\n`);

  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let generateCalls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => input,
    async generate({ output }) {
      generateCalls += 1;
      startedResolve();
      await release;
      await writeFile(output, "new-preview");
      return {} as never;
    },
    async probe() {
      return {
        duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720, frameRate: 30,
      };
    },
  });
  const handler = createEditPreviewArtifactHandler(manager);
  const url = `http://localhost/api/v1/projects/${f.projectId}/preview-artifact`;

  const staleResponse = await handler(new Request(url));
  expect(staleResponse?.status).toBe(200);
  expect((await staleResponse?.json()).phase).toBe("stale");
  await started;

  const generatingResponse = await handler(new Request(url));
  const generating = await generatingResponse?.json() as Record<string, unknown>;
  expect(generatingResponse?.status).toBe(200);
  expect(generating).toMatchObject({
    schemaVersion: 2,
    projectId: f.projectId,
    phase: "generating",
    editRevision: revision,
    source: legacySource,
  });
  for (let index = 0; index < 3; index += 1) {
    const response = await handler(new Request(url));
    expect((await response?.json()).phase).toBe("generating");
  }
  expect(generateCalls).toBe(1);

  releaseResolve();
  const current = await waitFor(manager, f.projectId, "current");
  expect(current).toMatchObject({ schemaVersion: 2, projectId: f.projectId, phase: "current" });
  expect(generateCalls).toBe(1);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("cached generating and failed states require matching schema version and project id", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const input: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const cacheKey = editPreviewArtifactCacheKey({
    sourceSha256: input.sourceSha256,
    editRevision: input.editRevision,
    config: editPreviewArtifactConfig(input),
  });
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    readProjectInput: async () => input,
  });
  (manager as any).states.set(f.projectId, {
    schemaVersion: 2,
    projectId: f.projectId,
    phase: "generating",
    editRevision: revision,
    artifactRevision: null,
    cacheKey,
    sourceSha256: input.sourceSha256,
    source: null,
    duration: null,
    byteLength: null,
    hasVideo: null,
    hasAudio: null,
    generatedAt: null,
    generationMs: null,
    error: null,
  });
  expect((await manager.status(f.projectId)).phase).toBe("pending");  // 从未生成 → pending，不再冒充 stale

  (manager as any).states.set(f.projectId, {
    schemaVersion: 1,
    projectId: "wrong-project",
    phase: "failed",
    editRevision: revision,
    artifactRevision: null,
    cacheKey,
    sourceSha256: input.sourceSha256,
    source: null,
    duration: null,
    byteLength: null,
    hasVideo: null,
    hasAudio: null,
    generatedAt: null,
    generationMs: null,
    error: "old",
  });
  expect((await manager.status(f.projectId)).phase).toBe("pending");  // 同上：无可信状态 → pending
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("status checks disk current before returning a cached failed state", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const sharedInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const failedManager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => sharedInput,
    async generate({ output }) { await writeFile(output, "bad"); return {} as never; },
    async probe() { throw new Error("first writer failed"); },
  });
  failedManager.schedule(f.projectId);
  const failed = await waitFor(failedManager, f.projectId, "failed");
  expect(failed.phase).toBe("failed");

  const currentManager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => sharedInput,
    async generate({ output }) { await writeFile(output, "good"); return {} as never; },
    async probe() {
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });
  currentManager.schedule(f.projectId);
  await waitFor(currentManager, f.projectId, "current");

  const status = await failedManager.status(f.projectId);

  expect(status.phase).toBe("current");
  expect(status.editRevision).toBe(revision);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("revision-keyed artifact without a current manifest is revalidated and atomically reused", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const input: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const cacheKey = editPreviewArtifactCacheKey({
    sourceSha256: input.sourceSha256,
    editRevision: input.editRevision,
    config: editPreviewArtifactConfig(input),
  });
  const artifactDir = join(f.projectDir, ".chengfeng-videocut", "preview-edited");
  await mkdir(artifactDir, { recursive: true });
  const finalOutput = join(artifactDir, `${cacheKey}.mp4`);
  await writeFile(finalOutput, "orphan-but-basic-probe-passes");
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => input,
    async generate({ output }) {
      calls += 1;
      expect(output).toContain(".writer-");
      await writeFile(output, "good");
      return {} as never;
    },
    async probe() {
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");

  expect(current.phase).toBe("current");
  expect(calls).toBe(0);
  expect(await readFile(finalOutput, "utf8")).toBe("orphan-but-basic-probe-passes");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("sharp cache rejects wrong, missing, and NaN fps before regeneration", async () => {
  for (const badFrameRate of [30, undefined, Number.NaN]) {
    const f = await fixture();
    const revision = await f.writeEdit(3);
    const input: ProjectInput = {
      projectId: f.projectId, projectDir: f.projectDir, editRevision: revision, sourceSha256: "a".repeat(64),
      sourceProxy: join(f.projectDir, "input", "source.mp4"), sourceKind: "canonical", previewProfile: "sharp-canonical-v1",
      previewFrameRate: 60, previewProxyRevision: "unused", previewProxyCacheKey: "unused", duration: 3,
      segments: [{ source: "input/source.mp4", start: 0, end: 3, playbackRate: 1 }],
    };
    const cacheKey = editPreviewArtifactCacheKey({ sourceSha256: input.sourceSha256, editRevision: input.editRevision, config: editPreviewArtifactConfig(input) });
    const artifactDir = join(f.projectDir, ".chengfeng-videocut", "preview-edited");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, `${cacheKey}.mp4`), "bad-fps");
    let calls = 0;
    const manager = new EditPreviewArtifactManager(f.projectsDir, {
      debounceMs: 0, readProjectInput: async () => input,
      async generate({ output }) { calls += 1; await writeFile(output, "sharp-good"); return {} as never; },
      async probe(path) {
        const generated = await readFile(path, "utf8") === "sharp-good";
        return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 6_000_000,
          videoProfile: "high", pixelFormat: "yuv420p", width: 1440, height: 1080,
          frameRate: generated ? 60 : badFrameRate };
      },
    });
    manager.schedule(f.projectId);
    await waitFor(manager, f.projectId, "current");
    expect(calls).toBe(1);
    await rm(f.projectsDir, { recursive: true, force: true });
  }
});

test("bad writer cleanup cannot delete another writer final artifact or current manifest", async () => {
  const f = await fixture();
  const revision = await f.writeEdit(3);
  const expectedInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: revision,
    sourceSha256: "a".repeat(64),
    sourceProxy: join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4"),
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const expectedCacheKey = editPreviewArtifactCacheKey({
    sourceSha256: expectedInput.sourceSha256,
    editRevision: expectedInput.editRevision,
    config: editPreviewArtifactConfig(expectedInput),
  });
  const finalOutput = join(f.projectDir, ".chengfeng-videocut", "preview-edited", `${expectedCacheKey}.mp4`);
  const manifest = join(f.projectDir, ".chengfeng-videocut", "preview-edited", "current.json");
  let releaseBadProbe!: () => void;
  const badProbeGate = new Promise<void>((resolve) => { releaseBadProbe = resolve; });
  let badCalls = 0;
  let goodCalls = 0;
  const bad = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => expectedInput,
    async generate({ output }) {
      badCalls += 1;
      expect(output).toContain(".writer-");
      await writeFile(output, "bad");
      return {} as never;
    },
    async probe(path) {
      const body = await readFile(path, "utf8");
      if (body === "bad") {
        await badProbeGate;
        throw new Error("bad writer probe failed");
      }
      return { duration: 3, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });
  const good = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => expectedInput,
    async generate({ output }) {
      goodCalls += 1;
      expect(output).toContain(".writer-");
      await writeFile(output, "good");
      return {} as never;
    },
    async probe(path) {
      const body = await readFile(path, "utf8");
      return { duration: body === "good" ? 3 : 1, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  bad.schedule(f.projectId);
  await Bun.sleep(10);
  good.schedule(f.projectId);
  const current = await waitFor(good, f.projectId, "current");
  releaseBadProbe();
  await Bun.sleep(20);
  const badStatus = await bad.status(f.projectId);

  expect(badCalls).toBe(1);
  expect(goodCalls).toBe(1);
  expect(badStatus.phase).toBe("current");
  expect(current.phase).toBe("current");
  expect(await readFile(finalOutput, "utf8")).toBe("good");
  const saved = JSON.parse(await readFile(manifest, "utf8"));
  expect(saved.phase).toBe("current");
  expect(saved.cacheKey).toBe(expectedCacheKey);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("final probe cannot publish an old revision when project identity changes before manifest rename", async () => {
  const f = await fixture();
  const r1 = await f.writeEdit(3);
  const r2 = await f.writeEdit(4);
  const sourceProxy = join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4");
  const firstInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: r1,
    sourceSha256: "a".repeat(64),
    sourceProxy,
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  const secondInput: ProjectInput = {
    ...firstInput,
    editRevision: r2,
    duration: 4,
    segments: [{ start: 0, end: 4 }],
  };
  let activeInput = firstInput;
  let probes = 0;
  let calls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => activeInput,
    async generate({ output }) {
      calls += 1;
      await writeFile(output, `artifact-${calls}`);
      return {} as never;
    },
    async probe(path) {
      probes += 1;
      const body = await readFile(path, "utf8");
      if (probes === 2) activeInput = secondInput;
      return { duration: body === "artifact-1" ? 3 : 4, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
  });

  manager.schedule(f.projectId);
  await Bun.sleep(80);
  const manifest = join(f.projectDir, ".chengfeng-videocut", "preview-edited", "current.json");
  let saved = JSON.parse(await readFile(manifest, "utf8"));
  expect(saved.editRevision).not.toBe(r1);
  const tempFilesAfterFirstRun = (await readdir(join(f.projectDir, ".chengfeng-videocut", "preview-edited")))
    .filter((name) => name.includes(".writer-") && name.endsWith(".tmp.mp4"));
  expect(tempFilesAfterFirstRun).toEqual([]);

  manager.schedule(f.projectId);
  const current = await waitFor(manager, f.projectId, "current");
  saved = JSON.parse(await readFile(manifest, "utf8"));
  const tempFilesAfterCurrent = (await readdir(join(f.projectDir, ".chengfeng-videocut", "preview-edited")))
    .filter((name) => name.includes(".writer-") && name.endsWith(".tmp.mp4"));

  expect(current.editRevision).toBe(r2);
  expect(saved.editRevision).toBe(r2);
  expect(saved.editRevision).not.toBe(r1);
  expect(tempFilesAfterCurrent).toEqual([]);
  expect(calls).toBe(2);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("shared project write lock serializes concurrent EditList writes against preview publish", async () => {
  const f = await fixture();
  const r1 = await f.writeEdit(3);
  const sourceProxy = join(f.projectDir, ".chengfeng-videocut", "preview", "source.mp4");
  let activeInput: ProjectInput = {
    projectId: f.projectId,
    projectDir: f.projectDir,
    editRevision: r1,
    sourceSha256: "a".repeat(64),
    sourceProxy,
    previewFrameRate: 30,
    previewProxyRevision: "proxy-revision-1",
    previewProxyCacheKey: "proxy-cache-1",
    duration: 3,
    segments: [{ start: 0, end: 3 }],
  };
  let r2 = "";
  let calls = 0;
  let releaseWriter!: () => void;
  let allowWriterCommit!: () => void;
  let writerEntered!: () => void;
  const writerStarted = new Promise<void>((resolve) => { writerEntered = resolve; });
  const writerMayCommit = new Promise<void>((resolve) => { allowWriterCommit = resolve; });
  const writerMayExit = new Promise<void>((resolve) => { releaseWriter = resolve; });
  let previewLockAttempted!: () => void;
  const previewTriedProjectLock = new Promise<void>((resolve) => { previewLockAttempted = resolve; });
  let writer: Promise<void> | null = null;
  let reads = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    debounceMs: 0,
    readProjectInput: async () => {
      reads += 1;
      const snapshot = activeInput;
      if (reads === 3 && !writer) {
        writer = serializeProjectOperation(f.projectDir, async () => {
          writerEntered();
          await writerMayCommit;
          r2 = await f.writeEdit(4);
          activeInput = {
            ...activeInput,
            editRevision: r2,
            duration: 4,
            segments: [{ start: 0, end: 4 }],
          };
          await writerMayExit;
        });
        await writerStarted;
      }
      return snapshot;
    },
    async generate({ output }) {
      calls += 1;
      await writeFile(output, `artifact-${calls}`);
      return {} as never;
    },
    async probe(path) {
      const body = await readFile(path, "utf8");
      return { duration: body === "artifact-1" ? 3 : 4, hasVideo: true, hasAudio: true, videoBitrate: 1,
        videoProfile: "high", pixelFormat: "yuv420p", width: 960, height: 720 };
    },
    async serializeProjectOperation(projectDir, operation) {
      previewLockAttempted();
      return await serializeProjectOperation(projectDir, operation);
    },
  });

  manager.schedule(f.projectId);
  await writerStarted;
  await previewTriedProjectLock;
  const manifest = join(f.projectDir, ".chengfeng-videocut", "preview-edited", "current.json");
  await expect(readFile(manifest, "utf8")).rejects.toThrow();
  allowWriterCommit();
  releaseWriter();
  await writer;

  const current = await waitFor(manager, f.projectId, "current");
  const saved = JSON.parse(await readFile(manifest, "utf8"));

  expect(saved.editRevision).toBe(r2);
  expect(saved.editRevision).not.toBe(r1);
  expect(current.editRevision).toBe(r2);
  expect(calls).toBe(2);
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("preview proxy frame rate is required for revision-bound cfr artifacts", async () => {
  const f = await fixture({ frameRate: null });
  await f.writeEdit(3);
  const manager = new EditPreviewArtifactManager(f.projectsDir);

  await expect(manager.status(f.projectId)).rejects.toThrow("frame-rate contract");

  await rm(f.projectsDir, { recursive: true, force: true });
});

test("preview-only ffmpeg generator emits non-gray cfr short-gop audio-video artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-artifact-ffmpeg-"));
  const input = join(root, "source.mp4");
  const output = join(root, "preview.mp4");
  await command("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v", "libx264", "-g", "6", "-keyint_min", "6", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", input,
  ]);

  await generatePreviewArtifactVideo({
    input,
    output,
    frameRate: 30,
    segments: [
      { start: 0.2, end: 0.8 },
      { start: 1.2, end: 2.0 },
    ],
  });

  const probe = JSON.parse(await commandOutput("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,start_time,duration,r_frame_rate,avg_frame_rate",
    "-of", "json",
    output,
  ])) as {
    streams: Array<{ codec_type: string; start_time?: string; duration?: string; r_frame_rate?: string; avg_frame_rate?: string }>;
    format: { duration: string };
  };
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const stats = signalStats(await commandOutput("ffmpeg", [
    "-v", "info", "-ss", "0", "-i", output, "-frames:v", "1",
    "-vf", "signalstats,metadata=print", "-f", "null", "-",
  ]));
  const keyframes = await commandOutput("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
    "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", output,
  ]);
  const times = keyframes.trim().split(/\s+/).map(Number).filter(Number.isFinite);
  const maxGap = Math.max(...times.slice(1).map((time, index) => time - (times[index] ?? 0)));

  expect(video?.r_frame_rate).toBe("30/1");
  expect(video?.avg_frame_rate).toBe("30/1");
  expect(Number(video?.start_time ?? 0)).toBeCloseTo(0, 3);
  expect(Number(audio?.start_time ?? 0)).toBeCloseTo(0, 3);
  expect(Number(probe.format.duration)).toBeGreaterThan(1.35);
  expect(Number(probe.format.duration)).toBeLessThan(1.5);
  expect(stats.YMIN).not.toBe(128);
  expect(stats.YMAX).not.toBe(128);
  expect(maxGap).toBeLessThanOrEqual(0.25);
  await command("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
  await rm(root, { recursive: true, force: true });
}, 20_000);
// The fixture's proxy is a placeholder, not decodable media. Fragment production is
// exercised for real by the ffmpeg test in this file; these cases are about state.
function stubStream(segments: readonly { start: number; end: number }[]) {
  let out = 0;
  const list = segments.map((segment, index) => {
    const entry = {
      source: `.chengfeng-videocut/preview-stream/${index}.m4s`,
      headExtra: 0,
      out,
      dur: segment.end - segment.start,
    };
    out += entry.dur;
    return entry;
  });
  return {
    segments: list,
    totalSeconds: out,
    mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  };
}

// --- 账本播放：不生成任何东西 ---------------------------------------------

async function readyProxyFixture(overrides: {
  segments?: Array<Record<string, unknown>>;
} = {}) {
  const f = await fixture();
  const workbench = JSON.parse(await readFile(join(f.projectDir, "workbench.json"), "utf8"));
  workbench.previewProxy.status = "ready";
  workbench.previewProxy.duration = 10;
  workbench.previewProxy.byteLength = 5;
  workbench.previewProxy.width = 960;
  workbench.previewProxy.height = 720;
  await writeFile(join(f.projectDir, "workbench.json"), JSON.stringify(workbench));
  if (overrides.segments) {
    const raw = `${JSON.stringify({
      schemaVersion: 1, projectId: f.projectId, mode: "manual", sourceDuration: 10, duration: 4,
      baseCutsRevision: "b".repeat(64), baseTranscriptRevision: "c".repeat(64),
      segments: overrides.segments,
    }, null, 2)}\n`;
    await writeFile(join(f.projectDir, "edit-list.json"), raw);
  }
  return f;
}

test("a ready proxy plays the edit list directly and never generates an artifact", async () => {
  const f = await readyProxyFixture();
  await f.writeEdit(4);
  const workbench = JSON.parse(await readFile(join(f.projectDir, "workbench.json"), "utf8"));
  workbench.previewProxy.status = "ready";
  await writeFile(join(f.projectDir, "workbench.json"), JSON.stringify(workbench));

  let generateCalls = 0;
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    generate: async () => { generateCalls += 1; throw new Error("must not encode"); },
    buildStream: async (input) => stubStream(input.segments),
    serializeProjectOperation,
  });

  const state = await manager.ensure(f.projectId);

  // Current the instant it is asked for: there is no artifact, so nothing can be
  // stale and no edit may schedule an encode.
  expect(state.phase).toBe("current");
  expect(state.profile).toBe("ledger-proxy-v1");
  expect(state.sourceKind).toBe("ledger-proxy");
  expect(state.source).toBe(".chengfeng-videocut/preview/source.mp4");
  expect(state.artifactRevision).toBe(state.editRevision);
  expect(state.generationMs).toBe(0);
  expect(state.cacheKey).toBeNull();
  // The player is handed fragments to assemble, never a ledger to jump around.
  expect(state.stream?.segments.length).toBeGreaterThan(0);
  expect(state.stream?.totalSeconds).toBeCloseTo(4, 6);
  expect(state.duration).toBeCloseTo(4, 6);

  // An edit must not start an encode either.
  await f.writeEdit(6);
  manager.schedule(f.projectId);
  await Bun.sleep(400);
  expect((await manager.status(f.projectId)).profile).toBe("ledger-proxy-v1");
  expect(generateCalls).toBe(0);

  await rm(f.projectsDir, { recursive: true, force: true });
});

test("the edit list cannot be played directly across two source files", async () => {
  // One <video> can hold one file, so a timeline spanning two of them must keep
  // the encoded path.
  //
  // The other case `canPlayFromLedger` guards — a segment whose speed is not 1x —
  // cannot be constructed today: `parseEditListDocument` rejects any playbackRate
  // other than 1 outright ("the current HyperFrames runtime does not support EDL
  // rate changes"). The guard stays as defence for when that contract opens up,
  // but it is unreachable, so there is nothing to assert here.
  const f = await readyProxyFixture({
    segments: [
      { id: "a", source: "input/one.mp4", sourceStart: 0, sourceEnd: 2, timelineStart: 0, trackId: "a-roll", playbackRate: 1 },
      { id: "b", source: "input/two.mp4", sourceStart: 0, sourceEnd: 2, timelineStart: 2, trackId: "a-roll", playbackRate: 1 },
    ],
  });
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    generate: async () => { throw new Error("stop before encoding"); },
    serializeProjectOperation,
  });
  const state = await manager.status(f.projectId);
  expect(state.profile).not.toBe("ledger-proxy-v1");
  expect(state.sourceKind).not.toBe("ledger-proxy");
  await rm(f.projectsDir, { recursive: true, force: true });
});

test("encoded artifacts are bounded instead of accumulating forever", async () => {
  // The first real project reached 26 files and 1.1GB because nothing ever
  // deleted one. Keep a few generations for undo, drop the rest.
  const f = await readyProxyFixture();
  await f.writeEdit(4);
  const artifactDir = join(f.projectDir, ".chengfeng-videocut", "preview-edited");
  await mkdir(artifactDir, { recursive: true });
  const names: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const name = `${digest(`old-artifact-${index}`)}.mp4`;
    names.push(name);
    await writeFile(join(artifactDir, name), "x".repeat(16));
    // Distinct mtimes so "most recent" is well defined.
    const when = new Date(1_700_000_000_000 + index * 1000);
    await utimes(join(artifactDir, name), when, when);
  }
  await writeFile(join(artifactDir, "current.json"), "{}");

  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    generate: async () => { throw new Error("must not encode"); },
    buildStream: async (input) => stubStream(input.segments),
    serializeProjectOperation,
  });
  await manager.status(f.projectId);
  await Bun.sleep(200);

  const left = (await readdir(artifactDir)).filter((name) => name.endsWith(".mp4"));
  expect(left).toHaveLength(3);
  // The three newest survive; anything unrelated in the directory is untouched.
  expect(left.sort()).toEqual(names.slice(-3).sort());
  expect(await readFile(join(artifactDir, "current.json"), "utf8")).toBe("{}");

  await rm(f.projectsDir, { recursive: true, force: true });
});

test("a slow first ledger build answers generating instead of hanging the request", async () => {
  // Issue #3 的第二半：首次切片 + 响度解码在慢机器上是分钟级。这个请求
  // 不许挂着——预算内建不完就先说 generating，构建在后台完成，下一次轮询拿走。
  const f = await readyProxyFixture();
  await f.writeEdit(4);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    generate: async () => { throw new Error("must not encode"); },
    buildStream: async (input) => { await gate; return stubStream(input.segments); },
    serializeProjectOperation,
    ledgerSyncBudgetMs: 30,
  });

  const first = await manager.ensure(f.projectId);
  expect(first.phase).toBe("generating");
  expect(first.source).toBeNull();

  release?.();
  await Bun.sleep(30);
  const second = await manager.status(f.projectId);
  expect(second.phase).toBe("current");
  expect(second.profile).toBe("ledger-proxy-v1");

  await rm(f.projectsDir, { recursive: true, force: true });
});

test("a failed background ledger build reports failed with the error text", async () => {
  const f = await readyProxyFixture();
  await f.writeEdit(4);
  let rejectBuild: ((error: Error) => void) | undefined;
  const gate = new Promise<never>((_resolve, rejectPromise) => { rejectBuild = rejectPromise; });
  const manager = new EditPreviewArtifactManager(f.projectsDir, {
    generate: async () => { throw new Error("must not encode"); },
    buildStream: async () => gate,
    serializeProjectOperation,
    ledgerSyncBudgetMs: 30,
  });

  expect((await manager.ensure(f.projectId)).phase).toBe("generating");
  rejectBuild?.(new Error("ENOENT: no such file or directory, uv_spawn 'ffprobe'"));
  await Bun.sleep(30);
  const state = await manager.status(f.projectId);
  // 失败要带原文暴露给前端，不许退化成裸 pending 把原因吞掉。
  expect(state.phase).toBe("failed");
  expect(state.error).toContain("ffprobe");

  await rm(f.projectsDir, { recursive: true, force: true });
});
