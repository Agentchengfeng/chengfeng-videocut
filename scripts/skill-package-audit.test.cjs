'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { audit, auditSource, uploadPolicy, wrappers, publishingGuide } = require('./skill-package-audit.cjs');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
function fixture(t, suffix = 'cut') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-publication-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = `chengfeng-videocut-${suffix}`, skillPath = `.agents/skills/${id}`;
  const write = (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
  const files = { 'SKILL.md': sha('public method') };
  const manifest = { id, skillPath, files, publication: { status: 'local-candidate', upload: uploadPolicy(id) } };
  write(`${skillPath}/SKILL.md`, 'public method');
  for (const name of wrappers) write(name, 'public wrapper');
  write('.gitignore', '.产品记录/\n.env\n');
  write('skill-package.json', JSON.stringify(manifest));
  write('PUBLISHING.md', publishingGuide(manifest));
  write('bin/check-package.cjs', fs.readFileSync(path.join(__dirname, 'skill-package-audit.cjs')));
  write('package.json', JSON.stringify({ name: id, version: '0.0.0-test', private: true, files: [...wrappers, skillPath] }));
  const paths = [...wrappers, `${skillPath}/SKILL.md`];
  const check = options => audit(root, { packPaths: paths, ...options });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return { root, id, skillPath, files, manifest, paths, write, check, git };
}
test('clean candidate and real npm inventory pass; helper never claims release readiness', t => {
  const f = fixture(t);
  assert.equal(f.check({ upload: true }).status, 'passed');
  const result = audit(f.root);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.packedFiles, f.paths.length);
  assert.equal(result.releaseReady, false);
  assert.ok(!fs.readdirSync(f.root).some(x => x.endsWith('.tgz')));
});
test('workbench is an independent candidate, not proof of Runtime compatibility', t => {
  const f = fixture(t, 'workbench');
  const result = f.check({ upload: true });
  assert.equal(result.status, 'passed');
  assert.equal(result.uploadDecision, 'independent-candidate');
  assert.equal(result.releaseReady, false);
});
test('known private/cache/receipt/media/key paths and source symlinks fail closed', t => {
  for (const rel of ['references/.env', 'assets/.产品记录/设计.md', '.skill-install.json', 'scripts/node_modules/pkg.js', 'references/run.log', 'assets/user.mp4', 'scripts/id_ed25519', 'references/cookies.json']) {
    const f = fixture(t); f.write(`${f.skillPath}/${rel}`, 'private test data');
    assert.equal(f.check().status, 'blocked', rel);
    assert.ok(f.check().issues.some(x => x.scope === 'source'));
  }
  const f = fixture(t); fs.symlinkSync(path.join(f.root, 'README.md'), path.join(f.root, f.skillPath, 'linked.md'));
  assert.ok(f.check().issues.some(x => x.rule === 'non-regular-file'));
});
test('safe HTML/SVG templates are allowed; nested credential signatures report no value', t => {
  const f = fixture(t);
  f.write(`${f.skillPath}/assets/template.html`, '<svg><circle r="2"/></svg>');
  assert.deepEqual(auditSource(path.join(f.root, f.skillPath)), []);
  const secret = 'ghp_' + 'z'.repeat(36);
  f.write(`${f.skillPath}/references/notes.md`, secret);
  const issues = auditSource(path.join(f.root, f.skillPath));
  assert.ok(issues.some(x => x.rule === 'credential-signature'));
  assert.ok(!JSON.stringify(issues).includes(secret));
});
test('actual packing extras and omitted required resources fail, even if npm files changed', t => {
  const f = fixture(t);
  assert.ok(f.check({ packPaths: [...f.paths, '.产品记录/design.md'] }).issues.some(x => x.scope === 'npm-pack'));
  assert.ok(f.check({ packPaths: f.paths.filter(x => x !== 'NOTICE.md') }).issues.some(x => x.rule === 'required-file-not-packed'));
  f.write('package.json', JSON.stringify({ name: f.id, version: '0.0.0', files: [...wrappers, f.skillPath, 'private.md'] }));
  f.write('private.md', 'not part of the public package');
  assert.ok(audit(f.root).issues.some(x => x.path === 'private.md' && x.scope === 'npm-pack'));
});
test('manifest hashes, missing and unmanifested source files are checked', t => {
  const f = fixture(t); f.write(`${f.skillPath}/SKILL.md`, 'changed source');
  assert.ok(f.check().issues.some(x => x.rule === 'hash-mismatch'));
  f.write(`${f.skillPath}/notes.md`, 'new source');
  assert.ok(f.check().issues.some(x => x.rule === 'unmanifested-file'));
  fs.unlinkSync(path.join(f.root, f.skillPath, 'SKILL.md'));
  assert.ok(f.check().issues.some(x => x.rule === 'manifest-file-missing'));
});
test('tracked ignored files cannot evade .gitignore', t => {
  const f = fixture(t); f.git('init', '-q'); f.write('.产品记录/design.md', 'private');
  f.git('add', '-f', '--', '.产品记录/design.md');
  assert.ok(f.check().issues.some(x => x.scope === 'git-index' && x.path === '.产品记录/design.md'));
  assert.equal(f.git('ls-files', '-z'), '.产品记录/design.md\0'); // no unstaging or deletion
});
test('staged content is inspected, not replaced by a clean working copy', t => {
  const f = fixture(t); f.git('init', '-q');
  const secret = 'ghp_' + 'y'.repeat(36);
  f.write('README.md', secret); f.git('add', '--', 'README.md'); f.write('README.md', 'clean now');
  const result = f.check();
  assert.ok(result.issues.some(x => x.scope === 'git-index' && x.rule === 'credential-signature'));
  assert.ok(result.issues.some(x => x.rule === 'index-differs-from-reviewed-file'));
  assert.ok(!JSON.stringify(result).includes(secret));
});
test('clean explicit staged files pass; ignored local records outside package may stay', t => {
  const f = fixture(t); f.git('init', '-q'); f.write('.产品记录/design.md', 'private');
  f.git('add', '--', 'README.md', 'PUBLISHING.md');
  const result = f.check(); assert.equal(result.status, 'passed'); assert.equal(result.git, 'index-checked');
});
test('private bird and old aliases cannot become independent public products via metadata', t => {
  for (const suffix of ['diagnose', 'check-updates', 'report-bug', 'visual', 'bird']) {
    const f = fixture(t, suffix);
    assert.equal(f.check().status, 'passed');
    assert.equal(f.check({ upload: true }).status, 'blocked');
    f.manifest.publication.upload = { decision: 'independent-candidate', blockers: [] };
    f.write('skill-package.json', JSON.stringify(f.manifest));
    assert.ok(f.check().issues.some(x => x.rule === 'upload-policy-drift'));
  }
});
test('xiaohei retains local packaging but is blocked from public upload pending license review', t => {
  const f = fixture(t, 'xiaohei');
  assert.equal(f.check().status, 'passed');
  assert.ok(f.check({ upload: true }).issues.some(x => x.rule === 'third-party-asset-license-review'));
});

test('extracted package needs neither .gitignore nor Git; a broken own Git must not silently pass', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.root, '.gitignore'));
  assert.equal(f.check().status, 'passed');
  f.write('.git', 'gitdir: missing-git-directory');
  assert.throws(() => f.check(), /Cannot inspect this repository/);
});

test('ignore rules are still scanned for accidentally embedded credentials', t => {
  const f = fixture(t); f.write('.gitignore', 'ghp_' + 'x'.repeat(36));
  assert.ok(f.check().issues.some(x => x.path === '.gitignore' && x.rule === 'credential-signature'));
});

test('packing inventory never runs a package lifecycle hook', t => {
  const f = fixture(t), packageFile = path.join(f.root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile));
  pkg.scripts = { prepack: `node -e "require('node:fs').writeFileSync('hook-ran','bad')"` };
  f.write('package.json', JSON.stringify(pkg));
  assert.equal(audit(f.root).status, 'passed');
  assert.ok(!fs.existsSync(path.join(f.root, 'hook-ran')));
});
