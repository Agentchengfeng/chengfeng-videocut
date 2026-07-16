import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    join(projectDir, "index.html"),
    '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script></head><body><main data-hf-composition="main" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-duration="2"><video src="input/source.mp4"></video></main><script>window.__timelines = {};</script></body></html>',
  );
  return { root, staticDir, projectsDir, projectDir };
}

describe("packaged Studio server", () => {
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
});
