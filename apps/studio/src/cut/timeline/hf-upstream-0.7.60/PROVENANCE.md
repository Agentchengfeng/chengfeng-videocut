# HyperFrames Timeline 0.7.60 上游母版

这是 F2 候选中的**只读审计母版**，用于证明“先完整复制，再裁剪”的上游起点。

## 固定来源

- 包：`@hyperframes/studio`
- 版本：`0.7.60`
- Bun 安装实例：`@hyperframes+studio@0.7.60+a7e23ed3f5c7c72f`
- 本地来源：`产品记录/实验/技术路线/04-HyperFrames插件路线/hyperframes-core/node_modules/.bun/@hyperframes+studio@0.7.60+a7e23ed3f5c7c72f/node_modules/@hyperframes/studio`
- 许可证：上游 `LICENSE`，Apache License 2.0
- 复制日期：`2026-07-21`

## 原样复制范围

本目录保留上游相对路径，原样复制了：

- `src/player/components/` 整个目录：108 个文件；
- `src/components/TimelineToolbar.tsx`；
- `src/components/nle/TimelinePane.tsx`；
- `src/components/nle/TimelineResizeDivider.tsx`；
- `src/styles/studio.css`；
- `src/styles/tailwind-preset.shared.js`；
- `LICENSE`。

因此上游原样文件共 114 个。每个文件的 SHA-256 见 `SHA256SUMS`。

## 使用边界

- 产品运行时代码**不得 import 本目录**。
- 本目录只服务于逐文件 diff、来源追踪、视觉对照和后续裁剪审计。
- 可运行的 Product Adapter / Fork 必须放在本目录之外，并明确标注其上游来源与改动。
- 不得在此母版上直接修 Product 行为或样式；需要变化时，应复制到可运行 Fork 后修改。

## 非上游文件

本母版内只有以下两个文件是我们的审计元数据，不属于 HyperFrames 上游：

- `PROVENANCE.md`
- `SHA256SUMS`

F2 候选 `timeline/` 顶层现场另有 10 个 Product 文件，它们也不属于 HyperFrames 上游：

- `CutAudioWaveform.tsx`
- `CutTimeline.test.tsx`
- `CutTimeline.tsx`
- `CutVideoFilmstrip.tsx`
- `editOperations.test.ts`
- `editOperations.ts`
- `timelineMedia.test.tsx`
- `timelineMedia.ts`
- `timelineTicks.test.ts`
- `timelineTicks.ts`

此外，`timeline/hyperframes-fork/` 是 Product 适配中的可运行派生 Fork，并非原样上游母版。现场候选相对官方的额外文件数量与文件名，以逐文件 manifest / diff 清单的实测结果为准，不用预设数字代替证据。

## 完整性复核

母版建立后执行三道复核：

1. 上游范围与母版范围逐文件 `diff -rq`，应无差异；
2. 母版 114 个上游文件重新计算 SHA-256，并与 `SHA256SUMS` 比对；
3. 在候选运行源码中检索 `hf-upstream-0.7.60` import，结果应为 0。
