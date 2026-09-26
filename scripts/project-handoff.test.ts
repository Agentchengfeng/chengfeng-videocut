import { test, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { plan, apply, recover, manifest } from './project-handoff';
const sha=(b:string)=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'handoff-test-'))), source=join(root,'registry','demo'), target=join(root,'works','demo'), backup=join(root,'backup');
 await fs.mkdir(source,{recursive:true}); await fs.mkdir(target,{recursive:true});
 const files:Record<string,string>={'index.html':'<html>demo</html>','source.wav':'real fixture media bytes','edit-list.json':JSON.stringify({schemaVersion:2,sources:[{path:'source.wav',sha256:sha('real fixture media bytes')}]}),'visuals.json':JSON.stringify({layers:[]}),'workbench.json':JSON.stringify({jobDir:'/old/path',stable:true})};
 for(const[k,v]of Object.entries(files))await fs.writeFile(join(source,k),v);
 await fs.writeFile(join(target,'old.json'),'old snapshot');
 return {root,source,target,backup,p:await plan(source,target,backup)};
}
async function freePort(){ const s=createServer(); await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return p; }
test('successful stopped handoff, exact media, idempotence and recovery',async()=>{
 const f=await fixture(), port=await freePort(); await apply(f.p,{confirmed:true,expectedPort:port});
 expect(await fs.readlink(f.source)).toBe(f.target);expect(JSON.parse(await fs.readFile(join(f.target,'workbench.json'),'utf8')).jobDir).toBe(f.target);
 expect(await manifest(join(f.backup,'source'))).toEqual(f.p.sourceFiles);
 await apply(f.p,{confirmed:true,expectedPort:port}); await recover(f.backup,port);
 expect(await manifest(f.source)).toEqual(f.p.sourceFiles);expect(await manifest(f.target)).toEqual(f.p.targetFiles); await recover(f.backup,port);
});
for(const phase of ['staged','target-retained','target-published','source-retained','linked','committed'])test(`recover failure after ${phase}`,async()=>{
 const f=await fixture(), port=await freePort();await expect(apply(f.p,{confirmed:true,expectedPort:port,failAfter:phase})).rejects.toThrow('Injected');await recover(f.backup,port);
 expect(await manifest(f.source)).toEqual(f.p.sourceFiles);expect(await manifest(f.target)).toEqual(f.p.targetFiles);
});
for(const side of ['source','target'] as const)test(`${side} CAS`,async()=>{
 const f=await fixture();await fs.writeFile(join(f[side],'new'),'external'); await expect(apply(f.p,{confirmed:true,expectedPort:await freePort()})).rejects.toThrow('conflict');expect(await fs.readFile(join(f[side],'new'),'utf8')).toBe('external');
});
test('reject live port and missing confirmation',async()=>{
 const f=await fixture(), s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r)); const port=(s.address() as any).port;
 try {await expect(apply(f.p,{confirmed:true,expectedPort:port})).rejects.toThrow('listening');await expect(apply(f.p,{confirmed:false,expectedPort:port})).rejects.toThrow('confirmation');} finally {s.close();}
});
test('reject nesting, symlinks, lock, transaction marker and backup conflict',async()=>{
 const f=await fixture();await expect(plan(f.source,join(f.source,'demo'),f.backup)).rejects.toThrow('Nested');
 await fs.symlink(f.source,join(f.root,'alias'),'dir');await expect(plan(join(f.root,'alias'),f.target,f.backup)).rejects.toThrow('Symlink');
 await fs.symlink('source.wav',join(f.source,'bad'));await expect(plan(f.source,f.target,f.backup)).rejects.toThrow('regular');await fs.unlink(join(f.source,'bad'));
 for(const n of ['.chengfeng-videocut.write.lock','.videocut-transaction.json']){await fs.writeFile(join(f.source,n),'held');await expect(plan(f.source,f.target,f.backup)).rejects.toThrow('marker');await fs.unlink(join(f.source,n));}
 await fs.mkdir(f.backup);await expect(apply(f.p,{confirmed:true,expectedPort:await freePort()})).rejects.toThrow('already exists');
});
test('recovery rejects edited published tree without mutation',async()=>{
 const f=await fixture(),port=await freePort();await apply(f.p,{confirmed:true,expectedPort:port});await fs.writeFile(join(f.target,'user-edit'),'keep');
 await expect(recover(f.backup,port)).rejects.toThrow('External target');expect(await fs.readlink(f.source)).toBe(f.target);expect(await fs.readFile(join(f.target,'user-edit'),'utf8')).toBe('keep');
});
test('reject manifest tamper and recovery after subsequent edits',async()=>{
 const f=await fixture(),port=await freePort(); await expect(apply({...f.p,digest:'bad'},{confirmed:true,expectedPort:port})).rejects.toThrow('digest');
 await apply(f.p,{confirmed:true,expectedPort:port});await recover(f.backup,port);await fs.writeFile(join(f.source,'new-edit'),'preserve');await expect(recover(f.backup,port)).rejects.toThrow('External edits');
});
test('target ancestor symlink is rejected',async()=>{
 const f=await fixture();await fs.symlink(join(f.root,'works'),join(f.root,'works-alias'),'dir');await expect(plan(f.source,join(f.root,'works-alias','demo'),f.backup)).rejects.toThrow('Symlink');
});
test.skipIf(!process.env.HANDOFF_REAL_SOURCE)('real project isolated copy handoff and recovery',async()=>{
 const f=await fixture();
 // Existing fixture source is moved aside, never destroyed; real source is read-only.
 await fs.rename(f.source,join(f.root,'small-fixture'));
 await fs.cp(process.env.HANDOFF_REAL_SOURCE!,f.source,{recursive:true,errorOnExist:true,force:false});
 const p=await plan(f.source,f.target,f.backup),port=await freePort();
 await apply(p,{confirmed:true,expectedPort:port});expect(await manifest(join(f.backup,'source'))).toEqual(p.sourceFiles);
 await recover(f.backup,port);expect(await manifest(f.source)).toEqual(p.sourceFiles);expect(await manifest(f.target)).toEqual(p.targetFiles);
 console.log(JSON.stringify({isolatedRealProject:f.root,files:Object.keys(p.sourceFiles).length,manifestDigest:p.digest,restored:true}));
},30000);
