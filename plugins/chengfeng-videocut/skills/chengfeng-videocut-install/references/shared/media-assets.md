# 本地 MP4：导入与绑定

先读[统一CLI](runtime-cli.md)，workbench connect核验用户指定服务，同一服务器projectId读workflow-get/edit-list-get/subtitles-get/visuals-get。需要mediaAssetsApiVersion=1。无需MCP，缺能力就报告，不改项目JSON、不起第二工作台，不用HTML video伪装接入。

## 1. 导入不等于启用

确认用户授权的具体本地 MP4，计算 SHA256，然后调用：

```json
{"sourcePath":"<绝对 MP4 路径>","expectedSourceSha256":"<64位 SHA256>"}
```

上面是workbench media-import的--file请求JSON；--api-base/--project作为独立参数，已有本次导入授权后加--confirmed。
Product 复制至项目内容寻址目录，校验文件哈希、视频流、尺寸、时长，原文件不变。
当前接受 H264/yuv420p MP4，最大 512MiB、有效视频时长 1 小时、8192×8192、120fps；禁止软链。
workbench media-get请求{assetId} 回读 manifest/contentUrl。
assetId 等于原文件 SHA256；超时/结果未知先查询同一 assetId，不重复生成素材。导入不更改字幕、口播或时间线。

## 2. 绑定已有字幕的真实词

从已读取的字幕 cue.wordIds 取得锚点，保留原有层，合并完整 visuals document，使用原样 revision CAS：

```json
{"id":"opening-01","wordIds":["<真实 word id>"],"media":{"assetId":"<SHA256>","sourceIn":0,"sourceOut":5,"fit":"contain","muted":true,"includeLeadingGap":true}}
```

workbench visuals-put请求{expectedRevision,document}并带--confirmed 回读后再验收。
新文档按当前 transcript revision 建立；冲突重新读和审核，不偷换 revision。
同一层只能有 media 或 module，视频层不能携带 HTML module/zoom。
sourceIn/sourceOut 是**素材内部入出点**，不是剪后时间线秒数。范围必须在已验证的视频时长内。
起点由词锚点计算，终点为词锚点终点与可用素材时长的较早者；不拉伸、循环或冻结以填缝。
只有覆盖第一个保留词的片头可以显式设置 includeLeadingGap=true，包含开头的未说话间隙；其他段默认省略。
contain 保持比例留黑边，cover 保持比例居中裁满。素材自身始终静音，口播音轨仍是唯一主音轨。
当前单画面轨不接受重叠层；不要为了达到覆盖比例改动 EDL 或字幕。计算覆盖必须用回读 timings 的区间并集，而不是 MP4 总长。

## 3. 验收

在同一工作台真实检查：入点、连续运动、暂停冻结、前后 seek、倍速、结束退出、字幕和口播连续。
保留层的 assetId/in/out/fit 回读与实际 timings；实际覆盖短于计划要如实报告。
导出仍交给导出 Skill，Product 按同一 manifest/词锚点做 FFmpeg 合成，不通过浏览器录制视频层。
只有工具回读不算视觉验收，预览正常也不等于完整成片验收通过。
