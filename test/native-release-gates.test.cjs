"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function writeToolsArchive(root, source, platformKey, {
  releaseReady = true,
  executable = true,
  schemaVersion = 4,
  rendererWorkerExecutable,
  rendererWorkerArguments,
} = {}) {
  const [platform, arch] = platformKey.split("-");
  const rootName = `chengfeng-videocut-tools-${VERSION}-${platformKey}`;
  const bundle = path.join(root, rootName);
  if (![2, 3, 4].includes(schemaVersion)) throw new Error("unsupported fixture schema version");
  mkdirSync(bundle, { recursive: true });
  if (schemaVersion === 2) mkdirSync(path.join(bundle, "chrome"), { recursive: true });
  const suffix = platform === "win32" ? ".exe" : "";
  const executables = {
    bun: `bun${suffix}`,
    ffmpeg: `ffmpeg${suffix}`,
    ffprobe: `ffprobe${suffix}`,
    ...(schemaVersion === 2 ? { chrome: `chrome/chrome${suffix}` } : {}),
  };
  for (const [key, relative] of Object.entries(executables)) {
    writeFileSync(path.join(bundle, relative), `${platformKey}:${key}\n`);
    if (platform === "darwin" && executable) chmodSync(path.join(bundle, relative), 0o755);
  }
  let resources;
  if (schemaVersion === 3) {
    const rendererRootName = `chengfeng-videocut-export-renderer-${VERSION}-${platformKey}`;
    const rendererRoot = path.join(root, rendererRootName);
    const worker = {
      executable: rendererWorkerExecutable ?? `electron/electron${suffix}`,
      arguments: rendererWorkerArguments ?? ["app/main.mjs"],
    };
    mkdirSync(path.join(rendererRoot, "electron"), { recursive: true });
    mkdirSync(path.join(rendererRoot, "app"), { recursive: true });
    writeFileSync(path.join(rendererRoot, "electron", `electron${suffix}`), "fixture electron\n");
    writeFileSync(path.join(rendererRoot, "app", "main.mjs"), "export {};\n");
    const rendererManifestPath = path.join(rendererRoot, "renderer-manifest.json");
    writeFileSync(rendererManifestPath, `${JSON.stringify({
      schemaVersion: 1,
      product: "chengfeng-videocut-export-renderer",
      platform,
      arch,
      worker,
    }, null, 2)}\n`);
    const rendererArchiveRelative = `resources/chengfeng-videocut-export-renderer-${VERSION}-${platformKey}.tar.gz`;
    const rendererArchive = path.join(bundle, rendererArchiveRelative);
    mkdirSync(path.dirname(rendererArchive), { recursive: true });
    execFileSync("tar", ["-czf", rendererArchive, "-C", root, rendererRootName]);
    const bytes = readFileSync(rendererArchive);
    resources = {
      exportRenderer: {
        archive: rendererArchiveRelative,
        sha256: sha256(bytes),
        size: bytes.length,
        root: rendererRootName,
        rendererManifestSha256: sha256(readFileSync(rendererManifestPath)),
        worker,
      },
    };
  }
  const files = Object.values(executables).map((relative) => {
    const bytes = readFileSync(path.join(bundle, relative));
    return { path: relative, size: bytes.length, sha256: sha256(bytes) };
  });
  if (schemaVersion === 3) {
    const relative = resources.exportRenderer.archive;
    const bytes = readFileSync(path.join(bundle, relative));
    files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
  }
  writeFileSync(path.join(bundle, "resources-manifest.json"), `${JSON.stringify({
    schemaVersion,
    product: "chengfeng-videocut-managed-tools",
    productVersion: VERSION,
    platform,
    arch,
    executables,
    versions: schemaVersion === 2
      ? { bun: "1", ffmpeg: "1", ffprobe: "1", chrome: "1" }
      : { bun: "1", ffmpeg: "1", ffprobe: "1" },
    ...(resources ? { resources } : {}),
    distributionMode: releaseReady ? "release-ready" : "local-test-only",
    files,
    licenseStatus: releaseReady ? "VERIFIED" : "UNVERIFIED",
    licenseNote: "test fixture",
  }, null, 2)}\n`);
  const asset = `${rootName}.tar.gz`;
  execFileSync("tar", ["-czf", path.join(source, asset), "-C", root, rootName]);
  return { asset, root: rootName };
}

function createNativeSource(testRoot, {
  releaseReady = true,
  toolsExecutable = true,
  toolsSchemaVersion = 4,
  rendererWorkerExecutable,
  rendererWorkerArguments,
} = {}) {
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
      schemaVersion: toolsSchemaVersion,
      rendererWorkerExecutable,
      rendererWorkerArguments,
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

test("exact VERIFIED content passes structural checks but source-controlled formal stage is always blocked", () => {
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
    assert.match(
      `${staged.stdout}\n${staged.stderr}`,
      /independent protected release orchestrator is not implemented or configured/,
    );
    assert.equal(readFileSync(path.join(destination, "sentinel.txt"), "utf8"), "do not delete\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release content verifier rejects legacy Chrome and Electron tool schemas", () => {
  for (const toolsSchemaVersion of [2, 3]) {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `videocut-native-release-legacy-v${toolsSchemaVersion}-`)));
    try {
      const { source } = createNativeSource(root, { toolsSchemaVersion });
      const content = verifyContent(source);
      assert.notEqual(content.status, 0);
      assert.match(`${content.stdout}\n${content.stderr}`, /resources-manifest is not VERIFIED\/release-ready\/exact-platform/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("attacker-controlled read-only policy and matching SHA cannot enable formal staging", () => {
  const stageSource = readFileSync(STAGE, "utf8");
  assert.doesNotMatch(stageSource, /process\.env|testHooks|policyPath|verifySecurity|securityVerifier/);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-attacker-trust-")));
  try {
    const { source } = createNativeSource(root);
    const attackerPolicy = path.join(root, "attacker-policy.json");
    writeFileSync(attackerPolicy, JSON.stringify({
      schemaVersion: 2,
      status: "VERIFIED",
      githubAttestation: {
        signerRepository: "attacker/release-builder",
        signerWorkflow: "attacker/release-builder/.github/workflows/attest.yml",
        signerDigest: "a".repeat(40),
      },
    }));
    chmodSync(attackerPolicy, 0o444);
    const destination = path.join(root, "destination");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "sentinel.txt"), "do not delete\n");
    const staged = run(STAGE, {
      CHENGFENG_VIDEOCUT_NATIVE_ASSET_SOURCE: source,
      CHENGFENG_VIDEOCUT_NATIVE_RELEASE_DIR: destination,
      CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY: attackerPolicy,
      CHENGFENG_VIDEOCUT_NATIVE_TRUST_POLICY_SHA256: sha256(readFileSync(attackerPolicy)),
    });
    assert.notEqual(staged.status, 0);
    assert.match(
      `${staged.stdout}\n${staged.stderr}`,
      /independent protected release orchestrator is not implemented or configured/,
    );
    assert.equal(readFileSync(path.join(destination, "sentinel.txt"), "utf8"), "do not delete\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content verifier still rejects a bad source manifest independently of disabled staging", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "videocut-native-release-bad-")));
  try {
    const { source, manifest } = createNativeSource(root);
    manifest.distributionMode = "local-test-only";
    writeFileSync(
      path.join(source, "chengfeng-videocut-install-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const content = verifyContent(source);
    assert.notEqual(content.status, 0);
    assert.match(`${content.stdout}\n${content.stderr}`, /not VERIFIED|release-ready/);
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
    const content = verifyContent(source);
    assert.notEqual(content.status, 0);
    assert.match(`${content.stdout}\n${content.stderr}`, /resources-manifest is not VERIFIED\/release-ready/);
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
      const content = verifyContent(source);
      assert.notEqual(content.status, 0);
      assert.match(`${content.stdout}\n${content.stderr}`, /not executable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
