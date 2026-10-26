import { VideocutError } from './errors';
/** A note pinned to the assembled timeline. Annotation only: never mixed, rendered or exported into the film. */
export interface TimelineMarker { id: string; start: number; duration: number; label: string; note?: string }
export interface MarkersDocument { schemaVersion: 1; editRevision: string; markers: TimelineMarker[] }
export const MAX_MARKERS = 500;
export function markersInvalid(message: string): never { throw new VideocutError('invalid_argument', message); }
export function parseMarkers(value: unknown, duration: number): MarkersDocument {
  const d = value as MarkersDocument;
  if (!d || d.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(d.editRevision) || !Array.isArray(d.markers) || d.markers.length > MAX_MARKERS)
    markersInvalid(`Invalid markers v1 document (maximum ${MAX_MARKERS} markers)`);
  const ids = new Set<string>();
  for (const m of d.markers) {
    if (!m || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(m.id) || ids.has(m.id)
      || typeof m.label !== 'string' || !m.label.trim() || m.label.length > 80
      || (m.note !== undefined && (typeof m.note !== 'string' || m.note.length > 500))) markersInvalid('Invalid or duplicate marker identity, label or note');
    ids.add(m.id);
    if (![m.start, m.duration].every(n => typeof n === 'number' && Number.isFinite(n)) || m.start < 0 || m.duration < 0 || m.start + m.duration > duration + 1e-6)
      markersInvalid('Marker exceeds the timeline');
  }
  // Stored in time order so the file reads the way the timeline does.
  const markers = d.markers.map(m => ({ id: m.id, start: m.start, duration: m.duration, label: m.label, ...(m.note ? { note: m.note } : {}) }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  return { schemaVersion: 1, editRevision: d.editRevision, markers };
}
