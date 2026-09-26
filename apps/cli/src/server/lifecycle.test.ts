import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleLog } from "./lifecycle";

test("lifecycle records identity and bounded rotation", () => {
  const root = mkdtempSync(join(tmpdir(), "studio-lifecycle-test-"));
  const log = createLifecycleLog(root);
  log.record("starting");
  const row = JSON.parse(readFileSync(log.path, "utf8"));
  expect(row.pid).toBe(process.pid);
  expect(row.instanceId).toBe(log.instanceId);
  for (let i = 0; i < 2000; i++) log.record("test", { index: i });
  expect(statSync(log.path).size).toBeLessThanOrEqual(1024 * 1024);
});

test("observation cleans up process listeners without taking exit ownership", () => {
  const log = createLifecycleLog(mkdtempSync(join(tmpdir(), "studio-lifecycle-test-")));
  const before = process.listenerCount("exit");
  const stop = log.observe();
  expect(process.listenerCount("exit")).toBe(before + 1);
  stop();
  expect(process.listenerCount("exit")).toBe(before);
});
