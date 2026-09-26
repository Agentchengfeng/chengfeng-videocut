import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitProjectTransaction, getProjectTransactionStatus, recoverProjectTransaction, snapshotProjectFiles, projectFilesRevision, TRANSACTION_FILES, TRANSACTION_MARKER, type ProjectTransaction } from "./projectTransaction";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "videocut-transaction-test-"));
  directories.push(directory);
  await writeFile(join(directory, "project.json"), "old");
  const before = await snapshotProjectFiles(directory);
  const record: ProjectTransaction = { schemaVersion: 1, operationId: "op", inputKey: "input", before, after: { ...before, "project.json": "new", "transcript.json": "words", "index.html": "page" } };
  const history = join(directory, ".chengfeng-videocut", "transactions", "op");
  return { directory, history, record };
}
async function prepared(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(f.history, { recursive: true });
  await writeFile(join(f.history, "record.json"), JSON.stringify(f.record));
}
async function marker(f: Awaited<ReturnType<typeof fixture>>, operationId = "op") {
  await writeFile(join(f.directory, TRANSACTION_MARKER), JSON.stringify({ operationId, sha256: createHash("sha256").update(JSON.stringify(f.record)).digest("hex") }));
}
test("record-before-marker is prepared, requires explicit recovery, and supports finish", async () => {
  const f = await fixture(); await prepared(f);
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("prepared");
  await expect(commitProjectTransaction(f.directory, f.record)).rejects.toThrow("explicitly recover");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.record.before);
  expect((await recoverProjectTransaction(f.directory, "op", "finish")).state).toBe("committed");
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("committed");
  expect((await commitProjectTransaction(f.directory, f.record)).changed).toBe(false);
});
test("prepared rollback is repeatable and cannot implicitly replay", async () => {
  const f = await fixture(); await prepared(f);
  const first = await recoverProjectTransaction(f.directory, "op", "rollback");
  expect(await recoverProjectTransaction(f.directory, "op", "rollback")).toEqual(first);
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("rolled_back");
  await expect(recoverProjectTransaction(f.directory, "op", "finish")).rejects.toThrow("cannot be replayed");
  await expect(commitProjectTransaction(f.directory, f.record)).rejects.toThrow("explicitly recover");
});
test("afterWrite interruption rolls back and finish/rollback are idempotent", async () => {
  const f = await fixture();
  await expect(commitProjectTransaction(f.directory, f.record, async name => { if (name === "project.json") throw Error("interruption"); })).rejects.toThrow("interruption");
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("interrupted");
  const finished = await recoverProjectTransaction(f.directory, "op", "finish");
  expect(await recoverProjectTransaction(f.directory, "op", "finish")).toEqual(finished);
  const rolled = await recoverProjectTransaction(f.directory, "op", "rollback");
  expect(await recoverProjectTransaction(f.directory, "op", "rollback")).toEqual(rolled);
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.record.before);
});
for (const stateWritten of [false, true]) test(`all files written before marker clear, stateWritten=${stateWritten}`, async () => {
  const f = await fixture();
  await expect(commitProjectTransaction(f.directory, f.record, async name => { if (name === TRANSACTION_FILES.at(-1)) throw Error("after-all"); })).rejects.toThrow("after-all");
  if (stateWritten) await writeFile(join(f.history, "state.json"), JSON.stringify({ state: "committed", revision: projectFilesRevision(f.record.after) }));
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("interrupted");
  await recoverProjectTransaction(f.directory, "op", "finish");
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("committed");
});
test("external edits and other operation markers reject recovery without mutation", async () => {
  for (const otherMarker of [false, true]) {
    const f = await fixture(); await prepared(f); await marker(f, otherMarker ? "other" : "op");
    if (!otherMarker) await writeFile(join(f.directory, "project.json"), "external-edit");
    const before = await snapshotProjectFiles(f.directory);
    const originalMarker = await readFile(join(f.directory, TRANSACTION_MARKER), "utf8");
    expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("diverged");
    for (const action of ["finish", "rollback"] as const) await expect(recoverProjectTransaction(f.directory, "op", action)).rejects.toThrow();
    expect(await snapshotProjectFiles(f.directory)).toEqual(before);
    expect(await readFile(join(f.directory, TRANSACTION_MARKER), "utf8")).toBe(originalMarker);
  }
});
test("valid journal greater than 8 MiB can finish and roll back", async () => {
  const f = await fixture();
  f.record.after["transcript.json"] = "a".repeat(5 * 1024 * 1024);
  f.record.after["index.html"] = "b".repeat(5 * 1024 * 1024);
  await expect(commitProjectTransaction(f.directory, f.record, async () => { throw Error("interruption"); })).rejects.toThrow("interruption");
  expect((await stat(join(f.history, "record.json"))).size).toBeGreaterThan(8 * 1024 * 1024);
  await recoverProjectTransaction(f.directory, "op", "finish");
  await recoverProjectTransaction(f.directory, "op", "rollback");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.record.before);
});
test("status is read-only even for missing project/history", async () => {
  const f = await fixture();
  const names = await readdir(f.directory);
  expect(await getProjectTransactionStatus(f.directory, "missing")).toBeNull();
  expect(await getProjectTransactionStatus(join(f.directory, "absent"), "missing")).toBeNull();
  expect(await readdir(f.directory)).toEqual(names);
  await prepared(f);
  const previous = await readdir(f.history);
  await getProjectTransactionStatus(f.directory, "op");
  expect(await readdir(f.history)).toEqual(previous);
  expect(await readdir(f.directory)).not.toContain(".chengfeng-videocut.write.lock");
});
test("unmarked journal with after bytes but no state is not a committed receipt", async () => {
  const f = await fixture(); await prepared(f);
  for (const name of TRANSACTION_FILES) if (f.record.after[name] !== null) await writeFile(join(f.directory, name), f.record.after[name]!);
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("diverged");
  await expect(recoverProjectTransaction(f.directory, "op", "finish")).rejects.toThrow();
});
test("terminal state must agree with current files and journal", async () => {
  const f = await fixture(); await commitProjectTransaction(f.directory, f.record);
  await writeFile(join(f.directory, "project.json"), "external");
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("diverged");
  await expect(recoverProjectTransaction(f.directory, "op", "rollback")).rejects.toThrow("Project changed");
  await writeFile(join(f.directory, "project.json"), "new");
  await writeFile(join(f.history, "state.json"), JSON.stringify({ state: "committed", revision: "wrong" }));
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("diverged");
});
test("before=after without state remains prepared rather than guessed committed", async () => {
  const f = await fixture(); f.record.after = { ...f.record.before }; await prepared(f);
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("prepared");
  await expect(commitProjectTransaction(f.directory, f.record)).rejects.toThrow("explicitly recover");
});
test("concurrent mutations use one project lock and recheck revision", async () => {
  const f = await fixture();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const first = commitProjectTransaction(f.directory, f.record, async name => {
    if (name === "project.json") { entered(); await releasePromise; }
  });
  await enteredPromise;
  const second = commitProjectTransaction(f.directory, { ...f.record, operationId: "second" }).then(() => "unexpected", error => error.message);
  // GET is observational and does not wait on/acquire the writer's lock.
  expect((await getProjectTransactionStatus(f.directory, "op"))?.state).toBe("interrupted");
  release(); await first;
  expect(await second).toContain("Project changed after plan");
  expect(await snapshotProjectFiles(f.directory)).toEqual(f.record.after);
});
