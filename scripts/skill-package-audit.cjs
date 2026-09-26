#!/usr/bin/env node
'use strict';
// Read-only distribution check. No installation, staging, lifecycle scripts or network access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wrappers = ['README.md', 'SKILL.md', 'package.json', 'skill-package.json', 'PUBLISHING.md', 'LICENSE', 'NOTICE.md', 'CITATION.cff', 'bin/install.cjs', 'bin/check-package.cjs'];
const independentIds = new Set(['install', 'cut', 'subtitle', 'export', 'maintain', 'shot-design', 'workbench'].map(x => `chengfeng-videocut-${x}`));
function uploadPolicy(id) {
  if (id === 'chengfeng-videocut-xiaohei') return { decision: 'license-review-required', blockers: ['third-party-asset-license-review'] };
  if (independentIds.has(id)) return { decision: 'independent-candidate', blockers: [] };
  return { decision: 'compatibility-only', blockers: ['not-an-independent-public-product'] };
}
function pathIssue(name) {
  const parts = name.split('/');
  if (!name || /[\\:\x00-\x1f]/.test(name) || parts.some(x => !x || x === '.' || x === '..')) return 'unsafe-path';
  if (parts.some(x => x.startsWith('.') || /^(node_modules|__pycache__|coverage|logs?|tmp|temp|cache|backups?|历史|实验|用户数据|原素材|成片)$/i.test(x))) return 'private-or-generated-path';
  if (parts.some(x => /^(credentials?|secrets?|cookies?|tokens?|auth|config\.local)(\.|$)/i.test(x) || /^id_(rsa|ed25519)(\.|$)/.test(x))) return 'credential-path';
  if (/\.(log|pyc|tmp|bak|tgz|zip|7z|dmg|exe|dll|mp4|mov|mkv|mp3|wav|srt|ass)$/i.test(name)) return 'runtime-data-or-binary';
  return null;
}
function contentIssue(bytes) {
  // Signatures only. Never echo matching values; this is not a complete DLP/license audit.
  if (bytes.includes(0)) return null;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})\b/.test(text)) return 'credential-signature';
  if (/\/(?:Users|home)\/chengfeng\b|\/Volumes\/成峰\//.test(text)) return 'operator-private-path';
  return null;
}
function walk(dir, relative = '') {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const local = relative ? `${relative}/${name}` : name, file = path.join(dir, name), stat = fs.lstatSync(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [{ local, file, regular: stat.isFile() && !stat.isSymbolicLink() }];
    // Surface forbidden directories even when empty. Do not recurse into caches or private data.
    if (pathIssue(local)) return [{ local, file, regular: false }];
    return walk(file, local);
  });
}
function auditSource(dir) {
  if (fs.lstatSync(dir).isSymbolicLink()) return [{ path: '.', rule: 'source-link' }];
  return walk(dir).flatMap(item => {
    const rule = pathIssue(item.local) || (!item.regular ? 'non-regular-file' : contentIssue(fs.readFileSync(item.file)));
    return rule ? [{ path: item.local, rule }] : [];
  });
}
function npmCli() {
  // Execute npm's JS entry with Node; never interpolate paths into a shell / Windows .cmd.
  const candidates = [];
  if (process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    const executable = path.join(dir, 'npm');
    if (fs.existsSync(executable)) candidates.push(fs.realpathSync(executable));
  }
  const found = candidates.find(p => /npm-cli\.js$/.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
  if (!found) throw new Error('npm-cli.js not found; run through npm run check:package or install Node with npm');
  return found;
}
function audit(root, { upload = false, packPaths } = {}) {
  root = path.resolve(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'skill-package.json')));
  if (!/^chengfeng-videocut-[a-z][a-z-]*$/.test(manifest.id) || manifest.skillPath !== `.agents/skills/${manifest.id}` || !manifest.files || Array.isArray(manifest.files)) throw new Error('Invalid Skill manifest identity');
  const skillPath = manifest.skillPath, skillRoot = path.join(root, skillPath), issues = [];
  const add = (scope, name, rule) => issues.push({ scope, path: name, rule });
  // All parent components must be real directories, including .agents and skills.
  for (const rel of ['.agents', '.agents/skills', skillPath, 'bin']) if (fs.lstatSync(path.join(root, rel)).isSymbolicLink()) throw new Error('Package source directory is a link');
  const owned = new Set([...wrappers, '.gitignore', ...Object.keys(manifest.files).map(x => `${skillPath}/${x}`)]);
  const inspect = (name, bytes, scope) => {
    if (!owned.has(name)) { add(scope, name, 'outside-public-allowlist'); return; }
    const local = name.startsWith(`${skillPath}/`) ? name.slice(skillPath.length + 1) : name;
    const rule = (name === '.gitignore' ? null : pathIssue(local)) || contentIssue(bytes);
    if (rule) add(scope, name, rule);
  };
  for (const issue of auditSource(skillRoot)) add('source', `${skillPath}/${issue.path}`, issue.rule);
  const actual = new Map(walk(skillRoot).filter(x => x.regular).map(x => [x.local, x.file]));
  for (const local of Object.keys(manifest.files)) {
    if (pathIssue(local)) { add('manifest', local, 'unsafe-or-private-path'); continue; }
    if (!actual.has(local)) add('source', `${skillPath}/${local}`, 'manifest-file-missing');
    else if (sha(fs.readFileSync(actual.get(local))) !== manifest.files[local]) add('source', `${skillPath}/${local}`, 'hash-mismatch');
  }
  for (const local of actual.keys()) if (!Object.hasOwn(manifest.files, local)) add('source', `${skillPath}/${local}`, 'unmanifested-file');
  for (const rel of [...wrappers, ...(fs.existsSync(path.join(root, '.gitignore')) ? ['.gitignore'] : [])]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) add('source', rel, 'missing-or-non-regular-wrapper');
    else inspect(rel, fs.readFileSync(file), 'source');
  }
  let git = 'not-checked-no-own-repository';
  let top;
  try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { if (fs.existsSync(path.join(root, '.git'))) throw new Error('Cannot inspect this repository Git index'); }
  if (top && fs.realpathSync(top) === fs.realpathSync(root)) {
    git = 'index-checked';
    const records = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
    for (const record of records) {
      const [, mode, hash, stage, name] = record.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/) || [];
      if (!name || stage !== '0' || !/^100(644|755)$/.test(mode)) { add('git-index', name || '(invalid entry)', 'link-or-conflict'); continue; }
      if (!owned.has(name)) { add('git-index', name, 'outside-public-allowlist'); continue; }
      const bytes = execFileSync('git', ['cat-file', 'blob', hash], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
      inspect(name, bytes, 'git-index');
      // Require re-staging after edits so the reviewed working tree cannot hide stale staged secrets.
      const file = path.join(root, name);
      if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || !bytes.equals(fs.readFileSync(file))) add('git-index', name, 'index-differs-from-reviewed-file');
    }
  }
  let packed = [];
  // Fail before npm processes unsafe sources. This also avoids following unknown pack symlinks.
  if (!issues.length) {
    if (packPaths) packed = packPaths;
    else {
      const result = JSON.parse(execFileSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
      packed = result[0].files.map(x => x.path);
    }
    const expected = new Set([...owned].filter(x => x !== '.gitignore'));
    for (const name of packed) {
      if (!expected.has(name)) { add('npm-pack', name, 'outside-public-allowlist'); continue; }
      inspect(name, fs.readFileSync(path.join(root, name)), 'npm-pack'); expected.delete(name);
    }
    for (const name of expected) add('npm-pack', name, 'required-file-not-packed');
  }
  const policy = uploadPolicy(manifest.id);
  if (JSON.stringify(manifest.publication?.upload) !== JSON.stringify(policy)) add('manifest', 'skill-package.json', 'upload-policy-drift');
  if (upload) for (const rule of policy.blockers) add('upload-policy', manifest.id, rule);
  return { status: issues.length ? 'blocked' : 'passed', id: manifest.id, mode: upload ? 'upload' : 'package', git, packedFiles: packed.length, uploadDecision: policy.decision, issues,
    publication: manifest.publication?.status || 'unknown', releaseReady: false,
    limitations: ['manual-content-and-license-review-required', 'git-history-not-audited', 'remote-install-and-host-loading-not-verified', 'does-not-push'] };
}
function publishingGuide(manifest) {
  const policy = uploadPolicy(manifest.id);
  const direction = policy.decision === 'compatibility-only' ? '旧名称兼容快照，不再建立独立公开仓库。'
    : policy.decision === 'license-review-required' ? '保留独立分发方向；第三方素材、图标及 vendor 许可完整性核验前禁止公开上传，仍可本地测试。'
    : manifest.publication?.status === 'github-source-preview' ? 'GitHub 源码预览；安装结果以固定提交对应的外部验收记录为准，不代表正式发行、宿主加载或业务验收通过。'
    : '完整能力独立维护与分发；当前是本地候选，不代表已经推送或远端安装通过。';
  return `# 发布范围

本文件与 bin/check-package.cjs 由工作台统一生成。业务 SKILL.md 面向使用者；发布步骤放在本文件，不维护第二套业务源码或包装逻辑。

## 本包的方向

${direction}

## 上传什么

- 唯一业务真源：${manifest.skillPath}/，含实际需要的 references、scripts、获许可 assets、公开样例与可复现测试。HTML、SVG、模板图片可以是必要资源。
- 包装文件：${wrappers.join('、')}，以及 .gitignore。公开使用方法需自包含，不能依赖私有产品记录。
- 保留 LICENSE / NOTICE / CITATION 以及第三方许可与出处；项目 LICENSE 不会重新授权别人的资源。

## 不上传什么

私有产品记录、历史/备份、内部复盘、用户媒体/作品/字幕稿/词典、凭据、安装记录、未脱敏日志、缓存、node_modules、本机快捷软链和旧源码。Runtime、Studio、FFmpeg、浏览器等公共基础设施归工作台发行，不在每个 Skill 重复打包。

## 怎么检查

在本包目录运行：

\x60\x60\x60sh
npm run check:package
npm run check:upload
\x60\x60\x60

check:package 检查源文件、内容摘要、npm pack 实际候选清单与本仓库 Git 索引；check:upload 额外检查独立发行方向及已知许可阻断。二者都不下载、不执行安装钩子、不暂存、不推送。安装后的纯 Skill 目录不是源码包装，不在其中运行这两个命令。

.gitignore 无法阻止已跟踪文件泄漏。只暂存审核过的公开文件，然后重新检查；索引与工作区不一致会阻断，确认内容后再暂存。当前阻断视频、音频、字幕等用户数据文件；确需新增公开 fixture 时先审查隐私/权利，并调整共享规则和测试，不能强行忽略检查。

检查不是完整隐私扫描：文字、图片、来源与许可须人工审查；既有 Git 历史不在扫描范围。通过不证明已发布、宿主加载或业务可用。按授权推送后，仍需固定 commit/产物摘要、真实安装、宿主加载和最小任务验收。
`;
}
module.exports = { audit, auditSource, pathIssue, uploadPolicy, wrappers, publishingGuide };
if (require.main === module) {
  try {
    const command = process.argv[2] || 'check';
    if (!['check', 'upload'].includes(command) || process.argv.length > 3) throw new Error('Usage: node bin/check-package.cjs [check|upload]');
    const result = audit(path.resolve(__dirname, '..'), { upload: command === 'upload' });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ status: 'blocked', rule: 'audit-could-not-complete', error: error.message.split('\n')[0] })); process.exitCode = 1; }
}
