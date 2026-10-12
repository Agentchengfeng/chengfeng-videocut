import { useCallback, useEffect, useRef, useState } from 'react';
import { useRuntimeProtection } from '../../runtime/useRuntimeProtection';
import type { SoundEffectCue, SoundEffectsDocument } from '@video-workbench/core';
import './sound-effects.css';
import { CLIP_Y, GUTTER, TRACK_H, TRACKS_LEFT_PAD } from '../timeline/hyperframes-fork/timelineLayout';
import { defaultTimelineTheme as theme } from '../timeline/hyperframes-fork/timelineTheme';
import { layoutSoundTracks, withTrackMove } from './soundEffectTracks';
const FOOTER_H = 28;
const MAX_ROW = 63;
function TrackIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 11.5V3.5l6-1v8" stroke="currentColor" />
      <circle cx="5" cy="11.5" r="1.5" stroke="currentColor" />
      <circle cx="11" cy="10.5" r="1.5" stroke="currentColor" />
      {muted && <path d="M2.5 2.5l11 11" stroke="currentColor" />}
    </svg>
  );
}
interface State {revision:string|null;editRevision:string;duration:number;stale:boolean;document:SoundEffectsDocument}
async function request(url:string,init?:RequestInit) {
 const r=await fetch(url,{cache:'no-store',...init}); const b=await r.json();
 if(!r.ok)throw new Error(b.error?.message??`音效请求失败 ${r.status}`);return b;
}
export function SoundEffectTrack({projectId,editRevision,time,onSaved,onSeek,pixelsPerSecond,displayContentWidth}:{pixelsPerSecond:number;displayContentWidth:number;projectId:string;editRevision:string;time:number;onSaved:()=>void;onSeek:(time:number)=>void}) {
 const [pendingCues,setPendingCues]=useState<SoundEffectCue[]|null>(null);
 const [writeFailed,setWriteFailed]=useState(false);
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState<string|null>(null),[draft,setDraft]=useState<SoundEffectCue|null>(null),[move,setMove]=useState<{id:string;start:number;row:number}|null>(null);
 const file=useRef<HTMLInputElement>(null),dialog=useRef<HTMLDialogElement>(null);
 const draftVersion=useRef(0);
 function editDraft(value:SoundEffectCue|null){draftVersion.current++;setDraft(value);}
 const url=`/api/v1/projects/${encodeURIComponent(projectId)}/sound-effects`;
 const load=useCallback(async()=>{const next=await request(url);setState(next);return next as State;},[url]);
 useEffect(()=>{let cancelled=false;setState(null);setPendingCues(null);setError('');setDraft(null);setSelected(null);dialog.current?.close();void request(url).then(s=>{if(!cancelled)setState(s);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};},[url,editRevision]);
 async function save(cues:SoundEffectCue[],rebind=false) {
  if(!state||busy)return;
  if(state.stale&&!rebind){setPendingCues(cues);setError('调整已暂存，尚未保存。请修正所有音效后点击“保存并重新绑定”。');return true;}
  setBusy(true);setError('');
  try {const next:State=await request(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,expectedRevision:state.revision,expectedEditRevision:state.editRevision,document:{schemaVersion:1,editRevision:state.editRevision,cues}})});
   setDraft(current=>{
    // Reconcile only this submission's draft. A later edit, or an unrelated
    // unsaved dialog edit, must not be overwritten by an acknowledgement.
    if(!current||current!==draft)return current;
    const before=(pendingCues??state.document.cues).find(c=>c.id===current.id);
    const submitted=cues.find(c=>c.id===current.id);
    if(!submitted||JSON.stringify(current)===JSON.stringify(before)||JSON.stringify(current)===JSON.stringify(submitted)) {
     const saved=next.document.cues.find(c=>c.id===current.id);
     return saved?{...saved}:null;
    }
    return current;
   });
   setState(next);setPendingCues(null);setWriteFailed(false);onSaved();return true;}
  catch(e){setWriteFailed(true);setError(String(e));if(!state.stale)await load().catch(()=>{});return false;}finally{setBusy(false);}
 }
 async function upload(f:File) {
  if(!state||busy||state.stale)return;setBusy(true);setError('');
  try {if(!/\.wav$/i.test(f.name))throw new Error('请选择 PCM WAV 音效');
   const {manifest}=await request(`${url}/assets`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:f});
   const length=Math.min(manifest.duration,state.duration),start=Math.min(time,state.duration-length);
   const cue:SoundEffectCue={id:`sfx-${crypto.randomUUID()}`,assetId:manifest.assetId,label:f.name,start:Math.max(0,start),sourceIn:0,sourceOut:length,gainDb:-12,fadeIn:0,fadeOut:Math.min(.05,length/4),mute:false};
   // Import and cue insertion are separate; a failed CAS leaves only an unused immutable asset.
   const next=await request(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,expectedRevision:state.revision,expectedEditRevision:state.editRevision,document:{schemaVersion:1,editRevision:state.editRevision,cues:[...state.document.cues,cue]}})});
   setState(next);setSelected(cue.id);setDraft(cue);setWriteFailed(false);onSaved();
  }catch(e){setWriteFailed(true);setError(String(e));await load().catch(()=>{});}finally{setBusy(false);}
 }
 const cues=pendingCues??state?.document.cues??[];
 useRuntimeProtection(busy || writeFailed || Boolean(pendingCues) || Boolean(move) || Boolean(draft && JSON.stringify(draft) !== JSON.stringify(cues.find(c=>c.id===draft.id))), false, `sound-effects:${projectId}`);
 function edit(c:SoundEffectCue){setSelected(c.id);editDraft({...c});dialog.current?.showModal();}
 function saveDialog(nextCues:SoundEffectCue[],deleting=false){
  const version=draftVersion.current;
  void save(nextCues).then(ok=>{
   // A completed older submission must not hide a newer editable draft.
   if(ok&&version===draftVersion.current){dialog.current?.close();if(deleting)setSelected(null);}
  });
 }
 const layout=layoutSoundTracks(cues);
 const border=`1px solid ${theme.rowBorder}`;
 const inRow=(row:number)=>cues.filter(c=>layout.rows.get(c.id)===row);
 // A track has no state of its own: muting it mutes every cue on that row.
 function toggleTrack(row:number){const members=inRow(row);if(!members.length)return;const mute=!members.every(c=>c.mute);void save(cues.map(c=>layout.rows.get(c.id)===row?{...c,mute}:c));}
 const newTrack=move?.row===layout.count;
 return <div className="cf-sfx" onPointerDown={e=>{if(!(e.target as HTMLElement).hasAttribute('data-sfx-lane'))e.stopPropagation();}} data-sfx-revision={state?.revision??''} data-sfx-stale={String(state?.stale??false)} data-sfx-tracks={layout.count}>
  {Array.from({length:layout.count},(_,row)=>{
   const members=inRow(row),muted=members.length>0&&members.every(c=>c.mute),name=`音频轨 ${row+1}`;
   return <div key={row} className="cf-sfx-row" style={{height:TRACK_H}} data-sfx-track={row}>
    <button type="button" className="cf-sfx-gutter" style={{width:GUTTER,background:theme.gutterBackground,borderRight:`1px solid ${theme.gutterBorder}`,borderBottom:border}} aria-label={name} aria-pressed={muted} title={`${name} · ${muted?'已静音，点击恢复':'点击整轨静音'}`} disabled={busy||!state} onClick={()=>toggleTrack(row)}><TrackIcon muted={muted}/></button>
    <div aria-hidden="true" className="cf-sfx-pad" style={{width:TRACKS_LEFT_PAD,background:theme.rowBackground,borderBottom:border}}/>
    <div data-sfx-lane={row} className="cf-sfx-lane" style={{width:displayContentWidth,background:theme.rowBackground,borderBottom:border}} aria-label={name}/>
   </div>;
  })}
  <div className={`cf-sfx-row cf-sfx-footer${newTrack?' is-drop':''}`} style={{height:newTrack?TRACK_H:FOOTER_H,background:theme.rowBackground,borderBottom:border}}>
   <div aria-hidden="true" className="cf-sfx-gutter" style={{width:GUTTER,background:theme.gutterBackground,borderRight:`1px solid ${theme.gutterBorder}`}}/>
   <div className="cf-sfx-status" style={{left:GUTTER}}>
    <button type="button" disabled={!state||busy||state.stale} onClick={()=>file.current?.click()}>添加 WAV</button>
    <input ref={file} type="file" accept=".wav,audio/wav" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/>
    <span>{busy?'保存中…':newTrack?'松开新建一条音频轨':cues.length?`${cues.length} 个音效 · 左右拖动改时间，上下拖动换轨，双击调整`:'还没有音效或配乐'}</span>
    {selected&&<button type="button" disabled={busy} onClick={()=>{const c=cues.find(c=>c.id===selected);if(c)edit(c);}}>编辑音效</button>}
    {state?.stale&&<><select aria-label="待审阅音效" value={selected??""} onChange={e=>{const c=cues.find(c=>c.id===e.target.value);if(c)edit(c);}}><option value="" disabled>选择音效调整</option>{cues.map(c=><option key={c.id} value={c.id}>{c.label} · {c.start.toFixed(3)}秒</option>)}</select><span role="alert">口播已变化，音效位置待审阅</span><button type="button" disabled={busy} onClick={()=>void save(cues,true)}>保存并重新绑定</button></>}
   </div>
  </div>
  {error&&<div role="alert" className="cf-sfx-error" style={{left:GUTTER}}>{error}</div>}
  <div className="cf-sfx-cues" style={{left:GUTTER+TRACKS_LEFT_PAD,width:displayContentWidth}}>
   {cues.map(c=>{const row=layout.rows.get(c.id)??0,moving=move?.id===c.id?move:null;return <button key={c.id} type="button" data-sfx-cue={c.id} title={`${c.label} · ${c.start.toFixed(3)}秒 · ${c.gainDb}dB${c.mute?' · 静音':''}`} aria-label={`音效 ${c.label}`} className={`cf-sfx-cue${selected===c.id?' selected':''}${moving?' moving':''}`} style={{left:(moving?moving.start:c.start)*pixelsPerSecond,width:(c.sourceOut-c.sourceIn)*pixelsPerSecond,top:(moving?moving.row:row)*TRACK_H+CLIP_Y,height:TRACK_H-CLIP_Y*2,opacity:c.mute?.4:1}}
    onDoubleClick={()=>edit(c)} onClick={()=>setSelected(c.id)} onKeyDown={e=>{if(e.key==='Enter')edit(c);if(e.key==='Delete'&&!state?.stale)void save(cues.filter(x=>x.id!==c.id));}}
    onPointerDown={e=>{
     if(e.button!==0||busy||state?.stale||!state)return;e.stopPropagation();setSelected(c.id);
     const x=e.clientX,y=e.clientY,width=pixelsPerSecond,initial=c.start,maxRow=Math.min(layout.count,MAX_ROW);let next=initial,nextRow=row;
     e.currentTarget.setPointerCapture(e.pointerId);
     const element=e.currentTarget;
     const move=(event:PointerEvent)=>{next=Math.round(Math.max(0,Math.min(state.duration-(c.sourceOut-c.sourceIn),initial+(event.clientX-x)/width))*1000)/1000;nextRow=Math.max(0,Math.min(maxRow,row+Math.round((event.clientY-y)/TRACK_H)));setMove({id:c.id,start:next,row:nextRow});};
     // Only a change of row writes track numbers; a horizontal move leaves them as they were.
     const finish=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',finish);element.removeEventListener('pointercancel',cancel);setMove(null);if(nextRow!==row)void save(withTrackMove(cues,c.id,next,nextRow));else if(next!==initial)void save(cues.map(v=>v.id===c.id?{...v,start:next}:v));};
     const cancel=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',finish);element.removeEventListener('pointercancel',cancel);setMove(null);};
     element.addEventListener('pointermove',move);element.addEventListener('pointerup',finish,{once:true});element.addEventListener('pointercancel',cancel,{once:true});
    }}>{c.label}</button>;})}
  </div>
  <dialog ref={dialog} className="cf-sfx-dialog" aria-label="音效设置" onCancel={()=>editDraft(null)}><form onSubmit={e=>{e.preventDefault();if(draft)saveDialog(cues.map(c=>c.id===draft.id?draft:c));}}>
   <h3>音效设置</h3>{draft&&<><p>{draft.label}</p>{([['start','开始（秒）'],['sourceIn','素材入点（秒）'],['sourceOut','素材出点（秒）'],['gainDb','音量（dB）'],['fadeIn','淡入（秒）'],['fadeOut','淡出（秒）']] as const).map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" step="0.001" required value={draft[key]} onChange={e=>editDraft({...draft,[key]:e.target.valueAsNumber})}/></label>)}
    <label><input type="checkbox" checked={draft.mute} onChange={e=>editDraft({...draft,mute:e.target.checked})}/>静音</label>
    {error&&<p role="alert">{error}</p>}<div className="cf-sfx-buttons"><button type="submit" disabled={busy}>{state?.stale?"暂存调整":"保存音效"}</button><button type="button" disabled={busy} onClick={()=>saveDialog(cues.filter(c=>c.id!==draft.id),true)}>{state?.stale?"暂存删除":"删除音效"}</button><button type="button" onClick={()=>{editDraft(null);dialog.current?.close();}}>取消</button></div></>}
  </form></dialog>
 </div>;
}
