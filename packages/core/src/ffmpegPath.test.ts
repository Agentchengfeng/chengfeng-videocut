import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ffmpegFileArg } from "./ffmpegPath";

describe("ffmpeg 文件参数", () => {
  it("给 POSIX 路径加 file: 前缀（macOS 上以 - 开头的文件名不会被当成选项）", () => {
    expect(ffmpegFileArg("/home/a/项目/成片.mp4")).toBe("file:/home/a/项目/成片.mp4");
    expect(ffmpegFileArg("-weird-name.mp4")).toBe("file:-weird-name.mp4");
  });

  it("把 Windows 反斜杠换成正斜杠，扩展名才推断得出来", () => {
    // 2026-08-04 用户真机报障：file:C:\Users\…\audio.mp3 → ffmpeg 报
    // "Unable to choose an output format"，因为反斜杠在 URL 语法里不是分隔符。
    const windowsTemp = ["C:", "Users", "时仙女", "AppData", "Local", "Temp", "x", "audio.mp3"];
    expect(ffmpegFileArg(windowsTemp.join("\\")))
      .toBe(`file:${windowsTemp.join("/")}`);
  });

  it("保留盘符，不让 ffmpeg 把 C: 读成协议名", () => {
    expect(ffmpegFileArg("D:\\video\\a.mp4")).toStartWith("file:D:/");
  });
});

describe("全库不得再手拼 file: 前缀", () => {
  it("媒体命令的文件参数一律走 ffmpegFileArg", () => {
    const root = resolve(import.meta.dir, "../../..");
    const offenders: string[] = [];
    const skipDirs = new Set(["node_modules", "dist", ".git", "release", "data"]);

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (skipDirs.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
        if (path.endsWith(join("core", "src", "ffmpegPath.ts"))) continue;
        if (/`file:\$\{/.test(readFileSync(path, "utf8"))) {
          offenders.push(path.slice(root.length + 1));
        }
      }
    };
    for (const workspace of ["packages", "apps"]) walk(join(root, workspace));

    expect(offenders).toEqual([]);
  });
});
