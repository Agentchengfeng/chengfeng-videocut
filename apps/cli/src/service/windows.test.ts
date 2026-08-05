import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../output";
import { runStudioServiceCommand, studioServicePaths } from "./index";
import {
  parseWindowsUserSid,
  renderStudioScheduledTask,
  windowsSupervisorStatePath,
} from "./windows";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Scenario {
  registered: boolean;
  enabled: boolean;
  started: boolean;
  alive: Set<number>;
  serverPid: number;
  healthRuntimeMode: string;
  healthPid?: number;
  readyAfterSleeps: number;
  sleeps: number;
  commands: string[][];
}

function taskXml(enabled: boolean): string {
  return `<?xml version="1.0"?><Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Settings><Enabled>${enabled}</Enabled></Settings></Task>`;
}

async function makeFixture(scenario: Partial<Scenario> = {}) {
  const root = await mkdtemp(join(tmpdir(), "videocut-windows-service-"));
  cleanupPaths.push(root);
  const homeDir = join(root, "home");
  const dataDir = join(root, "data");
  const launcherPath = join(dataDir, "bin", "chengfeng-videocut.cmd");
  await mkdir(join(dataDir, "bin"), { recursive: true });
  await writeFile(launcherPath, "@echo off\r\n", { mode: 0o755 });
  const paths = studioServicePaths(homeDir, dataDir, launcherPath, "win32");

  const state: Scenario = {
    registered: false,
    enabled: true,
    started: false,
    alive: new Set<number>(),
    serverPid: 4242,
    healthRuntimeMode: "windows-task",
    readyAfterSleeps: 0,
    sleeps: 0,
    commands: [],
    ...scenario,
  };
  await mkdir(join(dataDir, "service"), { recursive: true });
  await writeFile(
    windowsSupervisorStatePath(paths),
    `${JSON.stringify({ supervisorPid: state.serverPid - 1, serverPid: state.serverPid, updatedAt: 1 })}\n`,
  );

  const deps = {
    platform: "win32",
    homeDir,
    dataDir,
    launcherPath,
    readyTimeoutMs: 3_000,
    lockTimeoutMs: 2_000,
    sleep: async () => {
      state.sleeps += 1;
      if (state.started && state.sleeps >= state.readyAfterSleeps) state.alive.add(state.serverPid);
    },
    runCommand: async (executable: string, args: readonly string[]) => {
      state.commands.push([executable, ...args]);
      if (executable !== "schtasks") return { code: 1, stdout: "", stderr: "unknown executable" };
      const ok = { code: 0, stdout: "", stderr: "" };
      if (args[0] === "/Query") {
        return state.registered
          ? { code: 0, stdout: taskXml(state.enabled), stderr: "" }
          : { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
      }
      if (args[0] === "/Create") {
        state.registered = true;
        state.enabled = true;
        return ok;
      }
      if (args[0] === "/Run") {
        state.started = true;
        if (state.readyAfterSleeps === 0) state.alive.add(state.serverPid);
        return ok;
      }
      if (args[0] === "/Change") {
        if (args.includes("/DISABLE")) state.enabled = false;
        if (args.includes("/ENABLE")) state.enabled = true;
        return ok;
      }
      if (args[0] === "/End") return ok;
      return ok;
    },
    fetch: (async () => {
      if (!state.started || !state.alive.has(state.serverPid)) {
        throw new Error("ECONNREFUSED");
      }
      return new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        product: PRODUCT_NAME,
        productVersion: PRODUCT_VERSION,
        pid: state.healthPid ?? state.serverPid,
        runtimeMode: state.healthRuntimeMode,
        studioBuildId: "build-w2",
      }), { status: 200 });
    }) as unknown as typeof globalThis.fetch,
    isPortOccupied: async () => state.started && state.alive.has(state.serverPid),
    getPortOwnerPid: async () => null,
    isProcessAlive: (pid: number) => state.alive.has(pid),
    killProcess: (pid: number) => {
      state.alive.delete(pid);
      if (pid === state.serverPid) state.started = false;
    },
    windowsTaskUserId: "S-1-5-21-1000",
  };
  return { root, paths, state, deps };
}

describe("Windows scheduled-task service", () => {
  it("extracts a SID from whoami's invariant CSV output", () => {
    expect(parseWindowsUserSid('"DOMAIN\\user","S-1-5-21-1000-2000-3000-4000"\r\n'))
      .toBe("S-1-5-21-1000-2000-3000-4000");
    expect(parseWindowsUserSid('"DOMAIN\\user","not-a-sid"\r\n')).toBeNull();
  });

  it("runs the stable cmd launcher through a native command processor", async () => {
    const { paths } = await makeFixture();
    const commandProcessor = "C:\\Windows\\System32\\cmd.exe";
    const xml = renderStudioScheduledTask(
      paths,
      "S-1-5-21-1000",
      commandProcessor,
    );
    expect(xml).toContain(`<Command>${commandProcessor}</Command>`);
    expect(xml).toContain(
      `<Arguments>/d /v:off /s /c &quot;&quot;${paths.launcherPath}&quot; service supervise&quot;</Arguments>`,
    );
    expect(xml).not.toContain(`<Command>${paths.launcherPath}</Command>`);
  });

  it("still refuses platforms without a managed backend", async () => {
    await expect(
      runStudioServiceCommand("status", {}, { platform: "linux", uid: -1, homeDir: "/tmp" }),
    ).rejects.toMatchObject({ code: "service_unsupported" });
  });

  it("reports uninstalled on a machine with no task and no port owner", async () => {
    const { deps } = await makeFixture();
    const status = await runStudioServiceCommand("status", {}, deps);
    expect(status.state).toBe("uninstalled");
    expect(status.loaded).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("ensure registers the task, runs it, and reaches a verified ready identity", async () => {
    const { paths, state, deps } = await makeFixture();
    const result = await runStudioServiceCommand("ensure", {}, deps);
    expect(result.changed).toBe(true);
    expect(result.state).toBe("running");
    expect(result.ready).toBe(true);
    expect(result.pid).toBe(state.serverPid);
    expect(result.identity?.runtimeMode).toBe("windows-task");
    // 任务定义按 UTF-16LE + BOM 落盘（schtasks /XML 的硬要求）。
    expect(await readFile(paths.plistPath, "utf16le")).toBe(
      `\ufeff${renderStudioScheduledTask(paths, "S-1-5-21-1000")}`,
    );
    const verbs = state.commands
      .filter(([executable]) => executable === "schtasks")
      .map(([, verb]) => verb);
    expect(verbs).toContain("/Create");
    expect(verbs).toContain("/Run");
  });

  it("waits for Task Scheduler to publish the server PID before accepting health", async () => {
    const { state, deps } = await makeFixture({ readyAfterSleeps: 2 });
    const result = await runStudioServiceCommand("ensure", {}, deps);
    expect(result.ready).toBe(true);
    expect(result.pid).toBe(state.serverPid);
    expect(state.sleeps).toBe(2);
  });

  it("refuses to touch a Product runtime that is not task-managed", async () => {
    const { state, deps } = await makeFixture({ registered: false });
    state.started = true;
    state.alive.add(state.serverPid);
    state.healthRuntimeMode = "foreground";
    await expect(runStudioServiceCommand("ensure", {}, deps)).rejects.toMatchObject({
      code: "service_port_conflict",
    });
  });

  it("treats a launchd-mode runtime on Windows as a conflict, not an identity", async () => {
    const { paths, state, deps } = await makeFixture({ registered: true });
    await writeFile(paths.plistPath, Buffer.from(`\ufeff${renderStudioScheduledTask(paths, "S-1-5-21-1000")}`, "utf16le"));
    state.started = true;
    state.alive.add(state.serverPid);
    state.healthRuntimeMode = "launchd";
    const status = await runStudioServiceCommand("status", {}, deps);
    expect(status.state).toBe("conflict");
    expect(status.detail).toContain("windows-task");
  });

  it("stop disables the task and terminates the supervised processes", async () => {
    const { paths, state, deps } = await makeFixture({ registered: true });
    await writeFile(paths.plistPath, Buffer.from(`\ufeff${renderStudioScheduledTask(paths, "S-1-5-21-1000")}`, "utf16le"));
    state.started = true;
    state.alive.add(state.serverPid);
    state.alive.add(state.serverPid - 1);
    const result = await runStudioServiceCommand("stop", {}, deps);
    expect(result.changed).toBe(true);
    expect(result.state).toBe("stopped");
    expect(result.pid).toBeNull();
    expect(state.alive.size).toBe(0);
    const verbs = state.commands
      .filter(([executable]) => executable === "schtasks")
      .map((command) => command.join(" "));
    expect(verbs.some((command) => command.includes("/DISABLE"))).toBe(true);
    expect(verbs.some((command) => command.includes("/End"))).toBe(true);
  });
});
