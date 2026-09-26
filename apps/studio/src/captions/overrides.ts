import type { CaptionStyle } from "./types";
export interface CaptionOverrideEntry {
  wordId?: string; wordIndex: number; text?: string; start?: number; end?: number;
  sourcePath?: string; sourceVersion?: string;
  x?: number; y?: number; scale?: number; rotation?: number; activeColor?: string; dimColor?: string;
  opacity?: number; fontSize?: number; fontWeight?: number; fontFamily?: string;
}
const numbers = ["x", "y", "scale", "rotation", "opacity", "fontSize", "fontWeight"] as const;
const strings = ["text", "activeColor", "dimColor", "fontFamily"] as const;
export function parseCaptionOverrides(value: unknown): CaptionOverrideEntry[] {
  if (!Array.isArray(value)) throw new Error("字幕覆盖文件必须是数组");
  const seen = new Set<string>();
  return value.map(raw => {
    if (!raw || typeof raw !== "object" || !Number.isInteger(raw.wordIndex) || raw.wordIndex < 0) throw new Error("字幕词索引无效");
    const entry: CaptionOverrideEntry = { wordIndex: raw.wordIndex };
    if (raw.sourcePath !== undefined || raw.sourceVersion !== undefined) {
      if (typeof raw.sourcePath !== "string" || !raw.sourcePath || typeof raw.sourceVersion !== "string" || !/^"sha256:[a-f0-9]{64}"$/.test(raw.sourceVersion)) throw new Error("字幕源绑定无效");
      entry.sourcePath = raw.sourcePath; entry.sourceVersion = raw.sourceVersion;
    }
    if (raw.wordId !== undefined) {
      if (typeof raw.wordId !== "string" || !raw.wordId) throw new Error("字幕词ID无效");
      entry.wordId = raw.wordId;
    }
    const key = entry.wordId ?? `index:${entry.wordIndex}`;
    if (seen.has(key)) throw new Error("字幕词ID重复"); seen.add(key);
    for (const field of numbers) if (raw[field] !== undefined) {
      if (typeof raw[field] !== "number" || !Number.isFinite(raw[field])) throw new Error(`字幕样式${field}无效`);
      entry[field] = raw[field];
    }
    for (const field of strings) if (raw[field] !== undefined) {
      if (typeof raw[field] !== "string") throw new Error(`字幕${field}无效`);
      entry[field] = raw[field];
    }
    if (raw.start !== undefined || raw.end !== undefined) {
      if (typeof raw.start !== "number" || typeof raw.end !== "number" || !Number.isFinite(raw.start) || !Number.isFinite(raw.end)
        || raw.start < 0 || raw.end <= raw.start) throw new Error("字幕时间必须是有限且递增的区间");
      entry.start = raw.start; entry.end = raw.end;
    }
    return entry;
  });
}
interface Segment { wordId?: string; text: string; start: number; end: number; style: Partial<CaptionStyle> }
interface Model<S extends Segment> { groupOrder: string[]; groups: Map<string, { segmentIds: string[] }>; segments: Map<string, S> }
export function buildCaptionOverrides<S extends Segment>(model: Model<S>): CaptionOverrideEntry[] {
  const entries: CaptionOverrideEntry[] = [];
  for (const groupId of model.groupOrder) for (const id of model.groups.get(groupId)?.segmentIds ?? []) {
    const seg = model.segments.get(id); if (!seg) throw new Error("字幕词缺失");
    const entry: CaptionOverrideEntry = { wordIndex: entries.length, ...(seg.wordId ? { wordId: seg.wordId } : {}), text: seg.text, start: seg.start, end: seg.end };
    for (const field of [...numbers, "activeColor", "dimColor", "fontFamily"] as const) {
      const value = field === "scale" ? seg.style.scaleX : seg.style[field];
      if (value !== undefined) Object.assign(entry, { [field]: value });
    }
    entries.push(entry);
  }
  return parseCaptionOverrides(entries);
}
export function applyCaptionOverrides<S extends Segment>(model: Model<S>, input: CaptionOverrideEntry[]): Map<string, S> {
  const entries = parseCaptionOverrides(input);
  const ids = model.groupOrder.flatMap(id => model.groups.get(id)?.segmentIds ?? []);
  const byWord = new Map(ids.flatMap(id => { const word = model.segments.get(id)?.wordId; return word ? [[word, id] as const] : []; }));
  const segments = new Map(model.segments);
  for (const entry of entries) {
    const id = entry.wordId ? byWord.get(entry.wordId) : ids[entry.wordIndex];
    if (!id) continue;
    const seg = segments.get(id); if (!seg) continue;
    const style = { ...seg.style };
    for (const field of [...numbers, "activeColor", "dimColor", "fontFamily"] as const) {
      if (entry[field] === undefined) continue;
      if (field === "scale") { style.scaleX = entry.scale; style.scaleY = entry.scale; }
      else Object.assign(style, { [field]: entry[field] });
    }
    segments.set(id, { ...seg, ...(entry.text !== undefined ? { text: entry.text } : {}), ...(entry.start !== undefined ? { start: entry.start, end: entry.end! } : {}), style });
  }
  return segments;
}
