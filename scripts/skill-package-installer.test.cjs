'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { run } = require('./skill-package-installer.cjs');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function fixture(t, id = 'chengfeng-videocut-test') {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'skill 安装 test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const pkg = path.join(base, 'package 空格'), home = path.join(base, 'home 中文');
  const source = path.join(pkg, '.agents', 'skills', id), target = path.join(home, '.agents', 'skills', id);
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# Test\n');
  fs.mkdirSync(path.join(source, 'references')); fs.writeFileSync(path.join(source, 'references', 'readme.md'), 'reference');
  const manifest = { schemaVersion: 1, id, version: '0.1.0-local.1', skillPath: `.agents/skills/${id}`, files: { 'SKILL.md': hash('# Test\n'), 'references/readme.md': hash('reference') }, runtime: {}, publication: { status: 'local-candidate' } };
  const save = () => fs.writeFileSync(path.join(pkg, 'skill-package.json'), JSON.stringify(manifest)); save();
  fs.mkdirSync(path.join(pkg, 'bin')); const bin = path.join(pkg, 'bin/install.cjs'); fs.copyFileSync(path.join(__dirname, 'skill-package-installer.cjs'), bin);
  return { base, pkg, home, source, target, manifest, save, bin, exec: (...args) => run([...args, '--target-root', home], pkg) };
}
test('help defaults to no filesystem writes, CLI template works', t => {
  const f = fixture(t); assert.match(run([], '/nonexistent').help, /no writes/);
  const p = spawnSync(process.execPath, [f.bin], { encoding: 'utf8' }); assert.equal(p.status, 0); assert.match(p.stdout, /no writes/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test('install, reuse, doctor, Chinese/space path, Codex precise entry', t => {
  const f = fixture(t); assert.equal(f.exec('install', '--host', 'codex').status, 'installed');
  assert.equal(f.exec('install', '--host', 'codex').status, 'reused');
  const d = f.exec('doctor', '--host', 'codex'); assert.equal(d.status, 'verified'); assert.equal(d.runtime, 'not-checked');
  assert.equal(fs.realpathSync(path.join(f.home, '.codex/skills', f.manifest.id)), f.target);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)), [f.manifest.id]);
});
for (const mutation of ['tamper', 'extra', 'identity', 'symlink']) test(`installed ${mutation} is refused without overwrite`, t => {
  const f = fixture(t); f.exec('install');
  if (mutation === 'tamper') fs.writeFileSync(path.join(f.target, 'SKILL.md'), 'user edit');
  if (mutation === 'extra') fs.writeFileSync(path.join(f.target, 'extra.txt'), 'user file');
  if (mutation === 'identity') fs.writeFileSync(path.join(f.target, '.skill-install.json'), '{}');
  if (mutation === 'symlink') fs.symlinkSync(f.source, path.join(f.target, 'extra-link'), 'dir');
  const before = fs.readFileSync(path.join(f.target, 'SKILL.md'), 'utf8');
  assert.throws(() => f.exec('doctor')); assert.throws(() => f.exec('install'));
  assert.equal(fs.readFileSync(path.join(f.target, 'SKILL.md'), 'utf8'), before);
});
for (const mutation of ['missing-hash', 'bad-hash', 'source-link', 'path-traversal', 'skillpath', 'id', 'reserved', 'case-collision']) test(`source rejects ${mutation} before writes`, t => {
  const f = fixture(t);
  if (mutation === 'missing-hash') delete f.manifest.files['references/readme.md'];
  if (mutation === 'bad-hash') f.manifest.files['SKILL.md'] = 'a'.repeat(64);
  if (mutation === 'source-link') fs.symlinkSync(f.home, path.join(f.source, 'link'), 'dir');
  if (mutation === 'path-traversal') f.manifest.files['../escape'] = hash('bad');
  if (mutation === 'skillpath') f.manifest.skillPath = '../escape';
  if (mutation === 'id') f.manifest.id = '../../escape';
  if (mutation === 'reserved') f.manifest.files['.skill-install.json'] = hash('bad');
  if (mutation === 'case-collision') f.manifest.files['skill.md'] = hash('bad');
  f.save(); assert.throws(() => f.exec('install')); assert.deepEqual(fs.readdirSync(f.home), []);
});
test('existing target entity and Codex entity conflicts do not change old content', t => {
  const f = fixture(t); fs.mkdirSync(f.target, { recursive: true }); fs.writeFileSync(path.join(f.target, 'keep'), 'old');
  assert.throws(() => f.exec('install')); assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'old');
  fs.rmSync(f.target, { recursive: true });
  const link = path.join(f.home, '.codex/skills', f.manifest.id); fs.mkdirSync(link, { recursive: true }); fs.writeFileSync(path.join(link, 'keep'), 'old');
  assert.throws(() => f.exec('install', '--host', 'codex'), /conflict/); assert.equal(fs.existsSync(f.target), false); assert.equal(fs.readFileSync(path.join(link, 'keep'), 'utf8'), 'old');
});
test('target ancestry and incorrect Codex link are refused', t => {
  const f = fixture(t); const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.home, '.agents'), 'dir');
  assert.throws(() => f.exec('install'), /Unsafe/); assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(f.home, '.agents')); fs.mkdirSync(path.join(f.home, '.codex/skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(f.home, '.codex/skills', f.manifest.id), 'dir');
  assert.throws(() => f.exec('install', '--host', 'codex'), /conflict/);
});
test('doctor requires requested host entry and detects replaced link', t => {
  const f = fixture(t); f.exec('install'); assert.throws(() => f.exec('doctor', '--host', 'codex'), /missing/);
  f.exec('install', '--host', 'codex'); const link = path.join(f.home, '.codex/skills', f.manifest.id); fs.unlinkSync(link); fs.symlinkSync(f.source, link, 'dir');
  assert.throws(() => f.exec('doctor', '--host', 'codex'), /mismatch/);
});
test('same-name process competition leaves one verified tree and no staging debris', async t => {
  const f = fixture(t);
  const launch = () => new Promise(resolve => { const p = spawn(process.execPath, [f.bin, 'install', '--target-root', f.home]); let err = ''; p.stderr.on('data', d => err += d); p.on('exit', code => resolve({ code, err })); });
  const results = await Promise.all(Array.from({ length: 6 }, launch));
  assert.ok(results.some(r => r.code === 0)); for (const r of results) if (r.code !== 0) assert.match(r.err, /Install busy/);
  assert.equal(f.exec('doctor').status, 'verified'); assert.deepEqual(fs.readdirSync(path.dirname(f.target)), [f.manifest.id]);
});
test('two independent package ids never reuse each other', t => {
  const a = fixture(t, 'chengfeng-videocut-alpha'), b = fixture(t, 'chengfeng-videocut-beta');
  a.exec('install'); run(['install', '--target-root', a.home], b.pkg);
  assert.deepEqual(fs.readdirSync(path.dirname(a.target)).sort(), ['chengfeng-videocut-alpha', 'chengfeng-videocut-beta']);
  assert.equal(run(['doctor', '--target-root', a.home], b.pkg).id, 'chengfeng-videocut-beta');
});
test('invalid arguments and unsupported host cause no writes', t => {
  const f = fixture(t); for (const args of [['nope'], ['install', '--host', 'claude'], ['install', '--unknown', 'x'], ['install', '--host']]) assert.throws(() => f.exec(...args));
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test('copy failure removes staging and does not leave an installed tree', t => {
  const f = fixture(t), original = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error('injected copy failure'); };
  try { assert.throws(() => f.exec('install'), /injected copy failure/); }
  finally { fs.copyFileSync = original; }
  assert.equal(fs.existsSync(f.target), false); assert.deepEqual(fs.readdirSync(path.dirname(f.target)), []);
});
test('link failure rolls back new tree but preserves an identical old installation', t => {
  const f = fixture(t), original = fs.symlinkSync;
  fs.symlinkSync = () => { throw new Error('injected link failure'); };
  try { assert.throws(() => f.exec('install', '--host', 'codex'), /injected link failure/); }
  finally { fs.symlinkSync = original; }
  assert.equal(fs.existsSync(f.target), false); f.exec('install');
  fs.symlinkSync = () => { throw new Error('injected link failure'); };
  try { assert.throws(() => f.exec('install', '--host', 'codex'), /injected link failure/); }
  finally { fs.symlinkSync = original; }
  assert.equal(f.exec('doctor').status, 'verified');
});
test('version mismatch cannot overwrite an old installation', t => {
  const f = fixture(t); f.exec('install'); const record = fs.readFileSync(path.join(f.target, '.skill-install.json'), 'utf8');
  f.manifest.version = '0.1.1-local.1'; f.save(); assert.throws(() => f.exec('install'), /identity mismatch/);
  assert.equal(fs.readFileSync(path.join(f.target, '.skill-install.json'), 'utf8'), record);
});
test('different package process installs may proceed concurrently without mixing', async t => {
  const a = fixture(t, 'chengfeng-videocut-one'), b = fixture(t, 'chengfeng-videocut-two');
  const launch = f => new Promise(resolve => { const p = spawn(process.execPath, [f.bin, 'install', '--target-root', a.home]); let err = ''; p.stderr.on('data', d => err += d); p.on('exit', code => resolve({ code, err })); });
  for (const result of await Promise.all([launch(a), launch(b)])) assert.equal(result.code, 0, result.err);
  assert.equal(a.exec('doctor').id, a.manifest.id); assert.equal(run(['doctor', '--target-root', a.home], b.pkg).id, b.manifest.id);
});
