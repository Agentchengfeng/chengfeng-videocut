import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptSubtitleCandidate, getSubtitleResultState, readSubtitles, serializeJson, sha256,
  writeSubtitles, type AcceptSubtitleCandidateInput, type ResolvedProject,
} from "./node";
import { DEFAULT_SUBTITLE_STYLE, type SubtitleDocument } from "./subtitles";
import { buildEditListFromCuts } from "./editList";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "subtitle-handoff-"));
  roots.push(directory);
  const project: ResolvedProject = { directory, projectId: "p", project: {}, projectRevision: "0".repeat(64) };
  const transcriptRaw = serializeJson({ schemaVersion: 1, cues: [{ id: "speech", words: [
    { id: "gap", text: "", start: 0, end: 0.2, isGap: true },
    { id: "w1", text: "你", start: 0.2, end: 0.7 },
    { id: "w2", text: "好", start: 0.8, end: 1.2 },
    { id: "w3", text: "啊", start: 1.4, end: 1.8 },
  ] }] });
  const transcriptSha256 = sha256(transcriptRaw);
  const editList = buildEditListFromCuts({ projectId: "p", source: "input/source.wav", sourceDuration: 2,
    transcriptRevision: transcriptSha256, cutsRevision: "1".repeat(64), cutRanges: [] });
  const editListRaw = serializeJson(editList);
  await writeFile(join(directory, "transcript.json"), transcriptRaw);
  await writeFile(join(directory, "edit-list.json"), editListRaw);
  const document: SubtitleDocument = { schemaVersion: 1, projectId: "p", baseTranscriptRevision: transcriptSha256,
    style: { ...DEFAULT_SUBTITLE_STYLE }, cues: [
      { id: "c1", text: "你好", wordIds: ["w1", "w2"] }, { id: "c2", text: "啊", wordIds: ["w3"] },
    ] };
  function candidate(value = document, resultRevision = "none"): AcceptSubtitleCandidateInput {
    const { skillResult: _metadata, ...plain } = value;
    const documentContent = serializeJson(plain);
    return { documentContent, expectedRevision: resultRevision, receipt: {
      schemaVersion: 1, kind: "isolated-subtitle-candidate", productionCommitted: false,
      inputs: { transcriptSha256, editListSha256: sha256(editListRaw), projectId: "p", resultRevision },
      provenance: { generator: "candidate.mjs", version: "test-1", entrypointSha256: "2".repeat(64) },
      outputSha256: sha256(documentContent), validation: { valid: true, cueCount: plain.cues.length, wordCount: 4 },
    } };
  }
  return { directory, project, document, candidate, editList, transcriptRaw };
}

describe("Skill result handoff", () => {
  it("accepts exact candidate bytes and reports current provenance while legacy remains unknown", async () => {
    const f = await fixture();
    expect((await getSubtitleResultState(f.project, null)).status).toBe("missing");
    await writeSubtitles(f.project, f.document);
    let snapshot = (await readSubtitles(f.project))!;
    expect((await getSubtitleResultState(f.project, snapshot)).status).toBe("legacy");
    const raw = snapshot.raw;
    const result = await acceptSubtitleCandidate(f.project, f.candidate(f.document, snapshot.revision));
    snapshot = (await readSubtitles(f.project))!;
    expect(snapshot.revision).toBe(result.revision);
    expect((await getSubtitleResultState(f.project, snapshot)).status).toBe("current");
    expect(snapshot.value.skillResult?.provenance?.generator).toBe("candidate.mjs");
    expect(await readFile(join(f.directory, ".workbench/result-history/subtitles", `${sha256(raw)}.json`), "utf8")).toBe(raw);
  });

  it("fails missing CAS, forged metadata and output mismatch without creating an active result", async () => {
    const f = await fixture();
    const missing = f.candidate();
    delete (missing as Partial<AcceptSubtitleCandidateInput>).expectedRevision;
    await expect(acceptSubtitleCandidate(f.project, missing)).rejects.toMatchObject({ code: "revision_required" });
    const mismatch = f.candidate();
    mismatch.documentContent += " ";
    await expect(acceptSubtitleCandidate(f.project, mismatch)).rejects.toMatchObject({ code: "invalid_subtitles" });
    const forged = f.candidate();
    forged.documentContent = serializeJson({ ...f.document, skillResult: { sources: { fake: true } } });
    (forged.receipt as { outputSha256: string }).outputSha256 = sha256(forged.documentContent);
    await expect(acceptSubtitleCandidate(f.project, forged)).rejects.toMatchObject({ code: "invalid_subtitles" });
    expect(await readSubtitles(f.project)).toBeNull();
    expect(await readdir(f.directory)).toEqual(["edit-list.json", "transcript.json"]);
  });

  it("rejects source hash changes including time-only EDL changes without touching active bytes", async () => {
    const f = await fixture();
    const result = await acceptSubtitleCandidate(f.project, f.candidate());
    const pending = f.candidate(result.document, result.revision);
    const raw = await readFile(join(f.directory, "subtitles.json"), "utf8");
    const timeOnly = { ...f.editList, duration: 1.9, segments: [{ ...f.editList.segments[0]!, sourceEnd: 1.9 }] };
    await writeFile(join(f.directory, "edit-list.json"), serializeJson(timeOnly));
    const state = await getSubtitleResultState(f.project, await readSubtitles(f.project));
    expect(state.status).toBe("stale");
    expect(state.changedSources).toEqual(["edit-list"]);
    await expect(acceptSubtitleCandidate(f.project, pending)).rejects.toMatchObject({ code: "revision_conflict", details: { scope: "source" } });
    expect(await readFile(join(f.directory, "subtitles.json"), "utf8")).toBe(raw);
  });

  it("allows only one concurrent candidate to publish, preserves the winning bytes", async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled([acceptSubtitleCandidate(f.project, f.candidate()), acceptSubtitleCandidate(f.project, f.candidate())]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason.code).toBe("revision_conflict");
    expect((await readSubtitles(f.project))?.value.cues).toEqual(f.document.cues);
  });

  it("binds text/style/grouping edits and notes while ignoring caller metadata forgery", async () => {
    const f = await fixture();
    const first = await acceptSubtitleCandidate(f.project, f.candidate());
    const edited = structuredClone(first.document);
    edited.cues[0]!.text = "您好";
    edited.style.color = "#ff0000";
    edited.skillResult!.provenance = { generator: "forged" };
    const saved = await writeSubtitles(f.project, edited, { expectedRevision: first.revision, reviewNote: "保留专有名词" });
    expect(saved.document.skillResult?.provenance?.generator).toBe("candidate.mjs");
    expect(saved.document.skillResult?.review?.basedOnRevision).toBe(first.revision);
    expect(saved.document.skillResult?.review?.reviewed.cues[0]?.text).toBe("您好");
    expect(saved.document.skillResult?.review?.baseline.cues[0]?.text).toBe("你好");
    expect(saved.document.skillResult?.review?.notes[0]).toMatchObject({ basedOnRevision: first.revision, text: "保留专有名词" });
    const reopened = (await readSubtitles(f.project))!;
    expect(reopened.value.skillResult?.review?.editCount).toBe(1);
    const noteOnly = await writeSubtitles(f.project, reopened.value, { expectedRevision: reopened.revision, reviewNote: "第二轮备注" });
    expect(noteOnly.changed).toBe(true);
    expect(noteOnly.document.skillResult?.review?.editCount).toBe(1);
    expect(noteOnly.document.skillResult?.review?.notes).toHaveLength(2);
    await expect(acceptSubtitleCandidate(f.project, f.candidate(f.document, noteOnly.revision))).rejects.toMatchObject({ code: "invalid_subtitles" });
    const regenerated = await acceptSubtitleCandidate(f.project, f.candidate(noteOnly.document, noteOnly.revision));
    expect(regenerated.document.cues[0]?.text).toBe("您好");
    expect(regenerated.document.skillResult?.review?.notes).toHaveLength(2);
    expect(regenerated.document.skillResult?.review?.editCount).toBe(1);
    expect((await readdir(join(f.directory, ".workbench/result-history/subtitles"))).length).toBe(3);
  });

  it("cannot forge provenance into a legacy manual save, and preserves old API compatibility", async () => {
    const f = await fixture();
    const forged = { ...f.document, skillResult: { anything: "forged" } };
    const first = await writeSubtitles(f.project, forged);
    expect(first.document.skillResult).toBeUndefined();
    const second = await writeSubtitles(f.project, first.document, { expectedRevision: first.revision });
    expect(second.changed).toBe(false);
    const edited = { ...first.document, cues: [{ ...first.document.cues[0]!, text: "你们好" }, first.document.cues[1]!] };
    const reviewed = await writeSubtitles(f.project, edited, { expectedRevision: first.revision });
    const state = await getSubtitleResultState(f.project, await readSubtitles(f.project));
    expect(state.status).toBe("legacy");
    expect(state.provenance).toBeNull();
    expect(reviewed.document.skillResult?.review?.editCount).toBe(1);
  });

  it("checks receipt reviewed-result binding even if caller supplies current CAS", async () => {
    const f = await fixture();
    const first = await acceptSubtitleCandidate(f.project, f.candidate());
    const next = f.candidate(first.document, first.revision);
    (next.receipt as { inputs: { resultRevision: string } }).inputs.resultRevision = "none";
    await expect(acceptSubtitleCandidate(f.project, next)).rejects.toMatchObject({ code: "revision_conflict", details: { scope: "result" } });
    expect((await readSubtitles(f.project))?.revision).toBe(first.revision);
  });

  it("independently rejects false summaries, malformed styles and out-of-order/extra anchors", async () => {
    const f = await fixture();
    const summary = f.candidate();
    (summary.receipt as { validation: { wordCount: number } }).validation.wordCount = 99;
    await expect(acceptSubtitleCandidate(f.project, summary)).rejects.toMatchObject({ code: "invalid_subtitles" });
    const wrongStyle = structuredClone(f.document);
    (wrongStyle.style as unknown as { fontSize: unknown }).fontSize = "large";
    await expect(acceptSubtitleCandidate(f.project, f.candidate(wrongStyle))).rejects.toMatchObject({ code: "invalid_subtitles" });
    const missingStyle = structuredClone(f.document);
    delete (missingStyle.style as Partial<typeof missingStyle.style>).fontSize;
    await expect(acceptSubtitleCandidate(f.project, f.candidate(missingStyle))).rejects.toMatchObject({ code: "invalid_subtitles" });
    const reversed = structuredClone(f.document);
    reversed.cues[0]!.wordIds.reverse();
    await expect(acceptSubtitleCandidate(f.project, f.candidate(reversed))).rejects.toMatchObject({ code: "invalid_subtitles" });
    const gapAnchor = structuredClone(f.document);
    gapAnchor.cues[0]!.wordIds.unshift("gap");
    await expect(acceptSubtitleCandidate(f.project, f.candidate(gapAnchor))).rejects.toMatchObject({ code: "invalid_subtitles" });
    expect(await readSubtitles(f.project)).toBeNull();
  });

  it("preserves manual grouping and fails a corrupted recovery archive without active mutation", async () => {
    const f = await fixture();
    const first = await acceptSubtitleCandidate(f.project, f.candidate());
    const split = { ...first.document, cues: [
      { id: "new1", text: "您", wordIds: ["w1"] }, { id: "new2", text: "好", wordIds: ["w2"] }, first.document.cues[1]!,
    ] };
    const reviewed = await writeSubtitles(f.project, split, { expectedRevision: first.revision });
    await expect(acceptSubtitleCandidate(f.project, f.candidate(f.document, reviewed.revision))).rejects.toMatchObject({ code: "invalid_subtitles" });
    const accepted = await acceptSubtitleCandidate(f.project, f.candidate(reviewed.document, reviewed.revision));
    expect(accepted.document.cues).toEqual(split.cues);
    const activeBefore = await readFile(join(f.directory, "subtitles.json"), "utf8");
    await writeFile(join(f.directory, ".workbench/result-history/subtitles", `${accepted.revision}.json`), "corrupt archive");
    await expect(writeSubtitles(f.project, accepted.document, { expectedRevision: accepted.revision, reviewNote: "new note" }))
      .rejects.toMatchObject({ code: "readback_mismatch" });
    expect(await readFile(join(f.directory, "subtitles.json"), "utf8")).toBe(activeBefore);
  });

  it("shows transcript-only staleness and rejects its stale candidate", async () => {
    const f = await fixture();
    const first = await acceptSubtitleCandidate(f.project, f.candidate());
    await writeFile(join(f.directory, "transcript.json"), `${f.transcriptRaw}\n`);
    const state = await getSubtitleResultState(f.project, await readSubtitles(f.project));
    expect(state.changedSources).toEqual(["transcript"]);
    await expect(acceptSubtitleCandidate(f.project, f.candidate(first.document, first.revision)))
      .rejects.toMatchObject({ code: "revision_conflict", details: { scope: "source" } });
  });
});
