import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarkersDocument, TimelineMarker } from '@video-workbench/core';
import { useRuntimeProtection } from '../../runtime/useRuntimeProtection';
import { subscribeProjectFileChanges } from '../../product/projectEvents';
import { GUTTER, TRACKS_LEFT_PAD } from '../timeline/hyperframes-fork/timelineLayout';
import { defaultTimelineTheme as theme } from '../timeline/hyperframes-fork/timelineTheme';
import '../sound-effects/sound-effects.css';
import './markers.css';
/** Shorter than a clip lane: markers are notes, not media, and must not crowd the main tracks. */
export const MARKER_H = 28;
interface State {revision:string|null;editRevision:string;duration:number;stale:boolean;document:MarkersDocument}
async function request(url:string,init?:RequestInit) {
 const r=await fetch(url,{cache:'no-store',...init}); const b=await r.json();
 if(!r.ok)throw new Error(r.status===409?'标记已被别处修改，已重新载入':b.error?.message??`标记请求失败 ${r.status}`);return b;
}
/** The Runtime announces writes as {projectId, path}; Agents write markers through the CLI while Studio is open. */
export function isMarkersChange(payload:unknown,projectId:string) {
 try { const raw=payload&&typeof payload==='object'&&'data' in payload?(payload as MessageEvent).data:payload, value=typeof raw==='string'?JSON.parse(raw):raw;
  return value?.projectId===projectId&&typeof value.path==='string'&&(value.path==='markers.json'||value.path.endsWith('/markers.json')); }
 catch { return false; }
}
function FlagIcon() {
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 14V2.5M4 3h7.5l-1.5 2.5L11.5 8H4" stroke="currentColor" strokeLinejoin="round"/></svg>;
}
export function MarkerTrack({projectId,editRevision,time,onSeek,pixelsPerSecond,displayContentWidth}:{projectId:string;editRevision:string;time:number;onSeek:(time:number)=>void;pixelsPerSecond:number;displayContentWidth:number}) {
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<string|null>(null);
 const [draft,setDraft]=useState<TimelineMarker|null>(null),[move,setMove]=useState<{id:string;start:number}|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),busyRef=useRef(false);
 const url=`/api/v1/projects/${encodeURIComponent(projectId)}/markers`;
 const load=useCallback(async()=>{const next=await request(url) as State;setState(next);return next;},[url]);
 useEffect(()=>{let cancelled=false;setState(null);setError('');setSelected(null);void request(url).then(s=>{if(!cancelled)setState(s);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[url,editRevision]);
 useEffect(()=>subscribeProjectFileChanges(payload=>{if(isMarkersChange(payload,projectId)&&!busyRef.current)void load().catch(()=>{});}),[load,projectId]);
 async function save(markers:TimelineMarker[]) {
  if(!state||busyRef.current)return false;
  busyRef.current=true;setBusy(true);setError('');
  try {
   // A save always binds the current edit list: markers are notes, so there is no review gate after a cut.
   const current=state.stale?await load():state;
   const next:State=await request(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,expectedRevision:current.revision,expectedEditRevision:current.editRevision,document:{schemaVersion:1,editRevision:current.editRevision,markers}})});
   setState(next);return true;
  } catch(e) {setError(e instanceof Error?e.message:String(e));await load().catch(()=>{});return false;}
  finally {busyRef.current=false;setBusy(false);}
 }
 useRuntimeProtection(busy||Boolean(move),false,`markers:${projectId}`);
 const markers=state?.document.markers??[];
 function edit(m:TimelineMarker){setSelected(m.id);setDraft({...m});dialog.current?.showModal();}
 async function add() {
  if(!state)return;
  const start=Math.round(Math.max(0,Math.min(time,state.duration))*1000)/1000;
  const m:TimelineMarker={id:`mark-${crypto.randomUUID().slice(0,8)}`,start,duration:0,label:`标记 ${markers.length+1}`};
  if(await save([...markers,m])){setSelected(m.id);edit(m);}
 }
 function remove(id:string){void save(markers.filter(m=>m.id!==id)).then(ok=>{if(ok){setSelected(null);dialog.current?.close();setDraft(null);}});}
 const border=`1px solid ${theme.rowBorder}`;
 const name=state?.stale?'标记 · 口播改过，位置可能偏移；保存任一标记即按现在的口播重新绑定':'标记 · 点击在播放头处加一个';
 return <div className="cf-markers" data-markers-revision={state?.revision??''} data-markers-stale={String(state?.stale??false)} data-markers-count={markers.length}
  onPointerDown={e=>{if(!(e.target as HTMLElement).hasAttribute('data-markers-lane'))e.stopPropagation();}}>
  <div className="cf-sfx-row" style={{height:MARKER_H}}>
   <button type="button" className={`cf-sfx-gutter cf-markers-gutter${state?.stale?' is-stale':''}`} style={{width:GUTTER,background:theme.gutterBackground,borderRight:`1px solid ${theme.gutterBorder}`,borderBottom:border}}
    aria-label="在播放头处加标记" title={name} disabled={busy||!state} onClick={()=>void add()}><FlagIcon/></button>
   <div aria-hidden="true" className="cf-sfx-pad" style={{width:TRACKS_LEFT_PAD,background:theme.rowBackground,borderBottom:border}}/>
   <div data-markers-lane="true" className="cf-sfx-lane" style={{width:displayContentWidth,background:theme.rowBackground,borderBottom:border}} aria-label="标记轨"/>
  </div>
  {error&&<div role="alert" className="cf-sfx-error cf-markers-error" style={{left:GUTTER}}>{error}</div>}
  <div className="cf-sfx-cues" style={{left:GUTTER+TRACKS_LEFT_PAD,width:displayContentWidth}}>
   {markers.map(m=>{const at=move?.id===m.id?move.start:m.start;return <button key={m.id} type="button" data-marker={m.id}
    className={`cf-marker${selected===m.id?' selected':''}${move?.id===m.id?' moving':''}${m.duration>0?' has-span':''}`}
    title={`${m.label} · ${at.toFixed(2)}秒${m.duration>0?` · ${m.duration.toFixed(2)}秒长`:''}${m.note?`\n${m.note}`:''}`} aria-label={`标记 ${m.label}，${at.toFixed(2)} 秒`}
    style={{left:at*pixelsPerSecond,top:4,height:MARKER_H-8,...(m.duration>0?{width:Math.max(6,m.duration*pixelsPerSecond)}:{})}}
    onDoubleClick={()=>edit(m)} onKeyDown={e=>{if(e.key==='Enter'){e.stopPropagation();edit(m);}if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.stopPropagation();remove(m.id);}}}
    onPointerDown={e=>{
     if(e.button!==0||busy||!state)return;e.stopPropagation();setSelected(m.id);
     const x=e.clientX,initial=m.start,limit=Math.max(0,state.duration-m.duration),element=e.currentTarget;let next=initial,dragged=false;
     element.setPointerCapture(e.pointerId);
     const onMove=(event:PointerEvent)=>{if(Math.abs(event.clientX-x)<3&&!dragged)return;dragged=true;next=Math.round(Math.max(0,Math.min(limit,initial+(event.clientX-x)/pixelsPerSecond))*1000)/1000;setMove({id:m.id,start:next});};
     const done=(commit:boolean)=>{element.removeEventListener('pointermove',onMove);element.removeEventListener('pointerup',up);element.removeEventListener('pointercancel',cancel);setMove(null);
      if(!commit)return;if(!dragged){onSeek(m.start);return;}if(next!==initial)void save(markers.map(v=>v.id===m.id?{...v,start:next}:v));};
     const up=()=>done(true),cancel=()=>done(false);
     element.addEventListener('pointermove',onMove);element.addEventListener('pointerup',up,{once:true});element.addEventListener('pointercancel',cancel,{once:true});
    }}><span className="cf-marker-label">{m.label}</span></button>;})}
  </div>
  <dialog ref={dialog} className="cf-sfx-dialog" aria-label="标记设置" onCancel={()=>setDraft(null)}><form onSubmit={e=>{e.preventDefault();if(!draft||!draft.label.trim())return;const {note,...rest}=draft,clean:TimelineMarker={...rest,label:draft.label.trim(),...(note?.trim()?{note:note.trim()}:{})};void save(markers.map(m=>m.id===clean.id?clean:m)).then(ok=>{if(ok){dialog.current?.close();setDraft(null);}});}}>
   <h3>标记</h3>{draft&&<>
    <label>名称<input aria-label="名称" required maxLength={80} value={draft.label} onChange={e=>setDraft({...draft,label:e.target.value})}/></label>
    <label>备注<textarea aria-label="备注" maxLength={500} rows={3} value={draft.note??''} onChange={e=>setDraft({...draft,note:e.target.value})}/></label>
    {([['start','开始（秒）'],['duration','时长（秒，0 为一个点）']] as const).map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" step="any" min={0} required value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.valueAsNumber})}/></label>)}
    {error&&<p role="alert">{error}</p>}
    <div className="cf-sfx-buttons"><button type="submit" disabled={busy}>保存标记</button><button type="button" disabled={busy} onClick={()=>remove(draft.id)}>删除标记</button><button type="button" onClick={()=>{setDraft(null);dialog.current?.close();}}>取消</button></div></>}
  </form></dialog>
 </div>;
}
