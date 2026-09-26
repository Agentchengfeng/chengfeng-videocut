import { CaptionSourceError, readTranscriptLiteral } from "./transcriptLiteral";
// Caption Parser — Extract Transcript & Build Caption Model
// Parses a caption composition's JavaScript source to extract the transcript word array,
// and builds a CaptionModel from a TranscriptWord array.

import {
  CaptionModel,
  CaptionSegment,
  CaptionGroup,
  CaptionStyle,
  CaptionContainerStyle,
  DEFAULT_STYLE,
  DEFAULT_CONTAINER,
  DEFAULT_ANIMATION_SET,
} from "./types";

export interface TranscriptWord {
  id?: string;
  text: string;
  start: number;
  end: number;
}

export interface BuildOptions {
  width: number;
  height: number;
  duration: number;
  wordsPerGroup?: number; // default 5
}

/**
 * Builds a CaptionModel from a transcript word array and composition dimensions.
 *
 * Words are grouped into chunks of `wordsPerGroup` (default 5). Each word becomes a
 * CaptionSegment with its original timing. Each chunk becomes a CaptionGroup with
 * DEFAULT_STYLE, DEFAULT_ANIMATION_SET, and DEFAULT_CONTAINER.
 */
export function buildCaptionModel(
  transcript: TranscriptWord[],
  options: BuildOptions,
): CaptionModel {
  const { width, height, duration, wordsPerGroup = 5 } = options;

  const segments = new Map<string, CaptionSegment>();
  const groups = new Map<string, CaptionGroup>();
  const groupOrder: string[] = [];

  // Chunk the transcript into groups of wordsPerGroup
  for (let groupIdx = 0; groupIdx < transcript.length; groupIdx += wordsPerGroup) {
    const chunk = transcript.slice(groupIdx, groupIdx + wordsPerGroup);
    const groupId = `group-${groupIdx / wordsPerGroup}`;
    const segmentIds: string[] = [];

    chunk.forEach((word, wordIdx) => {
      const segmentId = `segment-${groupIdx + wordIdx}`;
      const segment: CaptionSegment = {
        id: segmentId,
        wordId: word.id ?? `w${groupIdx + wordIdx}`,
        text: word.text,
        start: word.start,
        end: word.end,
        groupIndex: wordIdx,
        style: {},
        animation: {},
      };
      segments.set(segmentId, segment);
      segmentIds.push(segmentId);
    });

    const group: CaptionGroup = {
      id: groupId,
      segmentIds,
      style: { ...DEFAULT_STYLE },
      animation: {
        entrance: { ...DEFAULT_ANIMATION_SET.entrance },
        highlight: DEFAULT_ANIMATION_SET.highlight,
        exit: { ...DEFAULT_ANIMATION_SET.exit },
      },
      containerStyle: { ...DEFAULT_CONTAINER },
    };
    groups.set(groupId, group);
    groupOrder.push(groupId);
  }

  return {
    width,
    height,
    duration,
    segments,
    groups,
    groupOrder,
    defaultAnimation: {
      entrance: { ...DEFAULT_ANIMATION_SET.entrance },
      highlight: DEFAULT_ANIMATION_SET.highlight,
      exit: { ...DEFAULT_ANIMATION_SET.exit },
    },
  };
}


/** Read only a unique, data-only declaration. Unsupported JavaScript is rejected. */
export function extractTranscript(source: string, onReject?: (reason: string) => void): TranscriptWord[] {
  const reject = (reason: string): TranscriptWord[] => { onReject?.(reason); return []; };
  try {
    const parsed = readTranscriptLiteral(source);
    if (!Array.isArray(parsed)) return reject("SOURCE_NOT_ARRAY");
    const ids = new Set<string>();
    for (const entry of parsed) {
      if (!entry || typeof entry.text !== "string" || !Number.isFinite(entry.start) || !Number.isFinite(entry.end)
        || entry.start < 0 || entry.end <= entry.start) return reject("SOURCE_WORD_TEXT_OR_TIME_INVALID");
      if (entry.id !== undefined) {
        if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) return reject("SOURCE_WORD_ID_INVALID_OR_DUPLICATE");
        ids.add(entry.id);
      }
    }
    return parsed.map(({ id, text, start, end }) => ({ ...(id !== undefined ? { id } : {}), text, start, end }));
  } catch (error) { return reject(error instanceof CaptionSourceError ? error.message : "SOURCE_PARSE_FAILED"); }
}

const GROUP_SELECTOR = ".caption-group, .caption-line, .caption-block";
const WORD_SELECTOR = ".word, .caption-word";

/** The caller must provide the uniquely resolved composition DOM scope. */
export function parseCaptionComposition(
  iframeDoc: Document | Element,
  iframeWin: Window,
  source: string,
  compositionWidth: number,
  compositionHeight: number,
  compositionDuration: number,
  onReject?: (reason: string) => void,
): CaptionModel | null {
  const reject = (reason: string): null => { onReject?.(reason); return null; };
  let sourceReason: string | undefined;
  const transcript = extractTranscript(source, reason => { sourceReason = reason; });
  if (!transcript.length) return reject(sourceReason ?? "SOURCE_EMPTY_TRANSCRIPT");
  if (![compositionWidth, compositionHeight, compositionDuration].every(value => Number.isFinite(value) && value > 0)) return reject(`DOM_METADATA_INVALID(width=${compositionWidth},height=${compositionHeight},duration=${compositionDuration})`);
  const groups = [...iframeDoc.querySelectorAll<HTMLElement>(GROUP_SELECTOR)];
  const words = [...iframeDoc.querySelectorAll<HTMLElement>(WORD_SELECTOR)];
  if (!groups.length || words.length !== transcript.length) return reject(`DOM_COUNT_MISMATCH(groups=${groups.length},words=${words.length},source=${transcript.length})`);
  if (groups.some(group => group.parentElement?.closest(GROUP_SELECTOR))) return reject("DOM_NESTED_GROUP");
  if (words.some(word => !groups.includes(word.closest(GROUP_SELECTOR) as HTMLElement))) return reject("DOM_ORPHAN_WORD");

  const domIds = words.map(word => word.getAttribute("data-word-id") ?? word.id);
  if (words.some(word => word.hasAttribute("data-word-id") && word.id && word.dataset.wordId !== word.id)) return reject("DOM_ID_ATTRIBUTES_CONFLICT");
  const hasIds = domIds.some(Boolean);
  const sourceHasIds = transcript.some(word => word.id !== undefined);
  if (sourceHasIds && transcript.some(word => !word.id)) return reject("SOURCE_PARTIAL_WORD_IDS");
  let mapped: TranscriptWord[];
  if (hasIds) {
    if (domIds.some(id => !id) || new Set(domIds).size !== words.length
      || !sourceHasIds || transcript.some(word => !word.id)) return reject("DOM_OR_SOURCE_IDS_MISSING_OR_DUPLICATE");
    const byId = new Map(transcript.map(word => [word.id, word]));
    if (domIds.some(id => !byId.has(id))) return reject("DOM_WORD_ID_NOT_IN_SOURCE");
    mapped = domIds.map(id => byId.get(id)!);
    // Existing index-based overlay controls require source order to agree with DOM.
    if (mapped.some((word, index) => word !== transcript[index])) return reject("DOM_WORD_ORDER_MISMATCH");
  } else {
    // Legacy DOM is accepted only with exact text + timing correspondence, not count alone.
    if (words.some((word, index) => word.textContent !== transcript[index].text
      || !word.hasAttribute("data-start") || !word.hasAttribute("data-end")
      || Number(word.dataset.start) !== transcript[index].start
      || Number(word.dataset.end) !== transcript[index].end)) return reject("DOM_LEGACY_TEXT_OR_TIME_MISMATCH");
    mapped = transcript;
  }
  if (words.some((word, index) => word.textContent !== mapped[index].text)) return reject("DOM_WORD_TEXT_MISMATCH");
  // HyperFrames runtime rebind stamps un-timed [id] elements with a full-root
  // placeholder range. This is not authored transcript timing. Only exempt the
  // exact marker/range shape after stable-ID mapping; legacy index mapping above
  // still requires genuine, matching start/end attributes.
  const isRuntimeAutoStamp = (word: HTMLElement) => hasIds && word.dataset.hfAutostamped === "1"
    && word.getAttribute("data-start") === "0" && Number(word.dataset.duration) === compositionDuration
    && !word.hasAttribute("data-end");
  if (words.some((word, index) => (word.hasAttribute("data-start") && !isRuntimeAutoStamp(word) && Number(word.dataset.start) !== mapped[index].start)
    || (word.hasAttribute("data-end") && Number(word.dataset.end) !== mapped[index].end))) return reject("DOM_WORD_TIME_MISMATCH");
  const model = buildCaptionModel(mapped, { width: compositionWidth, height: compositionHeight, duration: compositionDuration });
  model.groups.clear(); model.groupOrder = [];
  let offset = 0;
  for (const [groupIndex, element] of groups.entries()) {
    const groupWords = [...element.querySelectorAll<HTMLElement>(WORD_SELECTOR)];
    if (!groupWords.length || groupWords.some((word, i) => word !== words[offset + i])) return reject("DOM_GROUP_WORD_ORDER_MISMATCH");
    const id = `group-${groupIndex}`;
    const segmentIds = groupWords.map((word, index) => {
      const segmentId = `segment-${offset + index}`;
      const segment = model.segments.get(segmentId)!;
      segment.groupIndex = index;
      segment.style = readStyle(iframeWin.getComputedStyle(word));
      return segmentId;
    });
    const computed = iframeWin.getComputedStyle(element);
    const container = { ...DEFAULT_CONTAINER };
    for (const key of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderRadius"] as const) {
      const value = parseFloat(computed[key]); if (Number.isFinite(value)) container[key] = value;
    }
    if (computed.backgroundColor && computed.backgroundColor !== "transparent" && computed.backgroundColor !== "rgba(0, 0, 0, 0)") {
      container.backgroundColor = computed.backgroundColor; container.backgroundOpacity = 1;
    }
    model.groups.set(id, {
      id, segmentIds, style: { ...DEFAULT_STYLE, ...readStyle(computed) }, containerStyle: container,
      animation: { ...DEFAULT_ANIMATION_SET },
    });
    model.groupOrder.push(id); offset += groupWords.length;
  }
  return offset === words.length ? model : reject("DOM_GROUP_COVERAGE_MISMATCH");
}

function readStyle(computed: CSSStyleDeclaration): Partial<CaptionStyle> {
  const style: Partial<CaptionStyle> = {};
  const fontSize = parseFloat(computed.fontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) style.fontSize = fontSize;
  if (computed.fontWeight) {
    const weight = Number(computed.fontWeight);
    if (Number.isFinite(weight)) style.fontWeight = weight;
    else if (computed.fontWeight === "normal") style.fontWeight = 400;
    else if (computed.fontWeight === "bold") style.fontWeight = 700;
  }
  if (computed.fontFamily) style.fontFamily = computed.fontFamily;
  if (computed.color) style.color = computed.color;
  const textTransform = computed.textTransform as CaptionStyle["textTransform"];
  if (["none", "uppercase", "lowercase", "capitalize"].includes(textTransform)) style.textTransform = textTransform;
  const spacing = parseFloat(computed.letterSpacing);
  if (Number.isFinite(spacing) && fontSize > 0) style.letterSpacing = spacing / fontSize;
  return style;
}
