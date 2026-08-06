"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const VERSION = "0.5.0";
const STAGE = path.join(ROOT, "scripts/stage-native-release.ts");
const PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "win32-x64"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileRecord(directory, name, root) {
  const bytes = readFileSync(path.join(directory, name));
  return {
    asset: name,
    ...(root ? { root } : {}),
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

function writeToolsArchive(root, source, platformKey, { releaseReady = true, executable = true } = {}) {
  const [platform, arch] = platformKey.split("-");
  const rootName = `chengfeng-videocut-tools-${VERSION}-${platformKey}`;
  const bundle = path.join(root, rootName);
  mkdirSync(path.join(bundle, "chrome"), { recursive: true });
  const suffix = platform === "win32" ? ".exe" : "";
  const executables = {
    bun: `bun${suffix}`,
    ffmpeg: `ffmpeg${suffix}`,
    ffprobe: `ffprobe${suffix}`,
    chrome: `chrome/chrome${suffix}`,
  };
  for (const [key, relative] of Object.entries(executables)) {
    writeFileSync(path.join(bundle, relative), `${platformKey}:${key}\n`);
    if (platform === "darwin" && executable) chmodSync(path.join(bundle, relative), 0o755);
  }
  const files = Object.values(executables).map((relative) => {
    const bytes = readFileSync(path.join(bundle, relative));
    return { path: relative, size: bytes.length, sha256: sha256(bytes) };
  });
  writeFileSync(path.join(bundle, "resources-manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    product: "chengfeng-videocut-managed-tools",
    productVersion: VERSION,
    platform,
    arch,
    executables,
    versions: { bun: "1", ffmpeg: "1", ffprobe: "1", chrome: "1" },
    distributionMode: releaseReady ? "release-ready" : "local-test-only",
    files,
    licenseStatus: releaseReady ? "VERIFIED" : "UNVERIFIED",
    licenseNote: "test fixture",
  }, null, 2)}\n`);
  const asset = `${rootName}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(source, asset), "-C", root, rootName]);
  return { asset, root: rootName };
}

function createNativeSource(testRoot, { releaseReady = true, toolsExecutable = true } = {}) {
  const source = path.join(testRoot, "source");
  mkdirSync(source, { recursive: true });
  const runtimeRoot = path.join(testRoot, `chengfeng-videocut-${VERSION}`);
  mkdirSync(runtimeRoot);
  writeFileSync(path.join(runtimeRoot, "VERSION"), `${VERSION}\n`);
  const runtimeAsset = `chengfeng-videocut-runtime-${VERSION}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(source, runtimeAsset), "-C", testRoot, path.basename(runtimeRoot)]);
  const installerAssets = {
    "darwin-arm64": "chengfeng-videocut-installer-macos-arm64",
    "darwin-x64": "chengfeng-videocut-installer-macos-x64",
    "win32-x64": "chengfeng-videocut-installer-windows-x64.exe",
  };
  const platforms = {};
  for (const platformKey of PLATFORM_KEYS) {
    const installerAsset = installerAssets[platformKey];
    writeFileSync(path.join(source, installerAsset), `${platformKey}:installer\n`);
    if (platformKey.startsWith("darwin-")) chmodSync(path.join(source, installerAsset), 0o755);
    const tools = writeToolsArchive(testRoot, source, platformKey, {
      releaseReady,
      executable: toolsExecutable,
    });
    platforms[platformKey] = {
      installerAsset,
      installer: fileRecord(source, installerAsset),
      tools: fileRecord(source, tools.asset, tools.root),
    };
  }
  const manifest = {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    productVersion: VERSION,
    releaseTag: `v${VERSION}`,
    distributionMode: releaseReady ? "release-ready" : "local-test-only",
    runtime: fileRecord(source, runtimeAsset, path.basename(runtimeRoot)),
    platforms,
    licenseStatus: releaseReady ? "VERIFIED" : "UNVERIFIED",
    licenseNote: "test fixture",
  };
  writeFileSync(
    path.join(source, "chengfeng-videocut-install-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { source, manifest };
}

function run(script, env) {
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY;
  delete cleanEnvironment.CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY_SHA256;
  return spawnSync("bun", [script], {
    cwd: ROOT,
    env: { ...cleanEnvironment, ...env },
    encoding: "utf8",
  });
}

function runStageWithSnapshotReplacement(source, destination, asset, expectedBytes) {
  const trustPolicy = path.join(path.dirname(source), "protected-native-trust-policy.json");
  writeFileSync(trustPolicy, "{\"test\":\"module-mocked-security-gate\"}\n");
  chmodSync(trustPolicy, 0o444);
  const program = `
    import { mock } from "bun:test";
    import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const asset = process.env.NATIVE_MUTATED_ASSET;
    const expected = Buffer.from(process.env.NATIVE_EXPECTED_BASE64, "base64");
    mock.module(process.env.NATIVE_SIGNATURE_MODULE, () => ({
      nativeInstallerAssets: [
        "chengfeng-videocut-installer-macos-arm64",
        "chengfeng-videocut-installer-macos-x64",
        "chengfeng-videocut-installer-windows-x64.exe",
      ],
      verifyNativeReleaseSecurity: async ({ releaseDir }) => {
        const sourceDir = process.env.NATIVE_SOURCE;
        await rename(sourceDir, sourceDir + ".before-replacement");
        await mkdir(sourceDir);
        await writeFile(join(sourceDir, asset), "post-snapshot replacement bytes\\n");
        const actual = await readFile(join(releaseDir, asset));
        if (!actual.equals(expected)) throw new Error("security verifier did not receive snapshot bytes");
      },
    }));
    const { stageNativeRelease } = await import(${JSON.stringify(STAGE)});
    await stageNativeRelease({
      sourceDir: process.env.NATIVE_SOURCE,
      destinationDir: process.env.NATIVE_DESTINATION,
    });
  `;
  return spawnSync("bun", ["-e", program], {
    cwd: ROOT,
    env: {
      ...process.env,
      NATIVE_SOURCE: source,
      NATIVE_DESTINATION: destination,
      NATIVE_MUTATED_ASSET: asset,
      NATIVE_EXPECTED_BASE64: expectedBytes.toString("base64"),
      NATIVE_SIGNATURE_MODULE: path.join(ROOT, "scripts/native-release-signatures.ts"),
      CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY: trustPolicy,
      CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY_SHA256: sha256(readFileSync(trustPolicy)),
    },
    encoding: "utf8",
  });
}

function verifyContent(source) {
  return spawnSync("bun", [
    "-e",
    "import {verifyNativeReleaseInputs} from './scripts/release-assets.ts'; await verifyNativeReleaseInputs({releaseDir:process.env.NATIVE_SOURCE,version:'0.5.0'});",
  ], {
    cwd: ROOT,
    env: { ...process.env, NATIVE_SOURCE: source },
    encoding: "utf8",
  });
}

test("exact VERIFIED content passes structural checks but formal stage blocks without pinned signing policy", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-valid-")));
  try {
    const { source } = createNativeSource(root);
    const content = verifyContent(source);
    assert.equal(content.status, 0, `${content.stdout}\n${content.stderr}`);
    const destination = path.join(root, "destination");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "sentinel.txt"), "do not delete\n");
    const staged = run(STAGE, {
      CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
      CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: destination,
    });
    assert.notEqual(staged.status, 0);
    assert.match(`${staged.stdout}\n${staged.stderr}`, /Out-of-band native trust policy is required/);
    assert.equal(readFileSync(path.join(destination, "sentinel.txt"), "utf8"), "do not delete\n");
    assert.equal(
      readdirSync(root).filter((name) => name.startsWith(".destination.snapshot-")).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production stage exposes no injectable security verifier and rejects checkout policy as trust", () => {
  const stageSource = readFileSync(STAGE, "utf8");
  assert.doesNotMatch(stageSource, /testHooks|afterSnapshot|verifySecurity|securityVerifier/);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-local-trust-")));
  try {
    const { source } = createNativeSource(root);
    const localPolicy = path.join(ROOT, "installer/native-release-signing-policy.json");
    const staged = run(STAGE, {
      CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
      CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: path.join(root, "destination"),
      CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY: localPolicy,
      CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY_SHA256: sha256(readFileSync(localPolicy)),
    });
    assert.notEqual(staged.status, 0);
    assert.match(`${staged.stdout}\n${staged.stderr}`, /must live outside the release checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage verifies and atomically publishes immutable snapshot bytes after source path replacement", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-snapshot-")));
  try {
    const { source } = createNativeSource(root);
    const destination = path.join(root, "destination");
    const asset = "chengfeng-videocut-installer-windows-x64.exe";
    const expectedBytes = readFileSync(path.join(source, asset));
    const staged = runStageWithSnapshotReplacement(source, destination, asset, expectedBytes);
    assert.equal(staged.status, 0, `${staged.stdout}\n${staged.stderr}`);
    assert.equal(
      readFileSync(path.join(source, asset), "utf8"),
      "post-snapshot replacement bytes\n",
    );
    assert.deepEqual(readFileSync(path.join(destination, asset)), expectedBytes);
    const checksum = readFileSync(path.join(destination, "SHA256SUMS.txt"), "utf8");
    assert.match(checksum, new RegExp(`^${sha256(expectedBytes)}  ${asset}$`, "m"));
    const verified = verifyContent(destination);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.equal(
      readdirSync(root).filter((name) => name.startsWith(".destination.snapshot-")).length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bad source manifest fails before an existing destination sentinel is inspected or deleted", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-bad-")));
  try {
    const { source, manifest } = createNativeSource(root);
    manifest.distributionMode = "local-test-only";
    writeFileSync(
      path.join(source, "chengfeng-videocut-install-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const destination = path.join(root, "destination");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "sentinel.txt"), "do not delete\n");
    const staged = run(STAGE, {
      CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
      CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: destination,
    });
    assert.notEqual(staged.status, 0);
    assert.match(`${staged.stdout}\n${staged.stderr}`, /not VERIFIED|release-ready/);
    assert.equal(readFileSync(path.join(destination, "sentinel.txt"), "utf8"), "do not delete\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LOCAL_TOOLS_FIXTURE is explicitly forbidden from native staging", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-local-")));
  try {
    const { source } = createNativeSource(root);
    const staged = run(STAGE, {
      CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
      CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: path.join(root, "destination"),
      CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE: "1",
    });
    assert.notEqual(staged.status, 0);
    assert.match(`${staged.stdout}\n${staged.stderr}`, /can never be staged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("top-level VERIFIED cannot hide a local-test-only resources manifest", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-resource-")));
  try {
    const { source } = createNativeSource(root, { releaseReady: false });
    const manifestPath = path.join(source, "chengfeng-videocut-install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.distributionMode = "release-ready";
    manifest.licenseStatus = "VERIFIED";
    for (const platformKey of PLATFORM_KEYS) {
      const tools = manifest.platforms[platformKey].tools;
      Object.assign(tools, fileRecord(source, tools.asset, tools.root));
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const staged = run(STAGE, {
      CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
      CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: path.join(root, "destination"),
    });
    assert.notEqual(staged.status, 0);
    assert.match(`${staged.stdout}\n${staged.stderr}`, /resources-manifest is not VERIFIED\/release-ready/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native gate rejects non-executable macOS installers and managed tools", () => {
  for (const damaged of ["installer", "tools"]) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `videocut-native-release-mode-${damaged}-`)));
    try {
      const { source } = createNativeSource(root, { toolsExecutable: damaged !== "tools" });
      if (damaged === "installer") {
        chmodSync(path.join(source, "chengfeng-videocut-installer-macos-arm64"), 0o644);
      }
      const staged = run(STAGE, {
        CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
        CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: path.join(root, "destination"),
      });
      assert.notEqual(staged.status, 0);
      assert.match(`${staged.stdout}\n${staged.stderr}`, /not executable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
