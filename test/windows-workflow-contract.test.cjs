"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const WINDOWS_WORKFLOW = readFileSync(
  path.join(ROOT, ".github/workflows/windows-test.yml"),
  "utf8",
);
const INSTALLER_WORKFLOW = readFileSync(
  path.join(ROOT, ".github/workflows/native-windows-installer-smoke.yml"),
  "utf8",
);
const MANAGED_TOOLS_LOCK = JSON.parse(readFileSync(
  path.join(ROOT, "installer/managed-tools.lock.json"),
  "utf8",
));

test("Windows PR/main uses the self-contained Product installer rather than the legacy portable archive", () => {
  assert.match(
    WINDOWS_WORKFLOW,
    /install-smoke:\s*\n\s+uses: \.\/\.github\/workflows\/native-windows-installer-smoke\.yml/,
  );
  assert.doesNotMatch(WINDOWS_WORKFLOW, /github\.event_name == ['"]workflow_dispatch['"]/);
  assert.doesNotMatch(WINDOWS_WORKFLOW, /package-portable|local-release|CHENGFENG_VIDEOCUT_DOWNLOAD_BASE/);
  assert.match(WINDOWS_WORKFLOW, /timeout-minutes: 30/);
  assert.match(WINDOWS_WORKFLOW, /name: 准备固定版本的 FFmpeg 6\.0 测试工具[\s\S]*?timeout-minutes: 10/);
  assert.match(WINDOWS_WORKFLOW, /name: 全量单测[\s\S]*?timeout-minutes: 20/);
  assert.match(WINDOWS_WORKFLOW, /name: 原生项目 watcher（独立硬门禁）[\s\S]*?timeout-minutes: 5/);
  assert.match(
    WINDOWS_WORKFLOW,
    /name: 受管 Headless Shell 真实下载与成片门禁[\s\S]*?timeout-minutes: 10[\s\S]*?CHENGFENG_VIDEOCUT_RENDERER_E2E: ["']1["'][\s\S]*?exportFilm\.managed-runtime\.test\.ts/,
  );
  assert.match(WINDOWS_WORKFLOW, /releases\/download\/b6\.0\/ffmpeg-win32-x64/);
  assert.match(WINDOWS_WORKFLOW, /e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1/);
  assert.match(WINDOWS_WORKFLOW, /releases\/download\/b6\.0\/ffprobe-win32-x64/);
  assert.match(WINDOWS_WORKFLOW, /139f8420bcb2f29fcd5734e29d686289df826cadce5d2b7b5f56d0000ea9a951/);
  assert.doesNotMatch(WINDOWS_WORKFLOW, /ffmpeg-release-essentials\.zip/);
});

test("Windows installer smoke pins exact 6.0 fixtures by URL and SHA256", () => {
  assert.match(INSTALLER_WORKFLOW, /workflow_call:/);
  assert.match(INSTALLER_WORKFLOW, /timeout-minutes: 45/);
  assert.equal(MANAGED_TOOLS_LOCK.licenseStatus, "UNVERIFIED");
  assert.equal(MANAGED_TOOLS_LOCK.tools.ffmpeg.version, "6.0");
  assert.equal(MANAGED_TOOLS_LOCK.tools.ffprobe.version, "6.0");
  assert.match(
    INSTALLER_WORKFLOW,
    /releases\/download\/b6\.0\/ffmpeg-win32-x64/,
  );
  assert.match(
    INSTALLER_WORKFLOW,
    /e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1/,
  );
  assert.match(
    INSTALLER_WORKFLOW,
    /releases\/download\/b6\.0\/ffprobe-win32-x64/,
  );
  assert.match(
    INSTALLER_WORKFLOW,
    /139f8420bcb2f29fcd5734e29d686289df826cadce5d2b7b5f56d0000ea9a951/,
  );
  assert.match(INSTALLER_WORKFLOW, /Get-FileHash -Algorithm SHA256/);
  assert.match(INSTALLER_WORKFLOW, /\^ffmpeg version \(\?:n\)\?/);
  assert.match(INSTALLER_WORKFLOW, /\^ffprobe version \(\?:n\)\?/);
  assert.match(INSTALLER_WORKFLOW, /CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE=1/);
  assert.match(INSTALLER_WORKFLOW, /CHENGFENG_VIDEOCUT_ALLOW_UNVERIFIED_LOCAL_TOOLS: ["']1["']/);
  assert.match(INSTALLER_WORKFLOW, /local-test-only managed tools/);
  assert.doesNotMatch(INSTALLER_WORKFLOW, /require\(['"]ffmpeg-static['"]\)/);
  assert.doesNotMatch(INSTALLER_WORKFLOW, /require\(['"]@derhuerst\/ffprobe-static['"]\)/);
});
