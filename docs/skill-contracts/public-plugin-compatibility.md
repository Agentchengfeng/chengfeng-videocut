# 公开 Plugin 与独立 Skill：先比能力，再安装

本表是已核实的版本组合，不是自动更新源。查询日期：2026-09-14。更高版本仍须读取其真实发行合同，不能仅凭版本号推定兼容。

| 对象 | 固定身份 / 能力 |
|---|---|
| 公开 Plugin 仓库 | `Agentchengfeng/chengfeng-videocut-skills` |
| Plugin 版本及快照 | `0.10.9` / `b7cbe98c850249892da75de8e2296bd6a343f4a8` |
| Plugin 配套 Runtime | `Agentchengfeng/chengfeng-videocut` / `v0.4.10` |
| 独立包新 Runtime 合同 | >=0.5.9，且实际支持本任务所用的 workbench / module 命令 |

两条安装路线不是等价的。公开 Plugin 0.10.9 的 Runtime 0.4.10 有旧版 `visual add/remove`，但没有 `workbench commands/connect` 或 `module publish/get`。因此不能把它推荐为已满足独立小黑新模块交付合同的完整版，也不能用旧命令直接替换新命令。

## 当前任务如何处理

1. 用户已有 ChatCut 或其他合格工作台：沿用其当前受支持接口和本包适配说明；不为此安装我们的 Runtime，不向它发送 workbench JSON。
2. 已有本产品 Runtime：只读核验版本和所需命令，再核验原入口、项目及能力。缺命令标“已安装，但不兼容本次操作”，保留项目，不循环安装相同公开组合。
3. 尚未安装且希望用本产品完成新模块交付：安装前先核对目标发行。若只能取得上表 0.4.10，说明它不能补齐缺口；暂停该工程交接，等待有证据的配套发行或由用户选择另一合格工作台。安装本 Plugin 处理其自带旧版流程是另一选择，不冒充独立小黑新版接入。
4. 用户明确选择独立动画：可以继续生成 HTML/SVG；不要把独立文件说成已进入工程。未选择独立模式时，不静默降级。

小黑新版接入至少须证明 `module publish/get` 的资源摘要/版本回读，以及 `workbench visuals-get/visuals-put` 的完整文档与原 revision 条件提交。不能降低版本检查、略过 capability，或直接写正式项目 JSON 来“修复”兼容性。收费任务、软件安装和正式工程修改的授权分别保持原范围。

Plugin installed/enabled、Skill 文件 doctor、Runtime CLI 可执行、服务连接与业务交付分别报告。文件 doctor 的 `runtime: not-checked` 不代表 Runtime 兼容；仅版本足够也不代表每个命令已经存在。

Plugin 安装以所选 bootstrap 的 `installer-manifest.json` 为准，并回读解析后的确切提交。不要把本表 Plugin 快照当作包含后续修复的 bootstrap 提交；不要为通过测试移动旧标签或覆盖已发布资产。
