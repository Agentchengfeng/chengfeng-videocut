"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/write-install-manifest.ts");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeFixture(releaseDir, licenseStatus) {
  const version = "0.5.0";
  const runtimeName = `chengfeng-videocut-runtime-${version}.tar.gz`;
  const installerName = "chengfeng-videocut-installer-macos-arm64";
  const toolsName = `chengfeng-videocut-tools-${version}-darwin-arm64.tar.gz`;
  const runtimeBytes = Buffer.from("runtime");
  const toolsBytes = Buffer.from("tools");
  writeFileSync(path.join(releaseDir, runtimeName), runtimeBytes);
  writeFileSync(path.join(releaseDir, installerName), "installer");
  writeFileSync(path.join(releaseDir, toolsName), toolsBytes);
    writeFileSync(path.join(releaseDir, `${toolsName}.json`), `${JSON.stringify({
      platformKey: "darwin-arm64",
      asset: toolsName,
      root: toolsName.slice(0, -".tar.gz".length),
      sha256: sha256(toolsBytes),
      size: toolsBytes.length,
      resourcesManifestSha256: "a".repeat(64),
    distributionMode: licenseStatus === "VERIFIED" ? "release-ready" : "local-test-only",
    licenseStatus,
  })}\n`);
}

function generate(releaseDir, lockPath, allowLocalFixture) {
  return spawnSync("bun", [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CHENGFENG_VIDEOCUT_RELEASE_DIR: releaseDir,
      CHENGFENG_VIDEOCUT_MANAGED_TOOLS_LOCK: lockPath,
      CHENGFENG_VIDEOCUT_ALLOW_PARTIAL_MANIFEST: "1",
      CHENGFENG_VIDEOCUT_ALLOW_LOCAL_TOOLS_FIXTURE: allowLocalFixture ? "1" : "0",
    },
  });
}

test("install manifest becomes VERIFIED only when the lock and every selected sidecar are VERIFIED", () => {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-install-manifest-")));
  try {
    const lockPath = path.join(temp, "managed-tools.lock.json");
    writeFileSync(lockPath, `${JSON.stringify({ licenseStatus: "VERIFIED", licenseNote: "review recorded" })}\n`);
    writeFixture(temp, "VERIFIED");
    const verified = generate(temp, lockPath, false);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(
      JSON.parse(readFileSync(path.join(temp, "chengfeng-videocut-install-manifest.json"), "utf8")).licenseStatus,
      "VERIFIED",
    );

    writeFixture(temp, "UNVERIFIED");
    const local = generate(temp, lockPath, true);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(
      JSON.parse(readFileSync(path.join(temp, "chengfeng-videocut-install-manifest.json"), "utf8")).licenseStatus,
      "UNVERIFIED",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
