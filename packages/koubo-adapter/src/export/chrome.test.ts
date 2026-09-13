import { describe, expect, it } from "bun:test";
import { chromeCandidatePaths } from "./chrome";

describe("Chrome executable discovery", () => {
  it("includes machine and per-user Windows Chrome installs", () => {
    const paths = chromeCandidatePaths("win32", {
      ProgramW6432: "C:\\Program Files",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\DELL\\AppData\\Local",
    });

    expect(paths).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\DELL\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });

  it("puts an explicit executable override first", () => {
    const paths = chromeCandidatePaths("win32", {
      CHENGFENG_VIDEOCUT_CHROME_PATH: "D:\\Browsers\\chrome.exe",
      ProgramFiles: "C:\\Program Files",
    });

    expect(paths[0]).toBe("D:\\Browsers\\chrome.exe");
    expect(paths).toContain("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("keeps the existing POSIX candidates on non-Windows hosts", () => {
    expect(chromeCandidatePaths("darwin", {})).toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(chromeCandidatePaths("linux", {})).toContain("/usr/bin/google-chrome");
  });
});
