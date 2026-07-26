/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readOptionalProjectDocument,
  readProjectDocument,
  resolveProject,
} from "@video-workbench/core/node";

const API_SCHEMA_VERSION = 1 as const;
const REVIEW_PASSES_FILE = "review-passes.json" as const;
const REVISION_PATTERN = /^(?:none|[a-f0-9]{64})$/;

export interface ReviewPassCandidate {
  id: string;
  kind: "repeat";
  decision: "listen_then_decide";
  removeWordIds: string[];
  keepWordIds: string[];
  reason: string;
}

export type ReviewPassesState = "missing" | "stale" | "invalid" | "current";

export interface ReviewPassesResource {
  schemaVersion: 1;
  projectId: string;
  state: ReviewPassesState;
  removedWordIds: string[];
  candidates: ReviewPassCandidate[];
  reason?: string;
}

export interface VideocutReviewPassesHandlerOptions {
  projectsDir: string;
}

type VideocutReviewPassesHandler = (request: Request) => Promise<Response | null>;

interface ReviewPassesDocument {
  schemaVersion: 1;
  projectId: string;
  transcriptRevision: string;
  cutsRevision: string;
  editListRevision: string;
  passes: [
    { kind: "repair"; removedWordIds: string[] },
    { kind: "repeat"; candidates: ReviewPassCandidate[] },
  ];
}

interface TranscriptWord {
  id: string;
  isGap: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonResponse(value: ReviewPassesResource, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function response(
  projectId: string,
  state: ReviewPassesState,
  payload: Pick<ReviewPassesResource, "removedWordIds" | "candidates"> = {
    removedWordIds: [],
    candidates: [],
  },
  reason?: string,
): Response {
  return jsonResponse({
    schemaVersion: API_SCHEMA_VERSION,
    projectId,
    state,
    ...payload,
    ...(reason ? { reason } : {}),
  });
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function requestProjectId(pathname: string): string | null | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length !== 5 ||
    segments[0] !== "api" ||
    segments[1] !== "v1" ||
    segments[2] !== "projects" ||
    segments[4] !== "review-passes"
  ) return undefined;
  return decodeSegment(segments[3]);
}

function isSafeProjectId(projectId: string): boolean {
  return Boolean(
    projectId &&
    projectId !== "." &&
    projectId !== ".." &&
    !projectId.includes("/") &&
    !projectId.includes("\\") &&
    !projectId.includes("\0"),
  );
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "");
  return ids.every(Boolean) && new Set(ids).size === ids.length ? ids : null;
}

function parseCandidate(value: unknown): ReviewPassCandidate | null {
  if (!isRecord(value) ||
    typeof value.id !== "string" || !value.id ||
    value.kind !== "repeat" ||
    value.decision !== "listen_then_decide" ||
    typeof value.reason !== "string" || !value.reason
  ) return null;
  const removeWordIds = stringArray(value.removeWordIds);
  const keepWordIds = stringArray(value.keepWordIds);
  if (!removeWordIds || !keepWordIds) return null;
  return {
    id: value.id,
    kind: "repeat",
    decision: "listen_then_decide",
    removeWordIds,
    keepWordIds,
    reason: value.reason,
  };
}

function parseReviewPasses(value: unknown): ReviewPassesDocument | null {
  if (!isRecord(value) ||
    value.schemaVersion !== API_SCHEMA_VERSION ||
    typeof value.projectId !== "string" ||
    typeof value.transcriptRevision !== "string" || !REVISION_PATTERN.test(value.transcriptRevision) ||
    typeof value.cutsRevision !== "string" || !REVISION_PATTERN.test(value.cutsRevision) ||
    typeof value.editListRevision !== "string" || !REVISION_PATTERN.test(value.editListRevision) ||
    !Array.isArray(value.passes) || value.passes.length !== 2
  ) return null;
  const [repair, repeat] = value.passes;
  if (!isRecord(repair) || repair.kind !== "repair" || !isRecord(repeat) || repeat.kind !== "repeat") {
    return null;
  }
  const removedWordIds = stringArray(repair.removedWordIds);
  if (!removedWordIds || !Array.isArray(repeat.candidates)) return null;
  const candidates = repeat.candidates.map(parseCandidate);
  if (candidates.some((candidate) => candidate === null)) return null;
  return {
    schemaVersion: API_SCHEMA_VERSION,
    projectId: value.projectId,
    transcriptRevision: value.transcriptRevision,
    cutsRevision: value.cutsRevision,
    editListRevision: value.editListRevision,
    passes: [
      { kind: "repair", removedWordIds },
      { kind: "repeat", candidates: candidates as ReviewPassCandidate[] },
    ],
  };
}

function transcriptWords(value: unknown): TranscriptWord[] | null {
  if (!isRecord(value) || !Array.isArray(value.cues)) return null;
  const words: TranscriptWord[] = [];
  for (const cue of value.cues) {
    if (!isRecord(cue) || !Array.isArray(cue.words)) return null;
    for (const word of cue.words) {
      if (!isRecord(word) || typeof word.id !== "string" || !word.id) return null;
      words.push({ id: word.id, isGap: word.isGap === true });
    }
  }
  return new Set(words.map((word) => word.id)).size === words.length ? words : null;
}

function isContiguousVisibleRange(ids: readonly string[], words: readonly TranscriptWord[]): boolean {
  const visible = words.filter((word) => !word.isGap);
  const positions = ids.map((id) => visible.findIndex((word) => word.id === id));
  return positions.length > 0 && positions.every((position, index) =>
    position >= 0 && (index === 0 || position === positions[index - 1]! + 1),
  );
}

function validCurrentCandidates(document: ReviewPassesDocument, words: readonly TranscriptWord[]): ReviewPassCandidate[] | null {
  const knownIds = new Set(words.map((word) => word.id));
  const removedInFirstPass = new Set(document.passes[0].removedWordIds);
  if ([...removedInFirstPass].some((id) => !knownIds.has(id))) return null;
  const candidates = document.passes[1].candidates;
  if (candidates.length === 0 || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return null;
  const seenCandidateIds = new Set<string>();
  for (const candidate of candidates) {
    const candidateIds = [...candidate.removeWordIds, ...candidate.keepWordIds];
    if (new Set(candidateIds).size !== candidateIds.length) return null;
    if (candidateIds.some((id) => !knownIds.has(id) || removedInFirstPass.has(id) || seenCandidateIds.has(id))) return null;
    if (!isContiguousVisibleRange(candidate.removeWordIds, words)) return null;
    if (!isContiguousVisibleRange(candidate.keepWordIds, words)) return null;
    candidateIds.forEach((id) => seenCandidateIds.add(id));
  }
  return candidates;
}

async function readReviewPasses(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

export function createVideocutReviewPassesHandler(
  options: VideocutReviewPassesHandlerOptions,
): VideocutReviewPassesHandler {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const projectId = requestProjectId(url.pathname);
    if (projectId === undefined) return null;
    if (request.method !== "GET") {
      return response(projectId ?? "", "invalid", undefined, "只支持读取第二遍候选");
    }
    if (!projectId || !isSafeProjectId(projectId)) {
      return response(projectId ?? "", "invalid", undefined, "项目标识不合法");
    }
    try {
      const project = await resolveProject(resolve(options.projectsDir, projectId));
      const artifact = await readReviewPasses(join(project.directory, REVIEW_PASSES_FILE));
      if (artifact === null) return response(project.projectId, "missing");
      const document = parseReviewPasses(artifact);
      if (!document || document.projectId !== project.projectId) {
        return response(project.projectId, "invalid", undefined, "第二遍候选格式无效");
      }
      const [transcript, cuts] = await Promise.all([
        readProjectDocument(project, "transcript.json"),
        readOptionalProjectDocument(project, "cut-selection.json"),
      ]);
      const cutsRevision = cuts?.revision ?? "none";
      // Review passes are word-level conclusions: which words are a stumble, a
      // restart, or a repeat of a later take. Only the transcript can invalidate
      // them, and cut-selection because a candidate must not name a word that is
      // already deleted there.
      //
      // The edit list deliberately does NOT take part. It records which source
      // ranges play and in what order — rearranging, trimming or removing a
      // segment cannot change whether a given word is a stumble. Including it
      // here made the artifact self-invalidating: the candidates exist to be
      // reviewed on the timeline, and the first timeline edit threw all of them
      // away with no way to regenerate. `document.editListRevision` is still
      // persisted as provenance, but it is no longer a staleness key.
      if (
        document.transcriptRevision !== transcript.revision ||
        document.cutsRevision !== cutsRevision
      ) {
        return response(project.projectId, "stale", undefined, "项目文稿或删词结果已变化，请重新生成第二遍候选");
      }
      const words = transcriptWords(transcript.value);
      const candidates = words ? validCurrentCandidates(document, words) : null;
      if (!candidates) return response(project.projectId, "invalid", undefined, "第二遍候选的词边界无效");
      return response(project.projectId, "current", {
        removedWordIds: document.passes[0].removedWordIds,
        candidates,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取第二遍候选";
      return response(projectId, "invalid", undefined, message);
    }
  };
}
