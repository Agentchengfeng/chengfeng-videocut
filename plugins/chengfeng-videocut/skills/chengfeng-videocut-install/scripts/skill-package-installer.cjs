#!/usr/bin/env node
'use strict';
// Copied unchanged to bin/install.cjs in each independent Skill package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const RECORD = '.skill-install.json';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
function stat(p) { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function directory(p) { const s = stat(p); if (!s || s.isSymbolicLink() || !s.isDirectory()) fail(`Unsafe directory: ${p}`); }
function safeRelative(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.includes(':') &&
    !p.includes('\0') && p.split('/').every(x => x && x !== '.' && x !== '..' && !/[. ]$/.test(x) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(x));
}
function tree(root, installed = false) {
  directory(root);
  const files = {};
  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (!safeRelative(rel)) fail(`Unsafe filename: ${rel}`);
      const p = path.join(dir, name), s = fs.lstatSync(p);
      if (s.isSymbolicLink()) fail(`Symlink not allowed: ${rel}`);
      if (s.isDirectory()) walk(p, rel);
      else if (s.isFile()) {
        if (installed && rel === RECORD) continue;
        files[rel] = hash(fs.readFileSync(p));
      } else fail(`Unsupported file: ${rel}`);
    }
  }
  walk(root, '');
  return files;
}
function stableFiles(files) { return Object.fromEntries(Object.keys(files).sort().map(k => [k, files[k]])); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function packageInfo(root) {
  directory(root);
  const manifestPath = path.join(root, 'skill-package.json');
  if (!stat(manifestPath)?.isFile() || stat(manifestPath).isSymbolicLink()) fail('Unsafe package manifest');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.schemaVersion !== 1 || typeof m.id !== 'string' || !/^chengfeng-videocut-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id) || m.id.length > 100) fail('Invalid package identity');
  if (typeof m.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(m.version)) fail('Invalid version');
  if (m.skillPath !== `.agents/skills/${m.id}`) fail('Invalid skillPath');
  if (!m.files || Array.isArray(m.files) || typeof m.files !== 'object' || !Object.hasOwn(m.files, 'SKILL.md')) fail('Missing file hashes');
  const names = Object.keys(m.files), folded = new Set();
  for (const name of names) {
    if (!safeRelative(name) || name === RECORD || !/^[a-f0-9]{64}$/.test(m.files[name])) fail(`Invalid file hash/path: ${name}`);
    const fold = name.toLowerCase();
    if (folded.has(fold)) fail('Case-colliding file paths');
    folded.add(fold);
  }
  let source = root;
  for (const segment of m.skillPath.split('/')) { source = path.join(source, segment); directory(source); }
  const files = stableFiles(m.files);
  if (!same(tree(source), files)) fail('Source content/hash mismatch (missing or extra files)');
  const identity = { schemaVersion: 1, id: m.id, version: m.version, files };
  return { source, id: m.id, identity, digest: hash(JSON.stringify(identity)) };
}
function checkedPath(root, segments, create = false) {
  let p = root;
  for (const segment of segments) {
    p = path.join(p, segment);
    if (!stat(p)) { if (create) { try { fs.mkdirSync(p); } catch (e) { if (e.code !== 'EEXIST') throw e; } } else continue; }
    if (stat(p)) directory(p);
  }
  return p;
}
function verifyInstalled(target, info) {
  directory(target);
  const recordPath = path.join(target, RECORD), s = stat(recordPath);
  if (!s?.isFile() || s.isSymbolicLink()) fail('Installed identity record missing/unsafe');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  if (!same(record, { ...info.identity, digest: info.digest })) fail('Installed identity mismatch');
  if (!same(tree(target, true), info.identity.files)) fail('Installed content/hash mismatch (missing or extra files)');
}
function checkLink(link, target, required = false) {
  const s = stat(link);
  if (!s) { if (required) fail('Requested Codex entry is missing'); return false; }
  if (!s.isSymbolicLink()) fail('Codex entry conflict: existing entity is not a link');
  if (path.resolve(path.dirname(link), fs.readlinkSync(link)) !== target) fail('Codex entry conflict: link target mismatch');
  if (required && fs.realpathSync(link) !== fs.realpathSync(target)) fail('Codex link readback mismatch');
  return true;
}
function run(argv, packageRoot = path.resolve(__dirname, '..')) {
  const command = argv[0] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    return { help: 'plan|install|doctor [--target-root <home>] [--host agents|codex]. Default: help (no writes). Installs files only; no Runtime setup or host-load claim.' };
  }
  if (!['plan', 'install', 'doctor'].includes(command)) fail('Unknown command');
  let host = 'agents', root = os.homedir();
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!['--host', '--target-root'].includes(flag) || !value || value.startsWith('--') || seen.has(flag)) fail('Invalid arguments');
    seen.add(flag);
    if (flag === '--host') host = value; else root = path.resolve(value);
  }
  if (!['agents', 'codex'].includes(host)) fail('Unsupported host; use agents or codex');
  const info = packageInfo(packageRoot);
  // The selected home must already exist. It is the trust boundary, never created implicitly.
  directory(root); root = fs.realpathSync(root);
  const parent = checkedPath(root, ['.agents', 'skills']);
  const target = path.join(parent, info.id);
  const linkParent = host === 'codex' ? checkedPath(root, ['.codex', 'skills']) : null;
  const link = linkParent && path.join(linkParent, info.id);
  if (link) checkLink(link, target, command === 'doctor');
  if (command === 'doctor') {
    verifyInstalled(target, info);
    return { status: 'verified', id: info.id, target, digest: info.digest, host, runtime: 'not-checked', hostLoaded: 'not-checked' };
  }
  if (stat(target)) verifyInstalled(target, info); // Conflicts fail before mutations.
  if (command === 'plan') return { status: stat(target) ? 'reuse' : 'ready-to-install', id: info.id, target, digest: info.digest, host, runtime: 'not-checked', hostLoaded: 'not-checked' };
  checkedPath(root, ['.agents', 'skills'], true);
  const lock = path.join(parent, `.${info.id}.install-lock`);
  try { fs.mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') fail('Install busy: same package lock exists; inspect before removing stale lock'); throw e; }
  let stage, createdTarget = false, createdLink = false, reused = false;
  try {
    checkedPath(root, ['.agents', 'skills']);
    if (link) { checkedPath(root, ['.codex', 'skills']); checkLink(link, target); }
    if (stat(target)) { verifyInstalled(target, info); reused = true; }
    else {
      stage = fs.mkdtempSync(path.join(parent, `.${info.id}.stage-`));
      for (const name of Object.keys(info.identity.files)) {
        const destination = path.join(stage, ...name.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(info.source, ...name.split('/')), destination, fs.constants.COPYFILE_EXCL);
      }
      fs.writeFileSync(path.join(stage, RECORD), JSON.stringify({ ...info.identity, digest: info.digest }, null, 2) + '\n', { flag: 'wx' });
      verifyInstalled(stage, info);
      if (stat(target)) fail('Target appeared during install');
      fs.renameSync(stage, target); stage = undefined; createdTarget = true;
    }
    if (link) {
      checkedPath(root, ['.codex', 'skills'], true);
      if (!checkLink(link, target)) { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); createdLink = true; }
      checkLink(link, target, true);
    }
    verifyInstalled(target, info);
    return { status: reused ? 'reused' : 'installed', id: info.id, target, digest: info.digest, host, runtime: 'not-checked', hostLoaded: 'not-checked' };
  } catch (error) {
    if (createdLink) fs.unlinkSync(link);
    if (createdTarget) fs.rmSync(target, { recursive: true });
    throw error;
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true });
    fs.rmdirSync(lock);
  }
}
if (require.main === module) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(`Skill installer: ${error.message}`); process.exitCode = 1; }
}
module.exports = { run };
