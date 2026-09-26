'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { run } = require('./skill-package-installer.cjs');
const { run: suite } = require('./skill-suite-installer.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entries = [
  ['安装与接入Skill', 'install'],
  ['剪口播Skill', 'cut'], ['字幕Skill', 'subtitle'], ['镜头设计Skill', 'shot-design'],
  ['小黑动画Skill', 'xiaohei'], ['画面接入Skill', 'visual'], ['导出Skill', 'export'],
  ['维护与排障Skill', 'maintain'], ['环境排查Skill', 'diagnose'],
  ['检查更新Skill', 'check-updates'], ['上报BugSkill', 'report-bug'],
];
const modes = { diagnose: 'diagnose', 'check-updates': 'updates', 'report-bug': 'report-bug' };
test('workbench-only build preserves methods and all other packages, catalog and bootstrap', t => {
  const f = fixture(t);
  f.build();
  const root = path.join(f.root, '工作台操作Skill');
  const method = '.agents/skills/chengfeng-videocut-workbench/SKILL.md';
  write(root, method, '---\nname: chengfeng-videocut-workbench\ndescription: Fixture\n---\nUnchanged method\n');
  write(root, '.agents/skills/chengfeng-videocut-workbench/references/connection.md', 'fixture connection');
  const snapshot = dir => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().filter(x => fs.statSync(path.join(dir, x)).isFile()).map(x => [x, sha(fs.readFileSync(path.join(dir, x)))]));
  const before = snapshot(f.root);
  assert.equal(f.build('--only', 'workbench', '--github-preview').count, 1);
  const after = snapshot(f.root);
  for (const [name, hash] of Object.entries(before)) assert.equal(after[name], hash, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'skill-package.json')));
  assert.equal(manifest.version, '0.1.0-beta.1');
  assert.equal(manifest.runtime.minimumVersion, '0.5.9');
  assert.equal(manifest.publication.upload.decision, 'independent-candidate');
  assert.equal(manifest.publication.status, 'local-candidate');
  assert.ok(!fs.existsSync(path.join(root, '.agents/skills/chengfeng-videocut-workbench/references/shared')));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /install --host agents/);
  assert.match(readme, /Runtime 0.4.11/);
  assert.doesNotMatch(readme, /references\/shared/);
  const frozen = snapshot(f.root);
  f.build('--only', 'workbench', '--github-preview');
  assert.deepEqual(snapshot(f.root), frozen);
  assert.throws(() => f.build('--only', 'cut', '--github-preview'));
  assert.deepEqual(snapshot(f.root), frozen);
});
function write(root, name, body) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'videocut-maintenance-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wb = path.join(root, '剪辑工作台/源码');
  write(root, 'AGENTS.md', 'fixture');
  for (const file of ['build-independent-skills.cjs', 'skill-package-installer.cjs', 'skill-suite-installer.cjs', 'skill-directory-snapshot.cjs', 'skill-package-audit.cjs', 'skill-github-preview.cjs']) {
    write(wb, `scripts/${file}`, fs.readFileSync(path.join(__dirname, file)));
  }
  for (const file of ['LICENSE', 'NOTICE.md']) write(wb, file, 'fixture legal');
  write(wb, 'docs/skill-contracts/plugin-access.md', 'shared fixture');
  write(wb, 'docs/skill-contracts/public-plugin-compatibility.md', fs.readFileSync(path.join(__dirname, '../docs/skill-contracts/public-plugin-compatibility.md')));
  for (const file of ['module-publish.md', 'visual-module-contract.md', 'media-assets.md']) write(wb, `docs/skill-contracts/${file}`, 'shared fixture');
  write(root, '镜头设计Skill/.agents/skills/chengfeng-videocut-shot-design/references/visual-judgment.md', 'judgment fixture');
  for (const [folder, suffix] of entries) {
    write(root, `${folder}/.agents/skills/chengfeng-videocut-${suffix}/SKILL.md`, `---\nname: chengfeng-videocut-${suffix}\ndescription: Fixture\n---\n`);
  }
  write(root, '画面接入Skill/.agents/skills/chengfeng-videocut-visual/references/media-assets.md', 'media fixture');
  const source = path.join(root, '维护与排障Skill/.agents/skills/chengfeng-videocut-maintain');
  for (const mode of Object.values(modes)) write(source, `references/${mode}.md`, `mode ${mode}\n`);
  const build = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(wb, 'scripts/build-independent-skills.cjs'), root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const catalog = () => JSON.parse(fs.readFileSync(path.join(wb, 'skills.local-candidate.json')));
  return { root, wb, source, build, catalog };
}
test('default suite has one maintenance package; legacy IDs remain installable, self-contained aliases', t => {
  const f = fixture(t);
  assert.equal(f.build().count, 11);
  const c = f.catalog();
  assert.equal(c.publicReleaseReady, false);
  const active = c.skills.filter(x => x.defaultInstall).map(x => x.id);
  assert.ok(active.includes('chengfeng-videocut-maintain'));
  assert.deepEqual(active.map(x => x.replace('chengfeng-videocut-', '')).sort(), ['cut', 'export', 'install', 'maintain', 'shot-design', 'subtitle', 'xiaohei']);
  assert.deepEqual(fs.readdirSync(path.join(f.wb, 'plugins/chengfeng-videocut/skills')), ['chengfeng-videocut-install']);
  const plugin = JSON.parse(fs.readFileSync(path.join(f.wb, 'plugins/chengfeng-videocut/.codex-plugin/plugin.json')));
  assert.ok(plugin.author.name);
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) assert.ok(plugin.interface[field]);
  assert.ok(Array.isArray(plugin.interface.capabilities));
  assert.equal(plugin.interface.defaultPrompt.length, 1);
  assert.equal(plugin.skills, './skills/');
  const { snapshot, source } = require('./skill-directory-snapshot.cjs');
  const catalogBytes = fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json'));
  const directory = snapshot(catalogBytes);
  assert.deepEqual(directory.skills.map(s => s.name), active);
  assert.equal(directory.catalogSha256, sha(catalogBytes));
  assert.equal(directory.installUnit, 'independent-skill');
  assert.equal(directory.publicReleaseReady, false);
  assert.ok(directory.skills.every(s => s.loaded === 'unknown'));
  assert.equal(fs.readFileSync(path.join(f.wb, 'packages/contracts/src/skill-directory.generated.ts'), 'utf8'), source(catalogBytes));
  for (const suffix of Object.keys(modes)) assert.ok(!active.includes(`chengfeng-videocut-${suffix}`));
  const home = path.join(f.root, 'isolated-home'); fs.mkdirSync(home);
  for (const item of c.skills) {
    const pkg = path.join(f.root, item.directory);
    assert.equal(item.packageManifestSha256, sha(fs.readFileSync(path.join(pkg, 'skill-package.json'))));
    assert.equal(run(['install', '--target-root', home, '--host', 'codex'], pkg).status, 'installed');
    assert.equal(run(['install', '--target-root', home, '--host', 'codex'], pkg).status, 'reused');
    assert.equal(run(['doctor', '--target-root', home, '--host', 'codex'], pkg).status, 'verified');
    const compatibilityPath = 'references/shared/public-plugin-compatibility.md';
    const installedCompatibility = fs.readFileSync(path.join(home, '.agents/skills', item.id, compatibilityPath));
    assert.deepEqual(installedCompatibility, fs.readFileSync(path.join(f.wb, 'docs/skill-contracts/public-plugin-compatibility.md')));
    const packageManifest = JSON.parse(fs.readFileSync(path.join(pkg, 'skill-package.json')));
    assert.equal(packageManifest.files[compatibilityPath], sha(installedCompatibility));
    if (item.compatibility?.mode) {
      assert.equal(item.compatibility.replacementId, 'chengfeng-videocut-maintain');
      const installed = path.join(home, '.agents/skills', item.id);
      assert.ok(fs.existsSync(path.join(installed, `references/${item.compatibility.mode}.md`)));
      const p = JSON.parse(fs.readFileSync(path.join(installed, 'references/maintenance-provenance.json')));
      for (const [rel, hash] of Object.entries(p.files)) {
        assert.equal(hash, sha(fs.readFileSync(path.join(f.source, rel))));
        assert.equal(hash, sha(fs.readFileSync(path.join(installed, rel))));
      }
    }
  }
  const original = fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json'));
  f.build(); assert.deepEqual(fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json')), original);
});
test('mode source updates regenerate aliases and old installed bytes cannot be silently overwritten', t => {
  const f = fixture(t); f.build();
  const home = path.join(f.root, 'home'); fs.mkdirSync(home);
  const pkg = path.join(f.root, '环境排查Skill');
  run(['install', '--target-root', home], pkg);
  write(f.source, 'references/diagnose.md', 'changed canonical mode\n');
  f.build();
  const alias = path.join(pkg, '.agents/skills/chengfeng-videocut-diagnose');
  assert.deepEqual(fs.readFileSync(path.join(alias, 'references/diagnose.md')), fs.readFileSync(path.join(f.source, 'references/diagnose.md')));
  assert.throws(() => run(['install', '--target-root', home], pkg), /identity mismatch/);
  assert.equal(fs.readFileSync(path.join(home, '.agents/skills/chengfeng-videocut-diagnose/references/diagnose.md'), 'utf8'), 'mode diagnose\n');
});
test('GitHub preview prepares public copy for six packages without claiming publication', t => {
  const f = fixture(t); f.build(); f.build('--github-preview');
  const promoted = ['install', 'cut', 'subtitle', 'export', 'maintain', 'shot-design'];
  for (const [folder, suffix] of entries) {
    const root = path.join(f.root, folder), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'skill-package.json')));
    if (promoted.includes(suffix)) {
      assert.equal(pkg.version, '0.1.0-beta.1');
      assert.equal(pkg.chengfengDistribution.channel, 'github-preview');
      assert.equal(manifest.publication.status, 'local-candidate');
      assert.equal(manifest.publication.ref, undefined);
      assert.equal(manifest.publication.remoteCommit, null);
      assert.ok(fs.readFileSync(path.join(root, 'README.md'), 'utf8').includes('node bin/install.cjs install --host codex'));
      const publishing = fs.readFileSync(path.join(root, 'PUBLISHING.md'), 'utf8');
      assert.match(publishing, /当前是本地候选/);
      assert.match(publishing, /固定 commit\/产物摘要/);
    } else {
      assert.equal(pkg.version, '0.1.0-local.1');
      assert.equal(pkg.chengfengDistribution, undefined);
    }
  }
  const before = fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json'));
  const readme = fs.readFileSync(path.join(f.root, '安装与接入Skill/README.md'));
  assert.match(readme.toString(), /\[chengfeng-videocut-skills\]\(https:\/\/github.com\/Agentchengfeng\/chengfeng-videocut-skills\)/);
  assert.match(readme.toString(), /\[chengfeng-videocut\]\(https:\/\/github.com\/Agentchengfeng\/chengfeng-videocut\)/);
  assert.match(readme.toString(), /not all business Skills/);
  f.build();
  assert.deepEqual(fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '安装与接入Skill/README.md')), readme);
});
test('next local candidate cannot inherit a published tag claim or overwrite the installed preview', t => {
  const f = fixture(t); f.build('--github-preview');
  const pkgRoot = path.join(f.root, '安装与接入Skill');
  const home = path.join(f.root, 'isolated-home'); fs.mkdirSync(home);
  run(['install', '--target-root', home], pkgRoot);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json')));
  pkg.version = '0.1.0-beta.2'; pkg.chengfengDistribution.status = 'local-candidate';
  write(pkgRoot, 'package.json', JSON.stringify(pkg));
  f.build();
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'skill-package.json')));
  assert.equal(manifest.version, '0.1.0-beta.2');
  assert.equal(manifest.publication.status, 'local-candidate');
  assert.equal(manifest.publication.ref, undefined);
  const readme = fs.readFileSync(path.join(pkgRoot, 'README.md'), 'utf8');
  assert.match(readme, /Unpublished local candidate/);
  assert.match(readme, /node bin\/install.cjs install --host codex --target-root/);
  assert.doesNotMatch(readme, /github:.*#v0.1.0-beta.2/);
  assert.match(readme, /verified-preview-commits/);
  assert.throws(() => run(['install', '--target-root', home], pkgRoot), /identity mismatch/);
  const catalogBefore = fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json'));
  f.build('--github-preview');
  assert.deepEqual(fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json')), catalogBefore);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'))).chengfengDistribution.status, 'local-candidate');
});
test('missing, mistyped or stale release status cannot mint a published identity on rebuild', t => {
  const f = fixture(t); f.build('--github-preview');
  const root = path.join(f.root, '安装与接入Skill');
  for (const status of [undefined, 'local-candiate', 'github-source-preview']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    pkg.version = '0.1.0-beta.99';
    pkg.chengfengDistribution = { channel: 'github-preview', ...(status ? { status } : {}) };
    write(root, 'package.json', JSON.stringify(pkg));
    f.build('--github-preview');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'skill-package.json')));
    assert.equal(manifest.publication.status, 'local-candidate');
    assert.equal(manifest.publication.ref, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /github:.*#v0.1.0-beta.99/);
  }
});
test('missing maintenance source rejects generation before any package changes', t => {
  const f = fixture(t); f.build();
  const before = fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json'));
  fs.unlinkSync(path.join(f.source, 'references/updates.md'));
  assert.throws(() => f.build());
  assert.deepEqual(fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json')), before);
});

test('private nested source input aborts before generated packages change', t => {
  const f = fixture(t); f.build();
  const before = fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json'));
  write(f.root, '上报BugSkill/.agents/skills/chengfeng-videocut-report-bug/references/.env', 'private fixture');
  assert.throws(() => f.build(), /Unsafe Skill publication input/);
  assert.deepEqual(fs.readFileSync(path.join(f.wb, 'skills.local-candidate.json')), before);
});

test('a missing late package or foreign bootstrap Skill rejects before early package changes', t => {
  const f = fixture(t); f.build();
  const early = path.join(f.root, '安装与接入Skill/README.md');
  write(f.root, '安装与接入Skill/README.md', 'unchanged before successful build');
  const late = path.join(f.root, '上报BugSkill/.agents/skills/chengfeng-videocut-report-bug/SKILL.md');
  const original = fs.readFileSync(late); fs.unlinkSync(late);
  assert.throws(() => f.build());
  assert.equal(fs.readFileSync(early, 'utf8'), 'unchanged before successful build');
  fs.writeFileSync(late, original);
  write(f.wb, 'plugins/chengfeng-videocut/skills/unexpected/SKILL.md', 'must preserve');
  assert.throws(() => f.build());
  assert.equal(fs.readFileSync(early, 'utf8'), 'unchanged before successful build');
  assert.equal(fs.readFileSync(path.join(f.wb, 'plugins/chengfeng-videocut/skills/unexpected/SKILL.md'), 'utf8'), 'must preserve');
});

test('bootstrap follows source removals but refuses to overwrite modified generated files', t => {
  const f = fixture(t);
  const source = '安装与接入Skill/.agents/skills/chengfeng-videocut-install';
  write(f.root, `${source}/references/old.md`, 'old source'); f.build();
  const snapshot = path.join(f.wb, 'plugins/chengfeng-videocut/skills/chengfeng-videocut-install');
  fs.unlinkSync(path.join(f.root, source, 'references/old.md')); f.build();
  assert.ok(!fs.existsSync(path.join(snapshot, 'references/old.md')));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.wb, 'plugins/chengfeng-videocut/source-provenance.json')));
  for (const [file, hash] of Object.entries(manifest.files)) assert.equal(sha(fs.readFileSync(path.join(snapshot, file))), hash);
  write(snapshot, 'SKILL.md', 'keep user edit');
  assert.throws(() => f.build());
  assert.equal(fs.readFileSync(path.join(snapshot, 'SKILL.md'), 'utf8'), 'keep user edit');
});

test('suite plan is read-only; default install/doctor/reuse covers exactly seven Skills', t => {
  const f = fixture(t); f.build();
  const home = path.join(f.root, '中文 用户'); fs.mkdirSync(home);
  const args = ['--catalog', path.join(f.wb, 'skills.local-candidate.json'), '--workspace', f.root, '--target-root', home, '--host', 'codex'];
  assert.equal(suite(['plan', ...args]).results.length, 7);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.ok(suite(['install', ...args]).results.every(x => x.status === 'installed'));
  assert.equal(fs.readdirSync(path.join(home, '.agents/skills')).length, 7);
  assert.ok(suite(['doctor', ...args]).results.every(x => x.status === 'verified'));
  assert.ok(suite(['install', ...args]).results.every(x => x.status === 'reused'));
  assert.equal(suite(['doctor', ...args]).hostLoaded, 'not-checked');
});

test('suite IO failure preserves successful packages and a retry reuses them', t => {
  const f = fixture(t); f.build();
  const home = path.join(f.root, 'home'); fs.mkdirSync(home);
  const args = ['--catalog', path.join(f.wb, 'skills.local-candidate.json'), '--workspace', f.root, '--target-root', home, '--host', 'codex'];
  const original = fs.renameSync;
  const cutTarget = path.join(fs.realpathSync(home), '.agents/skills/chengfeng-videocut-cut');
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === cutTarget) throw new Error('simulated disk IO failure');
    return original(from, to);
  });
  const result = suite(['install', ...args]);
  mocked.mock.restore();
  assert.equal(result.status, 'partial');
  assert.equal(result.failed.id, 'chengfeng-videocut-cut');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, 'chengfeng-videocut-install');
  assert.deepEqual(fs.readdirSync(path.join(home, '.agents/skills')), ['chengfeng-videocut-install']);
  const retry = suite(['install', ...args]);
  assert.equal(retry.results[0].status, 'reused');
  assert.ok(retry.results.slice(1).every(x => x.status === 'installed'));
  assert.ok(suite(['doctor', ...args]).results.every(x => x.status === 'verified'));
});

for (const damage of ['manifest', 'content', 'target', 'traversal', 'source-link', 'duplicate']) {
  test(`suite rejects ${damage} across all packages before writing any earlier package`, t => {
    const f = fixture(t); f.build();
    const home = path.join(f.root, 'home'); fs.mkdirSync(home);
    const file = path.join(f.wb, 'skills.local-candidate.json'), c = f.catalog();
    const last = c.skills.find(x => x.id === 'chengfeng-videocut-maintain');
    if (damage === 'manifest') last.packageManifestSha256 = '0'.repeat(64);
    if (damage === 'content') write(f.source, 'SKILL.md', 'tampered');
    if (damage === 'target') write(home, '.agents/skills/chengfeng-videocut-maintain/user.md', 'keep');
    if (damage === 'traversal') last.directory = '../escape';
    if (damage === 'source-link') { fs.symlinkSync(path.join(f.root, last.directory), path.join(f.root, 'alias')); last.directory = 'alias'; }
    if (damage === 'duplicate') c.skills.push(c.skills[0]);
    write(f.wb, 'skills.local-candidate.json', JSON.stringify(c));
    assert.throws(() => suite(['install', '--catalog', file, '--workspace', f.root, '--target-root', home]));
    assert.ok(!fs.existsSync(path.join(home, '.agents/skills/chengfeng-videocut-install')));
    if (damage === 'target') assert.equal(fs.readFileSync(path.join(home, '.agents/skills/chengfeng-videocut-maintain/user.md'), 'utf8'), 'keep');
  });
}

test('legacy docs cannot claim a new independent maintenance product; export source is shared', t => {
  const f = fixture(t); f.build();
  for (const folder of ['环境排查Skill', '检查更新Skill', '上报BugSkill', '画面接入Skill']) {
    const readme = fs.readFileSync(path.join(f.root, folder, 'README.md'), 'utf8');
    assert.ok(readme.includes('历史兼容包'));
    assert.ok(!readme.includes('源码唯一真源是'));
    assert.ok(!readme.includes('计划仓库名为'));
  }
  fs.unlinkSync(path.join(f.root, '画面接入Skill/.agents/skills/chengfeng-videocut-visual/references/media-assets.md'));
  f.build();
  assert.equal(fs.readFileSync(path.join(f.root, '导出Skill/.agents/skills/chengfeng-videocut-export/references/media-assets.md'), 'utf8'), 'shared fixture');
});
