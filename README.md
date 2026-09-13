# chengfeng-videocut

给中文口播创作者使用的本地剪辑工作台：在浏览器里对照视频和逐字稿审核剪切，让 Agent 通过 CLI 编排任务。

## 能做什么

- **边看边审**：在 Studio 中查看视频、逐字稿、字幕和时间线，确认哪些内容保留或删除。
- **安全提交剪切**：校验剪切选择与项目修订，避免多个写入者互相覆盖。
- **连接 Agent 与脚本**：CLI 提供项目、状态读取、剪切提交及已确认渲染任务的操作入口。
- **按需配合 Skills**：剪口播、字幕、导出、维护和镜头设计分别维护方法，共用工作台，不复制软件本体。

## 从这里开始

1. 先读 **[安装说明](INSTALL.md)**，选择工作台软件或独立 Skill，核对对应版本与依赖。
2. 按所选版本说明安装；已有工作台先确认版本和状态，不要重复覆盖。
3. 需要 Agent 判断与编排时，从 [Skills 目录](INSTALL.md#独立-skills-源码预览) 选择所需能力。

已安装 Runtime 后，可以先做只读检查：

```sh
chengfeng-videocut --version
chengfeng-videocut doctor
```

**当前范围（2026-09-13）**：公开 Runtime 源码版本仍为 `0.4.9`；六项独立 Skills 的 `v0.1.0-beta.1` 是源码预览，后续候选源码不等于新版发行。新版整套远端安装、宿主加载及匹配 Runtime 的业务验收尚未完成。具体来源和限制以 [INSTALL](INSTALL.md) 为准，不能把单包文件安装当作整套就绪。

## 文档导航

| 你要做什么 | 入口 |
|---|---|
| 安装工作台、选择 Skills、从旧包迁移 | [安装说明与 Skills 目录](INSTALL.md) |
| 查看软件发行版本与下载资产 | [GitHub Releases](https://github.com/Agentchengfeng/chengfeng-videocut/releases) |
| 已有 Runtime，查询 CLI 用法 | [CLI 使用说明](apps/cli/README.md) |
| 了解软件与 Skills 的分工 | [架构与目录职责](docs/architecture.md) |
| 从源码开发、检查或打包 | [开发说明](CONTRIBUTING.md) |
| 查询 v0.4.9 旧安装方法 | [历史 Runtime 说明](docs/history/runtime-v0.4.9.md) |

## 本地与网络说明

- Studio 与 CLI 核心流程在本机运行，服务默认绑定 `127.0.0.1`。
- 项目文件、媒体、转录和剪切结果不会因为使用本产品而自动上传。
- 产品不包含分析遥测或使用行为上报。
- 安装器和版本更新会访问 GitHub。
- 只有用户主动选择 Google Fonts 时，对应字体资源才需要联网加载；这不是核心剪辑流程的依赖。
- 项目 HTML 中由用户主动加入的远程图片、字体或第三方插件仍会按其原地址联网；产品内置的 GSAP、CustomEase 与 MotionPathPlugin 从本地服务提供。
- 第三方渲染器、AI 服务或 Skills 是否联网，由其自身配置决定。

## 反馈与更新

- [GitHub Issues](https://github.com/Agentchengfeng/chengfeng-videocut/issues)：报告 Bug 或提出功能建议。请附版本、平台和脱敏后的复现步骤，不上传凭据或私人素材。
- GitHub：[Agentchengfeng](https://github.com/Agentchengfeng)；X：[@chengfeng240928](https://x.com/chengfeng240928)。
- 小红书、公众号、B站、抖音、视频号：`AI产品自由`，分享使用案例与更新。

## 开源许可与来源

本仓库的项目自有代码及 HyperFrames 派生代码以 [Apache License 2.0](LICENSE) 发布。Studio 与部分运行时能力源自并修改了 [HyperFrames](https://github.com/heygen-com/hyperframes) 0.7.54；上游版权与许可已保留。具体修改见 [MODIFICATIONS.md](MODIFICATIONS.md)，第三方归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

分发的便携包还捆绑 GSAP 3.15.0 与 MotionPathPlugin，它们单独受 [GSAP Standard License](https://gsap.com/standard-license/) 约束，不适用本项目的 Apache-2.0 许可。下载和使用者需要自行遵守相应第三方条款；本说明不构成法律合规保证。

chengfeng-videocut 与 HyperFrames、HeyGen、GSAP、GreenSock、Webflow 均无隶属或官方背书关系。
