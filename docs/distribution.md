# Distribution

## 唯一公开分发入口

chengfeng-videocut 的正式二进制分发入口是 GitHub Releases：

https://github.com/Agentchengfeng/chengfeng-videocut/releases

当前不发布 npm 包，不使用 `bunx` 作为用户入口，也不提供 DMG。这样可以避免用户安装时依赖 npm registry，并让下载文件、校验值、版本说明和回滚版本都集中在同一个 Release 中。

用户仍需自行准备：

- Bun 1.2 或更高版本
- FFmpeg，包含 `ffmpeg` 和 `ffprobe`
- Windows 安装阶段需要 Node.js 20 或更高版本来运行 `install.cjs`

## Release 资产

每个正式版本至少应提供：

- `install.sh`：与该版本绑定的一行安装器副本
- `install.cjs`：Windows / Node 安装器副本
- `chengfeng-videocut-<version>-portable.tar.gz`：版本化便携包
- `chengfeng-videocut-portable.tar.gz`：与本次 Release 内容相同的稳定文件名
- `chengfeng-videocut-<version>.tgz`：版本化 CLI 包，供诊断或受控安装
- `chengfeng-videocut.tgz`：与本次 Release 内容相同的稳定 CLI 文件名
- `SHA256SUMS.txt`：覆盖 `install.sh`、`install.cjs`、版本化/稳定名 portable 与 tgz 的 SHA-256 校验值

稳定文件名便于安装器和 Skills 使用；版本化文件名用于固定版本、审计和回滚。稳定文件名不得跨 Release 静默替换内容。

## 用户安装路径

推荐安装命令：

```bash
curl -fsSL https://raw.githubusercontent.com/Agentchengfeng/chengfeng-videocut/main/install.sh | sh
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

## 许可与品牌

项目自有代码和 HyperFrames 派生代码以 Apache License 2.0 发布，并包含基于 HyperFrames 0.7.54 的修改。便携包捆绑的 GSAP 3.15.0 与 MotionPathPlugin 受 GSAP Standard License 单独约束，因此不得把整个便携包描述为全部 Apache-2.0 或全部开源。源码和便携包必须保留：

- 根目录 `LICENSE`
- `NOTICE.md`
- `MODIFICATIONS.md`
- `THIRD_PARTY_NOTICES.md`
- `THIRD_PARTY_LICENSES.md`
- `LICENSES/HyperFrames-Apache-2.0.txt` 或等价完整 Apache-2.0 文本

chengfeng-videocut 与 HyperFrames、HeyGen、GSAP、GreenSock、Webflow 均无隶属或官方背书关系。发布页、截图和安装界面不得暗示官方关系或商标背书。发布维护者和用户仍需自行确认其具体使用方式符合所有适用条款；本清单不构成法律合规保证。
