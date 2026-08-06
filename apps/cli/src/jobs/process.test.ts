import { describe, expect, it } from "bun:test";
import { runWindowsTaskkill } from "./process";

describe("durable worker process cleanup", () => {
  it("treats every taskkill error as cleanup_failed without a root-liveness exception", async () => {
    expect(await runWindowsTaskkill(1234, async () => {
      throw Object.assign(new Error("taskkill raced with root exit"), { code: "ESRCH" });
    })).toBe("cleanup_failed");
  });

  it("accepts only a successful taskkill invocation as tree termination proof", async () => {
    const calls: Array<[string, string[]]> = [];
    expect(await runWindowsTaskkill(4321, async (file, args) => {
      calls.push([file, args]);
    })).toBe("terminated");
    expect(calls).toEqual([["taskkill.exe", ["/PID", "4321", "/T", "/F"]]]);
  });
});
