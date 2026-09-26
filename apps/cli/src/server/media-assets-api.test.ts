import { test, expect, spyOn } from "bun:test";
import fs from "node:fs";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mediaSha256, readMediaAsset, resolveProject, writeVisuals } from "@video-workbench/core/node";
import { assertVisualDocument, buildExportPlan, createVisualDocument, visualLayerTimings } from "@video-workbench/core";
import { createMediaAssetsApi } from "./media-assets-api";
import { assembleCut, composeFilm, verifyFilm } from "@video-workbench/koubo-adapter";
import { createHash } from "node:crypto";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
test("MP4: import, hash, range, CAS, finite anchors and real muted export", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "broll-qa-")));
  const dir = join(root,"demo"); await mkdir(dir);
  const source = join(root,"片头 with spaces.mp4");
  const ff = (args: string[]) => {
    const p=spawnSync("ffmpeg",["-v","error", "-nostdin",...args],{encoding:"utf8"});
    if (p.status !== 0) throw new Error(p.stderr || String(p.error));
  };
  try {
    ff(["-f","lavfi","-i","testsrc2=size=160x90:rate=24","-f","lavfi","-i","sine=frequency=800","-t","2","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",source]);
    await writeFile(join(dir,"project.json"), JSON.stringify({jobId:"demo"}));
    const hash=await mediaSha256(source);
    const api=createMediaAssetsApi(root,1234);
    const call=(path="",method="GET",body?: any,extra={}) => api(new Request("http://127.0.0.1:1234/api/v1/projects/demo/media-assets"+path,{method,headers:{host:"127.0.0.1:1234",...extra},...(body?{body:JSON.stringify(body)}:{})}),"127.0.0.1");
    const input={confirmed:true,sourcePath:source,expectedSourceSha256:hash};
    expect((await call("","POST",{...input,confirmed:false}))?.status).toBe(400);
    expect((await call("","POST",{...input,expectedSourceSha256:"0".repeat(64)}))?.status).toBe(400);
    expect((await call("","POST",input,{origin:"https://evil.test"}))?.status).toBe(403);
    await symlink(source,join(root,"linked.mp4"));
    expect((await call("","POST",{...input,sourcePath:join(root,"linked.mp4")}))?.status).toBe(400);
    const bad=join(root,"bad.mp4"); await writeFile(bad,"not video");
    expect((await call("","POST",{...input,sourcePath:bad,expectedSourceSha256:await mediaSha256(bad)}))?.status).toBe(400);
    const imports=await Promise.all([call("","POST",input),call("","POST",input)]);
    expect(imports.map(r=>r?.status)).toEqual([200,200]);
    const data=await imports[0]!.json(); expect(data.manifest).toMatchObject({assetId:hash,codec:"h264",width:160,height:90,hasAudio:true});
    expect((await readdir(join(dir,".chengfeng-videocut/media"))).filter(x=>!x.startsWith("."))).toEqual([hash]);
    expect((await call(`/${hash}`))?.status).toBe(200);
    const ranged=await call(`/${hash}/content`,"GET",undefined,{range:"bytes=0-31"});
    expect(ranged?.status).toBe(206); expect((await ranged!.arrayBuffer()).byteLength).toBe(32);
    expect((await call(`/${hash}/content`,"HEAD"))?.headers.get("content-type")).toBe("video/mp4");
    expect((await call(`/${hash}/content`,"GET",undefined,{range:"bytes=999999999-"}))?.status).toBe(416);
    const transcript={words:[{id:"w1",text:"one",start:0,end:1},{id:"w2",text:"two",start:1,end:3}]};
    const raw=JSON.stringify({cues:[transcript]}); await writeFile(join(dir,"transcript.json"),raw);
    const edl:any={schemaVersion:1,projectId:"demo",sourceDuration:3,baseCutsRevision:"b".repeat(64),baseTranscriptRevision:sha(raw),mode:"manual",duration:3,segments:[{id:"seg1",source:"source.wav",trackId:"a-roll",sourceStart:0,sourceEnd:3,timelineStart:0,playbackRate:1}]};
    await writeFile(join(dir,"edit-list.json"),JSON.stringify(edl));
    const media={assetId:hash,sourceIn:0.25,sourceOut:1.75,fit:"contain" as const,muted:true as const};
    const doc={...createVisualDocument("demo",sha(raw)),layers:[{id:"opening",wordIds:["w1","w2"],media}]};
    assertVisualDocument(doc);
    for(const patch of [{sourceIn:-1},{sourceOut:NaN},{sourceOut:0.1},{fit:"stretch"},{muted:false},{assetId:"../evil"}]) expect(()=>assertVisualDocument({...doc,layers:[{...doc.layers[0],media:{...media,...patch}}]})).toThrow();
    expect(()=>assertVisualDocument({...doc,layers:[{...doc.layers[0],module:"x.html"}]})).toThrow();
    const project=await resolveProject(dir);
    const written=await writeVisuals(project,doc,{expectedRevision:"none"});
    await expect(writeVisuals(project,doc,{expectedRevision:"none"})).rejects.toThrow();
    await expect(writeVisuals(project,{...doc,layers:[{...doc.layers[0],media:{...media,sourceOut:20}}]},{expectedRevision:written.revision})).rejects.toThrow();
    await expect(writeVisuals(project,{...doc,layers:[{...doc.layers[0],wordIds:["unknown"]}]},{expectedRevision:written.revision})).rejects.toThrow();
    expect(visualLayerTimings(doc,transcript.words,edl)[0]).toMatchObject({start:0,end:1.5,duration:1.5});
    const delayedWords = transcript.words.map(w => ({...w,start:w.start+0.1,end:w.end}));
    expect(visualLayerTimings(doc,delayedWords,edl)[0]?.start).toBeCloseTo(0.1);
    expect(visualLayerTimings({...doc,layers:[{...doc.layers[0]!,media:{...media,includeLeadingGap:true}}]},delayedWords,edl)[0])
      .toMatchObject({start:0,end:1.5});
    // A longer audio track must not authorize seeking past the video end.
    const audioTail=join(root,"audio-tail.mp4");
    ff(["-f","lavfi","-i","testsrc2=size=160x90:rate=24:duration=1","-f","lavfi","-i","sine=duration=2","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",audioTail]);
    const tailResponse=await call("","POST",{...input,sourcePath:audioTail,expectedSourceSha256:await mediaSha256(audioTail)});
    expect(tailResponse?.status).toBe(200);
    expect((await tailResponse!.json()).manifest.duration).toBeCloseTo(1);
    const plan=buildExportPlan({editList:edl,words:transcript.words,visuals:doc,subtitles:null,source:{width:160,height:90,duration:3,frameRate:24},scale:1});
    expect(plan.zoomSpans.map(s=>[s.startFrame,s.endFrame,!!s.media])).toEqual([[0,36,true],[36,72,false]]);
    const narration=join(root,"narration.wav");ff(["-f","lavfi","-i","sine=frequency=240:duration=3",narration]);
    const assembled=join(root,"assembled.mkv"),out=join(root,"out.mp4");
    await assembleCut({source:narration,output:assembled,plan,audioOnly:true});
    await composeFilm({assembled,framePattern:null,output:out,workDirectory:join(root,"spans"),plan,projectDirectory:dir,profile:"fast"});
    expect((await verifyFilm(out,plan)).problems).toEqual([]);
    // Inspect encoded pixels: first part is colorful B-roll, later white base.
    const pixels=(path:string,t:number)=>spawnSync("ffmpeg",["-v","error","-ss",String(t),"-i",path,"-frames:v","1","-vf","scale=16:9","-pix_fmt","rgb24","-f","rawvideo","pipe:1"]).stdout;
    expect([...pixels(out,0.5)].some(v=>v<80)).toBe(true);
    expect([...pixels(out,2)].every(v=>v>235)).toBe(true);
    // Imported video's 800Hz audio must not replace narration's 240Hz audio.
    const pcm=spawnSync("ffmpeg",["-v","error","-i",out,"-t","1","-ac","1","-ar","8000","-f","s16le","pipe:1"]).stdout;
    let crossings=0;for(let i=2;i<pcm.length;i+=2)if(pcm.readInt16LE(i-2)<=0&&pcm.readInt16LE(i)>0)crossings++;
    expect(crossings).toBeGreaterThan(230);expect(crossings).toBeLessThan(250);
    expect(await mediaSha256(source)).toBe(hash);
    const asset=await readMediaAsset(dir,hash);await writeFile(asset.path,"tampered");
    expect((await call(`/${hash}`))?.status).toBe(400);
    await expect(writeVisuals(project,doc,{expectedRevision:written.revision})).rejects.toThrow();
  } finally {await rm(root,{recursive:true,force:true});}
},30000);

test("large real MP4 repeated Range/HEAD and idempotent import do not reread the whole media", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "broll-range-cache-")));
  const dir = join(root, "demo"); await mkdir(dir);
  const source = join(root, "large.mp4");
  const ff = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  expect(ff.status).toBe(0);
  // ISO BMFF free space is valid MP4, so this exercises large-file I/O without
  // spending test time encoding a large video or substituting a mock probe.
  const free = Buffer.alloc(16 * 1024 * 1024); free.writeUInt32BE(free.length); free.write("free", 4);
  const bytes = Buffer.concat([await readFile(source), free]); await writeFile(source, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(dir, "project.json"), JSON.stringify({ jobId: "demo" }));
  const api = createMediaAssetsApi(root, 1234);
  const call = (method: string, suffix = "", body?: object, range?: string) => api(new Request(`http://127.0.0.1:1234/api/v1/projects/demo/media-assets${suffix}`, {
    method, headers: { host: "127.0.0.1:1234", ...(range ? { range } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), "127.0.0.1");
  const input = { confirmed: true, sourcePath: source, expectedSourceSha256: hash };
  const original = fs.createReadStream;
  let reads = 0, hashedBytes = 0;
  const spy = spyOn(fs, "createReadStream").mockImplementation(((...args: Parameters<typeof original>) => {
    const stream = original(...args);
    if (String(args[0]).startsWith(root)) { reads++; stream.on("data", chunk => { hashedBytes += chunk.length; }); }
    return stream;
  }) as typeof original);
  try {
    const initial = await call("POST", "", input); expect(initial?.status).toBe(200);
    expect((await initial!.json()).created).toBe(true);
    // Source once, staging copy once, published path once. Source post-copy
    // identity is rechecked, not rehashed; a new path is not blindly trusted.
    expect(reads).toBe(3); expect(hashedBytes).toBe(bytes.length * 3);
    const before = hashedBytes;
    for (let i = 0; i < 12; i++) {
      const range = await call("GET", `/${hash}/content`, undefined, "bytes=0-31");
      expect(range?.status).toBe(206);
      expect(Buffer.from(await range!.arrayBuffer())).toEqual(bytes.subarray(0, 32));
      const head = await call("HEAD", `/${hash}/content`); expect(head?.status).toBe(200);
      expect(head?.headers.get("content-length")).toBe(String(bytes.length));
      expect((await head!.arrayBuffer()).byteLength).toBe(0);
    }
    const repeated = await call("POST", "", input); expect(repeated?.status).toBe(200);
    expect((await repeated!.json()).created).toBe(false);
    expect(reads).toBe(3); expect(hashedBytes - before).toBe(0);
    console.info(`media-cache evidence: fixture=${bytes.length} bytes; initial hash reads=3; 12 Range + 12 HEAD + repeat import additional hash bytes=${hashedBytes - before}`);
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
