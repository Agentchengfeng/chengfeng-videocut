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

/**
 * ffmpeg 输出参数对：显式 `-f <format>` + file: 路径。
 *
 * 输出端**永远**用这个，不要单独用 ffmpegFileArg：ffmpeg 从文件名推断输出
 * 格式的行为跨构建不一致（2026-08-04 Windows 用户真机实测：路径合法、扩展名
 * 也对，仍报 "Unable to choose an output format"）。显式 -f 让推断这一步
 * 彻底不存在。输入端不需要 -f（探测的是内容，不是文件名）。
 */
export function ffmpegOutputArgs(format: string, path: string): string[] {
  return ["-f", format, ffmpegFileArg(path)];
}
