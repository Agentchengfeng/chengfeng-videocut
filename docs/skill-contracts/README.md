# 独立 Skills 的公共合同真源

这些文档描述工作台选择规则，以及选择 chengfeng-videocut 后同一个 Runtime CLI 的使用边界，不包含第二套执行器或第三方适配器。由构建脚本生成每个独立 Skill 的 `references/shared/` 快照，并记录 SHA-256。业务方法在各 Skill 仓库维护；公共 API 与安装边界在这里维护。

来源：从 chengfeng-videocut-skills 的现役 CLI 合同提取，调整为独立包路径与宿主中立安装，不复制旧 MCP 安装实现。共享内容变化须显式同步并重做包验证；不使已安装包自动更新。

画面接入不再单独作为默认 Skill。技术合同见 [visual-integration](visual-integration.md) 与 [media-assets](media-assets.md)，画面判断和制作工作流归镜头设计。导出和创作包由这里取同源快照，不从旧 visual 包读取。
