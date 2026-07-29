import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeProjectOperation } from "@video-workbench/core/node";
import { materializeKouboEditListIndex } from "@video-workbench/koubo-adapter";
import { PRODUCT_VERSION } from "../output";
import { startStudioServer, type RunningStudioServer } from "./start";

const cleanupPaths: string[] = [];
const servers: RunningStudioServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function serverFixture() {
  const root = await mkdtemp(join(tmpdir(), "chengfeng-videocut-server-"));
  cleanupPaths.push(root);
  const staticDir = join(root, "static");
  const projectsDir = join(root, "projects");
  const projectDir = join(projectsDir, "demo");
  await mkdir(join(staticDir, "assets"), { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Studio</title>");
  await writeFile(join(staticDir, "assets/app.js"), "globalThis.__studioSmoke = true;");
  await writeFile(
    join(staticDir, "chengfeng-videocut-capabilities.json"),
    JSON.stringify({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      studioVersion: "0.2.1",
      features: {
        topLevelViews: ["storyboard", "preview", "koubo"],
        legacyWorkbenchPanel: false,
        managedTimelineEditing: true,
        managedTimelineOperations: ["move", "trim", "split", "delete", "restore", "delete-range", "restore-snapshot"],
      },
    }),
  );
  await writeFile(
    join(projectDir, "index.html"),
    '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script></head><body><main data-hf-composition="main" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="2"><video src="input/source.mp4"></video></main><script>window.__timelines = {};</script></body></html>',
  );
  return { root, staticDir, projectsDir, projectDir };
}

const MANAGED_START = "<!-- chengfeng-videocut:a-roll:start -->";
const MANAGED_END = "<!-- chengfeng-videocut:a-roll:end -->";

async function managedServerFixture() {
  const fixture = await serverFixture();
  await writeFile(join(fixture.projectDir, "project.json"), JSON.stringify({
    jobId: "demo",
    title: "Managed fixture",
    config: { aspectRatio: "16:9" },
  }));
  await writeFile(join(fixture.projectDir, "workbench.json"), JSON.stringify({
    aspectRatio: "16:9",
  }));
  await writeFile(join(fixture.projectDir, "edit-list.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId: "demo",
    sourceDuration: 4,
    baseCutsRevision: "a".repeat(64),
    baseTranscriptRevision: "b".repeat(64),
    mode: "manual",
    duration: 4,
    segments: [{
      id: "a-roll-0001",
      source: "input/source.mp4",
      sourceStart: 0,
      sourceEnd: 4,
      timelineStart: 0,
      trackId: "a-roll",
      playbackRate: 1,
    }],
  }, null, 2)}\n`);
  await writeFile(
    join(fixture.projectDir, "index.html"),
    `<!DOCTYPE html>
<!-- generated-by: chengfeng-videocut -->
<html><head><title>Managed fixture</title></head><body>
<main data-hf-id="hf-root" id="root" data-composition-id="main" data-duration="4.000" data-edl-mode="manual" data-edit-list-revision="revision-1">
  ${MANAGED_START}
  <video data-hf-id="hf-a-roll-0001" id="a-roll-0001" class="a-roll-segment" src="input/source.mp4" data-edl-segment-id="a-roll-0001" data-source-start="0.000" data-source-end="4.000" data-start="0.000" data-duration="4.000"></video>
  ${MANAGED_END}
  <h1 data-hf-id="hf-title" id="title">Old title</h1>
  <div data-hf-id="hf-b-roll" id="b-roll">Old B-roll</div>
</main>
<script>window.__timelines = window.__timelines || {};</script>
</body></html>`,
  );
  return fixture;
}

function elementPatchBody(target: Record<string, unknown>, value: string) {
  return JSON.stringify({
    target,
    operations: [{ type: "text-content", value }],
  });
}

describe("packaged Studio server", () => {
  it("keeps generic title and B-roll edits while rejecting managed A-roll writes", async () => {
    const fixture = await managedServerFixture();
    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
    });
    servers.push(server);

    const titlePatch = await fetch(
      `${server.url}/api/projects/demo/file-mutations/patch-element/index.html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: elementPatchBody({ hfId: "hf-title" }, "New title"),
      },
    );
    expect(titlePatch.status).toBe(200);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toContain(
      "New title",
    );

    const bRollPatch = await fetch(
      `${server.url}/api/projects/demo/file-mutations/patch-element/index.html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: elementPatchBody({ id: "b-roll" }, "New B-roll"),
      },
    );
    expect(bRollPatch.status).toBe(200);

    // The next EDL projection runs through the same lock and must preserve the
    // generic Studio edits outside the Product-owned sentinel region.
    await serializeProjectOperation(fixture.projectDir, () =>
      materializeKouboEditListIndex(fixture.projectDir));
    const afterMaterialize = await readFile(join(fixture.projectDir, "index.html"), "utf8");
    expect(afterMaterialize).toContain("New title");
    expect(afterMaterialize).toContain("New B-roll");

    const beforeRejectedWrite = afterMaterialize;
    const directManagedPatch = await fetch(
      `${server.url}/api/projects/demo/file-mutations/patch-element/index.html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: elementPatchBody({ id: "a-roll-0001" }, "forbidden"),
      },
    );
    expect(directManagedPatch.status).toBe(409);
    expect(await directManagedPatch.json()).toMatchObject({
      error: "managed_a_roll_write_forbidden",
      details: { reason: "managed_element_targeted" },
    });
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toBe(
      beforeRejectedWrite,
    );

    // This selector deliberately avoids every known managed id. The post-write
    // ownership invariant must still reject and roll back the indirect change.
    const indirectManagedPatch = await fetch(
      `${server.url}/api/projects/demo/file-mutations/patch-element/index.html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { selector: '[data-source-start="0.000"]' },
          operations: [{ type: "attribute", property: "data-start", value: "1.000" }],
        }),
      },
    );
    expect(indirectManagedPatch.status).toBe(409);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toBe(
      beforeRejectedWrite,
    );

    const cardPath = join(fixture.projectDir, "card.html");
    const cardBefore = '<div data-hf-id="hf-card">Old card</div>';
    await writeFile(cardPath, cardBefore);
    const rejectedBatch = await fetch(
      `${server.url}/api/projects/demo/file-mutations/patch-element-batches`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batches: [
            {
              sourceFile: "index.html",
              patches: [{
                target: { selector: '[data-source-start="0.000"]' },
                operations: [{ type: "attribute", property: "data-start", value: "2.000" }],
              }],
            },
            {
              sourceFile: "card.html",
              patches: [{
                target: { hfId: "hf-card" },
                operations: [{ type: "text-content", value: "Leaked batch edit" }],
              }],
            },
          ],
        }),
      },
    );
    expect(rejectedBatch.status).toBe(409);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toBe(
      beforeRejectedWrite,
    );
    expect(await readFile(cardPath, "utf8")).toBe(cardBefore);

    const deleteIndex = await fetch(`${server.url}/api/projects/demo/files/index.html`, {
      method: "DELETE",
    });
    expect(deleteIndex.status).toBe(409);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toBe(
      beforeRejectedWrite,
    );
  });

  it("requires whole-file CAS and preserves managed ownership for allowed index writes", async () => {
    const fixture = await managedServerFixture();
    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
    });
    servers.push(server);

    const fileUrl = `${server.url}/api/projects/demo/files/index.html`;
    const initial = await fetch(fileUrl);
    const document = await initial.json() as { content: string; version: string };
    const allowedContent = document.content.replace("Old title", "CAS title");
    const allowed = await fetch(fileUrl, {
      method: "PUT",
      headers: { "If-Match": document.version },
      body: allowedContent,
    });
    expect(allowed.status).toBe(200);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toContain("CAS title");

    const stale = await fetch(fileUrl, {
      method: "PUT",
      headers: { "If-Match": document.version },
      body: allowedContent.replace("CAS title", "stale title"),
    });
    expect(stale.status).toBe(409);

    const current = await fetch(fileUrl);
    const currentDocument = await current.json() as { content: string; version: string };
    const forbiddenContent = currentDocument.content.replace(
      'data-source-start="0.000"',
      'data-source-start="1.000"',
    );
    const forbidden = await fetch(fileUrl, {
      method: "PUT",
      headers: { "If-Match": currentDocument.version },
      body: forbiddenContent,
    });
    expect(forbidden.status).toBe(409);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toBe(
      currentDocument.content,
    );
  });

  it("waits for the shared Product project lock before running generic Studio mutations", async () => {
    const fixture = await managedServerFixture();
    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
    });
    servers.push(server);

    let releaseLock = (): void => undefined;
    let signalEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockOwner = serializeProjectOperation(fixture.projectDir, async () => {
      signalEntered();
      await held;
    });
    await entered;

    let settled = false;
    const mutation = fetch(
      `${server.url}/api/projects/demo/file-mutations/patch-element/index.html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: elementPatchBody({ hfId: "hf-title" }, "Serialized title"),
      },
    ).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(40);
    expect(settled).toBe(false);

    releaseLock();
    await lockOwner;
    expect((await mutation).status).toBe(200);
    expect(await readFile(join(fixture.projectDir, "index.html"), "utf8")).toContain(
      "Serialized title",
    );
  });

  it("serves bundled GSAP assets before pluggable and generic API routes", async () => {
    const fixture = await serverFixture();
    let productHandlerSawVendorRoute = false;
    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
      apiHandler(request) {
        if (new URL(request.url).pathname.startsWith("/api/vendor/")) {
          productHandlerSawVendorRoute = true;
          return new Response("wrong handler", { status: 418 });
        }
        return null;
      },
    });
    servers.push(server);

    for (const asset of [
      { path: "gsap.min.js", minimumLength: 50_000, marker: "GSAP" },
      { path: "CustomEase.min.js", minimumLength: 5_000, marker: "CustomEase" },
      {
        path: "MotionPathPlugin.min.js",
        minimumLength: 10_000,
        marker: "MotionPathPlugin",
      },
    ]) {
      const vendorUrl = `${server.url}/api/vendor/${asset.path}`;
      const response = await fetch(vendorUrl);
      const source = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
      expect(response.headers.get("etag")).toBeTruthy();
      expect(Number(response.headers.get("content-length"))).toBeGreaterThan(
        asset.minimumLength,
      );
      expect(source.length).toBeGreaterThan(asset.minimumLength);
      expect(source).toContain(asset.marker);

      const head = await fetch(vendorUrl, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(response.headers.get("etag"));
      expect(head.headers.get("content-length")).toBe(response.headers.get("content-length"));
      expect(await head.text()).toBe("");

      const notModified = await fetch(vendorUrl, {
        headers: { "If-None-Match": response.headers.get("etag") ?? "" },
      });
      expect(notModified.status).toBe(304);

      const rejected = await fetch(vendorUrl, { method: "POST" });
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(productHandlerSawVendorRoute).toBe(false);
  });

  it("streams byte ranges only from media inside a registered preview project", async () => {
    const fixture = await serverFixture();
    const inputDir = join(fixture.projectDir, "input");
    await mkdir(inputDir, { recursive: true });
    const mediaPath = join(inputDir, "source.mp4");
    const mediaSize = 1024 * 1024 + 8192;
    const media = Buffer.allocUnsafe(mediaSize);
    for (let index = 0; index < media.length; index += 1) media[index] = index % 251;
    await writeFile(mediaPath, media);

    const outsideMedia = join(fixture.root, "outside.mp4");
    await writeFile(outsideMedia, Buffer.alloc(2048, 7));
    await symlink(outsideMedia, join(inputDir, "escaped.mp4"));

    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
    });
    servers.push(server);

    const mediaUrl = `${server.url}/api/projects/demo/preview/input/source.mp4`;
    const range = await fetch(mediaUrl, { headers: { Range: "bytes=4096-5119" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("accept-ranges")).toBe("bytes");
    expect(range.headers.get("content-range")).toBe(`bytes 4096-5119/${mediaSize}`);
    expect(range.headers.get("content-length")).toBe("1024");
    expect(range.headers.get("content-type")).toBe("video/mp4");
    const rangeBody = new Uint8Array(await range.arrayBuffer());
    expect(rangeBody).toHaveLength(1024);
    expect(rangeBody).toEqual(new Uint8Array(media.subarray(4096, 5120)));

    const head = await fetch(mediaUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("content-length")).toBe(String(mediaSize));
    expect(await head.arrayBuffer()).toHaveLength(0);

    const invalid = await fetch(mediaUrl, { headers: { Range: "bytes=invalid" } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe(`bytes */${mediaSize}`);
    const outOfBounds = await fetch(mediaUrl, {
      headers: { Range: `bytes=${mediaSize}-` },
    });
    expect(outOfBounds.status).toBe(416);
    expect(outOfBounds.headers.get("content-range")).toBe(`bytes */${mediaSize}`);

    const escaped = await fetch(
      `${server.url}/api/projects/demo/preview/input/escaped.mp4`,
    );
    expect(escaped.status).toBe(404);
    const traversed = await fetch(
      `${server.url}/api/projects/demo/preview/%2E%2E%2Foutside.mp4`,
    );
    expect(traversed.status).toBe(404);

    const full = await fetch(mediaUrl);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(mediaSize));
    const reader = full.body?.getReader();
    const firstChunk = await reader?.read();
    expect(firstChunk?.value?.byteLength).toBeGreaterThan(0);
    expect(firstChunk?.value?.byteLength).toBeLessThan(mediaSize);
    await reader?.cancel();

    // The media handler only claims supported preview media. Existing generic
    // project and preview routes must continue to reach HyperFrames unchanged.
    expect((await fetch(`${server.url}/api/projects`)).status).toBe(200);
    const preview = await fetch(`${server.url}/api/projects/demo/preview`);
    expect(preview.status).toBe(200);
    const previewHtml = await preview.text();
    expect(previewHtml).toContain('<base href="/api/projects/demo/preview/">');
    expect(previewHtml).toContain("input/source.mp4");
    expect(previewHtml).not.toContain(
      "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js",
    );
    expect(previewHtml).toContain("/api/vendor/gsap.min.js");
    const genericAsset = await fetch(
      `${server.url}/api/projects/demo/preview/index.html`,
    );
    expect(genericAsset.status).toBe(200);
  });

  it("serves Studio, runtime, API, SSE, and product handler routes", async () => {
    const fixture = await serverFixture();
    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
      apiHandler(request) {
        if (new URL(request.url).pathname === "/api/test") {
          return Response.json({ ok: true });
        }
        return null;
      },
    });
    servers.push(server);

    expect(server.port).toBeGreaterThan(0);
    expect(await (await fetch(`${server.url}/`)).text()).toContain("Studio");
    expect(await (await fetch(`${server.url}/assets/app.js`)).text()).toContain("studioSmoke");
    const health = await fetch(`${server.url}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toMatchObject({
      schemaVersion: 1,
      ok: true,
      product: "chengfeng-videocut",
      productVersion: PRODUCT_VERSION,
      pid: process.pid,
      runtimeMode: "foreground",
    });
    const capabilityResponse = await fetch(
      `${server.url}/chengfeng-videocut-capabilities.json`,
    );
    expect(capabilityResponse.status).toBe(200);
    expect(capabilityResponse.headers.get("content-type")).toContain("application/json");
    expect(capabilityResponse.headers.get("cache-control")).toBe("no-store");
    expect(await capabilityResponse.json()).toEqual({
      schemaVersion: 1,
      product: "chengfeng-videocut",
      studioVersion: "0.2.1",
      features: {
        topLevelViews: ["storyboard", "preview", "koubo"],
        legacyWorkbenchPanel: false,
        managedTimelineEditing: true,
        managedTimelineOperations: ["move", "trim", "split", "delete", "restore", "delete-range", "restore-snapshot"],
      },
    });
    const runtime = await fetch(`${server.url}/api/runtime.js`);
    expect(runtime.status).toBe(200);
    expect((await runtime.text()).length).toBeGreaterThan(100_000);
    expect(await (await fetch(`${server.url}/api/test`)).json()).toEqual({ ok: true });

    const projects = await fetch(`${server.url}/api/projects`);
    expect(projects.status).toBe(200);
    expect(JSON.stringify(await projects.json())).toContain("demo");
    const preview = await fetch(`${server.url}/api/projects/demo/preview`);
    expect(preview.status).toBe(200);

    const controller = new AbortController();
    const sse = await fetch(`${server.url}/api/events`, { signal: controller.signal });
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const reader = sse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain("connected");
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  });

  it("reports launchd only when the product service marker owns the process", async () => {
    const fixture = await serverFixture();
    const previousMarker = process.env.CHENGFENG_VIDEOCUT_SERVICE;
    process.env.CHENGFENG_VIDEOCUT_SERVICE = "launchd";
    let server: RunningStudioServer;
    try {
      server = await startStudioServer({
        port: 0,
        projectsDir: fixture.projectsDir,
        dataDir: join(fixture.root, "data"),
        staticDir: fixture.staticDir,
      });
    } finally {
      if (previousMarker === undefined) delete process.env.CHENGFENG_VIDEOCUT_SERVICE;
      else process.env.CHENGFENG_VIDEOCUT_SERVICE = previousMarker;
    }
    servers.push(server);

    expect(await (await fetch(`${server.url}/api/health`)).json()).toMatchObject({
      product: "chengfeng-videocut",
      productVersion: PRODUCT_VERSION,
      pid: process.pid,
      runtimeMode: "launchd",
    });
  });

  it("serves one coherent Studio snapshot while dist is rebuilt", async () => {
    const fixture = await serverFixture();
    const server = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data"),
      staticDir: fixture.staticDir,
    });
    servers.push(server);

    const initialIndex = await (await fetch(`${server.url}/`)).text();
    const initialAsset = await (await fetch(`${server.url}/assets/app.js`)).text();
    expect(initialIndex).toContain("Studio");
    expect(initialAsset).toContain("studioSmoke");

    await writeFile(join(fixture.staticDir, "index.html"), "<!doctype html><title>New build</title>");
    await writeFile(join(fixture.staticDir, "assets/app.js"), "globalThis.__newBuild = true;");

    expect(await (await fetch(`${server.url}/`)).text()).toBe(initialIndex);
    expect(await (await fetch(`${server.url}/assets/app.js`)).text()).toBe(initialAsset);
    const head = await fetch(`${server.url}/assets/app.js`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength(initialAsset)));
  });

  it("keeps build identity tied to published assets, not TypeScript metadata", async () => {
    const fixture = await serverFixture();
    const metadataPath = join(fixture.staticDir, "tsconfig.tsbuildinfo");
    await writeFile(metadataPath, '{"version":"first"}\n');

    const first = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data-first"),
      staticDir: fixture.staticDir,
    });
    servers.push(first);
    const firstHealth = await (await fetch(`${first.url}/api/health`)).json() as {
      studioBuildId: string;
    };

    await writeFile(metadataPath, '{"version":"after-typecheck"}\n');
    const second = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data-second"),
      staticDir: fixture.staticDir,
    });
    servers.push(second);
    const secondHealth = await (await fetch(`${second.url}/api/health`)).json() as {
      studioBuildId: string;
    };

    expect(secondHealth.studioBuildId).toBe(firstHealth.studioBuildId);
    expect((await fetch(`${second.url}/tsconfig.tsbuildinfo`)).status).toBe(404);

    await writeFile(join(fixture.staticDir, "assets/app.js"), "globalThis.__newStudioBuild = true;");
    const third = await startStudioServer({
      port: 0,
      projectsDir: fixture.projectsDir,
      dataDir: join(fixture.root, "data-third"),
      staticDir: fixture.staticDir,
    });
    servers.push(third);
    const thirdHealth = await (await fetch(`${third.url}/api/health`)).json() as {
      studioBuildId: string;
    };

    expect(thirdHealth.studioBuildId).not.toBe(firstHealth.studioBuildId);
  });
});
