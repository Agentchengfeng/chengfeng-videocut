# 画面接入是工程操作，不是独立产品

用户已有 HTML、MP4 或推近方案时，按本页调用共享 Runtime，不要求安装 visual Skill。创作任务另由镜头设计或用户选定的动画能力完成。

1. 读取 [接入与授权](plugin-access.md)、[Runtime CLI](runtime-cli.md)，核对显式 origin、projectId、能力和当前审核 revision。
2. HTML 读取 [模块发布](module-publish.md)及[回放合同](visual-module-contract.md)：候选 → 预检 → 按授权 publish → get。同版本异内容拒绝覆盖，超时先回读原身份。
3. MP4 读取[素材导入](media-assets.md)：核对原素材身份 → media-import → media-get。不要塞入 HTML 伪装接入。
4. 对字幕词锚点和现有层完整回读，使用原 expectedRevision 调用已支持的 visuals-put；保留未授权修改的层，不直接改正式 JSON。
5. 回读层/模块/素材，再检查 Studio 实际画面、暂停、前后 seek、边界和尺寸。预览通过不代替导出验收。

所需接口缺失时报告具体缺口，不扫描端口猜服务、不回退 MCP 或重装整包。镜头判断属于创作方，共用合同只负责安全接入。

## 新动画的渐进接入

新层按[local0 创作绑定](visual-module-contract.md#可选-local0-创作绑定)选择可选 `animation`，旧工程不自动升级。先从实际 transcript + EDL 得到剪后句子范围与稳定词 ID，再记录 authoredDuration/anchorWordIds；不要拿原始时间直接作为成片位置。`module-manifest.json` 仍只管理发布文件及摘要，不用它保存项目放置或扩展未经支持的字段。

修改句子后先回读 timing.animation.issues：仅平移可复用；时长变化、关键词删除或分散范围需人工/Agent 复核动作，生成新候选。整句删除禁用原层，不删除 HTML/参数。Studio 不显示明确失效的新层；导出拒绝这些层，不以文件存在冒充可交付。

新 animation 模块须实现显式 seek-applied/seek-error 握手，沿用请求 token。接口接通后还要故意测试一次缺确认和一次明确错误，预览应提示、导出应失败；旧模块收到消息即自动确认的兼容行为不适用于新绑定。

版本提交先 publish/get 验证新身份，再带已读取 expectedRevision 更新完整 visuals 文档，保留其他层；CAS 冲突重读，不自动用最新 revision 重试。移动项目后测试相对资源、0→末尾→中间→0、暂停和横竖方画布；实际预览与导出分别验收，不能只看测试或 HTTP 成功。
