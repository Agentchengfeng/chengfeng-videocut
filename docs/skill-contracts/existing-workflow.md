# 工作台 CLI 业务请求

先读runtime-cli.md，使用安装记录中的同一Runtime入口。所有项目操作显式--api-base和--project；JSON通过--file传，写操作独立--confirmed。命令数据在data，写回读在data.readback；保存source与原revision。无需MCP connection，不默认5190、不查客户端registry。

## 剪口播与修字

1. workbench workflow-get/cuts-get/edit-list-get读取同项目，分别保存revision。
2. workbench playback请求{limit:64}后用原样cursor串行直到page.nextCursor=null；startIndex/endIndex连续，transcriptRevision/editListRevision不变。版本变化整轮重读。
3. 句段通览、远距离take与五轮形成唯一全量语义候选。已授权才workbench cuts-put：{expectedRevision:原cuts revision,operationId,cutWordIds,reasons}，不混停顿基线。写后检查readback与noLongerCut，再读workflow/EDL。
4. 未知cuts提交读当前cuts/workflow/EDL；当前吻合不证明原操作成功，没有专门cuts operation查询不发明。保留原ID，不重复PUT当查询。
5. 修字先出表，workbench transcript-correct：{operationId,expectedRevision:本轮transcriptRevision,corrections:[{wordId,text}]}，只改字。成功后重新取playback；未知保留原ID，不能自动再写。

## WAV建档

workbench ingest-start不带--project，请求{operationId,sourcePath,expectedSourceSha256,taskDirectory,language?,aspectRatio?}，先确认云ASR费用及本次授权再加--confirmed。sourcePath为真实普通WAV，taskDirectory不得已有Product输出；源已在该目录时由Runtime核验复用，不清空目录。operationId绑定相同输入，原素材不改。

workbench ingest-status请求{operationId}精确查原操作；running等待、succeeded回读项目，interrupted/failed/unknown/notfound先核查不盲重试。服务需ingestApiVersion；新视频不能塞进WAV接口，另行核验同Runtime专用CLI或报告缺能力。修字需transcriptCorrectionApiVersion。

## 字幕

1. workbench subtitles-get读当前revision与skillResult.review，再subtitle-inputs取得inputDirectory及files中的原始transcript/EDL/subtitles字节。不要重序列化冒充SHA。
2. 本Skill candidate.mjs generate和validate，用同一原始输入；已有字幕两步都传--reviewed-subtitles。保留人工文字/分屏/样式，源锚词变化无稳定映射则拒绝。不重复ASR。
3. workbench subtitle-submit请求{expectedRevision,candidateDirectory}，候选校验和用户授权后--confirmed。Runtime核验receipt、源SHA和活动结果CAS；写后subtitles-get回读。
4. 未知提交先读当前字幕，不自动重提；API通过不等于人已看听或已烧入MP4。

## 画面、画布、媒体

模块按画面Skill module-publish.md。workbench visuals-put以原expectedRevision和完整document保存已授权层，不能把module发布当层绑定。MP4按media-import/sourceSHA→media-get/assetId→visuals-put，未知按同assetId查。config-get后config-set只修改已授权aspectRatio，expectedRevision取projectRevision；不把配置revision与字幕revision混用。

## 导出

workbench export-plan请求{profile:"fast"或"master"}，保存snapshotFingerprint/计划和新绝对outputPath。用户明确批准后export-start请求{operationId,expectedSnapshot:原指纹,profile:同档位,outputPath}加--confirmed；项目锁内冻结，已有输出不覆盖。指纹绑定项目JSON，不保证绑定全部HTML/媒体字节。

受理响应不是成片。workbench job-by-operation传原operationId精确查；其statusScope:"admission"的succeeded只表示受理，必须看嵌套job状态或job-get。拿到jobId后job-get；最近job-list不是未知恢复依据。用户明确取消才job-cancel({jobId})加--confirmed。job.state=succeeded后核对result.actualDuration/hasAudio/renderedFrames/problems，再分别验像素和人耳。

## 多源与恢复

sources-get读目标/源版本；prepend-plan/word-cuts-plan/segment-cuts-plan传commands要求字段和confirmed:false；commit沿用同operationId、原revisions、planRevision，confirmed:true并--confirmed。segment-cuts允许明确removeVisualLayerIds，word-cuts不混入该字段。

operation-get按原operationId查事务；只在用户确认且当前状态允许时operation-recover选择finish/rollback。不是任意撤销/重做，不恢复有后续编辑的旧快照。多源legacyCutsSet=false时不能cuts-put绕过计划。

旧 MCP 仅在用户明确选定旧发行时读取该发行自带的兼容文档；本独立包不携带旧 MCP 适配，不把它当默认路径或失败兜底。
