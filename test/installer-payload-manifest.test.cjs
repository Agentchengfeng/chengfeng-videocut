"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/write-installer-payload-manifest.ts");
const VERSION = "0.5.0";
const PLATFORM = "darwin-arm64";
const MANIFEST = "chengfeng-videocut-installer-payload-manifest.json";
const CHECKSUMS = "chengfeng-videocut-installer-payload-SHA256SUMS.txt";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-installer-payload-")));
  const release = path.join(temp, "release");
  const payload = path.join(temp, "payload");
  const lock = path.join(temp, "managed-tools.lock.json");
  mkdirSync(release);
  const runtimeAsset = `chengfeng-videocut-runtime-${VERSION}.tar.gz`;
  const toolsAsset = `chengfeng-videocut-tools-${VERSION}-${PLATFORM}.tar.gz`;
  const runtimeBytes = Buffer.from("minimal runtime archive payload\n");
  const toolsBytes = Buffer.from("minimal tools archive payload\n");
  writeFileSync(path.join(release, runtimeAsset), runtimeBytes);
  writeFileSync(path.join(release, toolsAsset), toolsBytes);
  writeFileSync(path.join(release, `${toolsAsset}.json`), `${JSON.stringify({
    platformKey: PLATFORM,
    asset: toolsAsset,
    root: toolsAsset.slice(0, -".tar.gz".length),
    sha256: sha256(toolsBytes),
    size: toolsBytes.length,
    distributionMode: "release-ready",
    licenseStatus: "VERIFIED",
  }, null, 2)}\n`);
  writeFileSync(lock, `${JSON.stringify({
    product: "chengfeng-videocut",
    productVersion: VERSION,
    licenseStatus: "VERIFIED",
    licenseNote: "test redistribution review",
  }, null, 2)}\n`);
  return {
    temp,
    release,
    payload,
    lock,
    runtimeAsset,
    toolsAsset,
    runtimeBytes,
    toolsBytes,
  };
}

function run({ release, payload, lock }, { includeOutputDirectory = true } = {}) {
  const env = {
    ...process.env,
    CHENGFENG_VIDEOCUT_RELEASE_DIR: release,
    CHENGFENG_VIDEOCUT_INSTALLER_TARGETS: PLATFORM,
    CHENGFENG_VIDEOCUT_MANAGED_TOOLS_LOCK: lock,
  };
  if (includeOutputDirectory) env.CHENGFENG_VIDEOCUT_INSTALLER_PAYLOAD_DIR = payload;
  return spawnSync("bun", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

test("installer payload receipt binds the exact runtime, one platform tools archive, and its three-file checksum", () => {
  const value = fixture();
  try {
    const result = run(value);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const directory = path.join(value.payload, PLATFORM);
    const manifestPath = path.join(directory, MANIFEST);
    const checksumPath = path.join(directory, CHECKSUMS);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.deepEqual(manifest, {
      schemaVersion: 1,
      product: "chengfeng-videocut",
      productVersion: VERSION,
      releaseTag: `v${VERSION}`,
      distributionMode: "release-ready",
      licenseStatus: "VERIFIED",
      licenseNote: "test redistribution review",
      runtime: {
        asset: value.runtimeAsset,
        root: `chengfeng-videocut-${VERSION}`,
        sha256: sha256(value.runtimeBytes),
        size: value.runtimeBytes.length,
      },
      platforms: {
        [PLATFORM]: {
          tools: {
            asset: value.toolsAsset,
            root: value.toolsAsset.slice(0, -".tar.gz".length),
            sha256: sha256(value.toolsBytes),
            size: value.toolsBytes.length,
          },
        },
      },
    });
    const checksumLines = readFileSync(checksumPath, "utf8").trimEnd().split("\n");
    assert.deepEqual(checksumLines, [
      `${sha256(readFileSync(manifestPath))}  ${MANIFEST}`,
      `${sha256(value.runtimeBytes)}  ${value.runtimeAsset}`,
      `${sha256(value.toolsBytes)}  ${value.toolsAsset}`,
    ]);
    assert.ok(checksumLines.every((line) => /^[a-f0-9]{64}  [^\s]+$/.test(line)));
  } finally {
    rmSync(value.temp, { recursive: true, force: true });
  }
});

test("installer payload receipt fails closed when a tools sidecar does not attest to its exact archive", () => {
  const value = fixture();
  try {
    const sidecarPath = path.join(value.release, `${value.toolsAsset}.json`);
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    sidecar.sha256 = "0".repeat(64);
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`);
    const result = run(value);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /sidecar does not match its exact archive/);
  } finally {
    rmSync(value.temp, { recursive: true, force: true });
  }
});

test("payload receipt CLI requires an explicit staging directory instead of writing into release", () => {
  const value = fixture();
  try {
    const result = run(value, { includeOutputDirectory: false });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /INSTALLER_PAYLOAD_DIR is required/);
    assert.equal(existsSync(path.join(value.release, ".installer-payload")), false);
  } finally {
    rmSync(value.temp, { recursive: true, force: true });
  }
});
