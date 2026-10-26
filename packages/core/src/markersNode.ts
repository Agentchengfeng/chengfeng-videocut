import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseMarkers, markersInvalid, type MarkersDocument } from './markers';
import { soundEffectHash, soundEffectsContext } from './soundEffectsNode';
import { regularMediaPath } from './mediaAssets';
export const MARKERS_MAX_BYTES = 256 * 1024;
/** Markers stay readable and visible after an edit-list change; `stale` only says positions may have shifted. */
export async function readMarkers(directory: string) {
  const context = await soundEffectsContext(directory);
  const path = resolve(await realpath(directory), 'markers.json');
  let raw: string;
  try { const p = await regularMediaPath(path); if ((await lstat(p)).size > MARKERS_MAX_BYTES) markersInvalid('Oversized markers document'); raw = await readFile(p, 'utf8'); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; return { ...context, revision: null, stale: false, document: { schemaVersion: 1, editRevision: context.editRevision, markers: [] } as MarkersDocument }; }
  const document = parseMarkers(JSON.parse(raw), Number.MAX_VALUE);
  return { ...context, revision: soundEffectHash(raw), stale: document.markers.length > 0 && document.editRevision !== context.editRevision, document };
}
