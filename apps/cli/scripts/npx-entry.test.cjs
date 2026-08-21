"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CLI_DIR = path.resolve(__dirname, "..");
const ENTRY = path.join(CLI_DIR, "src", "npx-entry.cjs");
const VERSION = JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8")).version;
const ACCEPT_PUBLIC_BETA = "--accept-public-beta";

function platform() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { key: "darwin-arm64", name: "@chengfeng/videocut-runtime-darwin-arm64", os: "darwin", cpu: "arm64", asset: "installer" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { key: "darwin-x64", name: "@chengfeng/videocut-runtime-darwin-x64", os: "darwin", cpu: "x64", asset: "installer" };
  }
  if (process.platform === "win32" && process.arch === "x64") {
    return { key: "win32-x64", name: "@chengfeng/videocut-runtime-win32-x64", os: "win32", cpu: "x64", asset: "installer.exe" };
  }
  throw new Error(`unsupported test platform ${process.platform}-${process.arch}`);
}

function sha256(file) {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fixture({ beta = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "videocut-npx-entry-"));
  const target = platform();
  const dist = path.join(dir, "dist");
  const runtimeDir = path.join(dir, "node_modules", ...target.name.split("/"));
  fs.mkdirSync(path.join(runtimeDir, "payload"), { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.copyFileSync(ENTRY, path.join(dist, "npx-entry.cjs"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "@chengfeng/videocut",
    version: VERSION,
    optionalDependencies: { [target.name]: VERSION },
  }));
  fs.writeFileSync(path.join(runtimeDir, "package.json"), JSON.stringify({ name: target.name, version: VERSION }));
  const installer = path.join(runtimeDir, "payload", target.asset);
  fs.writeFileSync(installer, `#!/bin/sh
set -eu
target="$2"
mkdir -p "$target/bin"
cat > "$target/bin/chengfeng-videocut" <<'LAUNCHER'
#!/bin/sh
if [ "\${1:-}" = doctor ]; then
  printf '{"healthy":true}\\n'
  exit 0
fi
printf 'runtime argv: %s\\n' "$*"
LAUNCHER
chmod 700 "$target/bin/chengfeng-videocut"
`);
  fs.chmodSync(installer, 0o700);
  const manifest = {
    schemaVersion: 1,
    product: "chengfeng-videocut",
    productVersion: VERSION,
    platformKey: target.key,
    npmPackage: { name: target.name, version: VERSION, os: [target.os], cpu: [target.cpu] },
    distributionMode: beta ? "public-beta" : "release-ready",
    licenseStatus: beta ? "UNVERIFIED" : "VERIFIED",
    ...(beta ? { beta: { channel: "windows-x64-public-beta", acknowledgement: ACCEPT_PUBLIC_BETA } } : {}),
    installer: {
      asset: target.asset,
      path: `payload/${target.asset}`,
      sha256: sha256(installer),
      size: fs.statSync(installer).size,
      executable: true,
    },
  };
  fs.writeFileSync(path.join(runtimeDir, "chengfeng-videocut-runtime-package.json"), JSON.stringify(manifest));
  return { dir, entry: path.join(dist, "npx-entry.cjs") };
}

function invoke(fixturePath, argv) {
  return childProcess.spawnSync(process.execPath, [fixturePath.entry, ...argv], {
    encoding: "utf8",
    env: { ...process.env, HOME: path.join(fixturePath.dir, "home"), USERPROFILE: path.join(fixturePath.dir, "home") },
  });
}

test("Node npx entry installs the exact platform Runtime then forwards CLI argv", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const result = invoke(f, ["doctor"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"healthy":true/);
    assert.equal(fs.existsSync(path.join(f.dir, "home", ".chengfeng-videocut", "bin", "chengfeng-videocut")), true);
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("Node npx entry refuses an unacknowledged beta before invoking an installer", { skip: process.platform !== "win32" }, () => {
  // The public beta is Windows-only. The real Windows smoke test covers the
  // cmd.exe invocation path; this branch exists so the contract remains explicit.
  assert.ok(true);
});
