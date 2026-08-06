"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const INSTALLER = path.join(ROOT, "install.cjs");

function invoke(args, env = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function temporaryRoot(prefix) {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

for (const [label, args, pattern] of [
  ["unknown options", ["--future-option"], /未知安装器参数/],
  ["positional junk", ["surprise"], /不接受多余位置参数/],
  ["duplicate options", ["--json", "--json"], /安装器参数重复/],
  ["relative target roots", ["--target-root", "relative/home"], /必须是绝对路径/],
  ["filesystem root", ["--target-root", path.parse(ROOT).root], /不得是文件系统根/],
  ["user HOME", ["--target-root", os.homedir()], /不得是文件系统根、用户 HOME/],
]) {
  test(`installer rejects ${label}`, () => {
    const result = invoke(args);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, pattern);
  });
}

test("Windows HOME protection is case-insensitive", { skip: process.platform !== "win32" }, () => {
  const home = os.homedir();
  const differentlyCasedHome = home.replace(/[A-Za-z]/, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
  assert.notEqual(differentlyCasedHome, home);
  const result = invoke(["--target-root", differentlyCasedHome]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /不得是文件系统根、用户 HOME/);
});

test("a manifest download failure removes its private temporary directory", () => {
  const temp = temporaryRoot("videocut-installer-cleanup-test-");
  try {
    const result = invoke(
      [
        "--manifest", path.join(temp, "missing-manifest.json"),
        "--checksum-file", path.join(temp, "missing-checksums.txt"),
        "--target-root", path.join(temp, "home"),
      ],
      { TMPDIR: temp },
    );
    assert.notEqual(result.status, 0);
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("installer rejects an existing symlink or reparse component before writing the managed root", () => {
  const temp = temporaryRoot("videocut-installer-root-link-");
  try {
    const outside = path.join(temp, "outside");
    const linked = path.join(temp, "linked");
    mkdirSync(outside);
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const result = invoke(["--target-root", path.join(linked, "product")]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /不得是链接或 reparse point|规范路径跳转/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const managedName of ["app", "bin", "tools"]) {
  test(`installer rejects a pre-created ${managedName} symlink without writing its external target`, () => {
    const temp = temporaryRoot(`videocut-installer-${managedName}-link-`);
    try {
      const target = path.join(temp, "product");
      const outside = path.join(temp, `outside-${managedName}`);
      mkdirSync(target);
      mkdirSync(outside);
      writeFileSync(path.join(outside, "keep.txt"), "keep\n");
      symlinkSync(outside, path.join(target, managedName), process.platform === "win32" ? "junction" : "dir");
      const result = invoke(["--target-root", target]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /普通目录|reparse point|规范路径跳转/);
      assert.deepEqual(readdirSync(outside).sort(), ["keep.txt"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

test("installer rejects symlinked state and update-lock paths without touching external data", () => {
  for (const targetName of ["installer-state.json", "runtime-update.lock"]) {
    const temp = temporaryRoot(`videocut-installer-${targetName.replaceAll(".", "-")}-link-`);
    try {
      const target = path.join(temp, "product");
      const outside = path.join(temp, "outside");
      mkdirSync(target);
      mkdirSync(outside);
      writeFileSync(path.join(outside, "keep.txt"), "keep\n");
      if (targetName.endsWith(".json")) {
        symlinkSync(path.join(outside, "keep.txt"), path.join(target, targetName), "file");
      } else {
        symlinkSync(outside, path.join(target, targetName), process.platform === "win32" ? "junction" : "dir");
      }
      const result = invoke(["--target-root", target]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /single-link regular file|普通目录|reparse point/);
      assert.deepEqual(readdirSync(outside).sort(), ["keep.txt"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
});

test("installer rejects an oversized manifest before parsing or creating the target root", () => {
  const temp = temporaryRoot("videocut-installer-manifest-limit-");
  try {
    const manifest = path.join(temp, "oversized.json");
    const checksum = path.join(temp, "SHA256SUMS.txt");
    const target = path.join(temp, "product");
    writeFileSync(manifest, Buffer.alloc(1_048_577, 0x20));
    writeFileSync(checksum, "0".repeat(64) + "  chengfeng-videocut-install-manifest.json\n");
    const result = invoke([
      "--manifest", manifest,
      "--checksum-file", checksum,
      "--target-root", target,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /安装 manifest 超过允许的下载大小/);
    assert.equal(readdirSync(temp).includes("product"), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("chunked HTTP manifest download stops at the byte limit without buffering the whole response", async () => {
  const temp = temporaryRoot("videocut-installer-http-limit-");
  const server = spawn(process.execPath, ["-e", `
    const http = require("node:http");
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(Buffer.alloc(1048577, 0x20));
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
  `], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [chunk] = await once(server.stdout, "data");
    const port = Number(String(chunk).trim());
    assert.ok(Number.isInteger(port) && port > 0);
    const checksum = path.join(temp, "SHA256SUMS.txt");
    writeFileSync(checksum, "0".repeat(64) + "  chengfeng-videocut-install-manifest.json\n");
    const result = invoke([
      "--manifest", `http://127.0.0.1:${port}/manifest.json`,
      "--checksum-file", checksum,
      "--target-root", path.join(temp, "product"),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /安装 manifest 超过允许的下载大小/);
    assert.equal(readdirSync(temp).includes("product"), false);
  } finally {
    server.kill("SIGTERM");
    rmSync(temp, { recursive: true, force: true });
  }
});

test("formal asset download requires the exact byte size declared by the manifest", () => {
  const platformKey = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "darwin-x64", "win32-x64"].includes(platformKey)) return;
  const temp = temporaryRoot("videocut-installer-asset-size-");
  try {
    const runtimeAsset = "runtime.tar.gz";
    const toolsAsset = "tools.tar.gz";
    const runtimeBytes = Buffer.from("not-a-tar");
    writeFileSync(path.join(temp, runtimeAsset), runtimeBytes);
    writeFileSync(path.join(temp, toolsAsset), "x");
    const manifestValue = {
      schemaVersion: 1,
      product: "chengfeng-videocut",
      productVersion: "0.5.0",
      releaseTag: "v0.5.0",
      distributionMode: "local-test-only",
      runtime: {
        asset: runtimeAsset,
        root: "runtime",
        sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
        size: 1,
      },
      platforms: Object.fromEntries(
        ["darwin-arm64", "darwin-x64", "win32-x64"].map((key) => [key, {
          installerAsset: key === platformKey ? "installer" : `installer-${key}`,
          installer: {
            asset: key === platformKey ? "installer" : `installer-${key}`,
            sha256: "1".repeat(64),
            size: 1,
          },
          tools: key === platformKey
            ? { asset: toolsAsset, root: "tools", sha256: "0".repeat(64), size: 1 }
            : { asset: `tools-${key}.tar.gz`, root: `tools-${key}`, sha256: "0".repeat(64), size: 1 },
        }]),
      ),
      licenseStatus: "UNVERIFIED",
    };
    const manifest = path.join(temp, "chengfeng-videocut-install-manifest.json");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestValue)}\n`);
    writeFileSync(manifest, manifestBytes);
    const checksum = path.join(temp, "SHA256SUMS.txt");
    writeFileSync(
      checksum,
      `${createHash("sha256").update(manifestBytes).digest("hex")}  chengfeng-videocut-install-manifest.json\n`,
    );
    const result = invoke(
      [
        "--manifest", manifest,
        "--checksum-file", checksum,
        "--target-root", path.join(temp, "product"),
        "--allow-unverified-local-fixture",
      ],
      { CHENGFENG_VIDEOCUT_DOWNLOAD_BASE: pathToFileURL(temp).href },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Runtime bundle 大小与安装 manifest 不一致/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
