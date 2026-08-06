"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
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

test("managed tools packaging rejects a Chrome source symlink to an external secret", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "videocut-tools-symlink-"));
  try {
    const chromeRoot = path.join(root, "chrome-headless-shell-mac-arm64");
    mkdirSync(chromeRoot, { recursive: true });
    const bun = path.join(root, "bun");
    const ffmpeg = path.join(root, "ffmpeg");
    const ffprobe = path.join(root, "ffprobe");
    const chrome = path.join(chromeRoot, "chrome-headless-shell");
    const secret = path.join(root, "secret.txt");
    executable(bun, "1.3.5");
    executable(ffmpeg, "ffmpeg version 6.0");
    executable(ffprobe, "ffprobe version 6.0");
    executable(chrome, "Google Chrome for Testing 151.0.7922.47");
    writeFileSync(secret, "must not enter archive\n");
    symlinkSync(secret, path.join(chromeRoot, "external-secret"));
    const result = spawnSync("bun", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE: "1",
        CHENGFENG_VIDEOCUT_BUN_SOURCE: bun,
        CHENGFENG_VIDEOCUT_FFMPEG_SOURCE: ffmpeg,
        CHENGFENG_VIDEOCUT_FFPROBE_SOURCE: ffprobe,
        CHENGFENG_VIDEOCUT_CHROME_ROOT: chromeRoot,
        CHENGFENG_VIDEOCUT_CHROME_EXECUTABLE: chrome,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /contains symlink/);
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
