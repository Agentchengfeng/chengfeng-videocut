/** Stopped-service project handoff. No daemon control, no automatic recovery. */
import * as fs from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';

type Manifest = Record<string, { bytes: number; sha256: string }>;
export type Plan = { version: 1; source: string; target: string; backupRoot: string; sourceFiles: Manifest; targetFiles: Manifest; digest: string };
type Journal = { plan: Plan; phase: string; expectedPublished: Manifest; targetOld: string; staging: string };
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const exists = async (p: string) => fs.lstat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
const within = (a: string, b: string) => { const r = relative(a, b); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
async function safeParents(p: string) {
  for (let q = resolve(p); ; q = dirname(q)) {
    if (await exists(q)) { const s = await fs.lstat(q); if (s.isSymbolicLink()) throw Error(`Symlink path: ${q}`); }
    if (dirname(q) === q) break;
  }
}
export async function manifest(root: string): Promise<Manifest> {
  const out: Manifest = {};
  async function walk(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (name === '.chengfeng-videocut.write.lock' || name === '.videocut-transaction.json') throw Error(`Active lock/transaction marker: ${name}`);
      const p = join(dir, name), s = await fs.lstat(p);
      if (s.isDirectory()) await walk(p);
      else if (s.isFile()) out[relative(root, p)] = { bytes: s.size, sha256: hash(await fs.readFile(p)) };
      else throw Error(`Not a regular file/directory: ${p}`);
    }
  }
  await safeParents(root); await walk(root); return out;
}
async function closure(root: string) {
  const read = async (f: string) => JSON.parse(await fs.readFile(join(root, f), 'utf8'));
  const edl = await read('edit-list.json'), visuals = await read('visuals.json');
  const check = async (p: string, sha?: string) => {
    if (isAbsolute(p) || !within(root, resolve(root, p))) throw Error(`External active reference: ${p}`);
    const file = resolve(root, p); if (!(await fs.stat(file)).isFile()) throw Error(`Missing regular reference: ${p}`);
    if (sha && hash(await fs.readFile(file)) !== sha) throw Error(`Media digest mismatch: ${p}`);
  };
  if (edl.schemaVersion !== 2 || !Array.isArray(edl.sources)) throw Error('Handoff currently requires explicit v2 source manifest');
  for (const s of edl.sources) { if(!/^[a-f0-9]{64}$/.test(s.sha256)) throw Error('Missing source digest'); await check(s.path, s.sha256); }
  for(const segment of edl.segments ?? []) if(!edl.sources.some((s:any)=>s.path===segment.source)) throw Error('Segment references an undeclared source');
  for (const layer of visuals.layers) {
    if (!layer.media || !/^[a-f0-9]{64}$/.test(layer.media.assetId)) throw Error('Only verified project-local media layers supported');
    const id = layer.media.assetId, folder = `.chengfeng-videocut/media/${id}`;
    const m = await read(`${folder}/manifest.json`);
    if (m.assetId !== id || m.sha256 !== id) throw Error('Invalid media manifest');
    const files = (await fs.readdir(join(root, folder))).filter(f => f !== 'manifest.json');
    if (files.length !== 1) throw Error('Ambiguous media asset');
    await check(`${folder}/${files[0]}`, id);
  }
}
export async function plan(source: string, target: string, backupRoot: string): Promise<Plan> {
  [source, target, backupRoot] = [source, target, backupRoot].map(p => resolve(p));
  for (const p of [source, target, backupRoot]) await safeParents(p);
  for (const [a,b] of [[source,target],[source,backupRoot],[target,backupRoot]]) if (within(a,b) || within(b,a)) throw Error('Nested/identical paths rejected');
  if (within(dirname(source), backupRoot)) throw Error('Backup must be outside registry root');
  if (await exists(backupRoot)) throw Error('Backup destination already exists');
  if (basename(source) !== basename(target)) throw Error('Project id must remain unchanged');
  if (!(await exists(join(source, 'index.html')))) throw Error('Missing project entrypoint');
  const sourceFiles = await manifest(source), targetFiles = await exists(target) ? await manifest(target) : {};
  if(await exists(target) && !Object.keys(targetFiles).length) throw Error('Existing empty target is ambiguous');
  await closure(source);
  const data = { version: 1 as const, source, target, backupRoot, sourceFiles, targetFiles };
  return {...data, digest: hash(JSON.stringify(data))};
}
async function stopped(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Explicit expectedPort required');
  for (const host of ['127.0.0.1','::1']) await new Promise<void>((ok, fail) => {
    const s = createConnection({host,port});
    s.once('connect', () => { s.destroy(); fail(Error(`Service still listening: ${host}:${port}`)); });
    s.once('error', (e: NodeJS.ErrnoException) => { s.destroy(); if (e.code === 'ECONNREFUSED' || (host === '::1' && e.code === 'EAFNOSUPPORT')) ok(); else fail(e); });
    s.setTimeout(1000, () => { s.destroy(); fail(Error('Port state unknown')); });
  });
}
function validatePlan(p: Plan) { const {digest,...data} = p; if (hash(JSON.stringify(data)) !== digest || p.version !== 1) throw Error('Plan digest mismatch'); }
async function save(j: Journal) { const p = join(j.plan.backupRoot,'journal.json'); await fs.writeFile(p+'.tmp', JSON.stringify(j,null,2)); await fs.rename(p+'.tmp',p); }
async function locks(p: Plan, fn: () => Promise<void>, recoverDead = false) {
  const paths = [p.source+'.handoff-lock',p.target+'.handoff-lock'].sort(), held: string[] = [];
  try { for(const q of paths) {
    if(recoverDead && await exists(q)) {
      await safeParents(q); const entries=await fs.readdir(q);
      if(!equal(entries,['owner.json'])) throw Error('Unknown handoff lock owner');
      const owner=JSON.parse(await fs.readFile(join(q,'owner.json'),'utf8'));
      if(owner.digest!==p.digest || !Number.isInteger(owner.pid) || owner.pid<1) throw Error('Unknown handoff lock owner');
      let dead=false; try {process.kill(owner.pid,0);} catch(e:any) {if(e.code==='ESRCH') dead=true;else throw e;}
      if(!dead) throw Error('Handoff lock owner still alive');
      await fs.unlink(join(q,'owner.json')); await fs.rmdir(q);
    }
    await fs.mkdir(q); held.push(q); await fs.writeFile(join(q,'owner.json'),JSON.stringify({pid:process.pid,digest:p.digest}));
  } await fn(); }
  finally { for(const q of held.reverse()) {await fs.unlink(join(q,'owner.json'));await fs.rmdir(q);} }
}
async function matches(p: string, m: Manifest) { if (!await exists(p)) return false; return equal(await manifest(p),m); }
export async function apply(p: Plan, options: {confirmed: boolean; expectedPort: number; failAfter?: string}) {
  validatePlan(p); if (!options.confirmed) throw Error('Explicit confirmation required'); await stopped(options.expectedPort);
  for(const q of [dirname(p.source),p.target,p.backupRoot]) await safeParents(q);
  await locks(p, async () => {
    if (await exists(join(p.backupRoot,'journal.json'))) {
      const j: Journal = JSON.parse(await fs.readFile(join(p.backupRoot,'journal.json'),'utf8'));
      if (j.plan.digest === p.digest && j.phase === 'committed' && await matches(p.target,j.expectedPublished) && await fs.readlink(p.source) === p.target) return;
      throw Error('Existing journal: explicit recovery required');
    }
    const fresh = await plan(p.source,p.target,p.backupRoot); if (fresh.digest !== p.digest) throw Error('Source/target manifest conflict');
    if ((await fs.stat(p.source)).dev !== (await fs.stat(dirname(p.backupRoot))).dev) throw Error('backupRoot must share source filesystem');
    await fs.mkdir(p.backupRoot);
    const suffix = p.digest.slice(0,16);
    const j: Journal = {plan:p,phase:'prepared',expectedPublished:{},targetOld:p.target+'.handoff-old-'+suffix,staging:p.target+'.handoff-stage-'+suffix};
    if (await exists(j.targetOld) || await exists(j.staging)) throw Error('Reserved target path conflict');
    await save(j);
    const step = async (phase: string) => { j.phase=phase; await save(j); if(options.failAfter===phase) throw Error(`Injected failure: ${phase}`); };
    await fs.cp(p.source,j.staging,{recursive:true,errorOnExist:true,force:false});
    if (!await matches(j.staging,p.sourceFiles)) throw Error('Staging mismatch');
    const wb = join(j.staging,'workbench.json'), doc = JSON.parse(await fs.readFile(wb,'utf8'));
    doc.jobDir=p.target; await fs.writeFile(wb,JSON.stringify(doc,null,2)+'\n');
    j.expectedPublished=await manifest(j.staging);
    for(const [f,v] of Object.entries(p.sourceFiles)) if(f!=='workbench.json' && !equal(v,j.expectedPublished[f])) throw Error('Unexpected staging difference');
    await closure(j.staging); await step('staged');
    if(Object.keys(p.targetFiles).length) { await fs.cp(p.target,join(p.backupRoot,'target-copy'),{recursive:true,errorOnExist:true,force:false}); if(!await matches(join(p.backupRoot,'target-copy'),p.targetFiles)) throw Error('Target backup mismatch'); }
    await stopped(options.expectedPort);
    if (!await matches(p.source,p.sourceFiles) || (Object.keys(p.targetFiles).length ? !await matches(p.target,p.targetFiles) : await exists(p.target))) throw Error('Final manifest conflict');
    if(await exists(p.target)) await fs.rename(p.target,j.targetOld); await step('target-retained');
    await fs.rename(j.staging,p.target); await step('target-published');
    await fs.rename(p.source,join(p.backupRoot,'source')); await step('source-retained');
    await fs.symlink(p.target,p.source,'dir'); await step('linked');
    if(!await matches(p.target,j.expectedPublished) || await fs.realpath(p.source)!==await fs.realpath(p.target)) throw Error('Final readback mismatch');
    await step('committed');
  });
}
export async function recover(backupRoot: string, expectedPort: number) {
  await safeParents(backupRoot);
  const j: Journal=JSON.parse(await fs.readFile(join(backupRoot,'journal.json'),'utf8')), p=j.plan;
  validatePlan(p); if(resolve(backupRoot)!==p.backupRoot) throw Error('Journal path mismatch'); await stopped(expectedPort);
  const suffix=p.digest.slice(0,16);
  if(j.targetOld!==p.target+'.handoff-old-'+suffix || j.staging!==p.target+'.handoff-stage-'+suffix) throw Error('Journal destinations mismatch');
  for(const q of [dirname(p.source),p.target,j.staging,j.targetOld]) await safeParents(q);
  await locks(p,async()=>{
    if(j.phase==='rolled-back') { if(!await matches(p.source,p.sourceFiles) || (Object.keys(p.targetFiles).length && !await matches(p.target,p.targetFiles))) throw Error('External edits after recovery'); return; }
    const sourceBackup=join(p.backupRoot,'source'), sourceMoved=await exists(sourceBackup), sourceExists=await exists(p.source);
    if(!sourceMoved && !sourceExists) throw Error('Source and backup both missing');
    if(sourceMoved && !await matches(sourceBackup,p.sourceFiles)) throw Error('Source backup changed');
    if(sourceExists) { const s=await fs.lstat(p.source); if(s.isSymbolicLink()) {if(!sourceMoved || await fs.readlink(p.source)!==p.target) throw Error('Unexpected registry link');} else if(!await matches(p.source,p.sourceFiles)) throw Error('External source edit'); }
    const oldExists=await exists(j.targetOld), targetExists=await exists(p.target);
    if(oldExists && !await matches(j.targetOld,p.targetFiles)) throw Error('Old target changed');
    const published=targetExists && await matches(p.target,j.expectedPublished);
    if(targetExists && !published && !await matches(p.target,p.targetFiles)) throw Error('External target edit');
    if(await exists(j.staging) && Object.keys(j.expectedPublished).length && !await matches(j.staging,j.expectedPublished)) throw Error('Staging changed');
    const retained=join(dirname(p.target),basename(p.target)+'.handoff-recovered-'+p.digest.slice(0,16));
    if(published && await exists(retained)) throw Error('Recovery retention conflict');
    // All conflicts checked before touching any entry. Preserve every data tree.
    if(sourceMoved) { if(sourceExists) await fs.unlink(p.source); await fs.rename(sourceBackup,p.source); }
    if(published) await fs.rename(p.target,retained);
    if(oldExists) await fs.rename(j.targetOld,p.target);
    j.phase='rolled-back'; await save(j);
  },true);
}
if(import.meta.main) {
  const [command,...args]=process.argv.slice(2), get=(n:string)=>{const i=args.indexOf('--'+n); if(i<0 || !args[i+1] || args[i+1].startsWith('--')) throw Error(`Missing --${n}`); return args[i+1];};
  try {
    if(command==='plan') console.log(JSON.stringify(await plan(get('source'),get('target'),get('backup-root')),null,2));
    else if(command==='apply') { await apply(JSON.parse(await fs.readFile(get('plan'),'utf8')),{confirmed:args.includes('--confirmed'),expectedPort:Number(get('expected-port'))}); console.log('committed'); }
    else if(command==='recover') { await recover(get('backup-root'),Number(get('expected-port'))); console.log('rolled-back'); }
    else throw Error('Use plan --source --target --backup-root; apply --plan --confirmed --expected-port; recover --backup-root --expected-port');
  } catch(e) { console.error(String(e)); process.exitCode=1; }
}
