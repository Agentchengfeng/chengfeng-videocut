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

常驻服务本版只支持 macOS。其他平台会返回结构化 `service_unsupported`，不会伪装已常驻；可继续使用下方 foreground 诊断入口。

### 前台诊断

```bash
chengfeng-videocut start --open
chengfeng-videocut start --port 0
chengfeng-videocut start \
  --projects-dir /absolute/projects \
  --data-dir /absolute/runtime-data
```

`start` 运行在当前终端，仅用于开发和故障诊断，不具备常驻语义。`--port 0` 可选择空闲诊断端口。业务 Skills 和便携包 `start.command` 不应调用该入口。

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
