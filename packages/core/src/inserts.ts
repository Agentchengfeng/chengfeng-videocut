import type { EditListDocument, EditListSegment, EditListSource } from "@video-workbench/contracts";
import type { TimedWord } from "./cuts";
import { EDIT_LIST_MIN_SEGMENT_SECONDS } from "./editList";
import { VideocutError } from "./errors";
import { orderedSegments, segmentMatchesWord, wordPlays } from "./subtitles";
import type { VisualMedia } from "./visuals";

export const INSERT_SCHEMA_VERSION = 1 as const;
export const INSERT_INSTANCE_PREFIX = "insert:";
/** How far past the anchor word the cut may move to land inside the following pause. */
const MAX_PAUSE_SHIFT = 0.3;
const EPSILON = 0.0005;

export interface InsertItem {
  id: string;
  /** The spoken word after which narration pauses and the clip plays. */
  afterWordId: string;
  /** Verified media asset (SHA-256). The clip's own audio is played on the main track. */
  assetId: string;
  sourceIn: number;
  sourceOut: number;
  fit: "contain" | "cover";
  /** Reserved; only 0 is accepted until per-span gain is implemented. */
  gainDb?: number;
  label?: string;
}

export interface InsertDocument {
  schemaVersion: typeof INSERT_SCHEMA_VERSION;
  projectId: string;
  inserts: InsertItem[];
}

export interface InsertAsset {
  duration: number;
  hasAudio: boolean;
}

const invalid = (message: string, details?: Record<string, unknown>): never => {
  throw new VideocutError("invalid_argument", message, details);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function insertAssetPath(assetId: string): string {
  return `.chengfeng-videocut/media/${assetId}/source.mp4`;
}

export function isInsertInstance(instanceId: string | undefined): boolean {
  return typeof instanceId === "string" && instanceId.startsWith(INSERT_INSTANCE_PREFIX);
}

export function createInsertDocument(projectId: string): InsertDocument {
  return { schemaVersion: INSERT_SCHEMA_VERSION, projectId, inserts: [] };
}

export function assertInsertDocument(payload: unknown): InsertDocument {
  if (!isObject(payload) || payload.schemaVersion !== INSERT_SCHEMA_VERSION) invalid("inserts.json schemaVersion must be 1");
  const doc = payload as Record<string, unknown>;
  if (typeof doc.projectId !== "string" || !doc.projectId) invalid("inserts.json requires projectId");
  if (!Array.isArray(doc.inserts) || doc.inserts.length > 64) invalid("inserts must be an array of at most 64 items");
  const ids = new Set<string>(), anchors = new Set<string>();
  const inserts = (doc.inserts as unknown[]).map((item, index): InsertItem => {
    if (!isObject(item)) return invalid(`inserts[${index}] must be an object`);
    const { id, afterWordId, assetId, sourceIn, sourceOut, fit, gainDb, label } = item;
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id) || ids.has(id)) invalid(`inserts[${index}].id must be a unique safe id`);
    if (typeof afterWordId !== "string" || !afterWordId) invalid(`inserts[${index}].afterWordId is required`);
    if (anchors.has(afterWordId as string)) invalid(`inserts[${index}] shares its anchor word with another insert`);
    if (typeof assetId !== "string" || !/^[a-f0-9]{64}$/.test(assetId)) invalid(`inserts[${index}].assetId must be a SHA-256`);
    if (typeof sourceIn !== "number" || !Number.isFinite(sourceIn) || sourceIn < 0 ||
      typeof sourceOut !== "number" || !Number.isFinite(sourceOut) || sourceOut <= sourceIn + 0.04 || sourceOut > 3600)
      invalid(`inserts[${index}] requires a bounded sourceIn/sourceOut range`);
    if (fit !== "contain" && fit !== "cover") invalid(`inserts[${index}].fit must be contain or cover`);
    if (gainDb !== undefined && gainDb !== 0) invalid(`inserts[${index}].gainDb is not supported yet; omit it or use 0`);
    if (label !== undefined && (typeof label !== "string" || label.length > 120)) invalid(`inserts[${index}].label must be a short string`);
    ids.add(id as string); anchors.add(afterWordId as string);
    return { id: id as string, afterWordId: afterWordId as string, assetId: assetId as string, sourceIn: sourceIn as number,
      sourceOut: sourceOut as number, fit: fit as "contain" | "cover", ...(label !== undefined ? { label: label as string } : {}) };
  });
  return { schemaVersion: INSERT_SCHEMA_VERSION, projectId: doc.projectId as string, inserts };
}

/** Drop every insert instance and heal the narration segments they split. */
export function stripInserts(editList: EditListDocument): EditListSegment[] {
  const kept = orderedSegments(editList).filter(s => !isInsertInstance(s.instanceId));
  const healed: EditListSegment[] = [];
  for (const segment of kept) {
    const last = healed[healed.length - 1];
    if (last && last.source === segment.source && last.instanceId === segment.instanceId &&
      Math.abs(last.sourceEnd - segment.sourceStart) <= EPSILON && segment.id.startsWith(`${last.id}~`)) {
      healed[healed.length - 1] = { ...last, sourceEnd: segment.sourceEnd };
    } else healed.push({ ...segment });
  }
  return healed;
}

/**
 * Rebuild the magnetic A-roll with the given inserts. Pure and idempotent: the
 * previous inserts are removed first, so resubmitting a document never
 * duplicates a clip. Subtitles and visual layers follow automatically because
 * they are always re-timed from the EDL.
 */
export function applyInserts(input: {
  editList: EditListDocument;
  words: readonly TimedWord[];
  document: InsertDocument;
  assets: ReadonlyMap<string, InsertAsset>;
}): EditListDocument {
  const { editList, words, document, assets } = input;
  if (editList.schemaVersion !== 2 || !editList.sources) invalid("Inserts require an edit-list v2 project");
  if (document.projectId !== editList.projectId) invalid("inserts.json belongs to another project");
  let segments = stripInserts(editList);
  const byId = new Map(words.map(w => [w.id, w]));
  const speech = words.filter(w => !w.isGap);
  const placements = document.inserts.map(item => {
    const asset = assets.get(item.assetId) ?? invalid(`Insert ${item.id} references an unimported media asset`, { insertId: item.id });
    if (!asset.hasAudio) invalid(`Insert ${item.id} media has no audio track`, { insertId: item.id });
    if (item.sourceOut > asset.duration + 0.000001) invalid(`Insert ${item.id} sourceOut exceeds the media duration`, { insertId: item.id });
    const word = byId.get(item.afterWordId);
    if (!word || word.isGap) invalid(`Insert ${item.id} anchor is not a spoken word`, { insertId: item.id, afterWordId: item.afterWordId });
    if (!wordPlays(segments, word!)) invalid(`Insert ${item.id} anchor word was cut from the edit`, { insertId: item.id, afterWordId: item.afterWordId });
    return { item, word: word! };
  });
  // Insert from the latest anchor backwards so earlier timeline positions stay valid.
  const timelineOf = (word: TimedWord) => {
    const seg = segments.find(s => segmentMatchesWord(s, word) && word.end > s.sourceStart + EPSILON && word.end <= s.sourceEnd + EPSILON);
    return seg ? seg.timelineStart + (word.end - seg.sourceStart) : -1;
  };
  placements.sort((a, b) => timelineOf(b.word) - timelineOf(a.word));
  const sources: EditListSource[] = editList.sources!.filter(s => s.mediaKind !== "video" || segments.some(seg => seg.source === s.path));
  for (const { item, word } of placements) {
    const index = segments.findIndex(s => segmentMatchesWord(s, word) && word.end > s.sourceStart + EPSILON && word.end <= s.sourceEnd + EPSILON);
    if (index < 0) invalid(`Insert ${item.id} anchor does not end inside a retained segment`, { insertId: item.id });
    const segment = segments[index]!;
    const next = speech.filter(w => w.source === word.source && w.instanceId === word.instanceId && w.start >= word.end - EPSILON)
      .sort((a, b) => a.start - b.start)[0];
    const pauseEnd = Math.min(segment.sourceEnd, next ? next.start : segment.sourceEnd);
    let cut = round(Math.min(pauseEnd, word.end + Math.min(MAX_PAUSE_SHIFT, Math.max(0, (pauseEnd - word.end) / 2))));
    if (cut - segment.sourceStart < EDIT_LIST_MIN_SEGMENT_SECONDS) cut = round(segment.sourceStart + EDIT_LIST_MIN_SEGMENT_SECONDS);
    const path = insertAssetPath(item.assetId);
    const clip: EditListSegment = { id: `insert-${item.id}`, source: path, sourceStart: item.sourceIn, sourceEnd: item.sourceOut,
      timelineStart: 0, trackId: "a-roll", playbackRate: 1, instanceId: `${INSERT_INSTANCE_PREFIX}${item.id}` };
    const replacement = segment.sourceEnd - cut >= EDIT_LIST_MIN_SEGMENT_SECONDS
      ? [{ ...segment, sourceEnd: cut }, clip, { ...segment, id: `${segment.id}~${item.id}`, sourceStart: cut }]
      : [segment, clip];
    segments = [...segments.slice(0, index), ...replacement, ...segments.slice(index + 1)];
    if (!sources.some(s => s.path === path)) {
      sources.push({ path, sha256: item.assetId, duration: assets.get(item.assetId)!.duration, mediaKind: "video" });
    }
  }
  let cursor = 0;
  const timed = segments.map(s => {
    const next = { ...s, timelineStart: round(cursor) };
    cursor = round(cursor + (s.sourceEnd - s.sourceStart) / s.playbackRate);
    return next;
  });
  const used = sources.filter(s => timed.some(seg => seg.source === s.path));
  return { ...editList, mode: "manual", sources: used, sourceDuration: Math.max(...used.map(s => s.duration)), segments: timed, duration: cursor };
}

export interface InsertMediaLayer {
  layerId: string;
  media: VisualMedia;
  start: number;
  end: number;
  duration: number;
}

/**
 * Read-only picture layers for inserted clips, derived from the EDL alone so
 * preview and export cannot disagree about where a clip plays.
 */
export function insertMediaLayers(editList: EditListDocument | null, document?: InsertDocument | null): InsertMediaLayer[] {
  if (!editList || editList.schemaVersion !== 2) return [];
  const fits = new Map((document?.inserts ?? []).map(i => [`${INSERT_INSTANCE_PREFIX}${i.id}`, i.fit]));
  return orderedSegments(editList)
    .filter(s => isInsertInstance(s.instanceId) && editList.sources?.find(src => src.path === s.source)?.mediaKind === "video")
    .map(s => {
      const assetId = editList.sources!.find(src => src.path === s.source)!.sha256;
      const duration = round((s.sourceEnd - s.sourceStart) / s.playbackRate);
      return {
        layerId: s.instanceId!,
        media: { assetId, sourceIn: s.sourceStart, sourceOut: s.sourceEnd, fit: fits.get(s.instanceId!) ?? "contain", muted: true },
        start: round(s.timelineStart),
        end: round(s.timelineStart + duration),
        duration,
      };
    });
}
