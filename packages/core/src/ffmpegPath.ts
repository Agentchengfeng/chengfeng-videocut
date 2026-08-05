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

/**
 * Runs one FFmpeg command whose complex filter graph lives in a file.
 *
 * FFmpeg 7 introduced the generic `-/option file` form and FFmpeg 8 removed
 * the older `-filter_complex_script` alias. FFmpeg 6 still needs that alias.
 * Prefer the current form, but retry only when FFmpeg says that exact option
 * is unknown; encoding and media errors must never be hidden by a retry.
 */
export async function runWithFfmpegComplexFilterFile<T>(
  filterPath: string,
  run: (filterArgs: readonly [string, string]) => Promise<T>,
): Promise<T> {
  try {
    return await run(["-/filter_complex", filterPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const modernOptionUnsupported =
      /Unrecognized option ['"]?\/filter_complex['"]?/i.test(message) ||
      (/\/filter_complex/i.test(message) && /Option not found/i.test(message));
    if (!modernOptionUnsupported) throw error;
    return await run(["-filter_complex_script", filterPath]);
  }
}
