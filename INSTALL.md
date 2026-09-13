# 安装 chengfeng-videocut

本仓库是产品总入口。安装与接入的方法只维护在 [chengfeng-videocut-install](https://github.com/Agentchengfeng/chengfeng-videocut-install)，软件本体仍由本仓库提供；业务 Skills 在各自仓库维护。

## 当前能安装到哪一步

截至 2026-09-13：

- 六项独立 Skills 的 `v0.1.0-beta.1` 是已公开的源码预览，可分别安装文件、校验和复用。
- 安装 `chengfeng-videocut-install` 取得的是安装 Skill 本身，**不会自动安装全部业务 Skills 或 Runtime**；其中的组合脚本目前接受本地清单与路径。
- 新整套远端安装、匹配 Runtime 的交付、宿主实际加载以及真实剪辑/导出流程仍需验收。不要把本页链接表当作已验证的整套兼容清单。
- 工作台旧版本见 [Releases](https://github.com/Agentchengfeng/chengfeng-videocut/releases)。各版本的平台和依赖以对应说明为准，不能默认与本批 Skills 兼容；本次没有发布新工作台版本。

## 独立 Skills 源码预览

以下六包均为 `v0.1.0-beta.1`。完整产品的组合清单由主仓维护；此表仅是已公开的单包目录。

| 功能 | 唯一仓库 | 本项职责 |
|---|---|---|
| 安装与接入 | [chengfeng-videocut-install](https://github.com/Agentchengfeng/chengfeng-videocut-install) | 计划、复用、安装指定 Skills 与回读，不含工作台 |
| 剪口播 | [chengfeng-videocut-cut](https://github.com/Agentchengfeng/chengfeng-videocut-cut) | 口误、重复与多次 take 的判断和审核 |
| 字幕 | [chengfeng-videocut-subtitle](https://github.com/Agentchengfeng/chengfeng-videocut-subtitle) | 修字、分屏、字幕候选与提交 |
| 导出 | [chengfeng-videocut-export](https://github.com/Agentchengfeng/chengfeng-videocut-export) | 导出编排与交付验收，编码执行归 Runtime |
| 维护与排障 | [chengfeng-videocut-maintain](https://github.com/Agentchengfeng/chengfeng-videocut-maintain) | 按请求选择排查、更新或 Bug 反馈 |
| 镜头设计 | [chengfeng-videocut-shot-design](https://github.com/Agentchengfeng/chengfeng-videocut-shot-design) | 构图、动作节拍与镜头方案 |

小黑动画未进入本次公开目录，第三方资源许可仍待核验；私人动画不公开、不默认安装。旧 diagnose、check-updates、report-bug 三项由 maintain 承担；visual 不是新的默认独立产品。

<a id="verified-preview-commits"></a>
## 已公开预览的固定来源

以下为 2026-09-13 回读 GitHub 的 `v0.1.0-beta.1` 标签提交。它们标识旧版单包源码，不代表本地后续修改，也不是已验收的整套 Runtime 兼容清单。

| 仓库 | 标签对应提交 |
|---|---|
| chengfeng-videocut-install | [3b6c4ef80aeb30dcc80a95b63f06c20360bad388](https://github.com/Agentchengfeng/chengfeng-videocut-install/commit/3b6c4ef80aeb30dcc80a95b63f06c20360bad388) |
| chengfeng-videocut-cut | [633d59236100784a36eef0c21c86945e618fc25a](https://github.com/Agentchengfeng/chengfeng-videocut-cut/commit/633d59236100784a36eef0c21c86945e618fc25a) |
| chengfeng-videocut-subtitle | [24f6d35726846df5b8778495b2cdc04b3bc67934](https://github.com/Agentchengfeng/chengfeng-videocut-subtitle/commit/24f6d35726846df5b8778495b2cdc04b3bc67934) |
| chengfeng-videocut-export | [74d20c8ee7f12853f954dec9e567ed74aa3d4a0e](https://github.com/Agentchengfeng/chengfeng-videocut-export/commit/74d20c8ee7f12853f954dec9e567ed74aa3d4a0e) |
| chengfeng-videocut-maintain | [ad2622865d72e688cdbc713d48a70f1e3ff124a9](https://github.com/Agentchengfeng/chengfeng-videocut-maintain/commit/ad2622865d72e688cdbc713d48a70f1e3ff124a9) |
| chengfeng-videocut-shot-design | [fa3ea6fe79a3cbbd48e62cb6a1bbff344ac223bf](https://github.com/Agentchengfeng/chengfeng-videocut-shot-design/commit/fa3ea6fe79a3cbbd48e62cb6a1bbff344ac223bf) |

安装前核对所选仓库的标签解析提交，例如：

```sh
git ls-remote https://github.com/Agentchengfeng/chengfeng-videocut-install.git refs/tags/v0.1.0-beta.1 'refs/tags/v0.1.0-beta.1^{}'
```

标签可能移动；不一致时停止，不把当前 main 或另一个提交冒充本表版本。下载后还要核对来源与安装文件摘要；本表不是签名，不消除下载期间标签变化风险。安装器本地收据只核对 ID、版本与文件摘要，尚不记录仓库 commit、组合归属或 Runtime 兼容性。

## 示例：只安装安装与接入 Skill

前提：Node.js 18+、npm、Git，可访问 GitHub；先检查来源与目标。执行以下命令会安装包文件，不会启动工作台、上传素材或调用云端服务。

```sh
npx -y github:Agentchengfeng/chengfeng-videocut-install#v0.1.0-beta.1 plan --host codex
npx -y github:Agentchengfeng/chengfeng-videocut-install#v0.1.0-beta.1 install --host codex
npx -y github:Agentchengfeng/chengfeng-videocut-install#v0.1.0-beta.1 doctor --host codex
```

该标签核实的提交为 `3b6c4ef80aeb30dcc80a95b63f06c20360bad388`；按标签取包仍应核对解析提交和文件摘要，标签不是签名。本机 npm 10.9.2 的完整 SHA 简写曾触发 GitFetcher 错误，因此这里使用已验证的标签形式，不承诺所有 npm/平台都已测试。

默认安装到用户 `.agents/skills/chengfeng-videocut-install`，Codex 模式建立对应入口。隔离测试先创建空目录，再为每条命令追加 `--target-root "<已存在的测试目录>"`；不用真实用户安装目录做首次测试，不覆盖 HOME/CODEX_HOME。具体行为与限制以 [本包说明](https://github.com/Agentchengfeng/chengfeng-videocut-install#quick-start) 为准，其他业务包按各自说明单装。

相同 ID、版本与文件摘要复用，内容或版本冲突拒绝覆盖；这不是对仓库来源或组合归属的完整判定。文件安装后还要确认宿主发现/加载；可能需要新任务。`doctor` 的 `runtime: not-checked` 和 `hostLoaded: not-checked` 不能算这两层通过。Windows 与完整业务 E2E 不在当前预览验收结论中。

## 完整产品的目标流程

主仓公开说明 → 固定组合清单与安装 Skill → Agent 按授权核对已有环境 → 准备或复用 Runtime 与所选 Skills → 分层验收 → 保存本地安装结果。

这条整套远端流程尚未全部实现。清单负责版本选择，安装 Skill 负责方法与调用，Runtime 负责软件运行；三者不互相复制源码。不支持的环境或版本要报告缺口，不猜安装命令，不为了安装新包删除旧环境。

## 旧仓库用户

[chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills) 保留旧网址、代码和标签，首页引导到本仓库。不与 install 合仓，不再维护第二套新安装流程。

现有旧 Plugin、安装器和已发布版本不会因这份说明被升级或卸载。旧命令仍可能安装旧版本；切换前必须核对当前来源、版本、本地修改与同名 Skills，按明确授权迁移，不要同时启用冲突的旧包与独立包。安装授权不包含上传视频、云端费用或自动上报 Issue。
