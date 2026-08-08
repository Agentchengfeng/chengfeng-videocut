"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/package-managed-tools.ts");

function executable(pathname, output) {
  writeFileSync(pathname, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`, { mode: 0o755 });
  chmodSync(pathname, 0o755);
}

function packagingEnvironment({ root, output }) {
  const bun = path.join(root, "bun");
  const ffmpeg = path.join(root, "ffmpeg");
  const ffprobe = path.join(root, "ffprobe");
  executable(bun, "1.3.5");
  executable(ffmpeg, "ffmpeg version 6.0");
  executable(ffprobe, "ffprobe version 6.0");
  return {
    ...process.env,
    CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE: "1",
    CHENGFENG_VIDEOCUT_BUN_SOURCE: bun,
    CHENGFENG_VIDEOCUT_FFMPEG_SOURCE: ffmpeg,
    CHENGFENG_VIDEOCUT_FFPROBE_SOURCE: ffprobe,
    // These deliberately point nowhere. Schema 4 must neither require nor
    // carry an Electron sidecar as part of the managed-tools product.
    CHENGFENG_VIDEOCUT_EXPORT_RENDERER_ARCHIVE: path.join(root, "missing-renderer.tar.gz"),
    CHENGFENG_VIDEOCUT_EXPORT_RENDERER_SIDECAR: path.join(root, "missing-renderer.tar.gz.json"),
    CHENGFENG_VIDEOCUT_TOOLS_OUTPUT_DIR: output,
  };
}

test("local tools packaging emits schema 4 with no browser or renderer resource", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "videocut-tools-schema4-"));
  try {
    const output = path.join(root, "release");
    const result = spawnSync("bun", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: packagingEnvironment({ root, output }),
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const sidecar = JSON.parse(result.stdout.trim());
    const extracted = path.join(root, "extracted");
    mkdirSync(extracted, { recursive: true });
    const unpacked = spawnSync("tar", ["-xzf", path.join(output, sidecar.asset), "-C", extracted], { encoding: "utf8" });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    const bundle = path.join(extracted, sidecar.root);
    const manifest = JSON.parse(readFileSync(path.join(bundle, "resources-manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 4);
    assert.deepEqual(Object.keys(manifest.executables).sort(), ["bun", "ffmpeg", "ffprobe"]);
    assert.equal(Object.hasOwn(manifest, "resources"), false);
    assert.equal(manifest.files.some((record) => /electron|renderer|chrome/i.test(record.path)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public tools packaging fails closed while redistribution is UNVERIFIED", () => {
  const result = spawnSync("bun", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE: "0" },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Public release packaging is blocked/);
});
