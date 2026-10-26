import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarkersApi } from './markers-api';
import { parseMarkers, type TimelineMarker } from '@video-workbench/core';
async function fixture(onChanged?:(id:string)=>void) {
 const root=await mkdtemp(join(tmpdir(),'markers-contract-')),registry=join(root,'projects'),project=join(registry,'demo');await mkdir(join(project,'input'),{recursive:true});
 await writeFile(join(project,'input/source.wav'),Buffer.alloc(64));
 const edit={schemaVersion:1,projectId:'demo',baseCutsRevision:'a'.repeat(64),baseTranscriptRevision:'b'.repeat(64),mode:'manual',sourceDuration:10,duration:10,segments:[{id:'one',source:'input/source.wav',sourceStart:0,sourceEnd:10,timelineStart:0,trackId:'a-roll',playbackRate:1}]};
 await writeFile(join(project,'edit-list.json'),JSON.stringify(edit));await writeFile(join(project,'project.json'),JSON.stringify({jobId:'demo',status:'cut_review_ready',inputVideo:'input/source.wav',config:{aspectRatio:'4:3'}}));
 const api=createMarkersApi(registry,1234,onChanged?{onChanged}:{});
 const call=async(method:string,value?:unknown,client='127.0.0.1')=>{const response=await api(new Request('http://127.0.0.1:1234/api/v1/projects/demo/markers',{method,headers:{host:'127.0.0.1:1234','content-type':'application/json'},...(value?{body:JSON.stringify(value)}:{})}),client);return {status:response!.status,body:await response!.json()};};
 return {root,project,edit,call};
}
const marker=(id:string,start:number,label='卡壳'):TimelineMarker=>({id,start,duration:1,label});
test('markers contract: bounded labels and notes, unique IDs, inside the timeline, stored in time order',()=>{
 const d={schemaVersion:1,editRevision:'a'.repeat(64),markers:[marker('b',5),marker('a',2,'停顿 0.05 秒')]};
 expect(parseMarkers(d,10).markers.map(m=>m.id)).toEqual(['a','b']);
 expect(parseMarkers({...d,markers:[{...marker('p',3),duration:0,note:'点'}]},10).markers[0]).toEqual({id:'p',start:3,duration:0,label:'卡壳',note:'点'});
 for(const patch of [{start:NaN},{start:-1},{duration:-1},{start:9.5},{label:''},{label:'  '},{label:'x'.repeat(81)},{note:'x'.repeat(501)},{id:'bad id'}])
  expect(()=>parseMarkers({...d,markers:[{...marker('x',1),...patch}]},10)).toThrow();
 expect(()=>parseMarkers({...d,markers:[marker('a',1),marker('a',2)]},10)).toThrow();
 expect(()=>parseMarkers({...d,markers:Array.from({length:501},(_,i)=>marker(`m${i}`,0))},10)).toThrow();
});
test('markers real API: empty start, CAS, readback, change event, stale after edit-list change, rebind, loopback only',async()=>{
 const changed:string[]=[];const f=await fixture(id=>changed.push(id));try{
  const initial=await f.call('GET');expect(initial.status).toBe(200);expect(initial.body.revision).toBeNull();expect(initial.body.document.markers).toEqual([]);
  const doc={schemaVersion:1,editRevision:initial.body.editRevision,markers:[marker('stall-02',7),marker('stall-01',3.5)]};
  const payload={confirmed:true,expectedRevision:null,expectedEditRevision:initial.body.editRevision,document:doc};
  expect((await f.call('PUT',{...payload,confirmed:false})).status).toBe(400);
  const saved=await f.call('PUT',payload);expect(saved.status).toBe(200);expect(changed).toEqual(['demo']);
  expect(saved.body.document.markers.map((m:TimelineMarker)=>m.id)).toEqual(['stall-01','stall-02']);
  const before=await readFile(join(f.project,'markers.json'));
  expect((await f.call('PUT',payload)).status).toBe(409);expect(await readFile(join(f.project,'markers.json'))).toEqual(before);
  expect((await f.call('PUT',{...payload,expectedRevision:saved.body.revision,document:{...doc,markers:[marker('late',9.5)]}})).status).toBe(400);
  expect(await readFile(join(f.project,'markers.json'))).toEqual(before);
  await writeFile(join(f.project,'edit-list.json'),JSON.stringify(f.edit,null,2));
  const stale=await f.call('GET');expect(stale.body.stale).toBe(true);expect(stale.body.document.markers).toHaveLength(2);
  expect((await f.call('PUT',{...payload,expectedRevision:saved.body.revision})).status).toBe(409);
  const rebound=await f.call('PUT',{...payload,expectedRevision:stale.body.revision,expectedEditRevision:stale.body.editRevision,document:{...doc,editRevision:stale.body.editRevision}});
  expect(rebound.status).toBe(200);expect(rebound.body.stale).toBe(false);
  const cleared=await f.call('PUT',{...payload,expectedRevision:rebound.body.revision,expectedEditRevision:stale.body.editRevision,document:{...doc,editRevision:stale.body.editRevision,markers:[]}});
  expect(cleared.status).toBe(200);expect(cleared.body.document.markers).toEqual([]);
  expect((await f.call('GET',undefined,'192.168.1.5')).status).toBe(403);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
