import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectConfigApi } from "./project-config-api";
import { exportSource } from "../export-source";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
test("project config: bounded confirmed CAS, no-op, busy, history, source isolation and shared canvas", async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),"config-qa-"))),dir=join(root,"demo");await mkdir(dir);
  const project={jobId:"demo",status:"cut_review_ready",source:{mediaKind:"audio"},inputVideo:"source.wav",config:{aspectRatio:"16:9",unrelated:"preserve"},opaque:{keep:true}};
  let raw=JSON.stringify(project,null,4);const file=join(dir,"project.json");await writeFile(file,raw);
  const protectedFiles=["source.wav","transcript.json","edit-list.json","subtitles.json","visuals.json"];
  for(const n of protectedFiles)await writeFile(join(dir,n),"protected "+n);
  let busy=false;const notifications:any[]=[];
  const api=createProjectConfigApi({projectsDir:root,port:1234,isBusy:async()=>busy,onChanged:e=>{notifications.push(e)}});
  const call=(method="GET",body?:any,extra:Record<string,string>={},client="127.0.0.1")=>api(new Request("http://127.0.0.1:1234/api/v1/projects/demo/project-config",{method,headers:{host:"127.0.0.1:1234","content-type":"application/json",...extra},...(body?{body:JSON.stringify(body)}:{})}),client);
  try {
    const before=await(await call())!.json();expect(before).toMatchObject({projectId:"demo",projectRevision:sha(raw),config:{aspectRatio:"16:9"}});
    const input={confirmed:true,expectedRevision:before.projectRevision,config:{aspectRatio:"4:3"}};
    for(const b of [{...input,confirmed:false},{...input,confirmed:1},{...input,expectedRevision:"none"},{...input,other:true},{...input,config:{aspectRatio:"4:3",status:"done"}},{...input,config:{aspectRatio:"2:0"}},{...input,config:{aspectRatio:null}}])expect((await call("PATCH",b))!.status).toBe(400);
    expect((await call("PATCH",input,{origin:"https://evil.example"}))!.status).toBe(403);
    expect((await call("PATCH",input,{},"192.168.0.2"))!.status).toBe(403);
    expect((await call("POST",input))!.status).toBe(405);
    expect((await call("PATCH",{...input,expectedRevision:"0".repeat(64)}))!.status).toBe(409);
    busy=true;expect((await call("PATCH",input))!.status).toBe(409);busy=false;
    expect(await readFile(file,"utf8")).toBe(raw);expect(notifications).toHaveLength(0);
    const concurrent=await Promise.all([call("PATCH",input),call("PATCH",input)]);
    expect(concurrent.map(r=>r!.status).sort()).toEqual([200,409]);
    const after=await(await call())!.json();expect(after.config.aspectRatio).toBe("4:3");expect(after.projectRevision).not.toBe(before.projectRevision);expect(after.configRevision).not.toBe(before.configRevision);
    expect(JSON.parse(await readFile(file,"utf8"))).toEqual({...project,config:{...project.config,aspectRatio:"4:3"}});
    expect(await readFile(join(dir,".chengfeng-videocut/project-config-history",before.projectRevision+".json"),"utf8")).toBe(raw);
    expect(notifications).toEqual([{projectId:"demo",path:"project.json",revision:after.projectRevision}]);
    const noop=await(await call("PATCH",{...input,expectedRevision:after.projectRevision}))!.json();expect(noop.changed).toBe(false);expect(notifications).toHaveLength(1);
    for(const n of protectedFiles)expect(await readFile(join(dir,n),"utf8")).toBe("protected "+n);
    const media=exportSource({hasVideo:false,hasAudio:true,duration:2,width:0,height:0,frameRate:null} as any,"4:3");
    expect(media).toMatchObject({audioOnly:true,source:{width:1440,height:1080}});
    await writeFile(file,JSON.stringify({...project,status:"cutting"}));const working=await(await call())!.json();expect((await call("PATCH",{...input,expectedRevision:working.projectRevision}))!.status).toBe(409);
    for(const source of [{mediaKind:"video"},{mediaKind:"unknown"},undefined]){
      await writeFile(file,JSON.stringify({...project,source}));const current=await(await call())!.json();expect((await call("PATCH",{...input,config:{aspectRatio:"4:5"},expectedRevision:current.projectRevision}))!.status).toBe(200);
      expect((await(await call())!.json()).config.aspectRatio).toBe("4:5");
    }
    await writeFile(file,JSON.stringify({...project,config:undefined}));const blank=await(await call())!.json();expect(blank.config.aspectRatio).toBeNull();
    // A stale/corrupt history or symlink may not redirect a backup write.
    await rm(join(dir,".chengfeng-videocut/project-config-history"),{recursive:true});const outside=join(root,"outside");await mkdir(outside);await symlink(outside,join(dir,".chengfeng-videocut/project-config-history"));
    expect((await call("PATCH",{...input,expectedRevision:blank.projectRevision}))!.status).toBe(400);
    expect((await(await call())!.json()).projectRevision).toBe(blank.projectRevision);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("config route rejects oversized input and preserves a committed broadcast failure",async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),"config-body-"))),dir=join(root,"demo");await mkdir(dir);await writeFile(join(dir,"project.json"),JSON.stringify({jobId:"demo",source:{mediaKind:"audio"},config:{aspectRatio:"16:9"}}));
 const api=createProjectConfigApi({projectsDir:root,port:1234,isBusy:async()=>false,onChanged:()=>{throw Error("subscriber unavailable")}});
 const req=(method:string,body?:string)=>new Request("http://127.0.0.1:1234/api/v1/projects/demo/project-config",{method,headers:{host:"127.0.0.1:1234","content-type":"application/json"},...(body?{body}:{})});
 try {const before=await(await api(req("GET"),"127.0.0.1"))!.json();expect((await api(req("PATCH","x".repeat(5000)),"127.0.0.1"))!.status).toBe(400);
 const result=await(await api(req("PATCH",JSON.stringify({confirmed:true,expectedRevision:before.projectRevision,config:{aspectRatio:"4:3"}})),"127.0.0.1"))!.json();expect(result).toMatchObject({changed:true,config:{aspectRatio:"4:3"},notificationWarning:"committed_but_refresh_required"});
 } finally {await rm(root,{recursive:true,force:true});}
});

test("canvas background: validated hex, set alone or with aspect, readback, no-op", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "config-bg-"))), dir = join(root, "demo"); await mkdir(dir);
  await writeFile(join(dir, "project.json"), JSON.stringify({ jobId: "demo", source: { mediaKind: "audio" }, config: { aspectRatio: "4:3" } }));
  const api = createProjectConfigApi({ projectsDir: root, port: 1234, isBusy: async () => false });
  const call = (method = "GET", body?: any) => api(new Request("http://127.0.0.1:1234/api/v1/projects/demo/project-config", { method,
    headers: { host: "127.0.0.1:1234", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), "127.0.0.1");
  try {
    const before = await (await call())!.json();
    expect(before.config).toEqual({ aspectRatio: "4:3", canvasBackground: null });
    for (const bad of ["red", "#fff", "#12345g", "", null]) {
      expect((await call("PATCH", { confirmed: true, expectedRevision: before.projectRevision, config: { canvasBackground: bad } }))!.status).toBe(400);
    }
    const set = await (await call("PATCH", { confirmed: true, expectedRevision: before.projectRevision, config: { canvasBackground: "#0F0F11" } }))!.json();
    expect(set).toMatchObject({ changed: true, config: { aspectRatio: "4:3", canvasBackground: "#0f0f11" } });
    const both = await (await call("PATCH", { confirmed: true, expectedRevision: set.projectRevision, config: { aspectRatio: "4:3", canvasBackground: "#0f0f11" } }))!.json();
    expect(both.changed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
