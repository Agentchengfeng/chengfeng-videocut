# chengfeng-VideoCut

chengfeng-VideoCut 是一个本地优先的口播视频剪辑产品：浏览器工作台负责预览、时间线、逐字稿与剪切审核，`chengfeng-videocut` CLI 为 Skills、脚本和 Agent 提供稳定的操作边界。

产品本体与 Skills 分开发布。用户只需安装一次工作台；不同 Skills 通过 CLI 填充项目、读取状态和提交剪切结果，无需复制工作台源码。

## 下载与安装

正式分发只走 [GitHub Releases](https://github.com/Agentchengfeng/chengfeng-VideoCut/releases)。不发布 npm 包，不需要 `bunx`，当前也不提供 DMG。

运行要求：

- Bun 1.2 或更高版本
- FFmpeg，并确保 `ffmpeg` 与 `ffprobe` 可在终端中运行
- macOS 或 Linux；Windows 尚未作为正式支持平台验证

一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/Agentchengfeng/chengfeng-VideoCut/main/install.sh | sh
```

安装后可运行：

```bash
chengfeng-videocut doctor
chengfeng-videocut start --open
```

若终端暂时找不到命令，请按照安装器最后输出的提示，将 `~/.chengfeng-videocut/bin` 加入 `PATH`。

### 手动安装

1. 从 [最新 Release](https://github.com/Agentchengfeng/chengfeng-VideoCut/releases/latest) 下载稳定资产 `chengfeng-VideoCut-portable.tar.gz` 和 `SHA256SUMS.txt`。
2. 对照 `SHA256SUMS.txt` 校验下载文件。
3. 解压后，在目录中运行 `./chengfeng-videocut doctor`。
4. 运行 `./chengfeng-videocut start --open` 启动工作台。

版本化资产用于固定版本和回滚；不带版本号的 `chengfeng-VideoCut-portable.tar.gz` 始终指向该次 Release 的便携包。

## 基本使用

默认服务只监听 `http://127.0.0.1:5190`，不会向局域网或公网开放。运行数据默认保存在 `~/.chengfeng-videocut`。

```bash
# 启动并打开浏览器
chengfeng-videocut start --open

# 检查项目及当前修订
chengfeng-videocut inspect /absolute/project --json

# 在运行中的工作台打开项目
chengfeng-videocut open /absolute/project \
  --origin http://127.0.0.1:5190

# 用审核结果更新剪切选择
chengfeng-videocut cuts set /absolute/project \
  --file cuts.json \
  --expected-revision <none-or-sha256> \
  --json

# 用户确认后执行物理剪切与验证
chengfeng-videocut render run /absolute/project \
  --expected-revision <sha256> \
  --confirmed \
  --renderer /absolute/path/to/renderer.cjs \
  --json
```

`cuts set` 以 `cutWordIds` 作为语义真相，并从 `transcript.json` 推导 `cutRanges`。写入必须携带 `inspect` 返回的修订值，避免两个写入者互相覆盖。

`render run` 只在显式传入 `--confirmed` 后运行。渲染器需要通过 `--renderer` 或 `CHENGFENG_VIDEOCUT_RENDERER_PATH` 指定；产品不会猜测某个 Skill 的安装目录。最终视频只有通过媒体、音频、时长、尺寸、帧率和关键帧证据检查后，项目状态才会进入 `done`。

## 产品与 Skills 的边界

chengfeng-VideoCut 负责确定性的产品能力：

- 项目注册、解析与修订控制
- 本地 Studio、预览、逐字稿、字幕列和时间线
- 剪切选择的读取、校验和原子写入
- 已确认任务的渲染调用与结果验证
- 面向自动化的本地 CLI/API

Skills 负责判断与编排，例如转录、口误识别、自然气口判断、让用户审核和决定是否执行剪切。公开 Skills 位于 [Agentchengfeng/chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills)。

## 本地与网络说明

- Studio 与 CLI 核心流程在本机运行，服务默认绑定 `127.0.0.1`。
- 项目文件、媒体、转录和剪切结果不会因为使用本产品而自动上传。
- 产品不包含分析遥测或使用行为上报。
- 安装器和版本更新会访问 GitHub。
- 只有用户主动选择 Google Fonts 时，对应字体资源才需要联网加载；这不是核心剪辑流程的依赖。
- 项目 HTML 中由用户主动加入的远程图片、字体或第三方插件仍会按其原地址联网；产品内置的 GSAP、CustomEase 与 MotionPathPlugin 从本地服务提供。
- 第三方渲染器、AI 服务或 Skills 是否联网，由其自身配置决定。

## 架构

- `apps/studio`：编辑器外壳、预览、时间线、字幕与导出界面
- `apps/cli`：`chengfeng-videocut` 命令和本地服务
- `packages/core`：项目解析、剪切语义、校验与原子写入
- `packages/contracts`：与渲染引擎无关的项目和编辑契约
- `packages/hyperframes-adapter`：HyperFrames 预览与渲染适配
- `packages/koubo-adapter`：口播项目适配

工作台不从 Skills 目录或 HyperFrames 源码目录直接导入文件。集成只能通过版本化包、项目文件和 CLI/API 契约完成。

## 源码开发

```bash
bun install
bun run typecheck
bun test packages apps/cli/src
bun run --cwd apps/studio test
bun run package:build
bun run package:check
```

发布前还应执行仓库提供的完整 Release 检查，并用全新临时目录验证便携包。

## 开源许可与来源

本仓库的项目自有代码及 HyperFrames 派生代码以 [Apache License 2.0](LICENSE) 发布。Studio 与部分运行时能力源自并修改了 [HyperFrames](https://github.com/heygen-com/hyperframes) 0.7.54；上游版权与许可已保留。具体修改见 [MODIFICATIONS.md](MODIFICATIONS.md)，第三方归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

分发的便携包还捆绑 GSAP 3.15.0 与 MotionPathPlugin，它们单独受 [GSAP Standard License](https://gsap.com/standard-license/) 约束，不适用本项目的 Apache-2.0 许可。下载和使用者需要自行遵守相应第三方条款；本说明不构成法律合规保证。

chengfeng-VideoCut 与 HyperFrames、HeyGen、GSAP、GreenSock、Webflow 均无隶属或官方背书关系。

## 官方账号

- GitHub：[Agentchengfeng](https://github.com/Agentchengfeng)
- X：[@chengfeng240928](https://x.com/chengfeng240928)
- 小红书、公众号、B站、抖音、视频号：`AI产品自由`
