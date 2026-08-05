import test from "node:test";
import assert from "node:assert/strict";
import { delimiter, join, resolve } from "node:path";
import {
  classifyRuntimeHealth,
  parseDesktopPort,
  parseDesktopProjectId,
  prependToolsPath,
  resolveDesktopLayout,
  studioUrl,
} from "./runtime.mjs";

test("parseDesktopPort accepts an explicit canonical port", () => {
  assert.equal(parseDesktopPort("5190"), 5190);
  assert.equal(parseDesktopPort(undefined), 5190);
  assert.throws(() => parseDesktopPort("0"), /Invalid desktop Runtime port/);
  assert.throws(() => parseDesktopPort("65536"), /Invalid desktop Runtime port/);
});

test("resolveDesktopLayout keeps packaged resources outside app.asar", () => {
  const layout = resolveDesktopLayout({
    isPackaged: true,
    resourcesPath: "/Applications/Chengfeng VideoCut.app/Contents/Resources",
    appRoot: "/ignored",
    platform: "darwin",
  });
  assert.equal(
    layout.cliPath,
    resolve("/Applications/Chengfeng VideoCut.app/Contents/Resources/runtime/cli.js"),
  );
  assert.equal(
    layout.bunPath,
    resolve("/Applications/Chengfeng VideoCut.app/Contents/Resources/runtime/bin/bun"),
  );
});

test("resolveDesktopLayout uses exe names on Windows", () => {
  const layout = resolveDesktopLayout({
    isPackaged: false,
    resourcesPath: "ignored",
    appRoot: "C:/repo/apps/desktop",
    platform: "win32",
  });
  assert.equal(layout.bunPath, join(layout.runtimeDir, "bin", "bun.exe"));
  assert.equal(layout.ffmpegPath, join(layout.toolsDir, "ffmpeg.exe"));
  assert.equal(layout.ffprobePath, join(layout.toolsDir, "ffprobe.exe"));
});

test("prependToolsPath makes bundled media tools win", () => {
  assert.equal(prependToolsPath("/usr/bin", "/app/tools"), `/app/tools${delimiter}/usr/bin`);
  assert.equal(prependToolsPath("", "/app/tools"), "/app/tools");
});

test("classifyRuntimeHealth spawns only when no service answers", () => {
  assert.deepEqual(classifyRuntimeHealth(null, "0.4.7"), { action: "spawn" });
});

test("classifyRuntimeHealth reuses only a complete matching product", () => {
  assert.deepEqual(
    classifyRuntimeHealth({
      ok: true,
      product: "chengfeng-videocut",
      productVersion: "0.4.7",
      pid: 42,
      runtimeMode: "launchd",
    }, "0.4.7"),
    { action: "reuse", pid: 42, runtimeMode: "launchd" },
  );
  assert.throws(
    () => classifyRuntimeHealth({
      ok: true,
      product: "other",
      productVersion: "0.4.7",
    }, "0.4.7"),
    /does not belong/,
  );
  assert.throws(
    () => classifyRuntimeHealth({
      ok: true,
      product: "chengfeng-videocut",
      productVersion: "0.4.6",
    }, "0.4.7"),
    /version conflict/,
  );
  assert.throws(
    () => classifyRuntimeHealth({
      ok: true,
      product: "chengfeng-videocut",
      productVersion: "0.4.7",
      mediaToolsMissing: ["ffmpeg"],
    }, "0.4.7"),
    /required media tools/,
  );
});

test("studioUrl opens the existing talking-head workbench", () => {
  assert.equal(studioUrl("http://127.0.0.1:5190"), "http://127.0.0.1:5190/?view=koubo");
  assert.equal(
    studioUrl("http://127.0.0.1:5190", "真实 项目"),
    "http://127.0.0.1:5190/?view=koubo#project/%E7%9C%9F%E5%AE%9E%20%E9%A1%B9%E7%9B%AE",
  );
});

test("parseDesktopProjectId accepts app arguments without allowing path traversal", () => {
  assert.equal(parseDesktopProjectId([], undefined), undefined);
  assert.equal(parseDesktopProjectId([], "job3"), "job3");
  assert.equal(parseDesktopProjectId(["--project", "项目 1"], undefined), "项目 1");
  assert.equal(parseDesktopProjectId(["--project=job4"], "job3"), "job4");
  assert.throws(() => parseDesktopProjectId(["--project", "../job3"]), /Invalid desktop project id/);
});
