import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationAuditStore, operationInputHash } from "./operationAudit";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "operation-audit-"));
  cleanup.push(root);
  const dataDir = join(root, "data");
  return { root, dataDir, store: new OperationAuditStore(dataDir) };
}

const baseAdmission = {
  kind: "cuts.set" as const,
  target: { projectId: "demo", projectDirectory: "/tmp/demo" },
  inputHash: operationInputHash({ cutWordIds: ["w-1"], expectedRevision: "none" }),
  baseRevisions: { cuts: "none" },
  actor: "skill",
  entrypoint: "http.cuts",
};

describe("operation audit store", () => {
  it("generates an operation id, records a bounded terminal result, and replays it", async () => {
    const { store } = await fixture();
    const admitted = await store.admit(baseAdmission);
    expect(admitted.operationId).toMatch(/^op_/);
    expect(admitted.replay).toBeNull();

    await store.finishSucceeded(admitted.operationId, {
      result: {
        projectId: "demo",
        revision: "a".repeat(64),
        previousRevision: "none",
        changed: true,
      },
    });

    const replay = await store.admit({ ...baseAdmission, operationId: admitted.operationId });
    expect(replay).toEqual({
      operationId: admitted.operationId,
      replay: {
        status: "succeeded",
        errorCode: null,
        result: {
          projectId: "demo",
          revision: "a".repeat(64),
          previousRevision: "none",
          changed: true,
        },
      },
    });
    expect(await store.read(admitted.operationId)).toMatchObject({
      accepted: true,
      succeeded: true,
      rejected: false,
      failed: false,
    });
  });

  it("fails closed when a reused operation id carries a different input", async () => {
    const { store } = await fixture();
    await store.admit({ ...baseAdmission, operationId: "fixed-id" });
    await expect(store.admit({
      ...baseAdmission,
      operationId: "fixed-id",
      inputHash: operationInputHash({ cutWordIds: ["w-2"], expectedRevision: "none" }),
    })).rejects.toMatchObject({ code: "operation_id_conflict" });
    const rejections = await readdir(store.rejectionsDir);
    expect(rejections).toHaveLength(1);
    expect(await readFile(join(store.rejectionsDir, rejections[0]!), "utf8"))
      .toContain("operation_id_conflict");
  });

  it("does not let a duplicate id bypass an unfinished operation", async () => {
    const { store } = await fixture();
    await store.admit({ ...baseAdmission, operationId: "in-flight" });
    await expect(store.admit({ ...baseAdmission, operationId: "in-flight" }))
      .rejects.toMatchObject({ code: "operation_in_progress" });
    await store.finishFailed("in-flight", { code: "revision_conflict", message: "stale" });
    const replay = await store.admit({ ...baseAdmission, operationId: "in-flight" });
    expect(replay.replay).toMatchObject({ status: "failed", errorCode: "revision_conflict" });
  });

  it("serializes concurrent admission for the same explicit id", async () => {
    const { store } = await fixture();
    const outcomes = await Promise.allSettled([
      store.admit({ ...baseAdmission, operationId: "racy-id" }),
      store.admit({ ...baseAdmission, operationId: "racy-id" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "operation_in_progress" });
    expect(await store.read("racy-id")).toMatchObject({ accepted: true, succeeded: false });
  });

  it("stores only hashes and bounded scalar summaries, not sensitive input payloads", async () => {
    const { store } = await fixture();
    const admitted = await store.admit({
      ...baseAdmission,
      operationId: "sensitive-input",
      inputHash: operationInputHash({
        cutWordIds: ["w-1"],
        transcriptText: "SECRET_TRANSCRIPT_SHOULD_NOT_BE_ON_DISK",
        apiKey: "SECRET_TOKEN_SHOULD_NOT_BE_ON_DISK",
      }),
    });
    await store.finishSucceeded(admitted.operationId, {
      result: { projectId: "demo", revision: "b".repeat(64), changed: false },
    });
    const raw = await readFile(store.recordPath(admitted.operationId), "utf8");
    expect(raw).not.toContain("SECRET_TRANSCRIPT_SHOULD_NOT_BE_ON_DISK");
    expect(raw).not.toContain("SECRET_TOKEN_SHOULD_NOT_BE_ON_DISK");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(16 * 1024);
  });

  it("rejects unbounded operation results before they can be written", async () => {
    const { store } = await fixture();
    const admitted = await store.admit({ ...baseAdmission, operationId: "too-large" });
    await expect(store.finishSucceeded(admitted.operationId, {
      result: { projectId: "demo", huge: "x".repeat(2_000) },
    })).rejects.toMatchObject({ code: "operation_audit_record_too_large" });
  });
});
