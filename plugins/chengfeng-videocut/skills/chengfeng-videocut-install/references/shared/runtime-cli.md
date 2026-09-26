# 统一 Runtime CLI

独立 Skills 的工作台业务默认直接调用同一 Runtime CLI，不以 MCP 加载为前提。Skill 判断、创作候选和字幕排版；Runtime 读取正式工程、权威校验、提交、渲染与导出。

## 发现和调用

使用安装记录或用户指定、已验证的Runtime可执行入口，以参数数组调用，不拼shell字符串，不把Plugin的MCP二进制当成Runtime。先读实际入口的--help和workbench commands --json；返回的operation/fields/required/mode是当前合同。新版说明不使旧安装自动具备命令。

```json
["workbench","commands","--json"]
["workbench","connect","--api-base","<用户指定origin>","--json"]
["workbench","workflow-get","--api-base","<同一origin>","--project","<服务器projectId>","--json"]
["workbench","cuts-put","--api-base","<同一origin>","--project","<服务器projectId>","--file","<绝对请求JSON>","--confirmed","--json"]
```

只接受显式HTTP字面loopback origin（127.0.0.1或[::1]，不是localhost），拒绝外网、凭据、重定向、路径和query。不查客户端registry、不猜5190、不注册第二项目、不自动启动服务。保存产品/version/PID/build及每次source；身份变化停止重核，不能把新revision偷换进旧批准方案。

写operation必须独立--confirmed，表示已有用户授权；JSON confirmed:true不能代替标志。仅 commands 中 mode:"plan" 的操作要求 JSON confirmed:false，不能带--confirmed；不要按命令名是否含 plan 推断字段。例如 export-plan 的 mode 是 "read"，请求仅允许 profile，不传 confirmed。请求只放commands列出的字段，不加connection、任意URL或HTTP方法；revision/hash来自回读，operationId在明确新操作时保存，未知结果不换ID。

标准envelope为ok/data或error；业务结果位于data，写回读在data.readback，readBackVerified不等于视觉通过。export/ingest-start的admissionOnly:true、completionVerified:false仅指受理。connect返回source/capabilities，不返回项目URL。

## 操作与请求字段

全部使用上面的workbench参数形状；有字段经--file传JSON。项目操作必须--project，connect/ingest-start/ingest-status不传--project。

| operation | JSON字段及边界 |
|---|---|
| workflow-get / edit-list-get / cuts-get / subtitles-get / visuals-get | 无体，各自revision不混用 |
| playback | {limit:64,cursor?:原样cursor}，串行到page.nextCursor=null；版本变整轮重读 |
| cuts-put | {expectedRevision,operationId,cutWordIds,reasons?,mode?:"semantic-overlay"}；完整语义集合，不混停顿基线 |
| edit-list-patch | {expectedRevision,operation,actor?}，只使用已支持编辑，不猜刀口 |
| workflow-action | {action,expectedRevision,expectedEditListRevision?,config?}；apply-cut额外绑定EDL revision |
| subtitle-inputs | 无体；data.inputDirectory、files、hashes为原始字节暂存，不重新序列化 |
| subtitle-submit | {expectedRevision,candidateDirectory}，本Skill candidate.mjs生成/校验，Runtime复核receipt/输入SHA/CAS |
| visuals-put | {expectedRevision,document}，完整文档、真实词锚点、保留已有层 |
| media-import / media-get | import:{sourcePath,expectedSourceSha256}；get:{assetId}；本地MP4，未知按源SHA即assetId查 |
| config-get / config-set | get无体；set:{expectedRevision,config:{aspectRatio}}，revision来自project.json |
| export-plan | {profile:"fast"或"master"}；保存snapshotFingerprint，尚无成片 |
| export-start | {operationId,expectedSnapshot,outputPath,profile}；原计划确认、新绝对输出路径不覆盖 |
| job-get / job-by-operation | {jobId}或{operationId}，只查同项目export，未知提交精确查原operation |
| job-list / job-cancel | list:{limit?,state?}仅辅助；cancel:{jobId}须确认，不用最近列表证明未提交 |
| ingest-start / ingest-status | start:{operationId,sourcePath,expectedSourceSha256,taskDirectory,language?,aspectRatio?}仅WAV先授权云ASR费用；status:{operationId} |
| transcript-correct | {operationId,expectedRevision,corrections:[{wordId,text}]}，先修字表，只改字不改id/时间 |
| sources-get / operation-get | sources无体；operation:{operationId}查询原多源事务 |
| prepend-plan / prepend-commit | {operationId,sourceProjectId,expectedTargetRevision,expectedSourceRevision,confirmed,planRevision?} |
| word-cuts-plan / word-cuts-commit | {operationId,expectedTargetRevision,wordIds,confirmed,planRevision?} |
| segment-cuts-plan / segment-cuts-commit | {operationId,expectedTargetRevision,clipIds,removeVisualLayerIds?,confirmed,planRevision?} |
| operation-recover | {operationId,action:"finish"或"rollback"}，先查询原事务，显式确认，不是任意undo/redo |

三组plan先confirmed:false；commit必须同operationId/原revision/返回planRevision和confirmed:true，再加--confirmed。多源不能冒用单源cuts-put；服务legacyCutsSet=false时按word/segment事务走。模块沿用module publish/get，见[模块包交付](module-publish.md)，不自动启用层。

## 失败和未支持能力

缺命令报告runtime_cli_command_missing（诊断分类），缺API报告具体capability。提交/回读失联可能已写：保留原输入/source/operationId，不自动重试。字幕/visuals/config读取当前资源；cuts读cuts/workflow/EDL但当前值吻合不证明原operation完成；导出job-by-operation、建档ingest-status、多源operation-get、模块和媒体按不可变身份get。notfound/unknown不授权重提。

新视频ingest、抽帧、词典自动匹配/对齐若不在commands中，不发明operation。仅同Runtime专用本地CLI已明确验证同项目/registry/权限和版本合同时另行选用，否则报告缺口，不转旧MCP、另一registry或源码脚本直写工程。

纯候选不强制Runtime。安装/更新见[共享接入](plugin-access.md)，workbench不替代安装器approvalDigest/资产SHA门禁。
