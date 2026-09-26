# 四个业务 Skill 的阶段合同

`chengfeng-videocut-cut` 必须引用并按本合同执行。本文件是普通内部 reference，不是用户可调用的 Skill，不创建项目副本、播放器、素材库、上传会话或媒体写入能力。

## 固定阶段

```text
preflight
  -> Product state readback
  -> proposal
  -> Product CAS
  -> project-level review binding
  -> user confirmation
  -> Product execution
  -> outcome verification
```

阶段不得跳过、合并成“已经审核”，或用缓存、浏览器 DOM、HTTP 200 代替 Product readback。

先读[共享接入](plugin-access.md)、[CLI合同](runtime-cli.md)和[业务请求](existing-workflow.md)。同一显式origin和服务器projectId；不用MCP或受管5190替代用户工作台。阶段是责任顺序，不强迫独立字幕/画面任务从剪口播重跑。

| 阶段 | 必须做 | 失败时 |
|---|---|---|
| preflight | workbench commands/connect核验具体能力、源媒体与授权；新WAV走ingest-start/status，先授权云ASR费用。新视频另验同Runtime专用CLI或报缺口，不走裸transcribe、素材库、material-library、上传会话或预写transcript.json | 保留最后完整状态 |
| Product state readback | workflow-get/cuts-get/edit-list-get；playback请求limit:64和原样page.nextCursor串行读完，冻结同revision | 版本变整轮重读 |
| proposal | 子Agent只返回候选行；唯一协调者临时合并全量语义候选，Skill不写正式项目 | 不提交 |
| Product CAS | 每个稳定版本只调用一次workbench cuts-put CAS；字幕subtitle-submit、画面visuals-put、其他明确操作使用原expectedRevision；写后readback | 不偷换revision，不增量补写 |
| project-level review binding | 同一origin的既有Studio项目URL中#project/<projectId>须与回读项目一致，绑定stage和各资源revision；核对页面capability。connect不返回项目URL | 身份或版本不一致先重核 |
| user confirmation | 明确批准本方案；不产生一次性Product receipt，CLI --confirmed只表达已有授权 | 播放/打开不算确认 |
| Product execution | workflow-action使用冻结revision；apply-cut额外expectedEditListRevision。导出export-start使用批准的expectedSnapshot/profile/outputPath | 变化回审核 |
| outcome verification | 读规范产物/任务最终result，分别报告结构/视觉/听感 | 受理不等于完成 |

## 结论等级

| 结论 | 允许的证据 | 不代表 |
| --- | --- | --- |
| API/readback PASS | Product 结构化 readback、revision、stage、媒体/verification 字段相符 | 视觉画面或人已听过声音 |
| visual frame PASS | 真实项目在 Codex 内置浏览器中打开，画面帧与同一绑定 project/revision 可见且符合审核目标 | 音频听感 |
| human listening PASS | 人实际比较并明确记录的听音结论 | 自动播放、静音测试、DOM、截图或媒体流探测 |

没有真实人类听音记录时，必须报告 **human listening UNVERIFIED**；不得声称 PASS。若本轮没有真实 UI 路径，visual frame 也必须是 UNVERIFIED，而不是由静态测试代替。

## 共同停止条件

- 业务 Skill 按流程顺序：剪口播 → 字幕 → 画面 → 导出。**一段只产出一样东西，产出即交棒。**
  「导出」曾经排在第二位，因为它当时的含义是物理剪切、下游要拿 `source_cut.mp4` 去重新转写。
  字幕改成从账本算时间之后，那个前置条件消失了，导出也就变成了链条最后一段：成片。
- 不新增或暴露“验证”“播放器”“上传”或“素材库” Skill；也不新增第五个业务段。
- 业务任务不自行替换Runtime/Studio、改端口/schema/source或直接写正式项目文件；服务维护须单独授权。
- 不改任何 Skill 的 `user-invocable` metadata；其存在不证明 host UI 可见。
- 支持 Skill 不进入本合同的剪辑状态机。
