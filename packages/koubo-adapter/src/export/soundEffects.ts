import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { soundEffectsFilter, ffmpegFileArg, ffmpegOutputArgs, runWithFfmpegComplexFilterFile, type SoundEffectCue } from '@video-workbench/core';
import { readSoundEffectAsset } from '@video-workbench/core/node';
import { runFfmpeg } from './compose';
export async function mixSoundEffects(input:{source:string;output:string;projectDirectory:string;cues:SoundEffectCue[];duration:number;lossless?:boolean;signal?:AbortSignal}) {
  const active=input.cues.filter(c=>!c.mute);
  const assets=await Promise.all(active.map(c=>readSoundEffectAsset(input.projectDirectory,c.assetId)));
  const dir=await mkdtemp(join(tmpdir(),'videocut-sfx-mix-'));
  try {
    const filter=join(dir,'mix.txt');await writeFile(filter,soundEffectsFilter(input.cues,input.duration));
    await runWithFfmpegComplexFilterFile(filter,args=>runFfmpeg(['-nostdin','-y','-v','error','-i',ffmpegFileArg(input.source),
      ...assets.flatMap(a=>['-i',ffmpegFileArg(a.path)]),...args,'-map','0:v?','-map','[mixed]','-c:v','copy','-ar','48000','-ac','2',
      ...(input.lossless?['-c:a','flac']:['-c:a','aac','-b:a','256k','-use_editlist','1','-movflags','+faststart']),
      ...ffmpegOutputArgs(input.lossless?'matroska':'mp4',input.output)],{signal:input.signal}));
    for(const c of active)await readSoundEffectAsset(input.projectDirectory,c.assetId);
  } finally {await rm(dir,{recursive:true,force:true});}
}
