'use strict';
// Public package copy, not the private product record. No upload is performed here.
const positioning = {
  workbench: ['Apply explicit edits to existing video-workbench projects.', 'Locate words and clips, add or remove visual overlays, and split, trim or move existing segments with verified readback. This Skill does not decide which take to keep or create animations.'],
  install: ['Install selected video-editing Skills with verifiable local receipts.', 'Plan, install and check explicitly selected local Skill packages. This is an installation guide plus file installers, not the video workbench itself.'],
  cut: ['Review Chinese talking-head retakes before committing word-level cuts.', 'Produce one reviewable cut ledger from real media and transcript evidence. It does not render a finished video or modify the original media.'],
  subtitle: ['Rebuild reviewed subtitles from a transcript and cut ledger.', 'Generate and validate subtitle candidates, preserve reviewed changes and submit through a compatible workbench. Standalone candidate scripts are included.'],
  export: ['Export reviewed edits and verify the requested delivery.', 'Guide an Agent through export planning, explicit confirmation, readback and delivery. The renderer and media tools belong to the workbench, not this Skill.'],
  maintain: ['Diagnose, update or report video-workbench issues with explicit scope.', 'One Skill routes to troubleshooting, checking a selected update, or preparing a redacted bug report. Diagnosis does not automatically authorize an update or an Issue submission.'],
  'shot-design': ['Design clear video shots before choosing animation tools.', 'Define the subject, composition, action beats and transitions. Independent shot planning needs no workbench; animation implementations are separate optional Skills.'],
};
function readme({ id, version, description, skillPath, published = true }) {
  const suffix = id.replace('chengfeng-videocut-', ''), [tagline, value] = positioning[suffix];
  const repo = `Agentchengfeng/${id}`, ref = `v${version}`, spec = `github:${repo}#${ref}`;
  const runner = published ? `npx -y ${spec}` : 'node bin/install.cjs';
  const target = published ? '' : ' --target-root "<existing-test-directory>"';
  const result = `# ${id}

${tagline}

${value}

中文：${description} 独立 Skill 文件包，不包含 Runtime、Studio、FFmpeg 或渲染浏览器。${suffix === 'install' ? '\n\nCodex Plugin source: [chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills), fixed ref `b7cbe98c850249892da75de8e2296bd6a343f4a8`. The Runtime workbench and release guide remain in [chengfeng-videocut](https://github.com/Agentchengfeng/chengfeng-videocut). These are separate delivery layers.\n\n中文分工：skills 仓提供 Codex Plugin 入口；主仓提供 Runtime 工作台与发行说明；安装后分别回读 Plugin 和 Runtime。' : ''}

## Quick Start

${published ? `Source preview **${version}**. Requires Node.js 18+, npm, Git and access to GitHub.` : `Unpublished local candidate **${version}**. Run in this verified source checkout with Node.js 18+. No GitHub tag or remote installation of this candidate is claimed; use an empty isolated target first.`} These commands install Skill files only; they do not install or start a workbench. Review the package before executing it.

\x60\x60\x60sh
${runner} plan --host codex${target}
${runner} install --host codex${target}
${runner} doctor --host codex${target}
\x60\x60\x60

The default target is your user home. For an isolated test, create an empty directory first and include \x60--target-root "<existing-test-directory>"\x60 in all three commands. Omit \x60--host codex\x60 to install only the neutral Agent directory. For published versions, use the documented version tag and verify its commit plus the installed file hashes. On npm 10.9.2, the shorthand with a full 40-character commit instead of the tag failed with \x60GitFetcher requires an Arborist constructor\x60; do not assume that form works on every npm version.

Files go to \x60.agents/skills/${id}\x60 under the target home; Codex mode also creates a precise \x60.codex/skills/${id}\x60 entry. Matching ID, version and file hashes are reused. A conflicting name, version or locally modified copy is rejected without overwriting it. The local receipt does not yet store repository commit, suite ownership or Runtime compatibility. No automatic upgrade or uninstall is provided.

Published preview identities are listed in [the product installation guide](https://github.com/Agentchengfeng/chengfeng-videocut/blob/main/INSTALL.md#verified-preview-commits). That table records verified tag-to-commit mappings, not a signed release or a compatible full-suite manifest. Local candidates are not covered by those published identities.

## Use with an Agent

Once your host discovers the Skill, ask it to use \x60$${id}\x60 for your task. The actual method is [SKILL.md](${skillPath}/SKILL.md); the root SKILL.md is an installer entry, not a duplicate business method. A new host session may be needed. Installing files is not proof that a host has loaded them.

For project operations, this Skill uses [the workbench contract](${skillPath}/references/shared/plugin-access.md) and probes actual CLI capabilities. Runtime >=0.5.9 alone does not guarantee every command; use a compatible workbench and an explicit project/endpoint. Other workbenches require their own verified adapter. Missing software is not silently downloaded. Before recommending installation, read the bundled references/shared/public-plugin-compatibility.md: Plugin 0.10.9 pairs with Runtime 0.4.10 and does not satisfy the independent Xiaohei module contract. Do not repeatedly install an incompatible combination.

${suffix === 'install' ? 'The bundled suite installer accepts explicit local catalogs and package directories. It does not automatically download an entire GitHub suite or install Runtime. This command installs the installation Skill itself, not all business Skills.\n' : ''}
## Preview limits

- File installation, host loading, Runtime compatibility and a completed video workflow are separate checks.
- \x60doctor\x60 reports \x60runtime: not-checked\x60 and \x60hostLoaded: not-checked\x60; these fields are not a claim of readiness.
- Windows and real host/business end-to-end validation are not claimed by this source preview.
- No cloud transcription, account access, telemetry, media upload or automatic Issue submission runs during installation.
- Source previews do not publish an entire workbench release or promise a one-command full suite.

## Package maintenance

The canonical method lives at \x60${skillPath}/\x60. Shared contracts and installer/audit helpers are generated snapshots from the workbench, with provenance where applicable. See [PUBLISHING.md](PUBLISHING.md) for upload boundaries. In a source checkout run \x60npm run check:package\x60 and \x60npm run check:upload\x60 before a release. Tests of file boundaries do not replace manual content/license review.

This repository is intentionally \x60private: true\x60 in package.json to prevent accidental npm-registry publication. GitHub installation and \x60npm pack --ignore-scripts\x60 are still supported. For changes, open a focused Issue or pull request with a minimal reproducible example; never attach secrets or private media.

## Community & Support / 官方来源

Created and maintained by **成峰 / AI产品自由**.

- [This repository](https://github.com/${repo}) and [GitHub Issues](https://github.com/${repo}/issues): source, bugs and reproducible reports.
- [Author on GitHub](https://github.com/Agentchengfeng), [X](https://x.com/chengfeng240928): project updates.
- 小红书、公众号、B站、抖音 / 视频号：**AI产品自由**。Following is optional and never required for installation.
- Original Skill lineage: [chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills); shared workbench: [chengfeng-videocut](https://github.com/Agentchengfeng/chengfeng-videocut).

## License

Project-owned material is provided under **Apache-2.0**. Preserve [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), [CITATION.cff](CITATION.cff) and any bundled third-party notices. Upstream provenance does not imply endorsement. Runtime and optional animation assets have their own distribution and licensing scope.
`;
  if (suffix !== 'workbench') return result;
  return result.replaceAll('--host codex', '--host agents')
    .replace('Omit `--host agents` to install only the neutral Agent directory.', 'The default host is agents; use `--host codex` only when a Codex compatibility entry is explicitly wanted.')
    .replace(/For project operations, this Skill uses[\s\S]*?Do not repeatedly install an incompatible combination\./, 'Project operations require Runtime >=0.5.9 plus actual workbench commands and endpoint capabilities. Read [connection and submission](.agents/skills/chengfeng-videocut-workbench/references/connection.md) and verify the explicit endpoint/project. As checked on 2026-09-20, the public Plugin pairs with Runtime 0.4.11, which lacks these workbench commands. Installing the Skill does not make those features available. If a command or capability is missing, stop: do not automatically download, upgrade, restart, or modify private projects to work around the mismatch.\n\n兼容边界：需要 Runtime >=0.5.9 且实际支持 workbench capabilities。公开 Plugin 配套 Runtime 0.4.11 缺命令；安装 Skill ≠ 功能可用，缺命令就停，不自动下载/升级/修改私有工程。')
    .replace('Shared contracts and installer/audit helpers are generated snapshots from the workbench, with provenance where applicable.', 'The installer/audit helpers are exact snapshots of the shared workbench implementation. This package preserves its own connection and operation methods; it does not bundle unrelated shared-contract snapshots.');
}
function notice(id) {
  return `# ${id} Notice

Copyright 2026 成峰 / AI产品自由

Created and maintained by 成峰 / AI产品自由. Licensed under the Apache License, Version 2.0; see LICENSE.

Official source: https://github.com/Agentchengfeng/${id}
GitHub: https://github.com/Agentchengfeng
X: https://x.com/chengfeng240928
小红书 / 公众号 / B站 / 抖音 / 视频号: AI产品自由

Original Skill lineage: https://github.com/Agentchengfeng/chengfeng-videocut-skills
Shared installer/contracts: https://github.com/Agentchengfeng/chengfeng-videocut
Independent packaging and instructions were reorganized in September 2026.

The upstream workbench contains code derived from HyperFrames (https://github.com/heygen-com/hyperframes), Copyright 2026 HeyGen, Inc., Apache License 2.0, modification baseline 0.7.54. Relevant upstream copyrights, LICENSE and source provenance are retained.
${id.endsWith('-subtitle') ? '\nThis package includes a modified, bundled subset of workbench subtitle/cut/EDL code in scripts/vendor under the installed Skill. Its original LICENSE and source/bundle hashes are retained alongside it. The independent candidate/submit workflow is a project modification.\n' : ''}
This Skill package does not bundle the Studio application, FFmpeg, a browser or GSAP/MotionPathPlugin. Their notices in the full workbench distribution do not describe this package payload. External dependencies, if explicitly installed later, retain their own terms.

Please preserve attribution when copying, translating, redistributing or adapting this Skill. Apache-2.0 Section 4 requires retaining applicable license and readable NOTICE information. This request does not add a separate permission restriction.

Independent project; not affiliated with or endorsed by HyperFrames, HeyGen, GSAP, GreenSock or Webflow. Associated marks belong to their respective owners.
`;
}
module.exports = { readme, notice };
