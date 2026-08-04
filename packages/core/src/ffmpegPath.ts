/**
 * 传给 ffmpeg/ffprobe 的文件参数。
 *
 * 两件事必须同时成立：
 *
 * 1. **带 `file:` 前缀**——否则 Windows 的 `C:\…` 会被 ffmpeg 读成协议名
 *    （`C:` 看着就像 `http:`），macOS 上以 `-` 开头的文件名也会被当成选项。
 * 2. **前缀后面只能是正斜杠**——`file:C:\Users\…\audio.mp3` 在 Windows 上
 *    会让 ffmpeg 报 "Unable to choose an output format"：反斜杠在 URL 语法里
 *    不是路径分隔符，扩展名推断因此落空。2026-08-04 用户真机报障。
 *
 * Windows 的 API 一律接受正斜杠，所以归一化不会带来别的问题。
 */
export function ffmpegFileArg(path: string): string {
  return `file:${path.replaceAll("\\", "/")}`;
}
