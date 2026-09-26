#!/usr/bin/env node
'use strict';
// Trusted local orchestrator. Never executes code from packages or downloads floating sources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { run: single } = require('./skill-package-installer.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function run(argv) {
  const command = argv[0] || 'help';
  if (['help', '--help', '-h'].includes(command)) return { help: 'plan|install|doctor --catalog <local-json> --workspace <existing-root> --target-root <existing-home> [--host agents|codex] [--ids id,id]. Local files only; defaults select defaultInstall=true. No Runtime setup, downloads or host-load claim.' };
  if (!['plan', 'install', 'doctor'].includes(command)) throw new Error('Unknown command');
  const opts = {};
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!['--catalog', '--workspace', '--target-root', '--host', '--ids'].includes(k) || !v || v.startsWith('--') || Object.hasOwn(opts, k)) throw new Error('Invalid arguments');
    opts[k] = v;
  }
  for (const key of ['--catalog', '--workspace', '--target-root']) if (!opts[key]) throw new Error(`Required: ${key}`);
  const workspace = fs.realpathSync(opts['--workspace']);
  const bytes = fs.readFileSync(opts['--catalog']), catalog = JSON.parse(bytes);
  if (catalog.schemaVersion !== 1 || catalog.status !== 'local-candidate' || !Array.isArray(catalog.skills)) throw new Error('Expected local candidate catalog');
  const ids = opts['--ids']?.split(',');
  if (ids && (ids.some(x => !x) || new Set(ids).size !== ids.length)) throw new Error('Invalid IDs');
  const seen = new Set();
  for (const item of catalog.skills) {
    if (typeof item.id !== 'string' || seen.has(item.id) || typeof item.defaultInstall !== 'boolean') throw new Error('Invalid/duplicate catalog identity');
    seen.add(item.id);
  }
  if (ids?.some(id => !seen.has(id))) throw new Error('Unknown selected ID');
  const items = catalog.skills.filter(x => ids ? ids.includes(x.id) : x.defaultInstall);
  if (!items.length) throw new Error('Empty selection');
  const args = ['--target-root', opts['--target-root'], '--host', opts['--host'] || 'agents'];
  // Preflight ALL selected source hashes and destinations before the first install.
  const packages = items.map(item => {
    if (typeof item.directory !== 'string' || !item.directory || /[\\/:]/.test(item.directory) || ['.', '..'].includes(item.directory)) throw new Error('Unsafe package directory');
    const root = path.join(workspace, item.directory);
    if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error('Unsafe package source');
    const manifestPath = path.join(root, 'skill-package.json');
    if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Unsafe package manifest');
    const data = fs.readFileSync(manifestPath), m = JSON.parse(data);
    if (sha(data) !== item.packageManifestSha256 || m.id !== item.id || m.version !== item.version || m.skillPath !== item.skillPath || sha(JSON.stringify(m.files)) !== item.contentSha256) throw new Error(`Catalog identity/hash mismatch: ${item.id}`);
    return { root, plan: single(['plan', ...args], root) };
  });
  const result = { schemaVersion: 1, status: command === 'plan' ? 'planned' : 'files-verified', catalogSha256: sha(bytes), results: [], runtime: 'not-checked', hostLoaded: 'not-checked' };
  for (const item of packages) {
    try {
      result.results.push(command === 'plan' ? item.plan : single([command, ...args], item.root));
    } catch (error) {
      // A race/IO error can occur after preflight. Retain successful packages for safe retry.
      result.status = 'partial'; result.failed = { id: item.plan.id, error: error.message };
      return result;
    }
  }
  return result;
}
if (require.main === module) {
  try { const result = run(process.argv.slice(2)); console.log(JSON.stringify(result, null, 2)); if (result.status === 'partial') process.exitCode = 1; }
  catch (error) { console.error(`Skill suite: ${error.message}`); process.exitCode = 1; }
}
module.exports = { run };
