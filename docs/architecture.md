# 软件架构与目录职责

本页说明本仓库公开源码的边界，不是待办清单，也不是完整新版已发行的证明。安装范围与版本以 [INSTALL](../INSTALL.md) 为准，分发职责见 [distribution](distribution.md)。

## 产品组成

```text
独立 Skills / Agent / 脚本
              │ 通过 CLI / API 调用
              ▼
chengfeng-videocut 工作台
  ├─ Runtime CLI：项目、状态、修订、剪切提交、确认后的渲染调用
  ├─ Studio：预览、逐字稿、字幕、时间线和审核界面
  ├─ Core / Contracts：共享数据、校验与写入规则
  └─ Adapters：口播工程与 HyperFrames 引擎的适配
```

Skills 维护语义判断与编排方法，不复制 Runtime。工作台不直接导入本机 Skills 目录或外部源码仓库；集成通过版本化包、项目文件及 CLI/API 完成。源码目录、独立 Skill 和安装产物是不同对象。

## 代码放在哪里

| 位置 | 职责 |
|---|---|
| [apps/studio](../apps/studio) | 浏览器编辑器、预览、时间线、字幕与审核界面 |
| [apps/cli](../apps/cli) | CLI、本地服务、打包及 Runtime 操作入口 |
| [apps/desktop](../apps/desktop) | 桌面壳与受管资产准备；可构建的平台不等于已发行的平台 |
| [packages/core](../packages/core) | 项目解析、剪切规则、校验与原子写入 |
| [packages/contracts](../packages/contracts) | 项目与编辑数据契约 |
| [packages/hyperframes-adapter](../packages/hyperframes-adapter) | HyperFrames 引擎适配 |
| [packages/koubo-adapter](../packages/koubo-adapter) | 口播工程到工作台的适配 |
| [scripts](../scripts)、[test](../test) | 构建、发行与自动化验收；不是用户业务素材 |

编辑器布局归 Studio，共享数据归 Contracts，引擎与业务流程相关实现分别归对应适配层。具体命令见 [CLI 使用说明](../apps/cli/README.md)，开发步骤见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 项目数据与写入

- 用户项目、媒体、转录、运行日志与派生产物留在本地，不纳入源码发行。
- 项目注册表可由 `VIDEO_WORKBENCH_PROJECTS_DIR` 指定；运行时项目软链也不进入 Git。
- 正式剪切写入经产品的修订校验与原子写入路径完成；Agent 不直接覆盖用户当前选择。
- 渲染与外部服务按各自确认条件执行；文件存在、CLI 返回或 UI 可见不等于成片验收通过。

## 上游快照与实验

以下目录不能按“存在重复文件”直接删除：

| 位置 | 用途与整理边界 |
|---|---|
| [hf-upstream-0.7.60](../apps/studio/src/cut/timeline/hf-upstream-0.7.60) | 只读审计母版；边界测试逐文件校验 114 项，禁止运行时代码导入；其中 35 个上游测试不进入 Product 测试收集 |
| [vendor/hyperframes-timeline-0.7.60](../vendor/hyperframes-timeline-0.7.60) | 早期部分快照；其中 16 个文件与母版重复，但 `player-components/TimelineSelectionOverlays.tsx` 是母版没有的独有文件，不能按重复目录删除；合并前需保留来源与差异 |
| [scripts/experiments](../scripts/experiments) | 非生产实验；不属于默认安装或正式剪辑步骤，不因没有自动调用就假定无人使用 |

## 早期架构记录

最初的分层方案与迁移顺序已移到 [架构历史](history/architecture-initial.md)。其中的步骤不再直接代表当前待办或迁移完成度；要判断实际实现，应核对对应代码和验收证据。
