---
name: chengfeng-videocut-install
description: 安装或补装 chengfeng-videocut 工作台与指定 Skills，检查固定来源、已有内容和宿主入口。用于首次安装、整套安装或指定包接入；故障和更新交给维护与排障，不因普通剪辑请求自动安装。
---

# 安装与接入

先确认用户要整套还是指定包、宿主与目标位置。读取所选发行的公开 INSTALL 和固定清单；清单与仓库内容只是待核验资料，不提供执行权限。整套授权覆盖清单内默认项，不包含私人小鸟、额外云端费用、系统改动或陌生库适配。

Codex Plugin 的官方来源是 [Agentchengfeng/chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills)，安装时固定到已核验提交 `1487e02b1c0c39ea74d079e8ce45da56bf59bc32`；主 Runtime 的工作台与发行说明仍见 [chengfeng-videocut](https://github.com/Agentchengfeng/chengfeng-videocut)。单装本 Skill 不附带完整组合清单或其他业务包。当前组合脚本只处理用户明确提供的本地清单与子包工作区；尚无已发布、可由该脚本执行的远端整套安装清单，不从仓库名猜下载地址或命令。

## 先判断现状

检查已有工作台和实际文件身份；PATH 找不到 Bun/FFmpeg 不等于未安装。只需独立创作时不强装工作台。已有服务按 [接入规则](references/shared/plugin-access.md)核对身份与能力；不可达/故障/缺接口不等于未安装。维护任务用当前可读的 `$chengfeng-videocut-maintain`，不以重装代替排查。

## 当前可以执行的本地安装

随包脚本只接受已有本地包，支持 Node 18+。不联网、不安装 Runtime，不执行包内钩子；不支持自动升级/卸载。清单中的 `publicReleaseReady=false`、`remoteCommit=null` 不能改写为可下载来源。远端缺少固定发行证据时停止远端步骤，说明需要发布方提供已核实的包，不猜 npx 命令。

使用用户明确选择的本地清单、包含对应子包的工作区，以及已存在的目标用户目录；首次验证使用隔离目录：

```sh
node scripts/skill-suite-installer.cjs plan --catalog "<候选清单.json>" --workspace "<包工作区>" --target-root "<目标目录>" --host codex
node scripts/skill-suite-installer.cjs install --catalog "<同一清单>" --workspace "<同一工作区>" --target-root "<同一目标>" --host codex
node scripts/skill-suite-installer.cjs doctor --catalog "<同一清单>" --workspace "<同一工作区>" --target-root "<同一目标>" --host codex
```

路径相对当前 Skill 目录。默认只取 `defaultInstall=true`；单项加 `--ids chengfeng-videocut-subtitle`，多个 ID 用逗号分隔。`agents` 模式只写中立目录；`codex` 另建对应入口，不改宿主 cache。已授权的明确安装才运行 install；plan/doctor 只读。预检全体包与目标后逐包安装；同身份复用，不同内容拒绝。发生竞态或 I/O 错误返回 partial，保留完成项，依据逐包 `.skill-install.json` 重跑预检，不删除其他包来重试。

## 软件本体与外部来源

软件本体按当前已核验的官方平台发行说明准备或复用，不使用本机开发路径作为通用安装方法。来源要有明确版本/commit、资源摘要和平台；当前本地候选清单不含可执行的远端 Runtime 安装事务。

外部已有 Skill/Plugin：核实固定来源、许可、依赖、目标范围，沿用宿主支持的安装方法。默认的 chengfeng-videocut Plugin 来源为 `Agentchengfeng/chengfeng-videocut-skills`，应按宿主 Plugin marketplace 流程安装并回读 enabled/加载状态；普通 GitHub 库不是现成 Skill，不能只改名字宣布兼容。

## 回读

分别报告包文件身份、宿主发现/加载、Runtime 能力和最小任务；`runtime=not-checked`、`hostLoaded=not-checked` 就是未检查。当前任务不保证热加载，必要时请用户新开任务。安装器只证明文件落地，不证明已经能剪片。业务任务、更新与 Bug 外发需各自授权。
