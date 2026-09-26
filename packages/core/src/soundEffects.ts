import { VideocutError } from './errors';
export interface SoundEffectCue {
  id: string; assetId: string; label: string; start: number; sourceIn: number; sourceOut: number;
  gainDb: number; fadeIn: number; fadeOut: number; mute: boolean;
}
export interface SoundEffectsDocument { schemaVersion: 1; editRevision: string; cues: SoundEffectCue[] }
export function soundEffectsInvalid(message: string): never { throw new VideocutError('invalid_argument', message); }
export function parseSoundEffects(value: unknown, duration: number): SoundEffectsDocument {
  const d = value as SoundEffectsDocument;
  if (!d || d.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(d.editRevision) || !Array.isArray(d.cues) || d.cues.length > 64)
    soundEffectsInvalid('Invalid sound-effects v1 document (maximum 64 cues)');
  const ids = new Set<string>();
  for (const c of d.cues) {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) || ids.has(c.id) || !/^[a-f0-9]{64}$/.test(c.assetId)
      || typeof c.label !== 'string' || c.label.length > 160 || typeof c.mute !== 'boolean') soundEffectsInvalid('Invalid or duplicate sound-effect cue identity');
    ids.add(c.id);
    if (![c.start,c.sourceIn,c.sourceOut,c.gainDb,c.fadeIn,c.fadeOut].every(n => typeof n === 'number' && Number.isFinite(n))
      || c.start < 0 || c.sourceIn < 0 || c.sourceOut <= c.sourceIn || c.sourceOut > 600
      || c.start + c.sourceOut - c.sourceIn > duration + 1e-6 || c.gainDb < -60 || c.gainDb > 12
      || c.fadeIn < 0 || c.fadeOut < 0 || c.fadeIn + c.fadeOut > c.sourceOut - c.sourceIn)
      soundEffectsInvalid('Sound-effect cue exceeds timeline, asset, gain or fade bounds');
  }
  return { schemaVersion: 1, editRevision: d.editRevision, cues: d.cues.map(c => ({id:c.id,assetId:c.assetId,label:c.label,start:c.start,sourceIn:c.sourceIn,sourceOut:c.sourceOut,gainDb:c.gainDb,fadeIn:c.fadeIn,fadeOut:c.fadeOut,mute:c.mute})) };
}
/** One sample-clock mix contract for both preview and export. */
export function soundEffectsFilter(cues: readonly SoundEffectCue[], duration: number): string {
  const active = cues.filter(c => !c.mute);
  const filters = ['[0:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[main]'];
  active.forEach((c,i) => {
    const length=c.sourceOut-c.sourceIn;
    filters.push(`[${i+1}:a:0]aresample=48000,aformat=channel_layouts=stereo,atrim=start_sample=${Math.round(c.sourceIn*48000)}:end_sample=${Math.round(c.sourceOut*48000)},asetpts=PTS-STARTPTS,volume=${c.gainDb}dB`
      +(c.fadeIn>0?`,afade=t=in:st=0:d=${c.fadeIn}`:'')+(c.fadeOut>0?`,afade=t=out:st=${length-c.fadeOut}:d=${c.fadeOut}`:'')
      +`,adelay=${Math.round(c.start*48000)}S:all=1[s${i}]`);
  });
  filters.push('[main]'+active.map((_,i)=>`[s${i}]`).join('')+`amix=inputs=${active.length+1}:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.98:attack=0.1:release=20:level=0:latency=1,atrim=end_sample=${Math.round(duration*48000)}[mixed]`);
  return filters.join(';');
}
