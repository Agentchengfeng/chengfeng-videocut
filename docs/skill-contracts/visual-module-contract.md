# 模块契约

每一条都是踩过的坑，不是风格偏好。

## 文档头三行命门

```text
:root { color-scheme: dark }   工作台是深色模式。不声明，Chromium 会因深浅不匹配
                               给整个 iframe 垫一层不透明白底 —— 透明标注直接变白板。
                               这行是模块能透明的前提（2026-07-28 白了一整天才破案）
背景                           标注模块 background: transparent；
                               动画模块白底放在 #stage 上（不放 body），整屏动画硬切进出
source 标注 viewBox             坐标 = 实际原片像素，不能固定为某个示例尺寸。
                               推近以 seek.zoom 到达，模块把 viewBox 对准那块区域。
project 动画 viewBox            按项目画布横/竖/方布局，背景满画布、角色文字等比；
                               不套原片标注的 zoom，不用编辑器视口缩放代替画布适配。
```

## 被驱动，不自播

```text
播放器按 requestAnimationFrame 每帧发 videocut:seek 消息（time/duration/cues/zoom），
模块 tl.seek 到那一帧。拖进度条、暂停、变速、导出逐帧，全都因此成立。

const tl = gsap.timeline({ paused: true });
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "videocut:seek") return;
  if (data.zoom) { /* viewBox 对准 zoom 区域 */ }
  // 仅旧模块示意；新绑定每次检查当前 wordCues，不能永久缓存首次构建的词时刻。
  if (!built) build(data.cues, data.duration);
  tl.seek(Number(data.time) || 0, false);
});
```

## GSAP 四禁

```text
禁 drawSVG        收费插件，免费版静默失效，画面什么都不发生。
                  画线用 strokeDasharray/strokeDashoffset
禁 .from()        seek 回 0 会留脏状态。一律 .to()/.fromTo()，初值写在 SVG 属性里
必须 lazy:false   paused 时间线首次跨过 tween 起点时 lazy 渲染被搁置，停在错误值
禁墙钟           Date.now / 自转 rAF 都不许，时间只来自 seek 消息
```

## duration 可能比词的跨度长

仅旧层：层间 ≤0.75 秒的空隙归前一层（防相邻边界闪原片）。新 `animation` 绑定不吸收接缝，不提前 local 0。
模块收到的 duration 是**延长后的**——按 duration 比例摆的兜底时刻会跟着挪，
写死的相对时刻要在层边界变化时复查。

## 可选 local0 创作绑定

旧层不自动迁移。新 HTML 层可以在 visuals 文档声明：

```json
{"id":"scene-1","module":"modules/published/scene-1/v1/index.html","wordIds":["w1","w2"],"animation":{"schemaVersion":1,"clock":"local0","authoredDuration":2.5,"anchorWordIds":["w2"],"canvas":"project"}}
```

`authoredDuration` 是创作时已核验的剪后句子跨度，单位秒，范围 `(0,3600]`，不是成片起点。`anchorWordIds` 必须非空、唯一、属于本层；不使用同名文本重绑。`canvas` 默认 `project`（填满项目视频画布），`source` 用于原片坐标标注；project 模式不能同时声明 zoom，media 层不能声明 animation。横竖方构图由创作方适配，不非等比拉伸。

Runtime 共享 resolver 在 timing.animation 和 seek.animation 中返回 `clock/authoredDuration/canvas/issues/wordCues`。seek 顶层也提供 `wordCues`，每项 `{id,text,start,end}` 为剪后本层 local0 秒；原有 `cues` 继续是字幕屏幕，供旧模块使用。宿主时间减去当前 placement 起点得到 `time`，不能再乘时长比例。句子整体移动不修改源码或内部时间。

`issues` 的 `duration_changed`（差异超过 1ms）、`missing_anchor`、`discontinuous` 表示先复核再生成新版本；预览提示且不显示失效动画，导出拒绝。`orphaned` 表示整层词被删除，停止显示/导出并保留源码。任意 seek 不是自动重排授权，不全局变速、不猜 fallback。用新参数生成候选时保留用户原参数和编辑，核验后才 CAS 切换模块引用。

### 新绑定必须明确确认定位

带 `animation` 的层收到 `videocut:seek` 后，必须在实际完成该帧更新时回复父窗口 `videocut:seek-applied`，携带原 `token`（可附 `time`）；失败回复 `videocut:seek-error`，携带原 `token` 和非敏感 `message`。先校验消息来自 parent；异步资源未就绪不能抢先确认。

预览与导出只接受对应 iframe 和当前 token 的消息；错误或 5 秒无确认即失败。预览显示可定位提示且停止该层，导出拒绝成功。预览每层最多一条未确认请求，不靠逐帧重发重置超时。修改候选/引用后重新验证。旧无 animation 层继续原来的导出自动确认，不据此声称任意旧模块已有主动握手。

```js
try {
  // applyFrame(data.time, data.wordCues) must finish before acknowledgement.
  parent.postMessage({ type: "videocut:seek-applied", token: data.token, time: data.time }, "*");
} catch (error) {
  parent.postMessage({ type: "videocut:seek-error", token: data.token, message: "动画定位失败，请检查词锚点" }, "*");
}
```

## 动作钉在词上

下例仅描述旧模块。新绑定使用 `wordCues.find(cue => cue.id === anchorWordId)`，缺失必须报错而不是按文本或 fallback 猜测。

```text
function stepAt(cues, keyword, fallback) {
  const hit = cues.find((cue) => cue.text.includes(keyword));
  return hit ? hit.start : fallback;
}
说到「调用」箭头才画，说到「一周」才圈 —— 禁止平均分时间。
但退场时刻是画面事实（滚动/操作开始前），用量出来的数字，写明出处。
```

## 小黑风格的 Avoid 清单对所有作者生效

装饰性箭头、幽灵轨迹、进度拖尾、一次全亮的批注——都不许。
动作本身就是叙事（盒子滑过去 = 交接），不需要一条线再说一遍。

**整屏动画进出场是硬切，不做淡入淡出。** 这条被反过来定过一次：
先以为白屏硬切晃眼加了渐变，用户看片后推翻——白屏淡出叠在静止画面上
看起来像播放器卡住；硬切是剪辑语言，观众认。（用户 2026-07-29 定）
