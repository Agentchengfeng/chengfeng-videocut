import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { startStudioServer } from "./server/start";

// Full production dispatcher/health/static snapshot, not a fixture health route.
// Only the temporary project is writable; each client is a separate CLI process.
test("module CLI works with production Studio and a server-only project registry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-production-")));
  const projectsDir = join(root, "server-projects");
  const projectId = "cli-production-demo";
  const project = join(projectsDir, projectId);
  const candidate = join(root, "candidate");
  const client = join(root, "client");
  const staticDir = join(root, "static");
  const projectJson = JSON.stringify({ jobId: projectId, title: "Isolated module CLI test" });
  const html = "<!doctype html><html><head><title>CLI module</title></head><body><h1>Verified module</h1></body></html>";
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = {
    schemaVersion: 1,
    moduleId: "cli-card", version: "v1", entry: "index.html",
    files: [{ path: "index.html", bytes: Buffer.byteLength(html), sha256: sha(html) }],
  };
  await mkdir(project, { recursive: true });
  await mkdir(candidate); await mkdir(client); await mkdir(staticDir);
  // Keep this regression runnable before a Studio build in a clean checkout.
  // The real static snapshot and health implementation still run unmodified.
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Isolated Studio shell</title>");
  await writeFile(join(staticDir, "chengfeng-videocut-capabilities.json"), JSON.stringify({
    schemaVersion: 1, product: "chengfeng-videocut", studioVersion: "0.2.0",
    features: { topLevelViews: ["storyboard", "preview", "koubo"], legacyWorkbenchPanel: false, managedTimelineEditing: true },
  }));
  await writeFile(join(project, "project.json"), projectJson);
  await writeFile(join(candidate, "index.html"), html);
  const manifestFile = join(candidate, "module-manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest));
  let server: Awaited<ReturnType<typeof startStudioServer>> | undefined;
  try {
    server = await startStudioServer({
      host: "127.0.0.1", port: 0, projectsDir, dataDir: join(root, "data"),
      staticDir, installSignalHandlers: false,
    });
    const origin = new URL(server.url).origin;
    expect([15192, 15197, 4186, 5190]).not.toContain(server.port);
    const health = await (await fetch(`${origin}/api/health`)).json();
    expect(health.modulePublishApiVersion).toBe(1);
    expect(health.studioBuildId).toMatch(/^[a-f0-9]+$/);
    const call = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "cli.ts"), "module", ...args, "--api-base", origin, "--json"], {
        cwd: client, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, CHENGFENG_VIDEOCUT_PROJECTS_DIR: join(client, "not-registered"), VIDEO_WORKBENCH_PROJECTS_DIR: join(client, "also-not-registered") },
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe("");
      return { ...JSON.parse(stdout), exitCode };
    };
    const publishArgs = ["publish", projectId, "--file", manifestFile];
    const unconfirmed = await call(publishArgs);
    expect(unconfirmed.exitCode).not.toBe(0);
    expect(unconfirmed.error.code).toBe("confirmation_required");
    expect((await call([...publishArgs, "--dry-run"])).data.submitted).toBe(false);
    expect(await readdir(project)).toEqual(["project.json"]);
    const publication = await call([...publishArgs, "--confirmed"]);
    expect(publication.exitCode).toBe(0);
    expect(publication.data.readBackVerified).toBe(true);
    expect(publication.data.source).toMatchObject({ pid: health.pid, productVersion: health.productVersion, studioBuildId: health.studioBuildId });
    const retrieved = await call(["get", projectId, "cli-card", "v1"]);
    expect(retrieved.exitCode).toBe(0);
    expect(retrieved.data.digest).toBe(publication.data.digest);
    const asset = await fetch(`${origin}/api/v1/projects/${projectId}/visuals/module/${retrieved.data.entryPath}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/html");
    expect(await asset.text()).toBe(html);
    expect(await readFile(join(project, "project.json"), "utf8")).toBe(projectJson);
    expect((await readdir(project)).sort()).toEqual(["modules", "project.json"]);
    expect(await readdir(client)).toEqual([]);
    console.log(JSON.stringify({ test: "production-module-cli", origin, pid: health.pid, studioBuildId: health.studioBuildId, digest: retrieved.data.digest, originalProjectSha256: sha(projectJson), readBackVerified: true, servedAsset: true, clientRegistryCreated: false }));
    await server.stop(); server = undefined;
    await expect(fetch(`${origin}/api/health`)).rejects.toThrow();
  } finally {
    if (server) await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
