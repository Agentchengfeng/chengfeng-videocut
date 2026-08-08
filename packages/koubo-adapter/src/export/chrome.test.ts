import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeError, findExplicitChromeOverride } from "./chrome";

const cleanup: string[] = [];
afterEach(async () => {
  delete process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function executableFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "videocut-explicit-chrome-"));
  cleanup.push(root);
  const executable = join(root, "chrome-headless-shell");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  return executable;
}

describe("explicit Chrome override", () => {
  it("uses a developer-supplied executable only when explicitly requested", async () => {
    const executable = await executableFixture();
    expect(findExplicitChromeOverride({ configuredPath: executable })).toBe(executable);
  });

  it("does not scan system Chrome paths when no override is configured", () => {
    expect(findExplicitChromeOverride()).toBeNull();
  });

  it("rejects a relative explicit override", () => {
    expect(() => findExplicitChromeOverride({ configuredPath: "chrome-headless-shell" }))
      .toThrow("必须是绝对路径");
  });

  it("rejects a non-executable explicit override", async () => {
    const executable = await executableFixture();
    await chmod(executable, 0o644);
    expect(() => findExplicitChromeOverride({ configuredPath: executable })).toThrow(ChromeError);
  });
});
