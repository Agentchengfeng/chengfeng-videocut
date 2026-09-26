/** Versioned handoff envelope. Only explicitly registered result adapters may accept it. */
export interface SkillResultSources {
  transcriptSha256: string;
  editListSha256: string;
}

export interface SkillResultReviewSnapshot {
  cues: Array<{ id: string; text: string; wordIds: string[] }>;
  style: Record<string, unknown>;
}

export interface SkillResultReview {
  schemaVersion: 1;
  baseResultRevision: string;
  basedOnRevision: string;
  editCount: number;
  updatedAt: string;
  /** One baseline and latest snapshot, never recursively embedded result history. */
  baseline: SkillResultReviewSnapshot;
  reviewed: SkillResultReviewSnapshot;
  notes: Array<{ basedOnRevision: string; text: string; createdAt: string }>;
}

export interface SkillResultMetadata {
  schemaVersion: 1;
  kind: string;
  /** null is honest for legacy results that have never passed candidate acceptance. */
  sources: SkillResultSources | null;
  provenance: Record<string, unknown> | null;
  outputSha256: string | null;
  acceptedAt: string | null;
  previousResultRevision: string | null;
  review?: SkillResultReview;
}

export interface SubtitleCandidateReceipt {
  schemaVersion: 1;
  kind: "isolated-subtitle-candidate";
  productionCommitted: false;
  inputs: SkillResultSources & { projectId: string; resultRevision: string };
  provenance: Record<string, unknown>;
  outputSha256: string;
  validation: { valid: true; cueCount: number; wordCount: number; [key: string]: unknown };
}

export interface SkillResultState {
  schemaVersion: 1;
  kind: "subtitles";
  revision: string;
  status: "missing" | "legacy" | "current" | "stale";
  sourceStale: boolean | null;
  changedSources: Array<"transcript" | "edit-list">;
  sources: SkillResultSources | null;
  provenance: Record<string, unknown> | null;
  acceptedAt: string | null;
  review: { editCount: number; noteCount: number; lastReviewedAt: string | null };
}
