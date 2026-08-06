import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, writeJsonAtomic } from "./store";

describe("durable job store", () => {
  it("keeps the previous record when a crash seam fires before rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-atomic-"));
    try {
      const path = join(root, "job.json");
      await writeJsonAtomic(path, { generation: 1 });
      await expect(writeJsonAtomic(path, { generation: 2 }, {
        beforeRename() { throw new Error("simulated crash"); },
      })).rejects.toThrow("simulated crash");
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ generation: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when any persisted job is bad JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-corrupt-"));
    try {
      await mkdir(join(root, "jobs", "bad"), { recursive: true });
      await writeFile(join(root, "jobs", "bad", "job.json"), "{broken");
      await expect(new JobStore(root).initialize()).rejects.toMatchObject({ code: "job_store_corrupt" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed when JSON parses but violates the job schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-invalid-schema-"));
    try {
      await mkdir(join(root, "jobs", "bad"), { recursive: true });
      await writeFile(join(root, "jobs", "bad", "job.json"), JSON.stringify({ schemaVersion: 1, jobId: "bad" }));
      await expect(new JobStore(root).initialize()).rejects.toMatchObject({ code: "job_store_corrupt" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("creates at most one active job for the same target transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "job-concurrency-"));
    try {
      const store = new JobStore(root);
      await store.initialize();
      const input = {
        kind: "export" as const,
        targetKey: "project:/one",
        projectId: "one",
        target: "/one",
        params: {},
        frozen: {},
      };
      const settled = await Promise.allSettled([store.create(input), store.create(input)]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((item) => item.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "job_target_conflict" });
      expect(await store.list()).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
