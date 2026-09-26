import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createModuleApi } from "./server/module-api";
import { moduleOrigin, readModuleCandidate } from "./module-command";
import { PRODUCT_VERSION } from "./output";

test("module origin rejects nonliteral/external/credential/path/redirect sources", () => {
  for (const origin of ["https://127.0.0.1:1234", "http://localhost:1234", "http://127.1:1234", "http://2130706433:1234", "http://example.com", "http://127.0.0.1/a/..", "http://a@127.0.0.1", "http://127.0.0.1?x", "http://127.0.0.1#x"]) expect(() => moduleOrigin(origin)).toThrow();
  expect(moduleOrigin("http://[::1]:1234/")).toBe("http://[::1]:1234");
});

test("candidate limits reject oversized manifests/files and symlinked manifest/parents", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-cli-bounds-")));
  const manifestPath = join(root, "module-manifest.json");
  const file = { path: "index.html", bytes: 0, sha256: createHash("sha256").update("").digest("hex") };
  const manifest = { schemaVersion: 1, moduleId: "scene", version: "v1", entry: "index.html", files: [file] };
  try {
    await writeFile(join(root, "index.html"), "");
    await writeFile(manifestPath, " ".repeat(65537));
    await expect(readModuleCandidate(manifestPath, root)).rejects.toThrow();
    for (const files of [Array(33).fill(file), [{ ...file, bytes: 524289 }], Array.from({ length: 5 }, (_, n) => ({ ...file, path: n ? `a${n}.html` : "index.html", bytes: 524288 }))]) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, files }));
      await expect(readModuleCandidate(manifestPath, root)).rejects.toThrow();
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, "index.html"), "x".repeat(524289));
    await expect(readModuleCandidate(manifestPath, root)).rejects.toThrow();
    await writeFile(join(root, "index.html"), "");
    await symlink(manifestPath, join(root, "linked.json"));
    await expect(readModuleCandidate(join(root, "linked.json"), root)).rejects.toThrow();
    await symlink(root, join(root, "linked-parent"));
    await expect(readModuleCandidate(join(root, "linked-parent/module-manifest.json"), root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Real product module handler + loopback HTTP + independent CLI child, with no client registry.
test("isolated CLI module publication, immutable readback and failure gates", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-cli-")));
  const registry = join(root, "server-registry"), project = join(registry, "demo"), candidate = join(root, "candidate"), client = join(root, "unregistered-client");
  await mkdir(project, { recursive: true }); await mkdir(candidate); await mkdir(client);
  await writeFile(join(project, "project.json"), JSON.stringify({ jobId: "demo" }));
  let healthPatch: Record<string, unknown> = {}, redirect = false, corruptReadback = false, healthCount = 0, driftAt = 0, posts = 0, postFailure = false, disconnectPost = false, driftOnGet = false;
  let api: ReturnType<typeof createModuleApi>;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/health") {
      healthCount++;
      if (redirect) return new Response(null, { status: 302, headers: { location: "/other" } });
      return Response.json({ ok: true, product: "chengfeng-videocut", productVersion: PRODUCT_VERSION, pid: process.pid, studioBuildId: driftAt && healthCount >= driftAt ? "changed" : "fixture", modulePublishApiVersion: 1, ...healthPatch });
    }
    if (req.method === "POST") {
      posts++;
      if (disconnectPost) { server.stop(true); return new Response(null); }
      if (postFailure) return Response.json({ error: { code: "fixture_failure" } }, { status: 500 });
    }
    const response = await api(req, "127.0.0.1");
    if (driftOnGet && req.method === "GET") healthPatch = { studioBuildId: "replaced-during-get" };
    if (corruptReadback && req.method === "GET" && response?.ok) return Response.json({ ...await response.json(), digest: "bad" });
    return response ?? new Response("missing", { status: 404 });
  } });
  api = createModuleApi(registry, server.port!);
  const fixturePort = server.port;
  const origin = `http://127.0.0.1:${fixturePort}`;
  const manifestPath = join(candidate, "module-manifest.json");
  const make = async (text = "<html>ok</html>", patch = {}) => {
    await writeFile(join(candidate, "index.html"), text);
    const manifest = { schemaVersion: 1, moduleId: "scene", version: "v1", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }], ...patch };
    await writeFile(manifestPath, JSON.stringify(manifest)); return manifest;
  };
  const call = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), "module", ...args, "--api-base", origin, "--json"], { cwd: client, stdout: "pipe", stderr: "pipe", env: { ...process.env, VIDEO_WORKBENCH_PROJECTS_DIR: join(client, "missing-registry"), HTTP_PROXY: "http://127.0.0.1:1" } });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); return { exitCode, ...JSON.parse(stdout) };
  };
  const publish = (flags = ["--confirmed"]) => call(["publish", "demo", "--file", manifestPath, ...flags]);
  try {
    await make();
    expect((await publish([])).error.code).toBe("confirmation_required"); expect(posts).toBe(0);
    expect((await publish(["--dry-run"])).data).toMatchObject({ dryRun: true, submitted: false }); expect(posts).toBe(0);
    for (const patch of [{ product: "foreign" }, { productVersion: "0.0.0" }, { pid: 0 }, { studioBuildId: "" }, { modulePublishApiVersion: undefined }]) {
      healthPatch = patch; const r = await publish(); expect(r.exitCode).not.toBe(0); expect(r.error.details.submitted).toBe(false);
    }
    healthPatch = {}; redirect = true; expect((await publish()).error.code).toBe("module_redirect_rejected"); redirect = false;
    healthCount = 0; driftAt = 2; expect((await publish()).error.code).toBe("module_source_changed"); driftAt = 0;
    expect(posts).toBe(0); expect(await readdir(project)).toEqual(["project.json"]);
    const missing = await call(["get", "demo", "scene", "missing"]);
    expect(missing.exitCode).not.toBe(0); expect(missing.error.code).toBe("module_http_error");
    const valid = await make();
    await make("x", { files: [{ ...valid.files[0], sha256: "0".repeat(64) }] }); expect((await publish()).error.code).toBe("module_candidate_invalid");
    await make('<img src="missing.png">'); expect((await publish()).error.code).toBe("module_candidate_invalid");
    await make("ok", { files: [{ ...valid.files[0], path: "../index.html" }] }); expect((await publish()).error.code).toBe("module_candidate_invalid");
    await make(); await rm(join(candidate, "index.html")); expect((await publish()).error.code).toBe("module_candidate_invalid");
    await symlink(join(project, "project.json"), join(candidate, "index.html")); expect((await publish()).error.code).toBe("module_candidate_invalid"); await rm(join(candidate, "index.html"));
    expect(posts).toBe(0);
    await make(); const first = await publish(); expect(first.exitCode).toBe(0); expect(first.data.readBackVerified).toBe(true);
    expect((await publish()).data.digest).toBe(first.data.digest);
    const get = await call(["get", "demo", "scene", "v1"]); expect(get.exitCode).toBe(0); expect(get.data.digest).toBe(first.data.digest);
    await make("<html>different</html>"); const conflict = await publish(); expect(conflict.exitCode).not.toBe(0); expect(conflict.error.code).toBe("module_conflict"); expect(conflict.error.details.submitted).toBe("rejected"); expect(conflict.error.details.serviceCode).toBe("module_conflict");
    expect(await readFile(join(project, "modules/published/scene/v1/index.html"), "utf8")).toBe("<html>ok</html>");
    await make(); corruptReadback = true; const corrupt = await publish(); expect(corrupt.error.code).toBe("module_publish_result_unknown"); expect(corrupt.error.details.causeCode).toBe("module_readback_mismatch"); corruptReadback = false;
    healthCount = 0; driftAt = 3; expect((await publish()).error.code).toBe("module_publish_result_unknown"); driftAt = 0;
    driftOnGet = true;
    expect((await publish()).error.code).toBe("module_publish_result_unknown"); healthPatch = {};
    expect((await call(["get", "demo", "scene", "v1"])).error.code).toBe("module_source_changed");
    driftOnGet = false; healthPatch = {};
    postFailure = true; const beforeFailure = posts;
    expect((await publish()).error.code).toBe("module_publish_result_unknown"); expect(posts).toBe(beforeFailure + 1); postFailure = false;
    const beforeDisconnect = posts; disconnectPost = true;
    expect((await publish()).error.code).toBe("module_publish_result_unknown"); expect(posts).toBe(beforeDisconnect + 1);
    expect(await readdir(client)).toEqual([]);
    expect((await readdir(project)).sort()).toEqual(["modules", "project.json"]);
    console.log(JSON.stringify({ fixture: "module-command.test.ts", port: fixturePort, pid: process.pid, sourceVersion: PRODUCT_VERSION, posts, digest: first.data.digest, clientRegistryCreated: false }));
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30000);
