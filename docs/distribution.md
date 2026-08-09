# Distribution

## 用户入口

0.5.1 只有一个目标入口：Codex Plugin。Plugin 内原生 STDIO MCP 是无状态 bootstrap，
它调用本仓库的编译 installer；Product Runtime 仍是唯一状态、服务、Studio 与长任务
拥有者。原生 MCP 不是第二 Runtime，也不叫 Companion。

```text
[Codex Plugin]
      |
      +-- 固定 npm package name + version + tarball integrity
      +-- 直接取得当前 os/cpu 的一个平台 Runtime 数据包
      |
      v
[npm 平台包：无 lifecycle script、无 bin，不要求用户安装 npm]
      |
      +-- package manifest：平台、installer / legal / SBOM size + SHA256、许可状态
      +-- 复合许可索引、NOTICE、第三方许可和平台 SPDX SBOM
      +-- payload/compiled installer
      |
      v
[compiled installer：无需系统 Node/Bun，安装期不再联网取件]
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

npm registry 在这里是 Product Runtime 平台包的版本化发行仓库，不是用户操作入口。用户只安装
Codex Plugin；原生 bootstrap 自己选择并获取一个精确平台包，校验 registry tarball integrity 与
包内 manifest 后，再显式执行原有 native installer。平台包本身只是数据，不允许
`preinstall` / `install` / `postinstall` 等 lifecycle script，也不暴露 `bin`。

每个平台包只允许以下布局：

```text
package.json
chengfeng-videocut-runtime-package.json
LICENSES.md
LICENSE
NOTICE.md
MODIFICATIONS.md
THIRD_PARTY_NOTICES.md
THIRD_PARTY_LICENSES.md
LICENSES/HyperFrames-Apache-2.0.txt
SBOM.spdx.json
payload/chengfeng-videocut-installer-<exact-platform>
```

`package.json` 使用 `SEE LICENSE IN LICENSES.md`，不把整个 bundled binary 笼统声明为
Apache-2.0。package manifest 对上述每份法律材料和 SPDX SBOM 记录精确 byte size 与 SHA-256；
SBOM 至少要把 Product、Bun、FFmpeg、FFprobe 及 native installer 的关系、版本、来源、许可和
installer SHA-256 绑定起来。SBOM 不替代许可证文本、NOTICE 或 FFmpeg 等组件的源码义务。

包内 native installer 仍静态内嵌 Product Runtime、Bun、FFmpeg 与 FFprobe。浏览器引擎继续由
Runtime 在用户确认的实际叠层 export 中按需下载与缓存，不进入 npm Runtime 包。

## 0.5.1 上游 native build 契约

同一个 `SHA256SUMS.txt` 必须覆盖且只覆盖以下八个资产：

- `chengfeng-videocut-install-manifest.json`
- `chengfeng-videocut-runtime-0.5.1.tar.gz`
- `chengfeng-videocut-installer-macos-arm64`
- `chengfeng-videocut-installer-macos-x64`
- `chengfeng-videocut-installer-windows-x64.exe`
- `chengfeng-videocut-tools-0.5.1-darwin-arm64.tar.gz`
- `chengfeng-videocut-tools-0.5.1-darwin-x64.tar.gz`
- `chengfeng-videocut-tools-0.5.1-win32-x64.tar.gz`

上述八个资产是 Runtime 仓库在 native build、签名与受保护汇总阶段内部使用的上游合同，
不是 Plugin 的下载合同。上游 self-contained installer 仍用 install manifest 与
`SHA256SUMS.txt` 把编译时内嵌的 Runtime/tools 输入绑定起来。

## Plugin 消费合同

Plugin 不再直接消费 GitHub installer、install manifest 或 `SHA256SUMS.txt`。它必须按当前
`os/cpu` 固定一个 npm 平台 package name、精确 version 与 registry 返回的 tarball SRI，解包后
先验证受控布局和 `chengfeng-videocut-runtime-package.json`，再用 manifest 中的 installer
byte size / SHA-256 复核 `payload/` 内的 self-contained installer。三层身份都一致才允许执行：

```text
--target-root <absolute managed root>
--ensure-service
--json
```

Plugin 不给 self-contained installer 传 `--manifest` 或 `--checksum-file`，installer 安装时也不再
联网取 Runtime/tools。未知参数、重复参数、多余位置参数、相对 target root、文件系统根、用户
HOME 或 HOME 祖先仍 fail-closed；target root 自身或任一已有路径组件是
symlink/junction/reparse point 时，也在第一次创建目录或写文件前拒绝。

## 安装事务

installer 使用 `runtime-update.lock`、`installer-state.json` 与同卷 pending 目录。只有
Runtime 自证、完整树摘要、managed tools 文件清单与服务 health/capabilities 全部通过，
才推进 `app/current` 和 `tools/current`。失败恢复 last-known-good，项目目录永不进入事务。

普通安装绝不覆盖 `rollback_failed` journal。维护恢复必须显式使用同平台的自包含 installer：

```text
--recover-rollback
```

它只允许当前用户的默认 Product 根；在锁内验证 journal、旧/候选 Runtime、stable launcher 和旧服务
身份，只解包并校验 installer 内嵌的 tools payload 来重做回滚。它不会读取外部 manifest/checksum，
不会下载 Runtime/tools，也不会开始新安装；custom root、source/external installer、篡改 journal、缺失
候选或损坏内嵌 tools 都必须 fail-closed。恢复成功时 JSON 的 `productVersion` 是实际恢复的旧 Runtime，
不是 installer 自身的版本。

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
bun run tools:pack                 # 每个平台在对应 runner 构建
bun run installer:build            # 需先有 Runtime 与同平台 tools archive + sidecar
bun run install-manifest:build     # 三个平台资产齐全后
CHENGFENG_VIDEOCUT_NATIVE_ATTESTATION_DIR=/absolute/attestations \
CHENGFENG_VIDEOCUT_NATIVE_WORKFLOW_RUN_ID=<protected-native-run-id> \
  bun run release:native:stage     # 签名门禁通过后生成干净目录与统一 SHA256SUMS.txt

# 只有受保护 native security stage、release-ready / VERIFIED 内容和平台 SPDX SBOM
# 同时通过后才允许暂存正式 npm 平台包；本仓没有 publish 脚本。
CHENGFENG_VIDEOCUT_NPM_RUNTIME_STAGE_DIR=/absolute/empty/output \
CHENGFENG_VIDEOCUT_NPM_RUNTIME_SBOM_DIR=/absolute/platform-sboms \
  bun run npm-runtime:stage
bun run npm-runtime:verify -- /absolute/output/darwin-arm64
```

`npm-runtime:stage` 默认只接受 `release-ready / VERIFIED` 的 install manifest，逐个复核
native installer 的 byte size、SHA-256 与 macOS executable bit，并执行与 native stage 相同的
Developer ID / 公证、独立 attestation 与固定发布者身份验证。Windows Authenticode 只能在原生
Windows runner 建立；跨平台 stage 还必须验证独立受保护流程签发的 Windows verification receipt，
该 receipt 逐字节绑定 Windows installer、release commit 与 signing policy，并有独立 GitHub
artifact attestation。一个手工把 JSON 改成 VERIFIED、或只带普通 receipt sidecar 的目录都不能
产生公开 npm 包。当前受保护发布编排尚未建立，checkout policy 明确为 `UNCONFIGURED`，所以正式
npm stage 仍会在写入前停止。

正式 stage 还要求每个平台存在
`chengfeng-videocut-sbom-<version>-<platform>.spdx.json`，并把仓库中现有许可材料逐字节复制、
摘要后放入受控 allowlist；缺文件、SBOM 身份/组件/关系不完整或任何摘要漂移都会拒绝。
输出目录已存在时同样拒绝覆盖。
工程测试必须同时显式设置 `NODE_ENV=test` 与
`CHENGFENG_VIDEOCUT_NPM_RUNTIME_LOCAL_FIXTURE=1`，产物会固定为
`local-test-only / UNVERIFIED / private: true`，仍必须携带法律材料与结构有效的 fixture SPDX
SBOM，普通 verifier 继续拒绝它。本仓普通脚本不提供 npm publish 命令；发布只允许进入下面的
手动 Trusted Publishing workflow。

正式法律材料还必须在 `THIRD_PARTY_NOTICES.md` 与 `THIRD_PARTY_LICENSES.md` 中实际覆盖
Bun、FFmpeg 和 FFprobe；只有文件名存在不算完成。当前仓库尚未收齐这些工具的已审核许可文本，
所以即使手工改变 manifest 状态，正式 npm stage 也会在 native security gate 之前 fail-closed。

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
- 跨平台汇总不接受普通 JSON sidecar。`.github/workflows/native-release-signing.yml` 在
  GitHub-hosted 的精确 `v<version>` tag、受保护的 `native-release` environment 中完成原生签名
  验证，并把 Windows native verification receipt 连同 installer 交给版本库外的独立受保护
  attestation builder；本仓不能给自己的 Release 授权。独立 builder 必须对三个 installer 和
  Windows receipt 生成 GitHub artifact attestation。最终 macOS stage 用 `gh attestation verify`
  对同一文件字节校验 repository、独立 signer workflow、精确 tag、当前 Release commit digest 与
  GitHub-hosted runner；任一 bundle 缺失、伪造、来自旧 tag 移动前的 commit 或对应不同字节都
  fail-closed。

PR 和手动 native workflow 只跑门禁测试；只有 tag 触发签名、公证与受保护 handoff jobs。Tag 模式缺
Developer ID、Apple Notary、Authenticode 证书或受保护 environment secrets 时必须失败，
不会降级为 unsigned。attestation bundles 是发布过程证据，不进入八个最终资产，也不能
代替平台原生签名验证。macOS job 用 tar 传递签名后的 executable 与 bundles，因为普通
GitHub Actions artifact 上传会归一化文件 mode；最终 stage 解包后仍会再次要求 executable
bit、签名和 Gatekeeper 全部成立。

### npm Trusted Publishing（设计已落地，发布仍未启用）

`.github/workflows/npm-runtime-trusted-publish.yml` 只有 `workflow_dispatch`，不会因 push、tag、PR、
Release 或定时任务自动发布。操作人必须同时提供精确 `v<version>` tag 与对应的受保护 native run
ID；workflow 会把 checkout commit、tag、根 `package.json` version 和 native run 的
`head_sha/head_branch/workflow path` 绑定，再下载唯一命名的 protected handoff。随后重新执行 native
security、法律材料、SBOM、平台包 exact-layout / SHA-256 verifier 与 `npm pack --dry-run`，全部通过后
才把三包送入最后的 publish job。

最后 job 使用受保护的 `npm-runtime-release` environment、GitHub-hosted runner、Node 24.6.0 与
npm 11.6.2；只有这个 job 有 `id-token: write`，没有 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN`，命令固定为
`npm publish --ignore-scripts --access public --provenance`。三个 npm package 必须分别在 npm 后台把
Trusted Publisher 配成仓库 `Agentchengfeng/chengfeng-videocut`、workflow 文件
`npm-runtime-trusted-publish.yml`、environment `npm-runtime-release`，并只允许 publish。平台包
`package.json.repository` 也必须精确指向同一 GitHub 仓库，供 provenance 绑定。

正式启用前仍有两个不可省略的外部门禁：一是把 signing policy 从 `UNCONFIGURED` 改为经审核的
真实发布者/独立 signer 固定值；二是由独立受保护 orchestrator 产出包含 release、attestations、
platform SBOM 的 `native-release-protected-stage.tar.gz`。当前任一项都未完成，所以 workflow 会在
publish 之前 fail-closed；不得为了“测试版”加 token、unsigned fallback、跳过 Windows receipt 或
把 local-test-only / UNVERIFIED 包发布出去。npm 的三个 publish 调用不是原子事务，workflow 会在
第一次 publish 前先确认三个精确版本都不存在；若发布中途网络失败，必须人工审计 registry 状态，
不能重用同一个 semver 假装整批回滚。

当前许可状态是 **UNVERIFIED**。POC 的 `ffmpeg-static@5.3.0` 实际 FFmpeg 6.0 配置含
GPL/nonfree，只可用于本机工程 smoke，绝不能作为公开资产。没有合规媒体二进制时构建/
发布必须失败。签名 policy 当前也是 **UNCONFIGURED**，没有写入任何虚构发布者身份；
Windows x64、macOS x64、真实调度器、真实证书签名/公证与许可尚未验证，因此 0.5.1
不得发布为稳定可用版本。当前本机的正式 stage 应在复制/删除目标目录前明确 BLOCKED。
