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
      |     Bun / FFmpeg / FFprobe
      |
      v
~/.chengfeng-videocut/app/<version> + app/current
~/.chengfeng-videocut/tools/<version> + tools/current
~/.chengfeng-videocut/bin/chengfeng-videocut(.cmd)
      |
      v
service ensure -> launchd / Windows Task Scheduler

用户已确认、确实需要字幕或 HTML 画面层的 export
      |
      v
固定 platform + chrome-headless-shell build + archive SHA-256
      |
      v
~/.chengfeng-videocut/cache/renderer-engine/
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
`assetDownloads: 0`，不重新下载 Runtime 或 tools。渲染引擎是确认 export 时才处理的
独立缓存，不属于安装交易。并发安装只有一个持锁者能改 current。
Codex/installer 退出不结束已经交给常驻 Runtime 的长任务。

## Managed tools

`installer/managed-tools.lock.json` 当前唯一固定：

```text
Bun                    1.3.5
FFmpeg                 6.0
FFprobe                6.0
```

打包必须显式给出三类 source 与 digest；不得从 PATH 选择首个 FFmpeg/FFprobe。复制前对
source 做 canonical + recursive `lstat`，拒绝 symlink、hardlink、reparse point 和特殊
文件。

Chrome Headless Shell 不属于 `tools/current`，也不随 Runtime installer 分发。用户已确认且
实际需要叠层的 export 才由 Runtime 自己取得固定的 Chrome for Testing Headless Shell
（当前 build `151.0.7922.47`），把归档 SHA-256 交给下载器校验，随后在
`cache/renderer-engine/.pending/` 做目录、版本和 executable 摘要自检，再原子激活。
缓存损坏、离线或锁不完整都 fail-closed；不扫描、不启动、不修改 Google Chrome、Chromium、
Edge 或 Electron。代码使用 `@puppeteer/browsers` 下载固定构建，不查询 `latest`。

## 构建

```bash
bun run package:build
bun run portable:pack
bun run installer:build
bun run tools:pack                 # 每个平台在对应 runner 构建
bun run install-manifest:build     # 三个平台资产齐全后
CHENGFENG_VIDEOCUT_NATIVE_ATTESTATION_DIR=/absolute/attestations \
  bun run release:native:stage     # 签名门禁通过后生成干净目录与统一 SHA256SUMS.txt
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
- 首次确认叠层 export 下载固定 Headless Shell，二次 export 命中已验证缓存且不重复下载
- installer 与工具包 macOS/Windows 签名、公证/信誉路径
- Bun、FFmpeg、FFprobe 的再分发许可、源代码/NOTICE 义务，以及 Chrome for Testing
  Headless Shell 的下载来源、使用与再分发边界

### Installer 独立签名门禁

工具许可 `VERIFIED` 只说明工具包许可，不代表 installer 可以公开。正式 native stage 还必须
读取版本库里的 `installer/native-release-signing-policy.json`；policy 必须由
`UNCONFIGURED` 改为经审核的 `VERIFIED`，并固定真实发布者身份：

- 两个 macOS 裸 executable 对最终字节执行 `codesign --verify --strict`，固定 Developer ID
  Team ID、证书 Common Name、叶证书 SHA256 与 codesign identifier，同时要求 Hardened
  Runtime 和 secure timestamp；随后必须由原生 macOS Gatekeeper 返回
  `source=Notarized Developer ID`。既定分发物是裸 executable，notary ticket 由 Apple 在线
  服务供 Gatekeeper 查询；若以后改成 DMG/PKG，则要另加对最终容器的 stapling 验证。
- Windows executable 只能在原生 Windows runner 用 `Get-AuthenticodeSignature` 验证：状态
  `Valid`、签名类型 `Authenticode`、固定证书 Subject/叶证书 SHA256、Code Signing EKU 与
  可信时间戳缺一不可。
- 跨平台汇总不接受普通 JSON sidecar。`.github/workflows/native-release-signing.yml` 只在
  GitHub-hosted 的精确 `v<version>` tag、受保护的 `native-release` environment 中，在原生
  验证通过后用 GitHub OIDC/Sigstore `actions/attest` 对 installer 本体生成 artifact
  attestation。最终 macOS stage 用 `gh attestation verify` 对同一文件字节校验 repository、
  signer workflow、精确 tag、当前 Release commit digest 与 GitHub-hosted runner；任一 bundle
  缺失、伪造、来自旧 tag 移动前的 commit 或对应不同字节都 fail-closed。

PR 和手动 workflow 只跑门禁测试；只有 tag 触发签名/公证/attestation jobs。Tag 模式缺
Developer ID、Apple Notary、Authenticode 证书或受保护 environment secrets 时必须失败，
不会降级为 unsigned。attestation bundles 是发布过程证据，不进入八个最终资产，也不能
代替平台原生签名验证。macOS job 用 tar 传递签名后的 executable 与 bundles，因为普通
GitHub Actions artifact 上传会归一化文件 mode；最终 stage 解包后仍会再次要求 executable
bit、签名和 Gatekeeper 全部成立。

当前许可状态是 **UNVERIFIED**。POC 的 `ffmpeg-static@5.3.0` 实际 FFmpeg 6.0 配置含
GPL/nonfree，只可用于本机工程 smoke，绝不能作为公开资产。没有合规媒体二进制时构建/
发布必须失败。签名 policy 当前也是 **UNCONFIGURED**，没有写入任何虚构发布者身份；
Windows x64、macOS x64、真实调度器、真实证书签名/公证与许可尚未验证，因此 0.5.0
不得发布为稳定可用版本。当前本机的正式 stage 应在复制/删除目标目录前明确 BLOCKED。
