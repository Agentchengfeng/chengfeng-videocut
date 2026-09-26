/** Composition shape is independent of source dimensions and export quality. */
export const CANVAS_ASPECT_PRESETS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export function parseCanvasAspect(value: unknown): { w: number; h: number } | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const match = /^(\d+)[:：](\d+)$/.exec(value.trim());
  if (!match) return null;
  const w = Number(match[1]), h = Number(match[2]);
  if (![w, h].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000)) return null;
  if (Math.max(w, h) / Math.min(w, h) > 8192 / 1080) return null;
  return { w, h };
}
export function canvasDimensions(value: unknown): { width: number; height: number } {
  const aspect = parseCanvasAspect(value);
  if (!aspect) throw new Error("Canvas aspect must be a bounded positive W:H ratio");
  const scale = 1080 / Math.min(aspect.w, aspect.h);
  return { width: Math.round(aspect.w * scale / 2) * 2, height: Math.round(aspect.h * scale / 2) * 2 };
}
