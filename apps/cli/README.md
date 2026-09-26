# chengfeng-videocut CLI

`chengfeng-videocut` 是 chengfeng-videocut 的本地命令行入口。它负责启动 Studio，并为 Skills、Agent 和脚本提供稳定的项目、剪切与渲染接口。

## 安装

CLI 随 [chengfeng-videocut GitHub Release](https://github.com/Agentchengfeng/chengfeng-videocut/releases/latest) 的便携包一起分发，不通过 npm 发布，也不需要 `bunx` 或 DMG。

运行要求：

- Bun 1.2 或更高版本
- FFmpeg，包含可执行的 `ffmpeg` 和 `ffprobe`

推荐使用仓库根目录 README 中的一行安装器；手动下载 Release 时也必须按根 README 用同版本 `install.sh` 把便携包落到稳定 `bin + app/current` 布局。裸解压目录只用于诊断。安装后先执行：

```bash
chengfeng-videocut doctor
chengfeng-videocut --version
```

## 常驻服务

```bash
chengfeng-videocut service ensure --open
chengfeng-videocut service status
chengfeng-videocut service logs
chengfeng-videocut service restart
chengfeng-videocut service stop
```

`service ensure` 是产品和 Skills 的唯一声明式入口：未安装服务时安装，已停止时启动，已健康时不重启。`--open` 会在健康身份检查通过后打开 Studio。`status` 只读服务状态，`logs` 读取产品持久日志。默认服务仅监听 `127.0.0.1:5190`，运行数据默认保存在 `~/.chengfeng-videocut`。

安装器只安装 Runtime，不会自动注册 LaunchAgent。首次显式运行 `service ensure` 或由业务 Skill 调用它时，才安装并启动用户级服务。

当前源码包含 macOS LaunchAgent 与 Windows 计划任务入口；源码测试不代表对应平台的真实安装已经通过。发行版本的支持范围以该版本验收为准。其他平台返回结构化 `service_unsupported`，可使用下方前台诊断入口。

### 入口一致性与失败重试（源码候选）

- 用户级服务标签和 `5190` 端口是单例。更改服务必须选择默认 `~/.chengfeng-videocut` 根及其 `bin/chengfeng-videocut`（Windows 为 `.cmd`）入口；开发根、混用的 HOME / DATA_DIR / EXECUTABLE 或链接重定向返回 `service_target_conflict`，不会尝试接管默认服务。`status` / `logs` 仍可只读检查并展示选择冲突。
- `doctor --json` 的 `runtimeEntry` 只检查选定入口和数据根。`target_missing` 表示该目标不存在，不代表整台机器未安装；`source-development` 不代表宿主 Plugin 已加载；`consistent` 也不代替服务身份、安装内容及业务就绪检查。
- 新生成的服务定义不循环重启失败进程：macOS 关闭 `KeepAlive`，Windows supervisor 单次运行且计划任务不设置失败重试。失败保留日志，解决原因后显式执行 `service start` / `restart`；登录自启仍保留。对应能力 `serviceCrashRestart` 为 `false`。
- PID 探测仅将 `ESRCH` 视为已退出。权限不足、其他未知结果或异机 hostname 的旧锁都会保留并报冲突，不能通过删除锁或反复启动来绕过；主机改名和 PID 复用的自动恢复尚未实现。

这些是源码候选行为，不会因修改源码自动替换已安装 launcher、旧服务配置或 Plugin cache。完整默认入口选择与升级切换仍需独立验收。

### 前台诊断

```bash
chengfeng-videocut start --open
chengfeng-videocut start --port 0
chengfeng-videocut start \
  --projects-dir /absolute/projects \
  --data-dir /absolute/runtime-data
```

`start` 运行在当前终端，仅用于开发和故障诊断，不具备常驻语义。`--port 0` 可选择空闲诊断端口。业务 Skills 和便携包 `start.command` 不应调用该入口。

### 空闲退出与诊断留存（源码候选，显式启用）

```bash
# 在已核验的入口和隔离数据目录验证，900 秒为建议值。
chengfeng-videocut start --data-dir /absolute/runtime-data \
  --projects-dir /absolute/projects --idle-timeout-seconds 900 --open
# 0 关闭自动退出；省略此参数仍保留原有运行方式。
```

- 只有没有活跃客户端、播放、未保存内容、排队/执行任务、转录、预览构建及处理中请求时才计算空闲。所有项目与标签共同判断；健康探测、状态查询和 SSE 心跳不会单独延长使用时间。
- 未保存或播放保护在客户端意外断联时保守保留，不把“心跳消失”当保存成功。通用编辑器尚未完整覆盖保存状态时保持保护，不能承诺全部编辑模式都能自动休眠。
- 普通页面每 25 秒登记活动；关闭时未送达释放信号，最多先等待 90 秒租约过期，再进入空闲倒计时。dirty/playing 保护不使用这一静默过期规则。
- `/api/runtime/activity` 可只读查看当前启用状态与阻断原因。退出前排空工作并释放自身锁，生命周期记录 `idle_timeout`；不删除项目、素材或操作回执。
- 结构化诊断存于所选数据目录的 `logs/diagnostics-v1/`，按 14 天和约 100 MiB 预算轮转，退出后可回读。仅记录允许的状态字段，不收集任意错误正文、凭据或逐字稿。已有 stdout/stderr、旧日志不自动迁移、删除或宣称已完成轮转。
- 默认受管服务的 `service logs` 同时显示结构化诊断，读取日志不启动服务。再次打开通过已核验的原启动入口，受管服务使用 `service ensure --open`；网页刷新本身无法启动已退出的 CLI。
- 某项旧日志不可读时，其他日志仍返回；JSON 的 `logs.errors` 或文字输出的 `unavailable` 标明失败来源，不将失败伪装成空日志。

自动退出不默认开启，避免旧宿主缺少可靠唤起或旧客户端没有未保存保护时中断工作。此源码能力不代表已安装服务、Plugin 或公开发行已升级；启用前须验收选定入口和匹配 Studio。

## 项目和剪切

```bash
# 首次创建：输入必须已经位于该任务目录内
chengfeng-videocut project create /absolute/job-dir \
  --video incoming/talk.mp4 \
  --transcript cloud/subtitles_words.json \
  --aspect-ratio 4:3 \
  --projects-dir /absolute/projects \
  --json

# 仅刷新已经存在 project.json 的规范项目
chengfeng-videocut project prepare /absolute/job-dir --json

chengfeng-videocut inspect <project> --json
chengfeng-videocut open <project> \
  --origin http://127.0.0.1:5190
chengfeng-videocut cuts set <project> \
  --file cuts.json \
  --expected-revision none \
  --json
```

`project create` 是新任务的唯一建档入口：产品会防止目录逃逸，把真实视频和转录复制到任务内规范路径，创建最小 `project.json`，在同一事务中执行 prepare 并注册项目。已有项目、已有同名注册或任何规范产物都会 fail-closed，不覆盖；失败会撤销本次创建的文件。命令不会寻找或注入 demo 媒体。Skill 不应先手写 `project.json`。

`project prepare` 只用于恢复或刷新已有规范项目，不会补造缺失的 `project.json`。

`cuts set` 通过产品 API 以 `semantic-overlay` 写入：文件中的 ids 只包含 Skill 判断的语义删词，产品在项目锁内自动合并 `natural-pause-v2` 初始化基线。Skill 不应读取或手工 union `initialization.baselineCutWordIds`。`--dry-run` 会执行相同的合并与语义计算但不落盘。项目路径必须已经注册到当前使用的项目注册表。

写入时应使用 `inspect` 返回的当前修订值；`expected-revision` 不匹配时命令会拒绝覆盖。剪切选择以 `cutWordIds` 为语义真相，由产品从逐字稿推导时间区间。

Cuts API 同时支持 Studio 的 `full-selection` 意图，它代表完整的删除/未删除状态并允许恢复静音；缺失或未知 `mode` 会 fail-closed。M1 尚未持久化“永远保留此静音”的独立用户 override，后续 semantic-overlay 会重新应用当前产品基线。

用户确认物理剪切时，必须同时携带确认卡锁定的项目 revision 与 EDL revision：

```bash
chengfeng-videocut cuts apply <project> \
  --expected-revision <confirmed-project-sha256> \
  --expected-edit-list-revision <confirmed-edl-sha256> \
  --confirmed \
  --json
```

CLI 不会自动读取“当前最新 EDL revision”来补齐旧命令。参数缺失、值为 `none` 或项目尚无 EDL 时返回 `revision_required`，要求先执行 `project prepare`；确认后 EDL 被修改时返回 `revision_conflict`。以上情况都不会启动物理剪切。

## 已确认渲染

```bash
chengfeng-videocut render run <project> \
  --expected-revision <sha256> \
  --confirmed \
  --renderer /absolute/path/to/renderer.cjs \
  --json
```

渲染是本地且需要确认的动作。兼容渲染器必须通过 `--renderer` 或 `CHENGFENG_VIDEOCUT_RENDERER_PATH` 显式提供。只有成片通过媒体、音频、时长、尺寸、帧率和关键帧证据验证后，项目状态才会写为 `done`。

稳定退出码：

- `7`：未配置渲染器
- `8`：渲染失败
- `9`：最终验证失败

## 本地边界

CLI 与 Studio 核心流程不包含分析遥测，默认只绑定 `127.0.0.1`。用户主动选择 Google Fonts 时会访问对应字体服务；第三方 Skills、AI 服务和渲染器的网络行为由它们各自决定。

需要自动化口播判断时，请另行安装 [chengfeng-videocut-skills](https://github.com/Agentchengfeng/chengfeng-videocut-skills)。Skills 调用此 CLI，不应直接修改 Studio 内部文件。
