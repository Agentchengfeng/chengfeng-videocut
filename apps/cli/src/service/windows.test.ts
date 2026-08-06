import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_NAME, PRODUCT_VERSION } from "../output";
import {
  StudioServiceError,
  runStudioServiceCommand,
  studioServicePaths,
  type StudioServiceDependencies,
} from "./index";
import {
  parseWindowsUserSid,
  renderStudioScheduledTask,
  resolveWindowsTaskUserId,
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

  const deps: StudioServiceDependencies = {
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
  const windowsOnly = process.platform === "win32" ? it : it.skip;

  it("extracts a SID from whoami's invariant CSV output", () => {
    expect(parseWindowsUserSid('"DOMAIN\\user","S-1-5-21-1000-2000-3000-4000"\r\n'))
      .toBe("S-1-5-21-1000-2000-3000-4000");
    expect(parseWindowsUserSid('"DOMAIN\\user","not-a-sid"\r\n')).toBeNull();
  });

  it("reports timeout, non-zero, empty, and malformed SID lookup failures without accepting a task identity", () => {
    const cases = [
      { status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT", stdout: '"DOMAIN\\user","S-1-5-21-1000"\r\n' },
      { status: 1, signal: null, errorCode: null, stdout: '"DOMAIN\\user","S-1-5-21-1000"\r\n' },
      { status: 0, signal: null, errorCode: null, stdout: "" },
      { status: 0, signal: null, errorCode: null, stdout: '"DOMAIN\\user","not-a-sid"\r\n' },
    ] as const;
    for (const expected of cases) {
      try {
        resolveWindowsTaskUserId(() => ({ executable: "whoami.exe", ...expected }));
        throw new Error("SID lookup should have failed");
      } catch (error) {
        expect(error).toBeInstanceOf(StudioServiceError);
        const serviceError = error as StudioServiceError;
        expect(serviceError.code).toBe("service_unavailable");
        expect(serviceError.details).toMatchObject({
          executable: "whoami.exe",
          status: expected.status,
          signal: expected.signal,
          errorCode: expected.errorCode,
          timeoutMs: 2_000,
        });
      }
    }
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

  windowsOnly("uses actual whoami SID resolution while service ensure talks only to the scheduled-task fixture", async () => {
    const { paths, state, deps } = await makeFixture();
    delete (deps as { windowsTaskUserId?: string }).windowsTaskUserId;
    const result = await runStudioServiceCommand("ensure", {}, deps);
    expect(result.ready).toBe(true);
    expect(result.pid).toBe(state.serverPid);
    expect(await readFile(paths.plistPath, "utf16le")).toMatch(
      /<UserId>S-1-[0-9-]+<\/UserId>/,
    );
    expect(state.commands.some((command) => command[1] === "/Create")).toBe(true);
    expect(state.commands.some((command) => command[1] === "/Run")).toBe(true);
  });

  it("waits for Task Scheduler to publish the server PID before accepting health", async () => {
    const { state, deps } = await makeFixture({ readyAfterSleeps: 2 });
    const result = await runStudioServiceCommand("ensure", {}, deps);
    expect(result.ready).toBe(true);
    expect(result.pid).toBe(state.serverPid);
    expect(state.sleeps).toBe(2);
  });

  it("returns status and reuses a healthy task when SID lookup is unavailable", async () => {
    const { paths, state, deps } = await makeFixture({ registered: true });
    await writeFile(
      paths.plistPath,
      Buffer.from(`\ufeff${renderStudioScheduledTask(paths, "S-1-5-21-1000")}`, "utf16le"),
    );
    state.started = true;
    state.alive.add(state.serverPid);
    delete (deps as { windowsTaskUserId?: string }).windowsTaskUserId;
    let lookups = 0;
    deps.windowsSidLookup = () => {
      lookups += 1;
      return { executable: "whoami.exe", stdout: "", status: null, signal: "SIGTERM", errorCode: "ETIMEDOUT" };
    };

    const status = await runStudioServiceCommand("status", {}, deps);
    expect(status.state).toBe("running");
    expect(status.ready).toBe(true);
    const ensured = await runStudioServiceCommand("ensure", {}, deps);
    expect(ensured.changed).toBe(false);
    expect(ensured.state).toBe("running");
    expect(lookups).toBe(0);
  });

  it("requires a SID only when ensure must create or rewrite the scheduled task", async () => {
    const { state, deps } = await makeFixture();
    delete (deps as { windowsTaskUserId?: string }).windowsTaskUserId;
    deps.windowsSidLookup = () => ({
      executable: "whoami.exe",
      stdout: "",
      status: null,
      signal: "SIGTERM",
      errorCode: "ETIMEDOUT",
    });
    await expect(runStudioServiceCommand("ensure", {}, deps)).rejects.toMatchObject({
      code: "service_unavailable",
      details: { errorCode: "ETIMEDOUT" },
    });
    expect(state.commands.some((command) => command[1] === "/Create")).toBe(false);
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
