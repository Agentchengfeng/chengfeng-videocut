import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditPreviewArtifactManager, type ProjectInput } from "./edit-preview-artifact";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const stream = { segments: [{ source: "fragment.m4s", headExtra: 0, out: 0, dur: 1 }], totalSeconds: 1, mimeType: "video/mp4" };
const input = (projectDir: string, ledger = false): ProjectInput => ({ projectId: "demo", projectDir,
  editRevision: "a".repeat(64), sourceSha256: "b".repeat(64), sourceProxy: join(projectDir, "source.mp4"),
  previewFrameRate: 30, previewProxyRevision: "", previewProxyCacheKey: "", duration: 1,
  ...(ledger ? { previewProxySource: "source.mp4" } : {}), segments: [{ start: 0, end: 1 }] });

test("close drains delayed scheduled input and rejects all later admission without launching a timer", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-close-read-"));
  const gate = deferred<ProjectInput>(); let reads = 0, builds = 0, closed = false;
  const manager = new EditPreviewArtifactManager(root, { debounceMs: 0,
    readProjectInput: async () => { reads++; return gate.promise; },
    generate: async () => { builds++; return {} as never; } });
  try {
    manager.schedule("demo");
    const close = manager.close();
    expect(manager.close()).toBe(close);
    void close.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    manager.schedule("demo"); manager.retry("demo");
    await expect(manager.status("demo")).rejects.toThrow("closed");
    await expect(manager.ensure("demo")).rejects.toThrow("closed");
    gate.resolve(input(root)); await close;
    expect(reads).toBe(1); expect(builds).toBe(0); expect(closed).toBe(true);
  } finally { gate.resolve(input(root)); await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("close drains an admitted status read and does not start its ledger build", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-close-status-"));
  const gate = deferred<ProjectInput>(); let builds = 0, closed = false;
  const manager = new EditPreviewArtifactManager(root, { readProjectInput: () => gate.promise,
    buildStream: async () => { builds++; return stream; } });
  try {
    const status = manager.status("demo").then(() => null, error => error as Error);
    const close = manager.close(); void close.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    gate.resolve(input(root, true)); expect((await status)?.message).toContain("closed"); await close;
    expect(builds).toBe(0);
  } finally { gate.resolve(input(root, true)); await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("close drains a budget-expired ledger build and an already started prune", async () => {
  for (const block of ["ledger", "prune"] as const) {
    const root = await mkdtemp(join(tmpdir(), "preview-close-ledger-"));
    const gate = deferred<void>(), started = deferred<void>(); let closed = false, builds = 0;
    const manager = new EditPreviewArtifactManager(root, { readProjectInput: async () => input(root, true), ledgerSyncBudgetMs: 1,
      buildStream: async () => { builds++; if (block === "ledger") { started.resolve(); await gate.promise; } return stream; },
      prune: async () => { if (block === "prune") { started.resolve(); await gate.promise; } return { removed: 0, freedBytes: 0 }; } });
    try {
      const status = await manager.status("demo");
      expect(status.phase).toBe(block === "ledger" ? "generating" : "current");
      await started.promise;
      const close = manager.close(); void close.then(() => { closed = true; });
      await Promise.resolve(); expect(closed).toBe(false);
      manager.schedule("demo"); manager.retry("demo");
      gate.resolve(); await close;
      expect(closed).toBe(true); expect(builds).toBe(1);
    } finally { gate.resolve(); await manager.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("close waits for started generation through final publication and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-close-generate-"));
  const gate = deferred<void>(), started = deferred<void>(); let closed = false, generations = 0, pruned = false;
  const manager = new EditPreviewArtifactManager(root, { debounceMs: 0, readProjectInput: async () => input(root),
    generate: async ({ output }) => { generations++; started.resolve(); await gate.promise; await writeFile(output, "artifact"); return {} as never; },
    probe: async () => ({ duration: 1, hasVideo: true, hasAudio: true, width: 960, height: 720, videoBitrate: 1, videoProfile: "high", pixelFormat: "yuv420p" }),
    serializeProjectOperation: async (_directory, operation) => operation(),
    prune: async () => { pruned = true; return { removed: 0, freedBytes: 0 }; } });
  try {
    manager.schedule("demo"); await started.promise;
    const close = manager.close(); void close.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    manager.schedule("demo"); gate.resolve(); await close;
    expect(closed).toBe(true); expect(generations).toBe(1); expect(pruned).toBe(true);
  } finally { gate.resolve(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("timer run initial-read failure is observable failed state, not an unhandled rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-close-error-"));
  const reported = deferred<void>(); let reads = 0;
  const log = spyOn(console, "error").mockImplementation(() => { reported.resolve(); });
  const manager = new EditPreviewArtifactManager(root, { debounceMs: 0, readProjectInput: async () => {
    if (++reads === 2) throw new Error("deliberate initial run read failure");
    return input(root);
  } });
  try {
    manager.schedule("demo"); await reported.promise;
    const state = await manager.status("demo");
    expect(state.phase).toBe("failed"); expect(state.error).toContain("deliberate initial run read failure");
    expect(log).toHaveBeenCalledTimes(1);
  } finally { await manager.close(); log.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
