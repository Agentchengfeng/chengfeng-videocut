import { describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import {
  CHENGFENG_VIDEOCUT_CHROME_PATH,
  findSystemChrome,
} from "@video-workbench/core/node";
import { ChromePage, chromeSpawnOptions } from "./chrome";

describe("Chrome export process", () => {
  it("spawns Chrome directly rather than through a shell", () => {
    expect(chromeSpawnOptions()).toEqual({
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("reports an invalid explicit Chrome path instead of falling back silently", async () => {
    const previous = process.env[CHENGFENG_VIDEOCUT_CHROME_PATH];
    process.env[CHENGFENG_VIDEOCUT_CHROME_PATH] = "chrome.exe";
    try {
      await expect(ChromePage.launch({ width: 64, height: 64, transparent: true }))
        .rejects.toThrow("Chrome 路径配置无效：CHENGFENG_VIDEOCUT_CHROME_PATH 必须是 Chrome 可执行文件的绝对路径。");
    } finally {
      if (previous === undefined) delete process.env[CHENGFENG_VIDEOCUT_CHROME_PATH];
      else process.env[CHENGFENG_VIDEOCUT_CHROME_PATH] = previous;
    }
  });

  const runChromeSmoke = process.env.CHENGFENG_VIDEOCUT_RUN_CHROME_SMOKE === "1";
  (runChromeSmoke ? it : it.skip)("launches local Chrome and captures a real transparent PNG", async () => {
    const executable = findSystemChrome();
    expect(executable).not.toBeNull();
    expect(statSync(executable!).isFile()).toBeTrue();
    if (process.platform === "win32") {
      expect(executable).toMatch(/\\Google\\Chrome\\Application\\chrome\.exe$/i);
    }
    const page = await ChromePage.launch({ width: 64, height: 64, transparent: true });
    try {
      await page.goto(`data:text/html,${encodeURIComponent("<!doctype html><body style='margin:0;background:transparent'><div style='width:64px;height:64px;background:#0f0'></div>")}`);
      const png = await page.screenshot();
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.byteLength).toBeGreaterThan(100);
    } finally {
      await page.close();
    }
  });
});
