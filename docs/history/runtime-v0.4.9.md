# v0.4.9 Runtime 历史安装与发布说明

本页保留早期安装、CLI 示例与发布契约，供旧版用户追溯；不是新版整套安装入口，也不证明与新独立 Skills 兼容。新用户从 [INSTALL](../../INSTALL.md) 开始，软件资产以 [v0.4.9 Release](https://github.com/Agentchengfeng/chengfeng-videocut/releases/tag/v0.4.9) 为准。

原文来源：[README](https://github.com/Agentchengfeng/chengfeng-videocut/blob/a0d5d78d2479d0b675b5a7032179c38843cd181f/README.md) 与 [分发文档](https://github.com/Agentchengfeng/chengfeng-videocut/blob/a0d5d78d2479d0b675b5a7032179c38843cd181f/docs/distribution.md)。以下“本版”“当前”“正式”等用词均属于当时语境；命令没有因本次文档整理而重新执行。

## 旧版安装与 CLI 原文

### v0.4.9 下载与安装

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


## 旧版发布契约原文

> 以下虚拟机排障记录不是通用安装建议；不要仅凭该历史记录修改系统安全设置。应先确认故障原因、适用环境及影响，再决定处理方式。

# Distribution

## 唯一公开分发入口

chengfeng-videocut 的正式二进制分发入口是 GitHub Releases：

https://github.com/Agentchengfeng/chengfeng-videocut/releases

当前不发布 npm 包，也不使用 `bunx` 作为用户入口。Runtime 便携包和 Windows NSIS
由同一个版本的 GitHub Release / CI 产物承载。**v0.4.9 是 Windows Desktop 受控测试
prerelease：不附带 macOS DMG。** 仓库可在 macOS CI 构建 DMG，但那不是本次 Release
资产。桌面包在签名、公证与媒体二进制再分发复核完成前只能标为预发布测试资产。

两条用户路径：

- 桌面路径：随包 Runtime、Bun、FFmpeg 与 FFprobe；首次启动写入 Product 受管根，
  不修改系统 PATH
- 纯 CLI 路径：用户自行准备 Bun 1.2+、FFmpeg 6+；Windows 安装阶段还需要
  Node.js 20+ 运行 `install.cjs`

## Release 资产

v0.4.9 Windows Desktop 受控测试 Release 应提供：

- `install.sh`：与该版本绑定的一行安装器副本
- `install.cjs`：Windows / Node 安装器副本
- `chengfeng-videocut-<version>-portable.tar.gz`：版本化便携包
- `chengfeng-videocut-portable.tar.gz`：与本次 Release 内容相同的稳定文件名
- `chengfeng-videocut-<version>.tgz`：版本化 CLI 包，供诊断或受控安装
- `chengfeng-videocut.tgz`：与本次 Release 内容相同的稳定 CLI 文件名
- `SHA256SUMS.txt`：覆盖同次 Release 的全部 Runtime 下载资产：`install.sh`、`install.cjs`、版本化/稳定名 portable 与 tgz，以及 Windows NSIS EXE；它是内容完整性清单，不是发布者签名
- `Chengfeng-VideoCut-<version>-win-x64.exe`：Windows 桌面受控测试包；必须由 Windows workflow 完成无提权安装、启动、受管 Runtime、卸载 smoke 后，才可与同一 `SHA256SUMS.txt` 一起下载

稳定文件名便于安装器和 Skills 使用；版本化文件名用于固定版本、审计和回滚。稳定文件名不得跨 Release 静默替换内容。
macOS DMG 不在 v0.4.9 附件中；未来单独提供 macOS Desktop 测试时，必须另列资产与
对应验证证据，不能把 CI artifact 当成已经发布的下载包。
本次 `release/` 不生成也不接受额外的 source `.tar.gz`；GitHub 自动生成的源码快照
不属于 Runtime 下载资产，不能混入 `SHA256SUMS.txt` 或本次附件清单。
开发者若需本地源码快照，可运行 `bun run release:pack`；它只写入本机
`source-archives/`，不会成为 GitHub Release 附件。

## 用户安装路径

### 桌面路径

桌面 App 的 resources 内包含本版本 `install.cjs`、便携 Runtime、独立校验清单、
Bun、FFmpeg 与 FFprobe。首次启动只写：

```text
~/.chengfeng-videocut/
  app/<version> + app/current
  tools/<version> + tools/current
  bin/chengfeng-videocut(.cmd)
```

随后由已安装稳定 CLI 执行 `service ensure`。macOS 使用 launchd，Windows 使用
Task Scheduler + supervisor；App 退出不停止该服务。所有 Skills 通过同一稳定
launcher 进入，不读取 `.app/Contents/Resources` 或 `%LOCALAPPDATA%\Programs`。
隔离 foreground 仅用于 smoke 和开发诊断。

### 纯 CLI 路径

v0.4.9 预发布测试使用固定 tag 的安装命令（不是可移动的 `main` 或
`releases/latest`）：

```bash
curl -fsSL https://github.com/Agentchengfeng/chengfeng-videocut/releases/download/v0.4.9/install.sh | sh
```

安装器只应从 `Agentchengfeng/chengfeng-videocut` 的 GitHub Release 下载资产，校验 `SHA256SUMS.txt`，并写入产品自己的用户目录。它不得修改用户项目、媒体或其他工具目录。

安装器只安装 Runtime 和稳定启动器，不自动注册、加载或启动用户级服务。用户首次显式调用 `chengfeng-videocut service ensure`，或业务 Skill 进入需要 Runtime 的阶段时，才由产品在 macOS 注册 LaunchAgent、在 Windows 注册 Task Scheduler 任务。

**Windows 虚拟机试用注意**：Windows 11 24H2+ 默认开启 VBS（基于虚拟化的安全），
在 QEMU/UTM 等虚拟机里会因嵌套虚拟化而无声死挂；此时需在客户机内执行
`bcdedit /set {default} hypervisorlaunchtype off` 后重启。真实物理机不受影响。

本版 `service` 契约支持 macOS LaunchAgent 与 Windows 计划任务（`windows-task`：登录任务 + 产品自带 supervisor 看门狗）；其余平台必须 fail-closed 返回 `service_unsupported`，不得用临时 `nohup` 伪装常驻服务。

手动安装用户应把同一 Release 的 `install.sh`、`chengfeng-videocut-portable.tar.gz` 与 `SHA256SUMS.txt` 下载到同一目录，校验后通过本地 Release 目录安装：

```bash
CHENGFENG_VIDEOCUT_DOWNLOAD_BASE="file://$PWD" sh ./install.sh
~/.chengfeng-videocut/bin/chengfeng-videocut doctor
~/.chengfeng-videocut/bin/chengfeng-videocut service ensure --open
~/.chengfeng-videocut/bin/chengfeng-videocut service status
~/.chengfeng-videocut/bin/chengfeng-videocut service logs
```

Windows 用户把同一 Release 的 `install.cjs`、便携包与校验清单放在同一目录后运行：

```powershell
$env:CHENGFENG_VIDEOCUT_DOWNLOAD_BASE = ([uri]$PWD).AbsoluteUri
node .\install.cjs
& "$env:USERPROFILE\.chengfeng-videocut\bin\chengfeng-videocut.cmd" service ensure --open
```

裸解压目录只用于 `doctor` 或 foreground 诊断；受管服务只绑定安装器建立的稳定 launcher，不能绑定下载目录或临时解压路径。

正式运行入口是 `service ensure/status/logs`。`start` 保留为当前终端内的 foreground 开发/诊断模式，不应出现在 Skills、`start.command` 或安装完成后的默认指引中。

LaunchAgent 必须执行便携启动器保留的稳定入口 `~/.chengfeng-videocut/bin/chengfeng-videocut`，并设置 `CHENGFENG_VIDEOCUT_SERVICE=launchd`。不得把某个版本目录的 `cli.js`、Bun PID 或开发机路径写入 plist。

## 包边界

公开便携包包含：

- 已打包的 `chengfeng-videocut` CLI
- Studio 静态资源
- 产品所需的运行时和适配代码
- `LICENSE`、`NOTICE.md`、`MODIFICATIONS.md`、`CITATION.cff` 和第三方归属材料

公开源码包含 `packages/koubo-adapter`，因为口播工作流就是本产品的公开能力之一。Skills 仍在独立仓库 [Agentchengfeng/chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills) 发布，不能被复制进产品便携包。

任何公开资产都不得包含：

- `output/`、用户项目、媒体、渲染结果或项目软链接
- API Key、Cookie、访问令牌、`.env` 或本机凭据
- 任务事件、日志、SQLite 数据库或运行时注册表
- 开发机绝对路径、私有 Skill 路径或未公开的架构工作稿
- Git 历史、`node_modules` 或构建缓存

## 网络和隐私边界

- 服务默认且仅应监听 `127.0.0.1`，除非未来提供显式、经过安全评审的远程模式。
- 核心剪辑流程不包含分析遥测或使用行为上报。
- 安装和更新访问 GitHub。
- 用户主动选择 Google Fonts 时，对应字体资源需要联网；该能力必须标为可选。
- Skills、AI 服务和第三方渲染器的网络行为不属于产品核心的无遥测承诺，必须由各自文档说明。

因此，发布说明应使用“本地优先、核心流程无分析遥测”，不要笼统宣称整个生态完全离线。

## 发布闸门

发布前必须：

1. 通过类型检查、单元测试、Studio 测试和 Release 检查。
2. 在仓库外的全新临时目录通过本地 `install.sh` 安装便携包，验证 `--version`、`doctor`、`service ensure/status/logs`、父终端退出存活、预览、项目写入和本地资源。
3. 在无 `node_modules` 且不访问 npm registry 的环境中验证正式资产。
4. 解压并扫描每个资产，确认没有密钥、本机绝对路径、PostHog 配置或用户数据。
5. 确认版本号、Release 标签、便携包内版本和 `CITATION.cff` 一致。
6. 生成最终 `SHA256SUMS.txt` 后再上传，不得在生成校验值后修改资产。
7. 保留 Apache-2.0 许可、HyperFrames 上游归属和修改说明。
8. v0.4.9 的 Windows 桌面资产必须额外通过无提权 NSIS 安装、App 父进程退出后服务
   存活、稳定 launcher doctor、显式 stop、端口冲突与卸载验证。未来 macOS Desktop
   资产必须另行通过只读 DMG 安装验证。
9. 面向正式可用性的桌面包须完成 macOS 签名/公证、Windows 签名，以及随包
   FFmpeg/FFprobe 的 GPL 许可、对应源代码提供方式与第三方通知复核；未完成只能保留
   为测试资产。v0.4.9 不声称这些工作已完成。

## 许可与品牌

项目自有代码和 HyperFrames 派生代码以 Apache License 2.0 发布，并包含基于 HyperFrames 0.7.54 的修改。便携包捆绑的 GSAP 3.15.0 与 MotionPathPlugin 受 GSAP Standard License 单独约束，因此不得把整个便携包描述为全部 Apache-2.0 或全部开源。源码和便携包必须保留：

- 根目录 `LICENSE`
- `NOTICE.md`
- `MODIFICATIONS.md`
- `THIRD_PARTY_NOTICES.md`
- `THIRD_PARTY_LICENSES.md`
- `LICENSES/HyperFrames-Apache-2.0.txt` 或等价完整 Apache-2.0 文本

chengfeng-videocut 与 HyperFrames、HeyGen、GSAP、GreenSock、Webflow 均无隶属或官方背书关系。发布页、截图和安装界面不得暗示官方关系或商标背书。发布维护者和用户仍需自行确认其具体使用方式符合所有适用条款；本清单不构成法律合规保证。


[返回安装入口](../../INSTALL.md) · [当前分发边界](../distribution.md)
