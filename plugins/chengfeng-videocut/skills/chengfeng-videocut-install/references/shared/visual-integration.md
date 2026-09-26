# 画面接入是工程操作，不是独立产品

用户已有 HTML、MP4 或推近方案时，按本页调用共享 Runtime，不要求安装 visual Skill。创作任务另由镜头设计或用户选定的动画能力完成。

1. 读取 [接入与授权](plugin-access.md)、[Runtime CLI](runtime-cli.md)，核对显式 origin、projectId、能力和当前审核 revision。
2. HTML 读取 [模块发布](module-publish.md)及[回放合同](visual-module-contract.md)：候选 → 预检 → 按授权 publish → get。同版本异内容拒绝覆盖，超时先回读原身份。
3. MP4 读取[素材导入](media-assets.md)：核对原素材身份 → media-import → media-get。不要塞入 HTML 伪装接入。
4. 对字幕词锚点和现有层完整回读，使用原 expectedRevision 调用已支持的 visuals-put；保留未授权修改的层，不直接改正式 JSON。
5. 回读层/模块/素材，再检查 Studio 实际画面、暂停、前后 seek、边界和尺寸。预览通过不代替导出验收。

所需接口缺失时报告具体缺口，不扫描端口猜服务、不回退 MCP 或重装整包。镜头判断属于创作方，共用合同只负责安全接入。
