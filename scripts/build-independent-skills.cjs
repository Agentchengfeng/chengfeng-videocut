#!/usr/bin/env node
'use strict';
// Local, explicit workspace packager. Never downloads, installs, or edits Plugin caches.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { source: directorySource } = require('./skill-directory-snapshot.cjs');
const { auditSource, uploadPolicy, wrappers, publishingGuide } = require('./skill-package-audit.cjs');
const githubPreview = require('./skill-github-preview.cjs');
const workbench = path.resolve(__dirname, '..');
const workspace = process.argv[2] && path.resolve(process.argv[2]);
const options = process.argv.slice(3);
const onlyWorkbench = options.includes('--only');
if (!['', '--github-preview', '--only workbench --github-preview'].includes(options.join(' '))) throw new Error('Use --github-preview or --only workbench --github-preview');
const requestPreview = options.includes('--github-preview');
if (!workspace || !fs.existsSync(path.join(workspace, 'AGENTS.md'))) throw new Error('Pass the explicit suite workspace root');
const definitions = onlyWorkbench ? [
  ['工作台操作Skill', 'workbench', '工作台操作', '定位工程内容，执行明确的画面与片段编辑，并回读验证。', false],
] : [
  ['安装与接入Skill', 'install', '安装与接入', '核对固定来源并安装、复用指定 Skills，分别核验文件与依赖。', true],
  ['剪口播Skill', 'cut', '剪口播', '识别口误、重复与多次 take，生成可审核的删词方案。', true],
  ['字幕Skill', 'subtitle', '字幕', '用已有逐词稿与账本生成、校对和排版字幕。', true],
  ['镜头设计Skill', 'shot-design', '镜头设计', '规划表达、构图、节拍与前后镜头交接。', true],
  ['小黑动画Skill', 'xiaohei', '小黑动画', '制作可编辑的 Ian 小黑风格 HTML/SVG 动画。', true],
  ['画面接入Skill', 'visual', '画面接入（旧调用兼容）', '旧入口已退出默认产品；接入方法由共享 Runtime 合同提供。', false],
  ['导出Skill', 'export', '导出', '调用统一 Runtime 导出并按真实交付终点验收。', true],
  ['维护与排障Skill', 'maintain', '维护与排障', '按请求选择故障排查、指定组件更新或脱敏 Bug 反馈。', true],
  ['环境排查Skill', 'diagnose', '环境排查（旧调用兼容）', '兼容旧 diagnose 调用，新任务使用维护与排障。', false],
  ['检查更新Skill', 'check-updates', '检查更新（旧调用兼容）', '兼容旧 check-updates 调用，新任务使用维护与排障。', false],
  ['上报BugSkill', 'report-bug', '上报 Bug（旧调用兼容）', '兼容旧 report-bug 调用，新任务使用维护与排障。', false],
];
const maintenanceModes = { diagnose: 'diagnose', 'check-updates': 'updates', 'report-bug': 'report-bug' };
const maintenanceId = 'chengfeng-videocut-maintain';
const maintenanceSource = path.join(workspace, `维护与排障Skill/.agents/skills/${maintenanceId}`);
// Preflight the shared source before touching any package, including legacy aliases.
for (const file of onlyWorkbench ? [] : ['SKILL.md', 'references/diagnose.md', 'references/updates.md', 'references/report-bug.md']) {
  if (!fs.statSync(path.join(maintenanceSource, file)).isFile()) throw new Error(`Missing maintenance source: ${file}`);
}
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function walk(dir, rel = '') {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), s = fs.lstatSync(file), local = rel ? `${rel}/${name}` : name;
    if (s.isSymbolicLink()) throw new Error(`Unexpected source link: ${file}`);
    return s.isDirectory() ? walk(file, local) : [{ file, local }];
  });
}
const sourcePlugin = workbench;
const legal = fs.readFileSync(path.join(sourcePlugin, 'LICENSE'));
const originalNotice = fs.readFileSync(path.join(sourcePlugin, 'NOTICE.md'), 'utf8');
const contractDir = path.join(workbench, 'docs/skill-contracts');
const contracts = onlyWorkbench ? [] : walk(contractDir).filter(x => x.local !== 'README.md');
const contractIssues = onlyWorkbench ? [] : auditSource(contractDir);
if (contractIssues.length) throw new Error(`Unsafe shared publication input: ${JSON.stringify(contractIssues)}`);
// Reject incomplete or unsafe inputs before updating any generated package.
for (const [folder, suffix] of definitions) {
  const root = path.join(workspace, folder), skill = path.join(root, `.agents/skills/chengfeng-videocut-${suffix}`);
  if (fs.lstatSync(skill).isSymbolicLink() || !fs.statSync(path.join(skill, 'SKILL.md')).isFile()) throw new Error(`Missing canonical Skill: ${suffix}`);
  walk(skill);
  const issues = auditSource(skill);
  if (issues.length) throw new Error(`Unsafe Skill publication input (${suffix}): ${JSON.stringify(issues)}`);
  if (fs.existsSync(path.join(root, 'package.json'))) JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
}
for (const file of onlyWorkbench ? [] : ['module-publish.md', 'visual-module-contract.md', 'media-assets.md']) fs.readFileSync(path.join(contractDir, file));
if (!onlyWorkbench) fs.readFileSync(path.join(workspace, '镜头设计Skill/.agents/skills/chengfeng-videocut-shot-design/references/visual-judgment.md'));
for (const file of ['skill-package-installer.cjs', 'skill-suite-installer.cjs', 'skill-package-audit.cjs']) fs.readFileSync(path.join(workbench, 'scripts', file));
const existingBootstrapSkills = path.join(workbench, 'plugins/chengfeng-videocut/skills');
let previousBootstrapFiles = [];
if (!onlyWorkbench && fs.existsSync(existingBootstrapSkills)) {
  for (const name of fs.readdirSync(existingBootstrapSkills)) if (name !== 'chengfeng-videocut-install') throw new Error('Unexpected business Skill in bootstrap; inspect before migration');
  const snapshot = path.join(existingBootstrapSkills, 'chengfeng-videocut-install');
  if (fs.existsSync(snapshot)) {
    if (fs.lstatSync(snapshot).isSymbolicLink()) throw new Error('Unsafe bootstrap snapshot');
    const provenance = JSON.parse(fs.readFileSync(path.join(existingBootstrapSkills, '../source-provenance.json')));
    if (provenance.sourceId !== 'chengfeng-videocut-install' || !provenance.files) throw new Error('Unowned bootstrap snapshot');
    previousBootstrapFiles = walk(snapshot);
    const actualFiles = Object.fromEntries(previousBootstrapFiles.map(item => [item.local, sha(fs.readFileSync(item.file))]));
    // The first local generator stored only the aggregate. Migrate only an exact matching snapshot.
    if (typeof provenance.files === 'string') {
      if (sha(JSON.stringify(actualFiles)) !== provenance.files) throw new Error('Modified legacy bootstrap snapshot');
    } else {
      for (const [file, hash] of Object.entries(actualFiles)) if (hash !== provenance.files[file]) throw new Error('Modified or unowned bootstrap file; preserve it and inspect before rebuilding');
    }
  }
}
const report = [];
for (const [folder, suffix, title, description, defaultInstall] of definitions) {
  const id = `chengfeng-videocut-${suffix}`, root = path.join(workspace, folder);
  const skillPath = `.agents/skills/${id}`, skill = path.join(root, skillPath);
  if (!fs.existsSync(path.join(skill, 'SKILL.md'))) throw new Error(`Missing canonical Skill: ${id}`);
  const maintenanceMode = maintenanceModes[suffix];
  if (maintenanceMode) {
    // Legacy packages remain independently readable without requiring another install.
    // Their method snapshots are generated ONLY from maintain, never hand-maintained.
    fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
    const snapshotFiles = {};
    for (const mode of Object.values(maintenanceModes)) {
      const relative = `references/${mode}.md`;
      const bytes = fs.readFileSync(path.join(maintenanceSource, relative));
      fs.writeFileSync(path.join(skill, relative), bytes);
      snapshotFiles[relative] = sha(bytes);
    }
    json(path.join(skill, 'references/maintenance-provenance.json'), {
      schemaVersion: 1, sourceId: maintenanceId, snapshotStatus: 'local-candidate', files: snapshotFiles,
    });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${id}\ndescription: 兼容旧 $${id} 调用；新任务优先使用 $${maintenanceId} 的对应模式。不自动安装、不自动更新或上报。\n---\n\n# ${title}\n\n这是保留给旧任务的兼容入口，已退出默认安装清单。若当前宿主可读 $${maintenanceId}，读取其 ${maintenanceMode} 模式；否则直接读取随包的[对应模式](references/${maintenanceMode}.md)，不要求安装另一包。\n\n模式说明由维护与排障的唯一真源生成，出处与 SHA 见 [快照记录](references/maintenance-provenance.json)。不手工维护副本；旧辅助脚本保留但不属于用户执行路径。诊断不授权更新或上报，所有模式的授权、脱敏、未知结果和回读边界保持一致。\n`);
  }
  if (suffix !== 'workbench') {
  fs.mkdirSync(path.join(skill, 'references/shared'), { recursive: true });
  const sharedFiles = {};
  for (const c of contracts) {
    fs.copyFileSync(c.file, path.join(skill, 'references/shared', c.local));
    sharedFiles[c.local] = sha(fs.readFileSync(c.file));
  }
  // These are generated compatibility snapshots, not separately maintained Runtime implementations.
  json(path.join(skill, 'references/shared/provenance.json'), {
    schemaVersion: 1, sourceRepository: 'Agentchengfeng/chengfeng-videocut', sourcePath: 'docs/skill-contracts',
    snapshotStatus: 'local-candidate', files: sharedFiles,
  });
  }
  if (suffix === 'install') {
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    for (const file of ['skill-package-installer.cjs', 'skill-suite-installer.cjs']) fs.copyFileSync(path.join(workbench, 'scripts', file), path.join(skill, 'scripts', file));
  }
  if (suffix === 'export' || suffix === 'visual') {
    fs.writeFileSync(path.join(skill, 'references/media-assets.md'), fs.readFileSync(path.join(contractDir, 'media-assets.md'), 'utf8').replaceAll('(runtime-cli.md)', '(shared/runtime-cli.md)'));
  }
  if (suffix === 'visual') {
    for (const name of ['module-publish.md', 'visual-module-contract.md']) fs.writeFileSync(path.join(skill, 'references', name), fs.readFileSync(path.join(contractDir, name), 'utf8').replaceAll('(runtime-cli.md)', '(shared/runtime-cli.md)'));
    fs.copyFileSync(path.join(workspace, '镜头设计Skill/.agents/skills/chengfeng-videocut-shot-design/references/visual-judgment.md'), path.join(skill, 'references/visual-judgment.md'));
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: chengfeng-videocut-visual\ndescription: 兼容旧画面接入调用；新任务直接使用 Runtime 画面接入合同或镜头设计 Skill，不作为独立默认产品。\n---\n\n# 旧画面接入兼容入口\n\n此包不再默认安装或独立维护方法。已有 HTML/MP4 按[共享接入](references/shared/visual-integration.md)执行；需要画面设计时读取当前可用的 $chengfeng-videocut-shot-design，不自动安装。共享合同由 Runtime 生成；旧画面判断由镜头设计真源生成，仅保留兼容。\n');
  }
  // Mechanical relocation only; keep algorithm/vendor bytes intact.
  for (const entry of walk(skill).filter(x => suffix !== 'workbench' && /\.(md|yaml)$/.test(x.local) && !x.local.startsWith('references/shared/'))) {
    let body = fs.readFileSync(entry.file, 'utf8');
    const relativeShared = path.relative(path.dirname(entry.file), path.join(skill, 'references/shared')).split(path.sep).join('/');
    body = body.replace(/(?:\.\.\/){2,3}references\/([a-z-]+\.md)/g, (_, name) => `${relativeShared}/${name}`)
      .replace(/\$chengfeng-videocut(?:-local-development)?:/g, '$')
      .replace(/\.\.\/chengfeng-videocut-visual\/references\/media-assets\.md/g, 'references/media-assets.md')
      .replace(/^user-invocable: true\r?\n/m, '');
    if (entry.local === 'SKILL.md') body = body.replace('插件references/ai-term-dictionary.md', '[共享AI词典](references/shared/ai-term-dictionary.md)');
    if (entry.local === 'references/module-publish.md') {
      body = body.replace(/旧MCP仅在明确选定旧版本时读\[legacy说明\]\([^)]*\)，不是默认或CLI缺命令时的自动回退。/g, '旧 MCP 仅按已明确选择、实测兼容的旧发行自带文档使用；独立包不携带或自动回退旧桥。');
    }
    if (body !== fs.readFileSync(entry.file, 'utf8')) fs.writeFileSync(entry.file, body);
  }
  const previousPackage = fs.existsSync(path.join(root, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'))) : {};
  const preview = uploadPolicy(id).decision === 'independent-candidate' && (requestPreview || previousPackage.chengfengDistribution?.channel === 'github-preview');
  // Building local bytes is never evidence of a remote release. --github-preview
  // selects public copy/licensing only; publication identities live in release receipts.
  const version = preview && !previousPackage.chengfengDistribution ? '0.1.0-beta.1' : previousPackage.version || '0.1.0-local.1';
  const thirdParty = suffix === 'xiaohei';
  const notice = preview ? githubPreview.notice(id) : originalNotice + `\n## Independent package: ${id}\n\nPackaging and instructions reorganized on 2026-09-11. Original sources and attribution retained.\n` +
    (thirdParty ? '\nIan Xiaohei-style guidance retains its original credit. GSAP, Rough.js and icon assets retain their own provenance and terms; the Apache license covers project-owned changes, not all bundled assets. Redistribution license completeness is UNVERIFIED; this local candidate is not cleared for public release.\n' : '');
  const citation = `cff-version: 1.2.0\nmessage: "Keep upstream attribution when reusing this Skill."\ntitle: "${id}"\nauthors:\n  - name: "成峰 / AI产品自由"\nversion: "${version}"\nlicense: ${thirdParty ? '"NOASSERTION"' : '"Apache-2.0"'}\n`;
  for (const dest of [root, skill]) {
    fs.writeFileSync(path.join(dest, 'LICENSE'), legal);
    fs.writeFileSync(path.join(dest, 'NOTICE.md'), notice);
    fs.writeFileSync(path.join(dest, 'CITATION.cff'), citation);
  }
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(workbench, 'scripts/skill-package-installer.cjs'), path.join(root, 'bin/install.cjs'));
  fs.copyFileSync(path.join(workbench, 'scripts/skill-package-audit.cjs'), path.join(root, 'bin/check-package.cjs'));
  const files = Object.fromEntries(walk(skill).map(x => [x.local, sha(fs.readFileSync(x.file))]));
  const runtime = { command: 'chengfeng-videocut', minimumVersion: '0.5.9', requireCapabilityProbe: true, bundled: false,
    requiredFor: ['install', 'shot-design', 'xiaohei', 'maintain', 'diagnose', 'check-updates', 'report-bug'].includes(suffix) ? 'project-integration-only' : 'project-operations',
    validatedPlatforms: [], notes: 'Check actual workbench commands and endpoint capabilities; version alone is not sufficient.' };
  const compatibility = maintenanceMode ? { status: 'legacy-alias', replacementId: maintenanceId, mode: maintenanceMode } : suffix === 'visual' ? { status: 'retired-entry', documentation: 'references/shared/visual-integration.md' } : undefined;
  const repository = maintenanceMode ? `Agentchengfeng/${maintenanceId}` : suffix === 'visual' ? 'Agentchengfeng/chengfeng-videocut' : `Agentchengfeng/${id}`;
  const manifest = { schemaVersion: 1, id, version, skillPath, files, runtime, ...(compatibility ? { compatibility } : {}), publication: { status: 'local-candidate',
    repository, remoteCommit: null, licenseReview: thirdParty ? 'required-before-publishing' : 'project-license-retained', upload: uploadPolicy(id) } };
  json(path.join(root, 'skill-package.json'), manifest);
  json(path.join(root, 'package.json'), { name: id, version, private: true, description, license: thirdParty ? 'SEE LICENSE IN NOTICE.md' : 'Apache-2.0',
    author: '成峰 / AI产品自由', bin: { [id]: 'bin/install.cjs' }, engines: { node: '>=18' }, ...(preview ? { chengfengDistribution: { channel: 'github-preview', status: 'local-candidate' } } : {}),
    files: [...wrappers.filter(x => x !== 'package.json'), skillPath],
    repository: { type: 'git', url: `git+https://github.com/${repository}.git` },
    bugs: { url: `https://github.com/${repository}/issues` }, homepage: `https://github.com/${repository}#readme`,
    scripts: { 'test': 'node bin/install.cjs help', 'check:package': 'node bin/check-package.cjs check', 'check:upload': 'node bin/check-package.cjs upload' } });
  fs.writeFileSync(path.join(root, '.gitignore'), `*\n!.gitignore\n!README.md\n!SKILL.md\n!package.json\n!skill-package.json\n!PUBLISHING.md\n!LICENSE\n!NOTICE.md\n!CITATION.cff\n!bin/\nbin/*\n!bin/install.cjs\n!bin/check-package.cjs\n!.agents/\n.agents/*\n!.agents/skills/\n.agents/skills/*\n!.agents/skills/${id}/\n!.agents/skills/${id}/**\n\n# Defense in depth; tracked files and npm contents are audited separately.\n**/.env*\n**/.产品记录/\n**/.skill-install.json\n**/.DS_Store\n**/node_modules/\n**/__pycache__/\n**/logs/\n**/backups/\n**/*.log\n**/*.tgz\n**/*.pyc\n`);
  fs.writeFileSync(path.join(root, 'PUBLISHING.md'), publishingGuide(manifest));
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${id}-installer\ndescription: Install the verified ${id} package when the user explicitly requests installation. Do not use this installer entry for the business task.\n---\n\n# 安装入口\n\n业务能力在 [${id}](${skillPath}/SKILL.md)。先读 [README](README.md) 和 skill-package.json；此包当前是本地候选，不提供已发布的 GitHub 下载承诺。安装需明确目标和授权，不能重装来代替诊断。\n`);
  fs.writeFileSync(path.join(root, 'README.md'), `# ${id}\n\n${title}：${description}\n\n${compatibility ? '历史兼容包，不是独立产品；方法由唯一维护源生成。新任务不默认安装此包。' : '独立维护与分发的 chengfeng-videocut Skill，共用 Runtime CLI；不包含 Runtime、Studio 或媒体工具。'}\n\n## 本地候选安装\n\n当前版本 **${version}**。此候选不代表已发布版本，不要把下面的本地命令替换为未经发布验证的 npx GitHub 地址。已有 Node 18+ 时，在本仓库目录运行：\n\n\`\`\`sh\nnode bin/install.cjs help\nnode bin/install.cjs install --host codex --target-root <已存在的隔离用户目录>\nnode bin/install.cjs doctor --host codex --target-root <同一目录>\n\`\`\`\n\n真实安装须获得授权，并把目标设为真实用户目录；不指定目标时使用当前用户。默认 help 不写入。安装只写中立 .agents/skills/${id}，codex 模式另建精确入口；默认 agents 模式不改宿主配置。不重建 Claude 整目录布局，不迁移现有 Plugin。\n\n相同 ID、版本和文件摘要复用；冲突拒绝，保留已有包，不提供自动升级/卸载。未验证 Windows 安装与当前任务加载。宿主文件安装、实际加载、Runtime 能力和业务验收分开报告。\n\n## 使用\n\n安装并确认宿主可读后，使用 $${id}。完整方法见 [SKILL.md](${skillPath}/SKILL.md)。需要工程操作时核对 Runtime >=0.5.9 及实际 workbench commands；不只看版本号，不默认连接某个端口。安装前先读随包 references/shared/public-plugin-compatibility.md：公开 Plugin 0.10.9 配 Runtime 0.4.10，不能当作已满足新模块合同的组合，不循环安装不兼容版本。\n\n## 整套安装与维护\n\nPlugin 安装入口：\`Agentchengfeng/chengfeng-videocut-skills\`（固定提交 \`b7cbe98c850249892da75de8e2296bd6a343f4a8\`）；需要工作台 Runtime 时再读主仓 INSTALL。\n\n整套说明见 [主仓 INSTALL](https://github.com/Agentchengfeng/chengfeng-videocut/blob/main/INSTALL.md)。已公开六包源码预览，但本候选和远端完整组合不因此视为已发布。本包只包含自己的方法与资源，其他 Skills 分别维护。${compatibility ? `不计划为此旧入口另建仓库；维护归属为 ${repository}。` : `计划仓库名为 ${repository}。`}候选状态见 skill-package.json；远端身份须另核对固定提交和发布证据。\n\n${compatibility ? `此目录是生成的兼容快照，不在此手改方法。维护源：${repository}；回读随包来源摘要。` : `源码唯一真源是 ${skillPath}/。`}references/shared 是公共 CLI 合同的带摘要快照；由工作台 scripts/build-independent-skills.cjs 显式更新。私有产品记录与旧源码不进 Git 或 npm pack。\n\n## 来源与许可\n\n由成峰 / AI产品自由维护，保留 [原项目](https://github.com/Agentchengfeng/chengfeng-videocut-skills) 来源及 LICENSE、NOTICE.md、CITATION.cff。${thirdParty ? '小黑素材内的 GSAP、Rough.js、图标等各有来源与许可，当前完整性未核验，不可直接公开再分发。' : '第三方及 vendor 保留自身的许可与 provenance，不因拆包改变其授权。'}\n`);
  if (maintenanceMode) fs.appendFileSync(path.join(root, 'README.md'), `\n## 旧名称兼容\n\n本包不再默认安装。新任务使用 $${maintenanceId}；此包只保留旧调用，模式文档由 maintain 的真源生成（见 references/maintenance-provenance.json）。单装旧包无需另装 maintain，也不代表获得更新或上报权限。\n`);
  fs.appendFileSync(path.join(root, 'README.md'), '\n## 维护者上传边界\n\n源码、安装包与本地资料的范围见 [PUBLISHING.md](PUBLISHING.md)。上传前运行 `npm run check:package` 和 `npm run check:upload`；检查不执行 GitHub 推送，也不代替人工许可/隐私审查。\n');
  if (preview) {
    fs.writeFileSync(path.join(root, 'README.md'), githubPreview.readme({ id, version, description, skillPath, published: false }));
    fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${id}-installer\ndescription: Install the ${id} local candidate package only when explicitly requested. For business tasks read the packaged Skill instead.\n---\n\n# 安装入口\n\n先读 [README](README.md) 与 skill-package.json，核对来源和明确的目标/授权。当前是未发布本地候选，不猜测 GitHub 标签；使用已核验的本地包路径。使用本包已有 plan/install/doctor，不执行额外安装钩子。业务方法在 [${id}](${skillPath}/SKILL.md)。文件安装不等于 Runtime、宿主加载或完整业务已经通过；未知字段如实报告。\n`);
  }
  report.push({ id, directory: folder, version, description, defaultInstall, ...(compatibility ? { compatibility } : {}), skillPath, files: Object.keys(files).length, contentSha256: sha(JSON.stringify(files)), packageManifestSha256: sha(fs.readFileSync(path.join(root, 'skill-package.json'))), publication: manifest.publication, runtime });
}
if (onlyWorkbench) {
  console.log(JSON.stringify({ status: 'built-local-candidates', count: report.length, skills: report.map(x => ({ id: x.id, files: x.files })) }, null, 2));
  process.exit(0); // A targeted build never refreshes the suite catalog or bootstrap.
}
const catalog = { schemaVersion: 1, status: 'local-candidate', publicReleaseReady: false, description: 'Seven current Skills and four non-default compatibility entries. Explicit local sources, not published download identities.', skills: report };
json(path.join(workbench, 'skills.local-candidate.json'), catalog);
const directoryOutput = path.join(workbench, 'packages/contracts/src/skill-directory.generated.ts');
fs.mkdirSync(path.dirname(directoryOutput), { recursive: true });
fs.writeFileSync(directoryOutput, directorySource(fs.readFileSync(path.join(workbench, 'skills.local-candidate.json'))));
// Bootstrap is a build output from the install Skill, not another maintained method.
const bootstrap = path.join(workbench, 'plugins/chengfeng-videocut');
const bootstrapSkills = path.join(bootstrap, 'skills');
const installId = 'chengfeng-videocut-install';
fs.mkdirSync(bootstrapSkills, { recursive: true });
for (const name of fs.readdirSync(bootstrapSkills)) if (name !== installId) throw new Error('Unexpected business Skill in bootstrap; inspect before migration');
fs.cpSync(path.join(workspace, '安装与接入Skill/.agents/skills', installId), path.join(bootstrapSkills, installId), { recursive: true });
const installFiles = report.find(x => x.id === installId).contentSha256;
// contentSha256 above is a manifest aggregate; use the source manifest's exact owned file list.
const bootstrapSourceFiles = JSON.parse(fs.readFileSync(path.join(workspace, '安装与接入Skill/skill-package.json'))).files;
for (const item of previousBootstrapFiles) if (!Object.hasOwn(bootstrapSourceFiles, item.local)) fs.unlinkSync(item.file);
fs.mkdirSync(path.join(bootstrap, '.codex-plugin'), { recursive: true });
json(path.join(bootstrap, '.codex-plugin/plugin.json'), {
  name: 'chengfeng-videocut', version: '0.1.0-local.1',
  description: 'Local candidate installation guide and pinned local Skill catalog. No bundled business Skills or MCP.',
  author: { name: '成峰 / AI产品自由' }, skills: './skills/',
  interface: {
    displayName: '成峰剪辑 · 安装与接入',
    shortDescription: '按固定清单安装独立 Skills 的本地候选入口',
    longDescription: '提供安装方法及固定本地候选清单。先预检来源、摘要和已有安装，再按授权安装或复用。业务 Skills 独立维护；远端发行、Runtime 安装及宿主加载须另行验收。',
    developerName: '成峰 / AI产品自由', category: 'Productivity', capabilities: [],
    defaultPrompt: ['检查 chengfeng-videocut 的本地候选清单和已有安装，先给出安装计划，不要直接覆盖或更新。'],
  },
});
json(path.join(bootstrap, 'skills.local-candidate.json'), catalog);
json(path.join(bootstrap, 'source-provenance.json'), { schemaVersion: 1, sourceId: installId, contentSha256: installFiles, files: bootstrapSourceFiles, catalogSha256: sha(fs.readFileSync(path.join(workbench, 'skills.local-candidate.json'))) });
fs.writeFileSync(path.join(bootstrap, 'README.md'), '# chengfeng-videocut bootstrap\n\nGenerated local candidate: only the installation Skill and local catalog. Business Skills remain independent. Read skills/chengfeng-videocut-install/SKILL.md. Requires explicit local package inputs; no verified remote bundle, Runtime install, automatic execution or host activation claim. Do not edit generated files.\n');
console.log(JSON.stringify({ status: 'built-local-candidates', count: report.length, skills: report.map(x => ({ id: x.id, files: x.files })) }, null, 2));
