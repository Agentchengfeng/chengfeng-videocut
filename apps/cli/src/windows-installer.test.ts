import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { win32 } from "node:path";

const require = createRequire(import.meta.url);
const installer = require("../../../install.cjs") as {
  findBun(options?: {
    platform?: string;
    searchPath?: string;
    homeDir?: string;
    exists?: (candidate: string) => boolean;
    probe?: (candidate: string) => boolean;
  }): string | null;
  runnableBun(
    candidate: string,
    run?: (candidate: string, args: string[], options: object) => {
      status: number | null;
      stdout?: string;
    },
  ): boolean;
  supportedBunVersion(version: string): boolean;
};

describe("Windows installer Bun resolution", () => {
  it("ignores an earlier bun.cmd shim and selects a healthy native bun.exe", () => {
    const shimDir = "C:\\stale-shim";
    const healthyDir = "C:\\healthy-bun";
    const staleShim = win32.join(shimDir, "bun.cmd");
    const healthyExe = win32.join(healthyDir, "bun.exe");
    const existing = new Set([staleShim, healthyExe]);
    const probed: string[] = [];

    const selected = installer.findBun({
      platform: "win32",
      searchPath: `${shimDir};${healthyDir}`,
      homeDir: "C:\\home",
      exists: (candidate) => existing.has(candidate),
      probe: (candidate) => {
        probed.push(candidate);
        return candidate === healthyExe;
      },
    });

    expect(selected).toBe(healthyExe);
    expect(probed).toEqual([healthyExe]);
  });

  it("continues after an unusable bun.exe instead of trusting file existence", () => {
    const brokenExe = "C:\\broken\\bun.exe";
    const healthyExe = "C:\\healthy\\bun.exe";
    const probed: string[] = [];

    const selected = installer.findBun({
      platform: "win32",
      searchPath: "C:\\broken;C:\\healthy",
      homeDir: "C:\\home",
      exists: () => true,
      probe: (candidate) => {
        probed.push(candidate);
        return candidate === healthyExe;
      },
    });

    expect(selected).toBe(healthyExe);
    expect(probed).toEqual([brokenExe, healthyExe]);
  });

  it("requires Bun 1.2 or newer when probing a candidate", () => {
    expect(installer.supportedBunVersion("1.1.39\n")).toBe(false);
    expect(installer.supportedBunVersion("1.2.0\n")).toBe(true);
    expect(installer.supportedBunVersion("2.0.0-canary.1\n")).toBe(true);
    expect(installer.supportedBunVersion("not-a-version")).toBe(false);

    expect(installer.runnableBun("bun.exe", () => ({ status: 0, stdout: "1.1.39\n" })))
      .toBe(false);
    expect(installer.runnableBun("bun.exe", () => ({ status: 0, stdout: "1.2.0\n" })))
      .toBe(true);
    expect(installer.runnableBun("bun.exe", () => ({ status: null, stdout: "" })))
      .toBe(false);
  });
});
