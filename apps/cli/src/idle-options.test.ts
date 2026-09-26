import { describe, expect, it } from "bun:test";
import { parseArgs } from "./args";
import { runCli } from "./run";
import { HELP_TEXT, humanService } from "./output";
import type { StartStudioServerOptions, RunningStudioServer } from "./server/start";

describe("explicit idle shutdown CLI policy", () => {
  it("shows partial diagnostic reads as unavailable instead of a successful empty log", () => {
    const result = {
      action: "logs", state: "stopped",
      paths: { stdoutLogPath: "/isolated/stdout.log", stderrLogPath: "/isolated/stderr.log", diagnosticsDir: "/isolated/diagnostics-v1" },
      logs: { stdout: "", stderr: "", diagnostics: '{"phase":"idle_timeout"}', errors: { stdout: "EACCES" } },
    } as Parameters<typeof humanService>[0];
    const output = humanService(result);
    expect(output).toContain("(unavailable: EACCES)");
    expect(output).toContain('{"phase":"idle_timeout"}');
    expect(output).toContain("stderr (/isolated/stderr.log):\n(empty)");
  });
  it("preserves existing starts and accepts disabled/recommended/bounded values", () => {
    expect(parseArgs(["start"]).idleTimeoutSeconds).toBeUndefined();
    for (const value of ["0", "1", "900", "86400"]) {
      expect(parseArgs(["start", "--idle-timeout-seconds", value]).idleTimeoutSeconds).toBe(Number(value));
    }
    expect(parseArgs(["start", "--idle-timeout-seconds=900"]).idleTimeoutSeconds).toBe(900);
    expect(HELP_TEXT).toContain("refreshing an old browser URL cannot launch a stopped CLI");
  });

  it("rejects invalid, repeated, or silently ignored idle policies", () => {
    for (const value of ["-1", "1.5", "NaN", "Infinity", "1e3", "86401", "9007199254740992"]) {
      expect(() => parseArgs(["start", "--idle-timeout-seconds", value])).toThrow();
    }
    expect(() => parseArgs(["start", "--idle-timeout-seconds"])).toThrow();
    expect(() => parseArgs(["start", "--idle-timeout-seconds", "900", "--idle-timeout-seconds", "0"])).toThrow();
    for (const command of [["doctor"], ["service", "ensure"], ["service", "status"], ["workbench", "commands"]]) {
      expect(() => parseArgs([...command, "--idle-timeout-seconds", "900"])).toThrow();
    }
  });

  it("passes the explicit policy to the selected server and reports it", async () => {
    for (const value of [undefined, "0", "900"]) {
      let received: StartStudioServerOptions | undefined;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(["start", "--json", ...(value === undefined ? [] : ["--idle-timeout-seconds", value])], {
        io: { stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
        startServer: async options => {
          received = options;
          return { host: "127.0.0.1", port: 65432, url: "http://127.0.0.1:65432", projectsDir: "/isolated/projects", dataDir: "/isolated/data", stop: async () => {} } as RunningStudioServer;
        },
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(received?.idleTimeoutSeconds).toBe(Number(value ?? "0"));
      expect(JSON.parse(stdout[0]!).data.idleTimeoutSeconds).toBe(Number(value ?? "0"));
    }
  });
});
