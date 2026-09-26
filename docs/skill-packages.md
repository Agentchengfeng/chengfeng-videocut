# 独立 Skill 包维护

这里说明维护者的源码/打包边界；使用者入口是 [INSTALL](../INSTALL.md)。主仓库维护 Runtime/Studio/CLI、bootstrap Plugin、固定清单和共用包装器；各项业务源码独立维护，未获许可的用户数据或第三方资源不能随源码公开。

## 维护位置

| 内容 | 唯一维护位置 |
|---|---|
| 本项业务方法、脚本、必要资源、测试 | 各包 `.agents/skills/<id>/` |
| 公共 Runtime 合同 | 本仓库 `docs/skill-contracts/` |
| 单包/整套本地安装实现 | `scripts/skill-package-installer.cjs`、`scripts/skill-suite-installer.cjs` |
| 发布白名单、检查与 PUBLISHING 生成模板 | `scripts/skill-package-audit.cjs` |
| 包装/元数据/快照/目录生成 | `scripts/build-independent-skills.cjs` |

各包的根 README、安装入口、清单、检查脚本、许可快照及 bootstrap 为显式生成物，不手改另一份业务实现。本仓库的包装器只在维护构建时读取指定工作区，不是 Runtime 对外部源码目录的运行时依赖。

已发布标签不移动。准备修改后的下一版时，在对应包 package.json 选定新版本，再重建。`chengfengDistribution.channel: github-preview`（或 `--github-preview`）只选择面向公开的 README/NOTICE 模板，不证明发布。所有本地生成物都标为 `publication.status: local-candidate`、不产生发布 ref，只给本地安装命令；字段缺失、拼错或只改版本号也不会生成新标签命令。公开 tag→commit 和实测结果独立记录；发布与下载/宿主/业务验收是另一步。

本地安装收据目前仅按 ID、版本、文件摘要复用，不包含仓库 commit、组合归属或 Runtime 检查结果。已公开源码预览的核实提交见 [INSTALL 固定来源表](../INSTALL.md#verified-preview-commits)；这些来源证据不能由一次 `doctor` 替代。

## 构建和检查

```sh
node scripts/build-independent-skills.cjs "<显式的 Skills 工作区>"
node --test scripts/skill-package-audit.test.cjs scripts/build-independent-skills.test.cjs scripts/skill-package-installer.test.cjs
```

在各包源码根目录运行：

```sh
npm run check:package
npm run check:upload
```

源码和 npm pack 候选文件必须与包清单一致；嵌套私有文件、缓存、收据、软链、用户媒体和常见凭据签名会阻断。Git 已跟踪的额外文件也会阻断；索引与工作区差异需审核后重新暂存，再检查。不会自动删除、暂存、推送或执行 npm 生命周期脚本。

安装包可保留必要 HTML/SVG/模板图片与公开测试；默认不含用户视频、音频、字幕数据。确需此类公开 fixture 时应先核验权利与隐私，再更新共用检查策略和测试，而非禁用检查。

## 上传不等于发行

六项候选（install/cut/subtitle/export/maintain/shot-design）按独立仓库方向检查；xiaohei 的第三方许可未完成时阻断公开上传；diagnose/check-updates/report-bug/visual 不另立公开产品。私人能力不进入公开默认清单。`publication.upload` 由同一策略生成，篡改清单不能解除已知阻断。

通过仅证明当前文件边界，仍需人工内容和许可核验；不会审计既有 Git 历史，也不证明远端仓库、完整发行产物、宿主加载或业务执行已通过。GitHub 源码上传需另行授权；工作台大二进制归对应平台发行，不塞进每个 Skill。

本工具检查独立包，不替代工作台整仓的 Release/隐私检查。公开产物应再实际打包、解包、校验、隔离安装，并核验最小任务。
