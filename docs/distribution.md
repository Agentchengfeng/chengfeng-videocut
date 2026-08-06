# Distribution

## 用户入口

0.5.0 只有一个目标入口：Codex Plugin。Plugin 内原生 STDIO MCP 是无状态 bootstrap，
它调用本仓库的编译 installer；Product Runtime 仍是唯一状态、服务、Studio 与长任务
拥有者。原生 MCP 不是第二 Runtime，也不叫 Companion。

```text
[Codex Plugin]
      |
      +-- 已固定 SHA256 的 native installer
      +-- 已固定 SHA256 的 install manifest
      |
      v
[compiled installer：无需系统 Node/Bun]
      |
      +-- Runtime bundle
      +-- platform tools bundle
      |     Bun / FFmpeg / FFprobe / Chrome Headless Shell
      |
      v
~/.chengfeng-videocut/app/<version> + app/current
~/.chengfeng-videocut/tools/<version> + tools/current
~/.chengfeng-videocut/bin/chengfeng-videocut(.cmd)
      |
      v
service ensure -> launchd / Windows Task Scheduler
```

## 0.5.0 Release 契约

同一个 `SHA256SUMS.txt` 必须覆盖且只覆盖以下八个资产：

- `chengfeng-videocut-install-manifest.json`
- `chengfeng-videocut-runtime-0.5.0.tar.gz`
- `chengfeng-videocut-installer-macos-arm64`
- `chengfeng-videocut-installer-macos-x64`
- `chengfeng-videocut-installer-windows-x64.exe`
- `chengfeng-videocut-tools-0.5.0-darwin-arm64.tar.gz`
- `chengfeng-videocut-tools-0.5.0-darwin-x64.tar.gz`
- `chengfeng-videocut-tools-0.5.0-win32-x64.tar.gz`

Plugin 必须固定 native installer SHA256 与 install manifest SHA256。installer 的正式调用
合同是：

```text
--manifest <versioned URL or verified local fixture>
--checksum-file <already verified SHA256SUMS.txt>
--target-root <absolute managed root>
--ensure-service
--json
```

未知参数、重复参数、多余位置参数、相对 target root、文件系统根、用户 HOME 或 HOME
祖先都 fail-closed；target root 自身或任一已有路径组件是 symlink/junction/reparse point
时，也在第一次创建目录或写文件前拒绝。`--checksum-file` 必须包含 manifest 的精确摘要；
manifest 再声明 Runtime/tools 资产名、根目录、SHA256 与精确 byte size，不能自证。
manifest/checksum 有独立小体积上限，Runtime/tools 按声明大小流式、有界下载，实际字节数
必须完全一致后才允许做摘要与解压校验。

## 安装事务

installer 使用 `runtime-update.lock`、`installer-state.json` 与同卷 pending 目录。只有
Runtime 自证、完整树摘要、managed tools 文件清单与服务 health/capabilities 全部通过，
才推进 `app/current` 和 `tools/current`。失败恢复 last-known-good，项目目录永不进入事务。

同一 manifest 的第二次安装先核对 Runtime/tree/tools/manifest 身份；完全一致时输出
`assetDownloads: 0`，不重新下载或启动 Chrome。并发安装只有一个持锁者能改 current。
Codex/installer 退出不结束已经交给常驻 Runtime 的长任务。

## Managed tools

`installer/managed-tools.lock.json` 当前唯一固定：

```text
Bun                    1.3.5
FFmpeg                 6.0
FFprobe                6.0
Chrome Headless Shell  151.0.7922.47
```

打包必须显式给出四类 source 与 digest；不得从 PATH 选择首个 FFmpeg/FFprobe。复制前对
source 做 canonical + recursive `lstat`，拒绝 symlink、hardlink、reparse point 和特殊
文件。Chrome executable 必须位于固定 root 内，`--version` 必须精确返回
`Google Chrome for Testing 151.0.7922.47`。

Runtime 导出只要检测到 Product data root，就严格从 `tools/current/resources-manifest.json`
解析 managed Chrome；manifest 缺失/损坏直接失败，不借系统 Chrome 掩盖。只有没有任何
Product data root 身份的源码 checkout 才允许 legacy system-Chrome fallback。代码不调用
Playwright/Puppeteer 下载浏览器。

## 构建

```bash
bun run package:build
bun run portable:pack
bun run installer:build
bun run tools:pack                 # 每个平台在对应 runner 构建
bun run install-manifest:build     # 三个平台资产齐全后
bun run release:native:stage       # 生成干净目录与统一 SHA256SUMS.txt
```

`tools:pack` 默认要求 release-ready、许可已验证的显式来源。工程 smoke 只有在显式设置
`CHENGFENG_VIDEOCUT_LOCAL_TOOLS_FIXTURE=1` 时才接受本地 POC 二进制，并把工具包写成
`local-test-only` / `UNVERIFIED`；`install-manifest:build` 默认拒绝把它们组装成公开 manifest。
只有 lock 与全部入选平台 sidecar 都是 `VERIFIED` 时，正式 manifest 才能写出
`licenseStatus: VERIFIED`；任何 local fixture 都显式保持 `UNVERIFIED`。

## 发布门禁

- clean macOS arm64/x64 与 Windows x64：无系统 Node/Bun/FFmpeg/Chrome 完整安装
- manifest/checksum 错误、坏 asset digest、并发安装、崩溃恢复和 last-known-good
- `--ensure-service` 后真实 launchd / Task Scheduler health 与 capabilities
- 二次安装 `assetDownloads: 0`，Chrome 不重复下载或启动
- installer 与工具包 macOS/Windows 签名、公证/信誉路径
- Bun、FFmpeg、FFprobe、Chrome Headless Shell 的再分发许可、源代码/NOTICE 义务

当前许可状态是 **UNVERIFIED**。POC 的 `ffmpeg-static@5.3.0` 实际 FFmpeg 6.0 配置含
GPL/nonfree，只可用于本机工程 smoke，绝不能作为公开资产。没有合规媒体二进制时构建/
发布必须失败。Windows x64、macOS x64、真实调度器、签名与许可尚未验证，因此 0.5.0
不得发布为稳定可用版本。
