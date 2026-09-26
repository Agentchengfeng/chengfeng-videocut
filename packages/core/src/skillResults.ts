import type {
  SkillResultMetadata, SkillResultReviewSnapshot, SubtitleCandidateReceipt,
} from "@video-workbench/contracts";
import { VideocutError } from "./errors";
import { normalizeSubtitleStyle, type SubtitleDocument } from "./subtitles";

const SHA = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const revision = (value: unknown) => typeof value === "string" && (value === "none" || SHA.test(value));
const hash = (value: unknown) => typeof value === "string" && SHA.test(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export function invalidResult(message: string, details?: Record<string, unknown>): never {
  throw new VideocutError("invalid_subtitles", message, details);
}

export function assertCandidateReceipt(value: unknown): asserts value is SubtitleCandidateReceipt {
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== "isolated-subtitle-candidate" || value.productionCommitted !== false
    || !object(value.inputs) || !hash(value.inputs.transcriptSha256) || !hash(value.inputs.editListSha256)
    || !revision(value.inputs.resultRevision) || typeof value.inputs.projectId !== "string"
    || !object(value.provenance) || Object.keys(value.provenance).length === 0
    || JSON.stringify(value.provenance).length > 65_536
    || !hash(value.outputSha256) || !object(value.validation) || value.validation.valid !== true
    || !Number.isSafeInteger(value.validation.cueCount) || (value.validation.cueCount as number) < 0
    || !Number.isSafeInteger(value.validation.wordCount) || (value.validation.wordCount as number) < 0) {
    invalidResult("Candidate receipt requires source/output hashes, resultRevision and declared provenance");
  }
}

function validSnapshot(value: unknown): value is SkillResultReviewSnapshot {
  return object(value) && object(value.style) && Array.isArray(value.cues) && value.cues.every((cue) =>
    object(cue) && typeof cue.id === "string" && typeof cue.text === "string"
      && Array.isArray(cue.wordIds) && cue.wordIds.every((id) => typeof id === "string"));
}

export function trustedResultMetadata(document: SubtitleDocument): SkillResultMetadata | undefined {
  const value = document.skillResult;
  if (value === undefined) return undefined;
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== "subtitles"
    || !(value.sources === null || (object(value.sources) && hash(value.sources.transcriptSha256) && hash(value.sources.editListSha256)))
    || !(value.provenance === null || object(value.provenance))
    || !(value.outputSha256 === null || hash(value.outputSha256))
    || !(value.acceptedAt === null || typeof value.acceptedAt === "string")
    || !(value.previousResultRevision === null || hash(value.previousResultRevision))) {
    invalidResult("Stored Skill result metadata is invalid; preserve it for recovery");
  }
  const review = value.review;
  if (review && (review.schemaVersion !== 1 || !revision(review.baseResultRevision)
    || !revision(review.basedOnRevision) || !Number.isSafeInteger(review.editCount) || review.editCount < 0
    || typeof review.updatedAt !== "string" || !validSnapshot(review.baseline) || !validSnapshot(review.reviewed)
    || !Array.isArray(review.notes) || review.notes.length > 50
    || review.notes.some((note) => !object(note) || !revision(note.basedOnRevision)
      || typeof note.text !== "string" || !note.text.trim() || note.text.length > 2000 || typeof note.createdAt !== "string"))) {
    invalidResult("Stored Skill review metadata is invalid; preserve it for recovery");
  }
  return structuredClone(value);
}

function snapshot(document: SubtitleDocument): SkillResultReviewSnapshot {
  return {
    cues: document.cues.map(({ id, text, wordIds }) => ({ id, text, wordIds: [...wordIds] })),
    style: { ...normalizeSubtitleStyle(document.style) },
  };
}

export function reviewedSubtitleDocument(
  proposal: SubtitleDocument,
  previous: SubtitleDocument | null,
  previousRevision: string,
  reviewNote?: string,
): SubtitleDocument {
  if (reviewNote !== undefined && (typeof reviewNote !== "string" || !reviewNote.trim() || reviewNote.trim().length > 2000)) {
    invalidResult("Review note must contain 1–2000 characters");
  }
  // The caller can edit subtitle content, never declare its own trusted origin or review history.
  const { skillResult: _untrusted, ...content } = proposal;
  const metadata = previous ? trustedResultMetadata(previous) : undefined;
  const document: SubtitleDocument = { ...content, ...(metadata ? { skillResult: metadata } : {}) };
  const before = previous ? snapshot(previous) : snapshot(document);
  const after = snapshot(document);
  const changed = previous !== null && !same(before, after);
  if (!changed && reviewNote === undefined) return document;
  const now = new Date().toISOString();
  const existing = metadata?.review;
  const notes = [...(existing?.notes ?? [])];
  if (reviewNote !== undefined) {
    if (notes.length >= 50) invalidResult("Review note limit reached (50); export/reconcile the review before adding more");
    notes.push({ basedOnRevision: previousRevision, text: reviewNote.trim(), createdAt: now });
  }
  document.skillResult = {
    ...(metadata ?? { schemaVersion: 1, kind: "subtitles", sources: null, provenance: null,
      outputSha256: null, acceptedAt: null, previousResultRevision: null }),
    review: {
      schemaVersion: 1,
      baseResultRevision: existing?.baseResultRevision ?? previousRevision,
      basedOnRevision: previousRevision,
      editCount: (existing?.editCount ?? 0) + (changed ? 1 : 0),
      updatedAt: now,
      baseline: existing?.baseline ?? before,
      reviewed: changed ? after : (existing?.reviewed ?? after),
      notes,
    },
  };
  return document;
}

/** Independently refuse loss of still-anchored manual edits, even if a Skill claims validation passed. */
export function assertPreservesSubtitleReview(
  candidate: SubtitleDocument, previous: SubtitleDocument | null, retainedWords: ReadonlySet<string>,
): void {
  const review = previous ? trustedResultMetadata(previous)?.review : undefined;
  if (!review || review.editCount === 0) return;
  const key = (cue: { wordIds: string[] }) => JSON.stringify(cue.wordIds);
  const baseline = new Map(review.baseline.cues.map((cue) => [key(cue), cue]));
  const proposed = new Map(candidate.cues.map((cue) => [key(cue), cue]));
  const reviewedWords = new Set(review.reviewed.cues.flatMap((cue) => cue.wordIds));
  const candidateWords = new Set(candidate.cues.flatMap((cue) => cue.wordIds));
  for (const cue of review.baseline.cues) {
    if (cue.wordIds.some((id) => retainedWords.has(id) && !reviewedWords.has(id) && candidateWords.has(id))) {
      invalidResult("Candidate would restore words intentionally removed from reviewed subtitles; reconcile feedback first", { cueId: cue.id });
    }
  }
  for (const cue of review.reviewed.cues) {
    const original = baseline.get(key(cue));
    if (original?.text === cue.text) continue;
    const surviving = cue.wordIds.filter((id) => retainedWords.has(id));
    if (surviving.length === 0 && cue.wordIds.length > 0) continue;
    if (surviving.length !== cue.wordIds.length || proposed.get(key(cue))?.text !== cue.text) {
      invalidResult("Candidate would discard or ambiguously remap a reviewed subtitle; reconcile feedback first", { cueId: cue.id });
    }
  }
  const style = normalizeSubtitleStyle(candidate.style) as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(review.reviewed.style)) {
    if (!same(value, review.baseline.style[field]) && !same(style[field], value)) {
      invalidResult("Candidate would discard a reviewed subtitle style", { field });
    }
  }
}
