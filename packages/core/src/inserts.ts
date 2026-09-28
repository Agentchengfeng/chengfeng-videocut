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
/**
 * A split leaving less than this after the clip would put a sliver of pause on
 * the timeline as its own clip (silent at best, a crackle at worst). Place the
 * clip at the end of the narration piece instead; the pause plays before it.
 */
export const INSERT_MIN_REMAINDER_SECONDS = 0.25;

/** Anchor for a clip that plays before the first word (a cold open). */
export const INSERT_AT_START = "@start";

export interface InsertItem {
  id: string;
  /** The spoken word after which narration pauses and the clip plays, or INSERT_AT_START. */
  afterWordId: string;
  /** Verified media asset (SHA-256). The clip's own audio is played on the main track. */
  assetId: string;
  sourceIn: number;
  sourceOut: number;
  fit: "contain" | "cover";
  /** Reserved; only 0 is accepted until per-span gain is implemented. */
  gainDb?: number;
  label?: string;
  /**
   * false = only the clip's sound plays (a re-recorded narration line); the
   * canvas and captions stay as for narration. Absent means the picture shows.
   */
  picture?: false;
  /** Subtitle text for a sound-only insert, drawn in the project's subtitle style. */
  caption?: string;
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
    const { id, afterWordId, assetId, sourceIn, sourceOut, fit, gainDb, label, picture, caption } = item;
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id) || ids.has(id)) invalid(`inserts[${index}].id must be a unique safe id`);
    if (typeof afterWordId !== "string" || !afterWordId) invalid(`inserts[${index}].afterWordId is required`);
    // Several cold-open clips may share the start; they play in document order.
    if (afterWordId !== INSERT_AT_START && anchors.has(afterWordId as string)) invalid(`inserts[${index}] shares its anchor word with another insert`);
    if (typeof assetId !== "string" || !/^[a-f0-9]{64}$/.test(assetId)) invalid(`inserts[${index}].assetId must be a SHA-256`);
    if (typeof sourceIn !== "number" || !Number.isFinite(sourceIn) || sourceIn < 0 ||
      typeof sourceOut !== "number" || !Number.isFinite(sourceOut) || sourceOut <= sourceIn + 0.04 || sourceOut > 3600)
      invalid(`inserts[${index}] requires a bounded sourceIn/sourceOut range`);
    if (fit !== "contain" && fit !== "cover") invalid(`inserts[${index}].fit must be contain or cover`);
    if (gainDb !== undefined && gainDb !== 0) invalid(`inserts[${index}].gainDb is not supported yet; omit it or use 0`);
    if (label !== undefined && (typeof label !== "string" || label.length > 120)) invalid(`inserts[${index}].label must be a short string`);
    if (picture !== undefined && picture !== false) invalid(`inserts[${index}].picture may only be false (sound only)`);
    if (caption !== undefined && (typeof caption !== "string" || !caption.trim() || caption.length > 120)) invalid(`inserts[${index}].caption must be a short non-empty string`);
    if (caption !== undefined && picture !== false) invalid(`inserts[${index}].caption is only for a sound-only insert (picture: false)`);
    ids.add(id as string); anchors.add(afterWordId as string);
    return { id: id as string, afterWordId: afterWordId as string, assetId: assetId as string, sourceIn: sourceIn as number,
      sourceOut: sourceOut as number, fit: fit as "contain" | "cover", ...(label !== undefined ? { label: label as string } : {}),
      ...(picture === false ? { picture: false as const } : {}), ...(caption !== undefined ? { caption: (caption as string).trim() } : {}) };
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
 * The one narration source of a project whose only multisource content is
 * inserted clips. Such a project keeps word-level cut editing: cuts are applied
 * to the narration alone and the inserts are re-applied afterwards.
 */
export function insertOnlyNarration(editList: EditListDocument | null | undefined): EditListSource | null {
  if (!editList || editList.schemaVersion !== 2 || !editList.sources) return null;
  const narration = editList.segments.filter(s => !isInsertInstance(s.instanceId));
  const source = narration[0]?.source;
  if (!source || narration.some(s => s.source !== source || s.instanceId !== "original")) return null;
  const entry = editList.sources.find(s => s.path === source);
  if (!entry || entry.mediaKind !== "audio") return null;
  if (editList.sources.some(s => s.path !== source && s.mediaKind !== "video")) return null;
  return entry;
}

/** The narration-only, single-source (v1) view of an insert-only project. */
export function narrationEditList(editList: EditListDocument): EditListDocument {
  const narration = insertOnlyNarration(editList) ?? invalid("Edit list is not a single narration with inserts");
  let cursor = 0;
  const segments = stripInserts(editList).map(({ instanceId: _instance, ...segment }) => {
    const next = { ...segment, timelineStart: round(cursor) };
    cursor = round(cursor + (segment.sourceEnd - segment.sourceStart) / segment.playbackRate);
    return next;
  });
  const { sources: _sources, ...rest } = editList;
  return { ...rest, schemaVersion: 1, sourceDuration: narration.duration, segments, duration: cursor } as EditListDocument;
}

/** Lift a single-source edit list back to v2 with its narration identity. */
export function narrationToMultisource(editList: EditListDocument, narration: EditListSource): EditListDocument {
  if (editList.schemaVersion === 2) return editList;
  return { ...editList, schemaVersion: 2, sources: [narration], sourceDuration: narration.duration,
    segments: editList.segments.map(s => ({ ...s, instanceId: "original" })) } as EditListDocument;
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
  const atStart = document.inserts.filter(item => item.afterWordId === INSERT_AT_START);
  for (const item of atStart) {
    const asset = assets.get(item.assetId) ?? invalid(`Insert ${item.id} references an unimported media asset`, { insertId: item.id });
    if (!asset.hasAudio) invalid(`Insert ${item.id} media has no audio track`, { insertId: item.id });
    if (item.sourceOut > asset.duration + 0.000001) invalid(`Insert ${item.id} sourceOut exceeds the media duration`, { insertId: item.id });
  }
  const placements = document.inserts.filter(item => item.afterWordId !== INSERT_AT_START).map(item => {
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
    const replacement = segment.sourceEnd - cut >= INSERT_MIN_REMAINDER_SECONDS
      ? [{ ...segment, sourceEnd: cut }, clip, { ...segment, id: `${segment.id}~${item.id}`, sourceStart: cut }]
      : [segment, clip];
    segments = [...segments.slice(0, index), ...replacement, ...segments.slice(index + 1)];
    if (!sources.some(s => s.path === path)) {
      sources.push({ path, sha256: item.assetId, duration: assets.get(item.assetId)!.duration, mediaKind: "video" });
    }
  }
  // A cold open plays before any narration; no narration segment is split.
  segments = [...atStart.map(item => {
    const path = insertAssetPath(item.assetId);
    if (!sources.some(s => s.path === path)) sources.push({ path, sha256: item.assetId, duration: assets.get(item.assetId)!.duration, mediaKind: "video" });
    return { id: `insert-${item.id}`, source: path, sourceStart: item.sourceIn, sourceEnd: item.sourceOut,
      timelineStart: 0, trackId: "a-roll", playbackRate: 1, instanceId: `${INSERT_INSTANCE_PREFIX}${item.id}` } as EditListSegment;
  }), ...segments];
  let cursor = 0;
  const timed = segments.map(s => {
    const next = { ...s, timelineStart: round(cursor) };
    cursor = round(cursor + (s.sourceEnd - s.sourceStart) / s.playbackRate);
    return next;
  });
  const used = sources.filter(s => timed.some(seg => seg.source === s.path));
  return { ...editList, sources: used, sourceDuration: Math.max(...used.map(s => s.duration)), segments: timed, duration: cursor };
}

export interface MovedInsert {
  insertId: string;
  label?: string;
  fromWordId: string;
  toWordId: string;
  toWordText: string;
}

/**
 * Magnetic anchors: when a cut removes the word an insert follows, the insert
 * moves to the nearest earlier word that still plays (later if nothing earlier
 * is left), like a clip riding the main track in an NLE. Pure; the caller
 * persists the moved document together with the cut.
 */
export function followCutAnchors(document: InsertDocument, words: readonly TimedWord[],
  narrationSegments: readonly EditListSegment[]): { document: InsertDocument; moved: MovedInsert[] } {
  const speech = words.filter(w => !w.isGap).slice().sort((a, b) => a.start - b.start);
  const index = new Map(speech.map((w, i) => [w.id, i]));
  const taken = new Set(document.inserts.map(i => i.afterWordId));
  const moved: MovedInsert[] = [];
  const inserts = document.inserts.map(item => {
    const at = index.get(item.afterWordId);
    if (at === undefined) return item;
    const word = speech[at]!;
    if (wordPlays(narrationSegments, word)) return item;
    const sameTrack = (w: TimedWord) => w.source === word.source && w.instanceId === word.instanceId;
    const free = (w: TimedWord) => sameTrack(w) && !taken.has(w.id) && wordPlays(narrationSegments, w);
    let target: TimedWord | undefined;
    for (let i = at - 1; i >= 0 && !target; i--) if (free(speech[i]!)) target = speech[i];
    for (let i = at + 1; i < speech.length && !target; i++) if (free(speech[i]!)) target = speech[i];
    if (!target) {
      throw new VideocutError("invalid_cut_selection",
        `删掉这段后，插入视频「${item.label ?? item.id}」已经没有可以跟随的口播，请先移除这段插入视频`,
        { insertId: item.id, reason: "insert_anchor_unavailable" });
    }
    taken.delete(item.afterWordId);
    taken.add(target.id);
    moved.push({ insertId: item.id, ...(item.label ? { label: item.label } : {}), fromWordId: item.afterWordId,
      toWordId: target.id, toWordText: target.text ?? "" });
    return { ...item, afterWordId: target.id };
  });
  return { document: { ...document, inserts }, moved };
}

export interface InsertMediaLayer {
  layerId: string;
  media: VisualMedia;
  start: number;
  end: number;
  duration: number;
  label?: string;
}

/**
 * Read-only picture layers for inserted clips, derived from the EDL alone so
 * preview and export cannot disagree about where a clip plays.
 */
export function insertMediaLayers(editList: EditListDocument | null, document?: InsertDocument | null): InsertMediaLayer[] {
  if (!editList || editList.schemaVersion !== 2) return [];
  const fits = new Map((document?.inserts ?? []).map(i => [`${INSERT_INSTANCE_PREFIX}${i.id}`, i.fit]));
  const soundOnly = new Set((document?.inserts ?? []).filter(i => i.picture === false).map(i => `${INSERT_INSTANCE_PREFIX}${i.id}`));
  const labels = new Map((document?.inserts ?? []).map(i => [`${INSERT_INSTANCE_PREFIX}${i.id}`, i.label]));
  return orderedSegments(editList)
    .filter(s => isInsertInstance(s.instanceId) && !soundOnly.has(s.instanceId!) && editList.sources?.find(src => src.path === s.source)?.mediaKind === "video")
    .map(s => {
      const assetId = editList.sources!.find(src => src.path === s.source)!.sha256;
      const duration = round((s.sourceEnd - s.sourceStart) / s.playbackRate);
      return {
        layerId: s.instanceId!,
        media: { assetId, sourceIn: s.sourceStart, sourceOut: s.sourceEnd, fit: fits.get(s.instanceId!) ?? "contain", muted: true },
        start: round(s.timelineStart),
        end: round(s.timelineStart + duration),
        duration,
        ...(labels.get(s.instanceId!) ? { label: labels.get(s.instanceId!) } : {}),
      };
    });
}

export interface InsertSound {
  layerId: string;
  start: number;
  end: number;
  label?: string;
  caption?: string;
}

/** Sound-only inserts with their timeline span; their captions play as subtitles. */
export function insertSounds(editList: EditListDocument | null, document?: InsertDocument | null): InsertSound[] {
  if (!editList || editList.schemaVersion !== 2 || !document) return [];
  const byInstance = new Map(document.inserts.filter(i => i.picture === false).map(i => [`${INSERT_INSTANCE_PREFIX}${i.id}`, i]));
  return orderedSegments(editList)
    .filter(s => isInsertInstance(s.instanceId) && byInstance.has(s.instanceId!))
    .map(s => {
      const item = byInstance.get(s.instanceId!)!;
      return { layerId: s.instanceId!, start: round(s.timelineStart), end: round(s.timelineStart + (s.sourceEnd - s.sourceStart) / s.playbackRate),
        ...(item.label ? { label: item.label } : {}), ...(item.caption ? { caption: item.caption } : {}) };
    });
}
