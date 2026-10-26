import { resolve } from 'node:path';
import { parseMarkers, markersInvalid, VideocutError } from '@video-workbench/core';
import { atomicWriteJson, resolveProject, serializeProjectOperation, readMarkers, MARKERS_MAX_BYTES } from '@video-workbench/core/node';
import { isLoopbackAddress, trustedLoopbackOrigin } from './jobs-api';
/** Timeline markers: annotations only. Writing them never rebuilds the preview or touches the export snapshot. */
export function createMarkersApi(projectsDir:string,port:number,options:{onChanged?:(id:string)=>void}={}) {
 return async(request:Request,client?:string):Promise<Response|null>=>{
  const url=new URL(request.url),m=/^\/api\/v1\/projects\/([^/]+)\/markers$/.exec(url.pathname);
  if(!m)return null;
  const origin=trustedLoopbackOrigin(request.headers.get('host'),port);
  if(!client||!isLoopbackAddress(client)||!origin||url.origin!==origin||(request.headers.has('origin')&&request.headers.get('origin')!==origin))return Response.json({error:{code:'origin_forbidden'}},{status:403});
  try {
   const id=decodeURIComponent(m[1]!);if(!id||id==='.'||id==='..'||/[\\/\0]/.test(id))markersInvalid('Invalid project');
   const root=(await resolveProject(resolve(projectsDir,id))).directory;
   if(request.method==='GET')return Response.json({schemaVersion:1,projectId:id,...await readMarkers(root)},{headers:{'Cache-Control':'no-store'}});
   if(request.method==='PUT') {
     const raw=await request.text();if(raw.length>MARKERS_MAX_BYTES)markersInvalid('Markers request exceeds size limit');
     const b=JSON.parse(raw);
     if(b.confirmed!==true||!Object.hasOwn(b,'expectedRevision'))markersInvalid('Confirmed CAS write required');
     const result=await serializeProjectOperation(root,async()=>{
       const current=await readMarkers(root);
       if(current.revision!==b.expectedRevision||current.editRevision!==b.expectedEditRevision)throw new VideocutError('revision_conflict','Markers or edit list changed; reload before saving');
       const document=parseMarkers(b.document,current.duration);
       if(document.editRevision!==current.editRevision)markersInvalid('Markers must bind the current edit revision');
       const revision=await atomicWriteJson(resolve(root,'markers.json'),document);
       const saved=await readMarkers(root);if(saved.revision!==revision)throw new VideocutError('readback_mismatch','Markers readback mismatch');return saved;
     });options.onChanged?.(id);return Response.json({schemaVersion:1,projectId:id,...result},{headers:{'Cache-Control':'no-store'}});
   }
   return Response.json({error:{code:'method_not_allowed'}},{status:405});
  } catch(e:any) {return Response.json({error:{code:e.code??'invalid_argument',message:e.message}},{status:e.code==='revision_conflict'?409:400});}
 };
}
