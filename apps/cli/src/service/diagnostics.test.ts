import { afterEach, expect, test } from "bun:test";
import { closeSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDiagnosticLog, diagnosticDirectory, DIAGNOSTIC_FILE_BYTES, DIAGNOSTIC_FILE_COUNT, DIAGNOSTIC_RETENTION_MS, readDiagnosticLogs } from "./diagnostics";
const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "diagnostic-test-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function event(time: number, index: number) {
  return JSON.stringify({ diagnosticSchema: 1, timestamp: new Date(time).toISOString(), phase: "test", index }) + "\n";
}
function indexes(root: string, lines: number, now: number) {
  return readDiagnosticLogs(root, lines, now).split("\n").filter(Boolean).map(row => JSON.parse(row).index);
}

test("age cleanup preserves fresh events sharing an expired head, then removes the wholly expired slot", () => {
  const root = fixture();
  const now = Date.now();
  let time = now - DIAGNOSTIC_RETENTION_MS - 1000;
  const logger = createDiagnosticLog(root, randomUUID(), { now: () => time });
  expect(logger.record("test", { index: 1 })).toBe(true);
  const mixed = logger.path;
  time += 23 * 60 * 60 * 1000;
  expect(logger.record("test", { index: 2 })).toBe(true);
  expect(logger.path).toBe(mixed);
  expect(indexes(root, 1000, now)).toEqual([2]);
  time = now;
  expect(logger.record("test", { index: 3 })).toBe(true);
  expect(indexes(root, 1000, now)).toEqual([2, 3]);
  expect(readFileSync(mixed, "utf8")).toContain('"index":2');
  time += 24 * 60 * 60 * 1000;
  expect(logger.record("test", { index: 4 })).toBe(true);
  expect(indexes(root, 1000, time)).toEqual([3, 4]);
  // The expired slot may be removed or reused, but its old rows must not remain.
  for (const name of readdirSync(diagnosticDirectory(root))) {
    expect(readFileSync(join(diagnosticDirectory(root), name), "utf8")).not.toContain('"index":2');
  }
});

test("cleanup uses the latest valid event even when an expired event is appended last", () => {
  const root = fixture();
  const now = Date.now();
  const logger = createDiagnosticLog(root, randomUUID(), { now: () => now });
  expect(logger.record("starting")).toBe(true);
  const mixed = logger.path;
  const expired = now - DIAGNOSTIC_RETENTION_MS - 1000;
  writeFileSync(mixed, event(expired, 1) + event(now - 1000, 2) + event(expired, 3));
  utimesSync(mixed, new Date(expired), new Date(expired));
  expect(logger.record("test", { index: 4 })).toBe(true);
  expect(indexes(root, 1000, now)).toEqual([2, 4]);
  expect(readFileSync(mixed, "utf8")).toContain('"index":2');
});

test("latest rows include intermediate events after the writer backfills an older slot", () => {
  const root = fixture();
  const now = Date.now();
  const logger = createDiagnosticLog(root, randomUUID(), { now: () => now });
  expect(logger.record("starting")).toBe(true);
  const older = logger.path;
  const newer = join(diagnosticDirectory(root), "events-01.jsonl");
  const rotateAt = DIAGNOSTIC_FILE_BYTES - 64 * 1024;
  for (const [path, time, index, remaining] of [
    [older, now - 2000, 1, 200], [newer, now - 1000, 2, 0],
  ] as const) {
    const row = event(time, index);
    // Valid JSONL with whitespace padding models unequal row sizes at rotation.
    writeFileSync(path, row + " ".repeat(rotateAt - remaining - row.length));
    utimesSync(path, new Date(time), new Date(time));
  }
  expect(logger.record("test", { index: 3 })).toBe(true);
  expect(logger.path).toBe(older);
  expect(indexes(root, 2, now)).toEqual([2, 3]);
  expect(indexes(root, 1000, now)).toEqual([1, 2, 3]);
});

test("event time beats mtime, with deterministic slot and row tie ordering and a 1000 row cap", () => {
  const root = fixture();
  const now = Date.now();
  const logger = createDiagnosticLog(root, randomUUID());
  expect(logger.record("starting")).toBe(true);
  const first = logger.path;
  const second = join(diagnosticDirectory(root), "events-01.jsonl");
  writeFileSync(first, event(now - 1000, 1) + event(now, 3) + event(now, 4));
  writeFileSync(second, event(now - 500, 2) + event(now, 5));
  // Even a slot with an expired filesystem mtime can contain current events.
  const old = new Date(now - DIAGNOSTIC_RETENTION_MS - 1000);
  utimesSync(first, old, old);
  expect(indexes(root, 1000, now)).toEqual([1, 2, 3, 4, 5]);
  expect(indexes(root, 3, now)).toEqual([3, 4, 5]);
  expect(indexes(root, 3, now)).toEqual([3, 4, 5]);
  writeFileSync(first, Array.from({ length: 1100 }, (_, index) => event(now - 2000 + index, index)).join(""));
  rmSync(second);
  const rows = indexes(root, 10000, now);
  expect(rows).toHaveLength(1000);
  expect(rows[0]).toBe(100);
  expect(rows.at(-1)).toBe(1099);
});

test("a later unsafe slot cannot be hidden by the output limit or an expired mtime", () => {
  const root = fixture();
  const logger = createDiagnosticLog(root, randomUUID(), { onError: () => {} });
  expect(logger.record("test")).toBe(true);
  const unsafe = join(diagnosticDirectory(root), "events-95.jsonl");
  const target = join(root, "private.txt");
  writeFileSync(target, "untouched");
  linkSync(target, unsafe);
  expect(() => readDiagnosticLogs(root, 1)).toThrow("Unsafe diagnostics file");
  expect(logger.record("test")).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("untouched");
  rmSync(unsafe);
  writeFileSync(unsafe, "unknown content");
  const old = new Date(Date.now() - DIAGNOSTIC_RETENTION_MS - 1000);
  utimesSync(unsafe, old, old);
  expect(() => readDiagnosticLogs(root, 1)).toThrow("Unknown diagnostics file");
  expect(logger.record("test")).toBe(false);
  expect(readFileSync(unsafe, "utf8")).toBe("unknown content");
});

test("logs survive a new logger and read-only lookup does not create missing paths", () => {
  const root = fixture();
  expect(readDiagnosticLogs(root)).toBe("");
  expect(readdirSync(root)).toEqual([]);
  const one = createDiagnosticLog(root, randomUUID());
  expect(one.record("starting", { pid: 11 })).toBe(true);
  const two = createDiagnosticLog(root, randomUUID());
  expect(two.record("stopped", { pid: 12 })).toBe(true);
  expect(readDiagnosticLogs(root).split("\n").map(line => JSON.parse(line).pid)).toEqual([11, 12]);
  expect(lstatSync(one.path).mode & 0o777).toBe(0o600);
  expect(lstatSync(diagnosticDirectory(root)).mode & 0o777).toBe(0o700);
});

test("full fixed namespace rotates within aggregate cap and prunes old owned files only", () => {
  const root = fixture();
  const logger = createDiagnosticLog(root, randomUUID());
  logger.record("starting");
  const dir = diagnosticDirectory(root);
  for (let i = 0; i < DIAGNOSTIC_FILE_COUNT; i++) {
    const fd = openSync(join(dir, `events-${String(i).padStart(2, "0")}.jsonl`), "w", 0o600);
    writeSync(fd, '{"diagnosticSchema":1}\n');
    ftruncateSync(fd, DIAGNOSTIC_FILE_BYTES);
    closeSync(fd);
  }
  expect(logger.record("stopped")).toBe(true);
  const sizes = readdirSync(dir).map(name => lstatSync(join(dir, name)).size);
  expect(sizes.length).toBe(DIAGNOSTIC_FILE_COUNT);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(DIAGNOSTIC_FILE_BYTES);
  expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100 * 1024 * 1024);
  const stale = join(dir, "events-95.jsonl");
  const old = new Date(Date.now() - DIAGNOSTIC_RETENTION_MS - 1000);
  utimesSync(stale, old, old);
  writeFileSync(join(dir, "user-notes.txt"), "keep me");
  expect(logger.record("starting")).toBe(true);
  expect(readdirSync(dir)).not.toContain("events-95.jsonl");
  expect(readFileSync(join(dir, "user-notes.txt"), "utf8")).toBe("keep me");
});

test("untrusted messages, arbitrary phase and string values cannot persist secrets", () => {
  const root = fixture();
  const logger = createDiagnosticLog(root, randomUUID());
  logger.record("bearer-secret", { token: "secret", errorName: "secret", host: "secret", pid: "secret", message: "secret", code: 7 });
  const text = readDiagnosticLogs(root);
  expect(text).not.toContain("secret");
  expect(JSON.parse(text)).toMatchObject({ phase: "unknown", code: 7 });
});

test("concurrent process append preserves complete rows before rotation", async () => {
  const root = fixture();
  const source = fileURLToPath(new URL("./diagnostics.ts", import.meta.url));
  const children = Array.from({ length: 4 }, () => Bun.spawn([Bun.argv[0]!, "-e",
    `import {createDiagnosticLog} from ${JSON.stringify(source)}; import {randomUUID} from 'node:crypto'; const log=createDiagnosticLog(${JSON.stringify(root)},randomUUID()); for(let i=0;i<50;i++) if(!log.record('test',{pid:process.pid,index:i}))process.exit(1);`], { stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0, 0]);
  const rows = readDiagnosticLogs(root, 1000).split("\n").map(row => JSON.parse(row));
  expect(rows.length).toBe(200);
  expect(new Set(rows.map(row => `${row.pid}:${row.index}`)).size).toBe(200);
});

test("symlinks and unknown content fail visibly without touching targets, then recover", () => {
  const root = fixture();
  const target = join(root, "project.txt");
  writeFileSync(target, "untouched");
  mkdirSync(join(root, "logs"));
  mkdirSync(diagnosticDirectory(root));
  const path = join(diagnosticDirectory(root), "events-00.jsonl");
  symlinkSync(target, path);
  let failures = 0;
  const logger = createDiagnosticLog(root, randomUUID(), { onError: () => failures++ });
  expect(logger.record("starting")).toBe(false);
  expect(logger.record("starting")).toBe(false);
  expect(failures).toBe(1);
  expect(() => readDiagnosticLogs(root)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("untouched");
  rmSync(path);
  writeFileSync(path, "unknown user file");
  expect(logger.record("starting")).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("unknown user file");
  rmSync(path);
  expect(logger.record("starting")).toBe(true);
  expect(logger.available).toBe(true);
});
