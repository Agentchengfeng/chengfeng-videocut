import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEditListDocument } from './editList';
import { parseSoundEffects, soundEffectsInvalid, type SoundEffectsDocument } from './soundEffects';
import { mediaSha256, regularMediaPath } from './mediaAssets';
import { assertProjectReadable } from './projectTransaction';
export const SOUND_EFFECT_MAX_BYTES = 64*1024*1024;
export interface SoundEffectAsset { schemaVersion:1; assetId:string; bytes:number; duration:number; codec:string; sampleRate:number; channels:number }
export const soundEffectHash = (raw:string|Buffer) => createHash('sha256').update(raw).digest('hex');
export async function readSoundEffectAsset(directory:string,id:string) {
  if (!/^[a-f0-9]{64}$/.test(id)) soundEffectsInvalid('Invalid sound-effect asset ID');
  const folder=resolve(await realpath(directory),'.chengfeng-videocut','sound-effects',id);
  const file=await regularMediaPath(resolve(folder,'manifest.json'));
  if ((await lstat(file)).size>4096) soundEffectsInvalid('Oversized audio manifest');
  const manifest=JSON.parse(await readFile(file,'utf8')) as SoundEffectAsset;
  if (manifest.schemaVersion!==1 || manifest.assetId!==id || !Number.isSafeInteger(manifest.bytes) || manifest.bytes<=0 || manifest.bytes>SOUND_EFFECT_MAX_BYTES
    || !Number.isFinite(manifest.duration) || manifest.duration<=0 || manifest.duration>600 || !/^pcm_/.test(manifest.codec)
    || !Number.isInteger(manifest.sampleRate) || manifest.sampleRate<8000 || manifest.sampleRate>192000 || ![1,2].includes(manifest.channels)) soundEffectsInvalid('Invalid audio manifest');
  const path=await regularMediaPath(resolve(folder,'source.wav'));
  if ((await lstat(path)).size!==manifest.bytes || await mediaSha256(path,id)!==id) soundEffectsInvalid('Sound-effect asset changed');
  return {manifest,path};
}
export async function soundEffectsContext(directory:string) {
  await assertProjectReadable(directory);
  const root=await realpath(directory);
  const raw=await readFile(await regularMediaPath(resolve(root,'edit-list.json')),'utf8');
  return {editRevision:soundEffectHash(raw),duration:parseEditListDocument(JSON.parse(raw)).duration};
}
export async function readSoundEffects(directory:string, strict=false) {
  const context=await soundEffectsContext(directory);
  const path=resolve(await realpath(directory),'sound-effects.json');
  let raw:string;
  try { const p=await regularMediaPath(path); if((await lstat(p)).size>128*1024) soundEffectsInvalid('Oversized sound-effects document'); raw=await readFile(p,'utf8'); }
  catch(e:any) { if(e.code!=='ENOENT') throw e; return {...context,revision:null,stale:false,document:{schemaVersion:1,editRevision:context.editRevision,cues:[]} as SoundEffectsDocument}; }
  // Stale documents are inspectable even when the new EDL is shorter.
  const document=parseSoundEffects(JSON.parse(raw),strict?context.duration:Number.MAX_VALUE);
  const stale=document.cues.length>0 && document.editRevision!==context.editRevision;
  if(strict && stale) soundEffectsInvalid('Sound effects are stale after an edit-list change; review positions and rebind explicitly');
  if(strict) await validateSoundEffectAssets(directory,document);
  return {...context,revision:soundEffectHash(raw),stale,document};
}
export async function validateSoundEffectAssets(directory:string,document:SoundEffectsDocument) {
  const assets=new Map<string,Awaited<ReturnType<typeof readSoundEffectAsset>>>();
  for (const c of document.cues) {
    let a=assets.get(c.assetId); if(!a) { a=await readSoundEffectAsset(directory,c.assetId); assets.set(c.assetId,a); }
    if(c.sourceOut>a.manifest.duration+1e-6) soundEffectsInvalid('Sound-effect sourceOut exceeds WAV duration');
  }
  return assets;
}
