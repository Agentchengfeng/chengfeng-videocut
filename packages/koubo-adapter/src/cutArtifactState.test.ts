import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  KOUBO_CUT_DONE_RELATIVE,
  KOUBO_SOURCE_CUT_RELATIVE,
  readKouboCutArtifactStatus,
} from "./cutArtifactState";

const cleanup: string[] = [];
const CURRENT_REVISION = "a".repeat(64);
const OLD_REVISION = "b".repeat(64);
const SOURCE_SHA256 = "c".repeat(64);
const OUTPUT_SHA256 = "d".repeat(64);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "koubo-artifact-state-"));
  cleanup.push(directory);
  await writeFile(join(directory, "project.json"), `${JSON.stringify({
    status: "cut_review_ready",
    source: {
      path: "input/source.mp4",
      sha256: SOURCE_SHA256,
      immutable: true,
    },
  })}\n`);
  return directory;
}

async function writeMedia(directory: string): Promise<void> {
  const path = join(directory, KOUBO_SOURCE_CUT_RELATIVE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "media");
}

async function writeCutDone(
  directory: string,
  value: unknown,
): Promise<void> {
  const path = join(directory, KOUBO_CUT_DONE_RELATIVE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

function verifiedCutDone(editListRevision: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    success: true,
    source: "chengfeng-videocut",
    artifactRevision: editListRevision,
    confirmedEditListRevision: editListRevision,
    editListRevision,
    sourceSha256: SOURCE_SHA256,
    outputRelative: KOUBO_SOURCE_CUT_RELATIVE,
    outputSha256: OUTPUT_SHA256,
    newDuration: 12.5,
    expectedDuration: 12.5,
    durationDeltaSeconds: 0,
    durationToleranceSeconds: 0.15,
    hasAudio: true,
    width: 1920,
    height: 1080,
  };
}

describe("physical cut artifact status", () => {
  it("reports missing whenever the canonical media file is absent", async () => {
    const directory = await fixture();
    await writeCutDone(directory, verifiedCutDone(CURRENT_REVISION));

    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toEqual({
      state: "missing",
      editListRevision: null,
      path: null,
    });

    const emptyMedia = join(directory, KOUBO_SOURCE_CUT_RELATIVE);
    await mkdir(dirname(emptyMedia), { recursive: true });
    await writeFile(emptyMedia, "");
    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toMatchObject({
      state: "missing",
      path: null,
    });
  });

  it("reports media without a valid cut_done EDL revision as legacy", async () => {
    const directory = await fixture();
    await writeMedia(directory);

    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toEqual({
      state: "legacy",
      editListRevision: null,
      path: KOUBO_SOURCE_CUT_RELATIVE,
    });

    await writeCutDone(directory, { schemaVersion: 1, editListRevision: "not-a-revision" });
    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toMatchObject({
      state: "legacy",
      editListRevision: null,
    });
  });

  it("reports a valid artifact revision different from the current EDL as stale", async () => {
    const directory = await fixture();
    await writeMedia(directory);
    await writeCutDone(directory, verifiedCutDone(OLD_REVISION));

    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toEqual({
      state: "stale",
      editListRevision: OLD_REVISION,
      path: KOUBO_SOURCE_CUT_RELATIVE,
    });
  });

  it("does not infer verification when a matching cut_done omits persisted facts", async () => {
    const directory = await fixture();
    await writeMedia(directory);
    await writeCutDone(directory, {
      schemaVersion: 1,
      editListRevision: CURRENT_REVISION,
    });

    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toMatchObject({
      state: "stale",
      editListRevision: CURRENT_REVISION,
    });
  });

  it("reports stale when cut provenance is bound to a different canonical source", async () => {
    const directory = await fixture();
    await writeMedia(directory);
    await writeCutDone(directory, {
      ...verifiedCutDone(CURRENT_REVISION),
      sourceSha256: "e".repeat(64),
    });

    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toMatchObject({
      state: "stale",
      editListRevision: CURRENT_REVISION,
    });
  });

  it("reports current only for a matching canonical pair with persisted verification", async () => {
    const directory = await fixture();
    await writeMedia(directory);
    await writeCutDone(directory, verifiedCutDone(CURRENT_REVISION));

    await expect(readKouboCutArtifactStatus(directory, CURRENT_REVISION)).resolves.toEqual({
      state: "current",
      editListRevision: CURRENT_REVISION,
      path: KOUBO_SOURCE_CUT_RELATIVE,
    });
  });
});
