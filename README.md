# chengfeng-videocut

chengfeng-videocut 是一个本地优先的口播视频剪辑产品：浏览器工作台负责预览、时间线、逐字稿与剪切审核，`chengfeng-videocut` CLI 为 Skills、脚本和 Agent 提供稳定的操作边界。

产品本体与 Skills 分开发布。用户只需安装一次工作台；不同 Skills 通过 CLI 填充项目、读取状态和提交剪切结果，无需复制工作台源码。

## 下载与安装

正式分发只走 [GitHub Releases](https://github.com/Agentchengfeng/chengfeng-videocut/releases)，
不发布 npm 包，也不需要 `bunx`。**v0.4.9 是 Windows Desktop 受控测试
prerelease**：本次 Release 提供 Windows 桌面 EXE 与 CLI 便携包，**不提供 macOS
Desktop DMG**。桌面测试包在完成代码签名、公证与 FFmpeg 再分发复核前只作为预发布
测试资产。

v0.4.9 桌面预览包：

- Windows 10/11 x64：NSIS EXE
- 随包提供 Runtime、Bun、FFmpeg 与 FFprobe，不要求用户修改系统 PATH
- 首次启动把这些资产安装到 `~/.chengfeng-videocut`，再通过同一个稳定 CLI 执行
  `service ensure`；关闭窗口后用户级服务继续运行，Skills 直接复用

macOS 用户可使用下面的 CLI Runtime 安装路径；它不会安装 Desktop App。

纯 CLI / 便携包仍要求 Bun 1.2+ 与 FFmpeg 6+；Windows 的 `install.cjs` 另需
Node.js 20+。Linux 可用 foreground `start` 做开发诊断，常驻 `service` 尚不支持。

macOS CLI Runtime 一行安装（非 Desktop App）：

```bash
curl -fsSL https://github.com/Agentchengfeng/chengfeng-videocut/releases/download/v0.4.9/install.sh | sh
```

安装后可运行：

```bash
chengfeng-videocut doctor
chengfeng-videocut service ensure --open
chengfeng-videocut service status
chengfeng-videocut service logs
```

`service ensure` 是正式用户入口：首次使用时在 macOS 注册 LaunchAgent、在 Windows 注册 Task Scheduler 用户任务，后续调用会复用健康进程。安装器本身只安装 Runtime，不会在安装时偷偷注册后台服务。

桌面 App 是这个规则的另一个入口，不是另一套服务：它先在本地安装随包资产，再显式
执行 `service ensure`。App 与 Skills 都只认 `~/.chengfeng-videocut/bin` 的稳定
launcher；Electron resources 路径不会成为公开 CLI。

本版常驻服务支持 macOS 与 Windows。其他平台调用 `service` 会明确返回 `service_unsupported`，仍可使用 foreground `start` 进行开发诊断。

若终端暂时找不到命令，请按照安装器最后输出的提示，将 `~/.chengfeng-videocut/bin` 加入 `PATH`。

### 手动安装

1. 从 [v0.4.9 prerelease](https://github.com/Agentchengfeng/chengfeng-videocut/releases/tag/v0.4.9) 下载同一版本的 `install.sh`、`chengfeng-videocut-portable.tar.gz` 和 `SHA256SUMS.txt` 到同一目录。
2. 对照 `SHA256SUMS.txt` 校验下载文件。
3. 在该目录运行 `CHENGFENG_VIDEOCUT_DOWNLOAD_BASE="file://$PWD" sh ./install.sh`，把 Runtime 落到稳定的 `~/.chengfeng-videocut/bin` 与 `app/current` 布局。
4. 运行 `~/.chengfeng-videocut/bin/chengfeng-videocut service ensure --open` 启动工作台。

Windows PowerShell 使用同一 Release 的 `install.cjs`、便携包与校验清单：

```powershell
$env:CHENGFENG_VIDEOCUT_DOWNLOAD_BASE = ([uri]$PWD).AbsoluteUri
node .\install.cjs
& "$env:USERPROFILE\.chengfeng-videocut\bin\chengfeng-videocut.cmd" service ensure --open
```

裸解压的便携目录可用于 `doctor` 或 foreground 诊断，但不会被操作系统受管任务绑定为永久路径；请勿移动临时目录后继续依赖其中的服务入口。

版本化资产用于固定版本和回滚；不带版本号的 `chengfeng-videocut-portable.tar.gz` 始终指向该次 Release 的便携包。

## 基本使用

默认服务只监听 `http://127.0.0.1:5190`，不会向局域网或公网开放。运行数据默认保存在 `~/.chengfeng-videocut`。

```bash
# 从任务目录内的真实视频和云端逐词转录创建、准备并注册新项目
chengfeng-videocut project create /absolute/job-dir \
  --video incoming/talk.mp4 \
  --transcript cloud/subtitles_words.json \
  --aspect-ratio 4:3 \
  --json

# 确保常驻服务健康并打开浏览器
chengfeng-videocut service ensure --open

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

正式流程使用 `service ensure/status/logs`。`chengfeng-videocut start` 会把 Server 运行在当前终端中，只用于本地开发和故障诊断；终端退出时它也会退出。

新任务必须走 `project create`，Skill 不预写 `project.json`。视频与转录路径必须位于任务目录内；产品负责规范化输入、prepare 和注册，并在失败时回滚本次创建。`project prepare` 只刷新已有规范项目，二者都不会使用 demo 媒体。

`cuts set` 的 `cutWordIds` 只表示 Skill 判断出的语义删词。CLI 通过 Cuts API 使用 `semantic-overlay` 意图；产品在项目锁内把它与 `natural-pause-v2` 的合法初始化基线合并，再从 `transcript.json` 推导 `cutRanges`。Skill 不读取、复制或手工合并 `baselineCutWordIds`。写入必须携带当前修订值，避免两个写入者互相覆盖。

Studio 逐词编辑使用另一种明确意图 `full-selection`，提交当前完整的“删除/未删除”状态，因此用户可以恢复初始化选中的静音。Cuts API 不接受缺失或未知意图。M1 不把“恢复静音”另存为跨语义重跑的永久偏好：之后再次执行 `semantic-overlay` 会按产品当前的 natural-pause 基线重新计算；永久覆盖需要未来独立的用户 override 字段。

`render run` 只在显式传入 `--confirmed` 后运行。渲染器需要通过 `--renderer` 或 `CHENGFENG_VIDEOCUT_RENDERER_PATH` 指定；产品不会猜测某个 Skill 的安装目录。最终视频只有通过媒体、音频、时长、尺寸、帧率和关键帧证据检查后，项目状态才会进入 `done`。

## 产品与 Skills 的边界

chengfeng-videocut 负责确定性的产品能力：

- 项目注册、解析与修订控制
- 本地 Studio、预览、逐字稿、字幕列和时间线
- 剪切选择的读取、校验和原子写入
- 已确认任务的渲染调用与结果验证
- 面向自动化的本地 CLI/API

Skills 负责判断与编排，例如转录、口误/重复等语义识别、让用户审核和决定是否执行剪切。普通静音由产品的 `natural-pause-v2` 确定性策略负责。公开 Skills 位于 [Agentchengfeng/chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills)。

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
- `apps/desktop`：把同一 Runtime 与依赖装入受管根的 macOS / Windows 桌面壳
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

chengfeng-videocut 与 HyperFrames、HeyGen、GSAP、GreenSock、Webflow 均无隶属或官方背书关系。

## 官方账号

- GitHub：[Agentchengfeng](https://github.com/Agentchengfeng)
- X：[@chengfeng240928](https://x.com/chengfeng240928)
- 小红书、公众号、B站、抖音、视频号：`AI产品自由`
