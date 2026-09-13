import { describe, expect, it } from "bun:test";
import {
  CHENGFENG_VIDEOCUT_CHROME_PATH,
  findSystemChrome,
  SystemChromePathError,
} from "./node";

const chromeInProgramFiles = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const chromeInLocalAppData = "C:\\Users\\video\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
const chromeInProgramFilesX86 = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const chromeInProgramW6432 = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function existsOnly(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe("system Chrome discovery", () => {
  it("finds Chrome in Program Files without treating the space as an argument separator", () => {
    expect(findSystemChrome({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      isRegularFile: existsOnly(chromeInProgramFiles),
    })).toBe(chromeInProgramFiles);
  });

  it("finds a per-user Windows Chrome installation", () => {
    expect(findSystemChrome({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\video\\AppData\\Local" },
      isRegularFile: existsOnly(chromeInLocalAppData),
    })).toBe(chromeInLocalAppData);
  });

  it("finds the x86 Program Files installation", () => {
    expect(findSystemChrome({
      platform: "win32",
      env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      isRegularFile: existsOnly(chromeInProgramFilesX86),
    })).toBe(chromeInProgramFilesX86);
  });

  it("finds the ProgramW6432 Windows Chrome installation", () => {
    expect(findSystemChrome({
      platform: "win32",
      env: { ProgramW6432: "C:\\Program Files" },
      isRegularFile: existsOnly(chromeInProgramW6432),
    })).toBe(chromeInProgramW6432);
  });

  it("prefers an explicit Chrome path override", () => {
    const override = "D:\\Browsers\\chrome.exe";
    expect(findSystemChrome({
      platform: "win32",
      env: {
        [CHENGFENG_VIDEOCUT_CHROME_PATH]: override,
        ProgramFiles: "C:\\Program Files",
      },
      isRegularFile: existsOnly(override, chromeInProgramFiles),
    })).toBe(override);
  });

  it("rejects a relative override instead of silently falling back to Program Files", () => {
    expect(() => findSystemChrome({
      platform: "win32",
      env: {
        [CHENGFENG_VIDEOCUT_CHROME_PATH]: "chrome.exe",
        ProgramFiles: "C:\\Program Files",
      },
      isRegularFile: existsOnly(chromeInProgramFiles),
    })).toThrow(SystemChromePathError);
  });

  it("rejects an absolute override that is not an existing regular file", () => {
    expect(() => findSystemChrome({
      platform: "win32",
      env: { [CHENGFENG_VIDEOCUT_CHROME_PATH]: "D:\\Browsers\\chrome.exe" },
      isRegularFile: () => false,
    })).toThrow("必须指向一个现有的普通文件");
  });

  it("fails closed when no Windows candidate is a regular existing file", () => {
    expect(findSystemChrome({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      isRegularFile: () => false,
    })).toBeNull();
  });

  it("does not probe Unix paths while resolving Windows Chrome", () => {
    const attempted: string[] = [];
    expect(findSystemChrome({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      isRegularFile: (path) => {
        attempted.push(path);
        return false;
      },
    })).toBeNull();
    expect(attempted).toEqual([chromeInProgramFiles]);
  });

  it("keeps the existing Linux Chrome candidates", () => {
    expect(findSystemChrome({
      platform: "linux",
      env: {},
      isRegularFile: existsOnly("/usr/bin/chromium"),
    })).toBe("/usr/bin/chromium");
  });

  it("keeps the existing macOS Edge fallback", () => {
    const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(findSystemChrome({
      platform: "darwin",
      env: {},
      isRegularFile: existsOnly(edge),
    })).toBe(edge);
  });
});
