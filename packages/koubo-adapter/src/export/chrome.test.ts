import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeError, findSystemChrome } from "./chrome";

const cleanup: string[] = [];
afterEach(async () => {
  delete process.env.CHENGFENG_VIDEOCUT_CHROME_PATH;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function managedFixture(relative = "chrome/chrome-headless-shell") {
  const root = await mkdtemp(join(tmpdir(), "videocut-managed-chrome-"));
  cleanup.push(root);
  const tools = join(root, "tools/current");
  const executable = join(tools, relative);
  await mkdir(join(executable, ".."), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await writeFile(
    join(tools, "resources-manifest.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      product: "chengfeng-videocut-managed-tools",
      executables: { chrome: relative },
    })}\n`,
  );
  return { root, executable, tools };
}

describe("managed Chrome resolution", () => {
  it("prefers the fixed managed Chrome without downloading or scanning latest caches", async () => {
    const fixture = await managedFixture();
    expect(findSystemChrome({ dataDir: fixture.root, candidates: [] })).toBe(fixture.executable);
  });

  it("rejects a managed manifest traversal", async () => {
    const fixture = await managedFixture();
    await writeFile(
      join(fixture.tools, "resources-manifest.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        product: "chengfeng-videocut-managed-tools",
        executables: { chrome: "../../secret" },
      })}\n`,
    );
    expect(() => findSystemChrome({ dataDir: fixture.root, candidates: [] })).toThrow(ChromeError);
  });

  it("fails closed instead of borrowing system Chrome when a Product data root is damaged", async () => {
    const root = await mkdtemp(join(tmpdir(), "videocut-managed-chrome-missing-"));
    cleanup.push(root);
    expect(() => findSystemChrome({ dataDir: root, candidates: ["/bin/sh"] }))
      .toThrow("缺少受管浏览器 manifest");
  });

  it("rejects a relative explicit override", () => {
    expect(() => findSystemChrome({ configuredPath: "chrome-headless-shell", candidates: [] }))
      .toThrow("必须是绝对路径");
  });
});
