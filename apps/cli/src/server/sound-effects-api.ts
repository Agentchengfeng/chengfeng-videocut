import { probePcmWav } from "@video-workbench/koubo-adapter";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { parseSoundEffects, soundEffectsInvalid, VideocutError } from '@video-workbench/core';
import { atomicWriteJson, resolveProject, serializeProjectOperation, readSoundEffects, validateSoundEffectAssets,
  readSoundEffectAsset, soundEffectHash, SOUND_EFFECT_MAX_BYTES, regularMediaPath, mediaSha256, type SoundEffectAsset } from '@video-workbench/core/node';
import { isLoopbackAddress, trustedLoopbackOrigin } from './jobs-api';
import { parseMediaRange } from './project-media';
async function body(request:Request,max:number) {
  const reader=request.body?.getReader(); if(!reader) soundEffectsInvalid('Body required');
  const chunks:Uint8Array[]=[]; let size=0,expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel();},30000);
  try { for(;;) { const r=await reader.read(); if(expired) soundEffectsInvalid('Upload timed out'); if(r.done) break;
    size+=r.value.length; if(size>max) {await reader.cancel();soundEffectsInvalid('Upload exceeds size limit');} chunks.push(r.value); }
    return Buffer.concat(chunks);
  } finally {clearTimeout(timer);reader.releaseLock();}
}
async function assetParent(root:string) {
  let p=await realpath(root);
  for(const name of ['.chengfeng-videocut','sound-effects']) { p=resolve(p,name); await mkdir(p).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const s=await lstat(p); if(!s.isDirectory()||s.isSymbolicLink())soundEffectsInvalid('Unsafe audio asset parent'); }
  return p;
}
export async function importSoundEffect(root:string,input:{bytes?:Buffer;sourcePath?:string;expectedSourceSha256?:string}) {
  const parent=await assetParent(root), staging=await mkdtemp(resolve(parent,'.import-'));
  try {
    const target=resolve(staging,'source.wav');
    if(input.sourcePath) {
      if(extname(input.sourcePath).toLowerCase()!=='.wav'|| !/^[a-f0-9]{64}$/.test(input.expectedSourceSha256??''))soundEffectsInvalid('WAV path and SHA256 required');
      const source=await regularMediaPath(input.sourcePath);
      if((await lstat(source)).size>SOUND_EFFECT_MAX_BYTES) soundEffectsInvalid('WAV exceeds 64MiB');
      await mediaSha256(source,input.expectedSourceSha256); await copyFile(source,target);
      await mediaSha256(source,input.expectedSourceSha256);
    } else { if(!input.bytes?.length || input.bytes.length>SOUND_EFFECT_MAX_BYTES)soundEffectsInvalid('Invalid WAV upload'); await writeFile(target,input.bytes,{flag:'wx'}); }
    const assetId=await mediaSha256(target,input.expectedSourceSha256);
    const probe=await probePcmWav(target);
    const manifest:SoundEffectAsset={schemaVersion:1,assetId,bytes:(await lstat(target)).size,...probe};
    await writeFile(resolve(staging,'manifest.json'),JSON.stringify(manifest),{flag:'wx'});
    // Validate staged facts before publishing, with the same limits as readback.
    if(!(manifest.duration>0&&manifest.duration<=600)||manifest.sampleRate<8000||manifest.sampleRate>192000||![1,2].includes(manifest.channels))soundEffectsInvalid('WAV must be mono/stereo, 8..192kHz, up to 10 minutes');
    const folder=resolve(parent,assetId);
    let exists=false; try {await lstat(folder);exists=true;} catch(e:any){if(e.code!=='ENOENT')throw e;}
    if(!exists) await rename(staging,folder);
    return (await readSoundEffectAsset(root,assetId)).manifest;
  } finally {await rm(staging,{recursive:true,force:true});}
}
export function createSoundEffectsApi(projectsDir:string,port:number,options:{isBusy?:(root:string)=>boolean|Promise<boolean>;onChanged?:(id:string)=>void}={}) {
 return async(request:Request,client?:string):Promise<Response|null>=>{
  const url=new URL(request.url),m=/^\/api\/v1\/projects\/([^/]+)\/sound-effects(?:\/(assets)(?:\/([a-f0-9]{64})(\/content)?)?)?$/.exec(url.pathname);
  if(!m)return null;
  const origin=trustedLoopbackOrigin(request.headers.get('host'),port);
  if(!client||!isLoopbackAddress(client)||!origin||url.origin!==origin||(request.headers.has('origin')&&request.headers.get('origin')!==origin))return Response.json({error:{code:'origin_forbidden'}},{status:403});
  try {
   const id=decodeURIComponent(m[1]!);if(!id||id==='.'||id==='..'||/[\\/\0]/.test(id))soundEffectsInvalid('Invalid project');
   const project=await resolveProject(resolve(projectsDir,id)),root=project.directory;
   if(m[3]&&['GET','HEAD'].includes(request.method)) {
     const {manifest,path}=await readSoundEffectAsset(root,m[3]);
     if(!m[4]) return Response.json({schemaVersion:1,projectId:id,manifest},{headers:{"Cache-Control":"no-store"}});
     const rangeValue=request.headers.get('range'),range=rangeValue?parseMediaRange(rangeValue,manifest.bytes):null;
     const headers:Record<string,string>={'Content-Type':'audio/wav','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
     if(rangeValue&&!range)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${manifest.bytes}`}});
     headers['Content-Length']=String(range?range.end-range.start+1:manifest.bytes);if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${manifest.bytes}`;
     return new Response(request.method==='HEAD'?null:range?Bun.file(path).slice(range.start,range.end+1):Bun.file(path),{status:range?206:200,headers});
   }
   if(m[2]&&!m[3]&&request.method==='POST') {
     const isJson=request.headers.get('content-type')?.startsWith('application/json');
     const bytes=await body(request,isJson?16384:SOUND_EFFECT_MAX_BYTES);
     const input=isJson?JSON.parse(bytes.toString()):{bytes};
     if(isJson&&input.confirmed!==true)soundEffectsInvalid('Confirmed local import required');
     const manifest=await serializeProjectOperation(root,async()=>{await readSoundEffects(root);return importSoundEffect(root,input);});
     return Response.json({schemaVersion:1,projectId:id,manifest},{headers:{'Cache-Control':'no-store'}});
   }
   if(!m[2]&&request.method==='GET')return Response.json({schemaVersion:1,projectId:id,...await readSoundEffects(root)},{headers:{'Cache-Control':'no-store'}});
   if(!m[2]&&request.method==='PUT') {
     const b=JSON.parse((await body(request,128*1024)).toString());
     if(b.confirmed!==true||!Object.hasOwn(b,'expectedRevision'))soundEffectsInvalid('Confirmed CAS write required');
     const result=await serializeProjectOperation(root,async()=>{
       if(await options.isBusy?.(root))throw new VideocutError("project_busy","Export is using this project; retry after it finishes");
       const current=await readSoundEffects(root);
       if(current.revision!==b.expectedRevision||current.editRevision!==b.expectedEditRevision)throw new VideocutError('revision_conflict','Sound effects or edit list changed; reload before saving');
       const document=parseSoundEffects(b.document,current.duration);
       if(document.editRevision!==current.editRevision)soundEffectsInvalid('Sound effects must explicitly bind current edit revision');
       await validateSoundEffectAssets(root,document);
       const check=await readSoundEffects(root);if(check.revision!==current.revision||check.editRevision!==current.editRevision)throw new VideocutError('revision_conflict','Project changed during validation');
       const revision=await atomicWriteJson(resolve(root,'sound-effects.json'),document);
       const saved=await readSoundEffects(root,true);if(saved.revision!==revision)throw new VideocutError('readback_mismatch','Sound-effects readback mismatch');return saved;
     });options.onChanged?.(id);return Response.json({schemaVersion:1,projectId:id,...result},{headers:{'Cache-Control':'no-store'}});
   }
   return Response.json({error:{code:'method_not_allowed'}},{status:405});
  } catch(e:any) {return Response.json({error:{code:e.code??'invalid_argument',message:e.message}},{status:['revision_conflict','project_busy'].includes(e.code)?409:400});}
 };
}
