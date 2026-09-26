import { afterEach, describe, expect, it } from "bun:test";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRuntimeEntry } from "./runtimeEntry";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(platform = process.platform) {
  const root = await mkdtemp(join(tmpdir(), "runtime-entry-"));
  roots.push(root);
  const dataDir = join(root, "runtime");
  await mkdir(join(dataDir, "bin"), { recursive: true });
  const launcher = join(dataDir, "bin", platform === "win32" ? "chengfeng-videocut.cmd" : "chengfeng-videocut");
  await writeFile(launcher, "THIS FILE MUST NEVER EXECUTE\n", { mode: 0o755 });
  return { root, dataDir, launcher, platform };
}

describe("selected Runtime entry diagnostics", () => {
  it("verifies the selected launcher without executing it or writing any record", async () => {
    const f = await fixture();
    const before = await readFile(f.launcher, "utf8");
    expect(await inspectRuntimeEntry(f)).toMatchObject({ ok: true, state: "consistent", scope: "selected-runtime-only" });
    expect(await readFile(f.launcher, "utf8")).toBe(before);
    expect(await readdir(f.dataDir)).toEqual(["bin"]);
  });
  it("does not confuse direct source execution with an installed Plugin", async () => {
    const f = await fixture();
    expect(await inspectRuntimeEntry({ dataDir: f.dataDir })).toMatchObject({ ok: true, state: "source-development", launcher: null });
  });
  it("rejects a PATH wrapper belonging to another Runtime", async () => {
    const f = await fixture();
    expect(await inspectRuntimeEntry({ ...f, launcher: join(f.root, "other", "bin", "chengfeng-videocut") })).toMatchObject({ ok: false, state: "entry_mismatch" });
  });
  it("rejects conflicting HOME and DATA_DIR even when the selected launcher exists", async () => {
    const f = await fixture();
    expect(await inspectRuntimeEntry({ ...f, configuredHome: join(f.root, "old") })).toMatchObject({ ok: false, state: "entry_mismatch" });
  });
  it("reports only the missing selected target and leaves other installations untouched", async () => {
    const f = await fixture();
    const missing = join(f.root, "dev");
    const result = await inspectRuntimeEntry({ dataDir: missing, launcher: join(missing, "bin", "chengfeng-videocut") });
    expect(result).toMatchObject({ ok: false, state: "target_missing", scope: "selected-runtime-only" });
    expect(result.detail).toContain("does not mean no Runtime");
    expect(await readdir(f.root)).toEqual(["runtime"]);
  });
  it("rejects a symlink launcher", async () => {
    const f = await fixture();
    const actual = join(f.root, "actual");
    await writeFile(actual, "test", { mode: 0o755 });
    await rm(f.launcher);
    await symlink(actual, f.launcher);
    expect(await inspectRuntimeEntry(f)).toMatchObject({ ok: false, state: "unverified" });
  });
  it("rejects a hard-linked launcher", async () => {
    const f = await fixture();
    await link(f.launcher, join(f.root, "alias"));
    expect(await inspectRuntimeEntry(f)).toMatchObject({ ok: false, state: "unverified" });
  });
  it("rejects a redirected bin directory", async () => {
    const f = await fixture();
    await rm(join(f.dataDir, "bin"), { recursive: true });
    const other = join(f.root, "other");
    await mkdir(other);
    await writeFile(join(other, "chengfeng-videocut"), "test", { mode: 0o755 });
    await symlink(other, join(f.dataDir, "bin"), "dir");
    expect(await inspectRuntimeEntry(f)).toMatchObject({ ok: false, state: "unverified" });
  });
  it.skipIf(process.platform === "win32")("requires execute permission on Unix", async () => {
    const f = await fixture();
    await chmod(f.launcher, 0o600);
    expect(await inspectRuntimeEntry(f)).toMatchObject({ ok: false, state: "unverified" });
  });
  it("rejects relative launcher and root selections", async () => {
    const f = await fixture();
    expect((await inspectRuntimeEntry({ ...f, launcher: "bin/chengfeng-videocut" })).state).toBe("entry_mismatch");
    expect((await inspectRuntimeEntry({ ...f, dataDir: "runtime" })).state).toBe("entry_mismatch");
  });
  it("uses the cmd entry for Windows layout (not a Windows execution test)", async () => {
    const f = await fixture("win32");
    expect(await inspectRuntimeEntry(f)).toMatchObject({ ok: true, state: "consistent" });
  });
});
