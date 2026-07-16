# chengfeng-VideoCut CLI

`chengfeng-videocut` 是 chengfeng-VideoCut 的本地命令行入口。它负责启动 Studio，并为 Skills、Agent 和脚本提供稳定的项目、剪切与渲染接口。

## 安装

CLI 随 [chengfeng-VideoCut GitHub Release](https://github.com/Agentchengfeng/chengfeng-VideoCut/releases/latest) 的便携包一起分发，不通过 npm 发布，也不需要 `bunx` 或 DMG。

运行要求：

- Bun 1.2 或更高版本
- FFmpeg，包含可执行的 `ffmpeg` 和 `ffprobe`

推荐使用仓库根目录 README 中的一行安装器，或下载 `chengfeng-VideoCut-portable.tar.gz` 手动解压。安装后先执行：

```bash
chengfeng-videocut doctor
chengfeng-videocut --version
```

## 启动

```bash
chengfeng-videocut start --open
chengfeng-videocut start --port 0
chengfeng-videocut start \
  --projects-dir /absolute/projects \
  --data-dir /absolute/runtime-data
```

服务默认监听 `127.0.0.1:5190`，不会主动打开浏览器；使用 `--open` 才会打开。`--port 0` 会选择空闲端口。运行状态默认保存在 `~/.chengfeng-videocut`。

## 项目和剪切

```bash
chengfeng-videocut inspect <project> --json
chengfeng-videocut open <project> \
  --origin http://127.0.0.1:5190
chengfeng-videocut cuts set <project> \
  --file cuts.json \
  --expected-revision none \
  --json
```

`cuts set` 通过产品 API 写入。`--dry-run` 会执行相同的语义计算但不落盘。项目路径必须已经注册到当前使用的项目注册表。

写入时应使用 `inspect` 返回的当前修订值；`expected-revision` 不匹配时命令会拒绝覆盖。剪切选择以 `cutWordIds` 为语义真相，由产品从逐字稿推导时间区间。

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
