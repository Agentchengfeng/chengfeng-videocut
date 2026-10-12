import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSoundEffectsApi } from './sound-effects-api';
import { parseSoundEffects, soundEffectsFilter, type SoundEffectCue } from '@video-workbench/core';
import { soundEffectHash, readSoundEffects, resolveProject } from '@video-workbench/core/node';
import { mixSoundEffects, probeMedia } from '@video-workbench/koubo-adapter';
import { createExportSnapshot, exportInputFingerprint } from '../jobs/runners';
import { executeExport } from '../export-command';
function wav(seconds:number,frequency:number,amplitude=.12) {
 const rate=48000,n=Math.round(seconds*rate),b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++)b.writeInt16LE(Math.round(32767*amplitude*Math.sin(i*2*Math.PI*frequency/rate)),44+i*2);return b;
}
async function fixture(options:Parameters<typeof createSoundEffectsApi>[2]={}) {
 const root=await mkdtemp(join(tmpdir(),'sfx-contract-')),registry=join(root,'projects'),project=join(registry,'demo');await mkdir(join(project,'input'),{recursive:true});
 const source=wav(3,440);await writeFile(join(project,'input/source.wav'),source);
 const edit={schemaVersion:1,projectId:'demo',baseCutsRevision:'a'.repeat(64),baseTranscriptRevision:'b'.repeat(64),mode:'manual',sourceDuration:3,duration:3,segments:[{id:'one',source:'input/source.wav',sourceStart:0,sourceEnd:3,timelineStart:0,trackId:'a-roll',playbackRate:1}]};
 await writeFile(join(project,'edit-list.json'),JSON.stringify(edit));await writeFile(join(project,'project.json'),JSON.stringify({jobId:'demo',status:'cut_review_ready',inputVideo:'input/source.wav',config:{aspectRatio:'4:3'}}));
 const api=createSoundEffectsApi(registry,1234,options);
 const call=async(method:string,path='',value?:unknown,raw=false)=>{const response=await api(new Request(`http://127.0.0.1:1234/api/v1/projects/demo/sound-effects${path}`,{method,headers:{host:'127.0.0.1:1234','content-type':raw?'audio/wav':'application/json'},...(value?{body:raw?new Uint8Array(value as Buffer):JSON.stringify(value)}:{})}),'127.0.0.1');return {status:response!.status,body:await response!.json()};};
 return {root,project,registry,edit,call};
}
const cue=(id:string,assetId:string):SoundEffectCue=>({id,assetId,label:'click.wav',start:1,sourceIn:0,sourceOut:.5,gainDb:-6,fadeIn:.01,fadeOut:.02,mute:false});
test('SFX contract: finite values, unique IDs, bounded cues, envelope validation',()=>{
 const d={schemaVersion:1,editRevision:'a'.repeat(64),cues:[cue('cue','b'.repeat(64))]};expect(parseSoundEffects(d,3).cues).toHaveLength(1);
 for(const patch of [{start:NaN},{gainDb:Infinity},{fadeOut:1},{sourceIn:-1},{start:2.9}])expect(()=>parseSoundEffects({...d,cues:[{...d.cues[0],...patch}]},3)).toThrow();
 expect(()=>parseSoundEffects({...d,cues:[d.cues[0],d.cues[0]]},3)).toThrow();expect(soundEffectsFilter(d.cues,3)).toContain('level=0:latency=1');
});
test('SFX contract: optional display track is kept, bounded and absent on legacy cues',()=>{
 const base={schemaVersion:1,editRevision:'a'.repeat(64),cues:[cue('cue','b'.repeat(64))]};
 expect('track' in parseSoundEffects(base,3).cues[0]!).toBe(false);
 expect(parseSoundEffects({...base,cues:[{...base.cues[0],track:2}]},3).cues[0]!.track).toBe(2);
 for(const track of [-1,1.5,64,'1',null])expect(()=>parseSoundEffects({...base,cues:[{...base.cues[0],track}]},3)).toThrow();
});
test('SFX real API: upload, CAS, move/fades/mute/delete, stale EDL, missing asset and symlinks fail closed',async()=>{
 const f=await fixture();try{
  const initial=await f.call('GET');expect(initial.status).toBe(200);expect(initial.body.revision).toBeNull();
  const asset=await f.call('POST','/assets',wav(.5,1800),true);expect(asset.status).toBe(200);
  const doc={schemaVersion:1,editRevision:initial.body.editRevision,cues:[cue('first',asset.body.manifest.assetId)]};
  const payload={confirmed:true,expectedRevision:null,expectedEditRevision:initial.body.editRevision,document:doc};
  const saved=await f.call('PUT','',payload);expect(saved.status).toBe(200);const before=await readFile(join(f.project,'sound-effects.json'));
  expect((await f.call('PUT','',payload)).status).toBe(409);expect(await readFile(join(f.project,'sound-effects.json'))).toEqual(before);
  expect((await f.call('PUT','',{...payload,expectedRevision:saved.body.revision,document:{...doc,cues:[cue('missing','f'.repeat(64))]}})).status).toBe(400);expect(await readFile(join(f.project,'sound-effects.json'))).toEqual(before);
  const moved=await f.call('PUT','',{...payload,expectedRevision:saved.body.revision,document:{...doc,cues:[{...doc.cues[0],start:2,gainDb:-20,fadeIn:.1,fadeOut:.1,mute:true}]}});expect(moved.status).toBe(200);
  expect((await f.call('GET')).body.document.cues[0]).toMatchObject({start:2,gainDb:-20,mute:true});
  await writeFile(join(f.project,'edit-list.json'),JSON.stringify(f.edit,null,2));
  expect((await f.call('GET')).body.stale).toBe(true);await expect(readSoundEffects(f.project,true)).rejects.toThrow('stale');
  expect((await f.call('PUT','',{...payload,expectedRevision:moved.body.revision})).status).toBe(409);
  const current=(await f.call('GET')).body;
  const rebound=await f.call('PUT','',{...payload,expectedRevision:current.revision,expectedEditRevision:current.editRevision,document:{...doc,editRevision:current.editRevision}});expect(rebound.status).toBe(200);
  const deleted=await f.call('PUT','',{...payload,expectedRevision:rebound.body.revision,expectedEditRevision:current.editRevision,document:{...doc,editRevision:current.editRevision,cues:[]}});expect(deleted.status).toBe(200);expect(deleted.body.document.cues).toHaveLength(0);
  const outside=join(f.root,'outside.wav');await writeFile(outside,wav(.5,440));const link=join(f.root,'link.wav');await symlink(outside,link);
  expect((await f.call('POST','/assets',{sourcePath:link,expectedSourceSha256:soundEffectHash(await readFile(outside)),confirmed:true})).status).toBe(400);
  expect((await f.call('POST','/assets',Buffer.from('not wav'),true)).status).toBe(400);
 }finally{await rm(f.root,{recursive:true,force:true});}
},30000);
async function pcm(path:string) {const p=Bun.spawn(['ffmpeg','-v','error','-i',path,'-f','f32le','-ac','1','-ar','48000','pipe:1'],{stdout:'pipe',stderr:'pipe'});const b=await new Response(p.stdout).arrayBuffer();expect(await p.exited).toBe(0);return new Float32Array(b);}
function amplitude(a:Float32Array,start:number,end:number,freq:number){let sin=0,cos=0;const from=Math.round(start*48000),to=Math.round(end*48000);for(let i=from;i<to;i++){sin+=a[i]!*Math.sin(i*2*Math.PI*freq/48000);cos+=a[i]!*Math.cos(i*2*Math.PI*freq/48000);}return Math.hypot(sin,cos)*2/(to-from);}
test('SFX real preview/export mix, frozen asset snapshot, exact duration and unchanged speech level',async()=>{
 const f=await fixture();try{
  const initial=(await f.call('GET')).body,asset=(await f.call('POST','/assets',wav(.5,1800,.2),true)).body.manifest;
  const c=cue('click',asset.assetId),doc={schemaVersion:1,editRevision:initial.editRevision,cues:[c]};
  expect((await f.call('PUT','',{confirmed:true,expectedRevision:null,expectedEditRevision:initial.editRevision,document:doc})).status).toBe(200);
  const before=await exportInputFingerprint(f.project),snapshot=join(f.root,'snapshot');await createExportSnapshot(f.project,snapshot);expect(await exportInputFingerprint(snapshot)).toBe(before);
  const preview=join(f.root,'preview.mp4');await mixSoundEffects({source:join(f.project,'input/source.wav'),output:preview,projectDirectory:f.project,cues:[c],duration:3});
  expect((await probeMedia(preview)).duration).toBeCloseTo(3,3);const samples=await pcm(preview);
  expect(amplitude(samples,.2,.8,440)).toBeCloseTo(.12,2);expect(amplitude(samples,.2,.8,1800)).toBeLessThan(.002);expect(amplitude(samples,1.1,1.4,1800)).toBeGreaterThan(.09);expect(amplitude(samples,1.1,1.4,440)).toBeCloseTo(.12,2);expect(amplitude(samples,2,2.7,1800)).toBeLessThan(.002);
  // Live edits cannot alter the worker's frozen cue or WAV.
  await rm(join(f.project,'.chengfeng-videocut/sound-effects'),{recursive:true,force:true});
  const film=join(f.root,'film.mp4');const result=await executeExport({project:await resolveProject(snapshot),assetProjectDirectory:f.project,sourcePathOverride:join(f.project,'input/source.wav'),outputPath:film,workDirectory:join(f.root,'export-work'),scale:.2,profile:'fast'});
  expect(result.soundEffectCues).toBe(1);expect(result.problems).toEqual([]);const filmPcm=await pcm(film);expect(amplitude(filmPcm,1.1,1.4,1800)).toBeGreaterThan(.085);expect(amplitude(filmPcm,.2,.8,1800)).toBeLessThan(.003);
 }finally{await rm(f.root,{recursive:true,force:true});}
},60000);

test('SFX EDL shortening: inspect out-of-bounds old cues, explicit adjusted rebind recovers',async()=>{
 const f=await fixture();try {
  const initial=(await f.call('GET')).body,asset=(await f.call('POST','/assets',wav(.5,1000),true)).body.manifest;
  const c={...cue('late',asset.assetId),start:2};
  const saved=await f.call('PUT','',{confirmed:true,expectedRevision:null,expectedEditRevision:initial.editRevision,document:{schemaVersion:1,editRevision:initial.editRevision,cues:[c]}});
  await writeFile(join(f.project,'edit-list.json'),JSON.stringify({...f.edit,duration:1,segments:[{...f.edit.segments[0],sourceEnd:1}]}));
  const stale=(await f.call('GET')).body;expect(stale.stale).toBe(true);expect(stale.document.cues[0].start).toBe(2);
  const request={confirmed:true,expectedRevision:saved.body.revision,expectedEditRevision:stale.editRevision,document:{schemaVersion:1,editRevision:stale.editRevision,cues:[c]}};
  expect((await f.call('PUT','',request)).status).toBe(400);
  const fixed=await f.call('PUT','',{...request,document:{...request.document,cues:[{...c,start:.25}]}});expect(fixed.status).toBe(200);expect(fixed.body.stale).toBe(false);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('SFX async busy guard awaits false; true rejects without document writes',async()=>{
 let busy=false;const f=await fixture({isBusy:async()=>busy});try {
  const s=(await f.call('GET')).body,b={confirmed:true,expectedRevision:null,expectedEditRevision:s.editRevision,document:s.document};
  busy=true;expect((await f.call('PUT','',b)).status).toBe(409);expect(await Bun.file(join(f.project,'sound-effects.json')).exists()).toBe(false);
  busy=false;expect((await f.call('PUT','',b)).status).toBe(200);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('Legacy export fingerprint stays identical without sound-effects.json',async()=>{
 const f=await fixture();try{
  const {createHash}=await import('node:crypto');const hash=createHash('sha256');
  for(const name of ['project.json','edit-list.json','transcript.json','subtitles.json','visuals.json']){hash.update(`${name}\0`);try{hash.update(await readFile(join(f.project,name)));}catch(e:any){if(e.code!=='ENOENT')throw e;hash.update('<missing>');}hash.update('\0');}
  expect(await exportInputFingerprint(f.project)).toBe(hash.digest('hex'));
 }finally{await rm(f.root,{recursive:true,force:true});}
});
