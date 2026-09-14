"use strict";
const assert = require("node:assert/strict");
const { test: nodeTest } = require("node:test");
const test = (name, fn) => nodeTest(name, { skip: process.platform !== "darwin" }, fn);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { ensureBun, BUN_RELEASE } = require("../install.cjs");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bun bootstrap ' space-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  fs.mkdirSync(path.join(source, "bun-darwin-aarch64"), { recursive: true });
  fs.writeFileSync(path.join(source, BUN_RELEASE.entry), '#!/bin/sh\nprintf "1.4.2\\n"\n', { mode: 0o755 });
  const archive = path.join(dir, "fixture.zip");
  execFileSync("/usr/bin/zip", ["-q", archive, BUN_RELEASE.entry], { cwd: source });
  const release = { ...BUN_RELEASE, sha256: createHash("sha256").update(fs.readFileSync(archive)).digest("hex") };
  let downloads = 0;
  const root = path.join(dir, "product");
  return { dir, root, release, archive, options: {
    root, release, candidates: [], platform: "darwin-arm64",
    downloadAsset: async (_url, destination) => { downloads++; fs.copyFileSync(archive, destination); },
  }, downloads: () => downloads };
}

test("compatible existing Bun is reused without downloading or creating product directories", async (t) => {
  const f = fixture(t);
  const existing = path.join(f.dir, "source", BUN_RELEASE.entry);
  assert.equal(await ensureBun({ ...f.options, candidates: [existing] }), existing);
  assert.equal(f.downloads(), 0);
  assert.equal(fs.existsSync(f.root), false);
});

test("missing or incompatible Bun installs exact verified bytes, then reuses cache", async (t) => {
  const f = fixture(t);
  const old = path.join(f.dir, "old bun");
  fs.writeFileSync(old, '#!/bin/sh\nprintf "1.1.0\\n"\n', { mode: 0o755 });
  const executable = await ensureBun({ ...f.options, candidates: [old] });
  assert.equal(execFileSync(executable, ["--version"], { encoding: "utf8" }).trim(), "1.4.2");
  assert.equal(await ensureBun(f.options), executable);
  assert.equal(f.downloads(), 1);
  assert.equal(execFileSync(old, ["--version"], { encoding: "utf8" }).trim(), "1.1.0");
});

test("digest mismatch and network failure leave prior Runtime and launcher unchanged", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "app"), { recursive: true });
  fs.mkdirSync(path.join(f.root, "bin"));
  fs.symlinkSync("previous", path.join(f.root, "app", "current"));
  fs.symlinkSync("previous-launcher", path.join(f.root, "bin", "chengfeng-videocut"));
  fs.writeFileSync(path.join(f.root, "installer-state.json"), "prior journal");
  for (const options of [
    { release: { ...f.release, sha256: "0".repeat(64) } },
    { downloadAsset: async () => { throw new Error("offline"); } },
  ]) {
    await assert.rejects(ensureBun({ ...f.options, ...options }), /SHA-256|offline/);
    assert.equal(fs.readlinkSync(path.join(f.root, "app", "current")), "previous");
    assert.equal(fs.readlinkSync(path.join(f.root, "bin", "chengfeng-videocut")), "previous-launcher");
    assert.equal(fs.readFileSync(path.join(f.root, "installer-state.json"), "utf8"), "prior journal");
    assert.deepEqual(fs.readdirSync(path.join(f.root, "dependencies", "bun", "1.4.2")), []);
  }
});

test("tampered cache is preserved and rejected, including a changed binary with matching claimed version", async (t) => {
  const f = fixture(t);
  const executable = await ensureBun(f.options);
  fs.appendFileSync(executable, "# tampered\n");
  await assert.rejects(ensureBun(f.options), /缓存内容已改变/);
  await assert.rejects(ensureBun({ ...f.options, candidates: [executable] }), /缓存内容已改变/);
  const alias = path.join(f.dir, "cache alias");
  fs.symlinkSync(executable, alias);
  await assert.rejects(ensureBun({ ...f.options, candidates: [alias] }), /缓存内容已改变/);
  assert.match(fs.readFileSync(executable, "utf8"), /tampered/);
  assert.equal(f.downloads(), 1);
});

test("symlink cache directory never writes outside managed root", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.root);
  fs.symlinkSync(f.dir, path.join(f.root, "dependencies"));
  await assert.rejects(ensureBun(f.options), /不是普通目录/);
  assert.equal(f.downloads(), 0);
});

test("a real managed Bun shim inherited in PATH cannot bypass cache integrity", async (t) => {
  const f = fixture(t);
  const executable = await ensureBun(f.options);
  fs.mkdirSync(path.join(f.root, "bin"));
  const shimDirectory = execFileSync(process.execPath, ["-e", 'process.stdout.write(require(process.argv[1]).createBunShim(process.argv[2]))', path.resolve(__dirname, "../install.cjs"), executable], {
    env: { ...process.env, CHENGFENG_VIDEOCUT_HOME: f.root }, encoding: "utf8",
  });
  const shim = path.join(shimDirectory, "bun");
  assert.equal(await ensureBun({ ...f.options, candidates: [shim] }), executable);
  fs.appendFileSync(executable, "# changed but same version\n");
  await assert.rejects(ensureBun({ ...f.options, candidates: [shim] }), /缓存内容已改变/);
  assert.equal(f.downloads(), 1);
});

test("unsupported platforms never borrow a macOS archive", async (t) => {
  const f = fixture(t);
  await assert.rejects(ensureBun({ ...f.options, platform: "win32-x64" }), /尚无已核验/);
  assert.equal(f.downloads(), 0);
});

test("unconfirmed Bun probe termination preserves structured evidence and never falls back", async (t) => {
  const f = fixture(t);
  const failure = require("../install.cjs").executableFailure("无法验证 Bun 版本", {
    error: { code: "ENOBUFS" }, status: null,
    termination: { confirmed: false, rootPid: 123, method: "test", detailCode: "unconfirmed" },
  });
  assert.equal(failure.code, "EPROCESSTREE");
  assert.equal(failure.terminationFailure.reasonCode, "ENOBUFS");
  await assert.rejects(ensureBun({ ...f.options, candidates: [path.join(f.dir, "source", BUN_RELEASE.entry)], probe: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(f.downloads(), 0);
});

test("pinned launcher survives a new process with empty PATH and quotes spaces and apostrophes", (t) => {
  const f = fixture(t);
  const bun = process.env.BUN_BOOTSTRAP_REAL_BUN || spawnSync("/bin/sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
  assert.ok(bun, "real Bun required for launcher/child-process verification");
  const bin = path.join(f.dir, "selected bun's directory");
  fs.mkdirSync(bin);
  fs.symlinkSync(bun, path.join(bin, "bun"));
  fs.writeFileSync(path.join(bin, "ffmpeg"), '#!/bin/sh\nprintf "external-ffmpeg\\n"\n', { mode: 0o755 });
  const managed = path.join(f.root, "tools", "current");
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(managed, "bun"), '#!/bin/sh\nprintf "0.1.0\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(managed, "ffmpeg"), '#!/bin/sh\nprintf "managed-ffmpeg\\n"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(f.root, "app", "current"), { recursive: true });
  fs.mkdirSync(path.join(f.root, "bin"));
  fs.writeFileSync(path.join(f.root, "app", "current", "cli.js"), 'console.log(JSON.stringify({version:Bun.spawnSync(["bun","--version"]).stdout.toString().trim(),ffmpeg:Bun.spawnSync(["ffmpeg"]).stdout.toString().trim(),args:process.argv.slice(2),root:process.env.CHENGFENG_VIDEOCUT_DATA_DIR}));');
  const source = execFileSync(process.execPath, ["-e", 'const m=require(process.argv[1]);process.stdout.write(m.pinnedLauncher(process.argv[2],m.createBunShim(process.argv[2])))', path.resolve(__dirname, "../install.cjs"), path.join(bin, "bun")], {
    env: { ...process.env, CHENGFENG_VIDEOCUT_HOME: f.root }, encoding: "utf8",
  });
  const launcher = path.join(f.root, "bin", "chengfeng-videocut");
  fs.writeFileSync(launcher, source, { mode: 0o755 });
  const result = spawnSync(launcher, ["one two", "it's safe"], { env: { PATH: "" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.args, ["one two", "it's safe"]);
  assert.equal(observed.version, execFileSync(bun, ["--version"], { encoding: "utf8" }).trim());
  assert.equal(observed.ffmpeg, "managed-ffmpeg");
  assert.equal(observed.root, f.root);
  const explicitRoot = path.join(f.dir, "explicit data root");
  const explicit = spawnSync(launcher, [], { env: { PATH: "", CHENGFENG_VIDEOCUT_DATA_DIR: explicitRoot, CHENGFENG_VIDEOCUT_HOME: explicitRoot }, encoding: "utf8" });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).root, explicitRoot);
});
