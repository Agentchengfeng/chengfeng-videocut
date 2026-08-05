#!/bin/sh
set -eu

REPOSITORY="Agentchengfeng/chengfeng-videocut"
VERSION="0.4.7"
ARCHIVE_NAME="chengfeng-videocut-portable.tar.gz"
CHECKSUM_NAME="SHA256SUMS.txt"
DOWNLOAD_BASE="${CHENGFENG_VIDEOCUT_DOWNLOAD_BASE:-https://github.com/$REPOSITORY/releases/download/v$VERSION}"
INSTALL_ROOT="${CHENGFENG_VIDEOCUT_HOME:-${HOME:-}/.chengfeng-videocut}"
APP_ROOT="$INSTALL_ROOT/app"
BIN_ROOT="$INSTALL_ROOT/bin"
TARGET_DIR="$APP_ROOT/$VERSION"
CURRENT_LINK="$APP_ROOT/current"
BIN_LINK="$BIN_ROOT/chengfeng-videocut"

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  if [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi

  for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

verify_checksum() {
  archive_path=$1
  expected=$2

  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$archive_path" | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$archive_path" | awk '{print $1}')
  else
    fail "找不到 shasum 或 sha256sum，无法验证下载文件。"
  fi

  [ "$actual" = "$expected" ] || fail "SHA-256 校验失败；文件可能不完整，安装已停止。"
}

command -v curl >/dev/null 2>&1 || fail "需要 curl 才能从 GitHub 下载安装包。"
[ -n "${HOME:-}" ] || fail "HOME 未设置，无法确定安装目录。"

if ! BUN_EXECUTABLE=$(find_bun); then
  fail "需要先安装 Bun 1.2 或更高版本：https://bun.sh/docs/installation"
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/chengfeng-videocut.XXXXXX")
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

ARCHIVE_PATH="$TMP_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$TMP_DIR/$CHECKSUM_NAME"

printf '%s\n' "正在从 GitHub 下载 chengfeng-videocut ${VERSION}…"
curl -fL --retry 3 --connect-timeout 15 "$DOWNLOAD_BASE/$ARCHIVE_NAME" -o "$ARCHIVE_PATH"
curl -fL --retry 3 --connect-timeout 15 "$DOWNLOAD_BASE/$CHECKSUM_NAME" -o "$CHECKSUM_PATH"

EXPECTED_HASH=$(awk -v file="$ARCHIVE_NAME" '$2 == file { print $1; exit }' "$CHECKSUM_PATH")
[ -n "$EXPECTED_HASH" ] || fail "$CHECKSUM_NAME 中没有 $ARCHIVE_NAME 的校验值。"
verify_checksum "$ARCHIVE_PATH" "$EXPECTED_HASH"

if tar -tzf "$ARCHIVE_PATH" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null 2>&1; then
  fail "安装包包含不安全的路径，安装已停止。"
fi

tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"
PACKAGE_DIR="$TMP_DIR/chengfeng-videocut-$VERSION"
[ -f "$PACKAGE_DIR/cli.js" ] || fail "安装包缺少 cli.js。"
[ -f "$PACKAGE_DIR/studio/index.html" ] || fail "安装包缺少 Studio。"
[ -f "$PACKAGE_DIR/legal/LICENSE" ] || fail "安装包缺少许可证。"
[ -x "$PACKAGE_DIR/chengfeng-videocut" ] || fail "安装包缺少可执行启动器。"
[ -f "$PACKAGE_DIR/VERSION" ] || fail "安装包缺少版本信息。"
[ "$(sed -n '1p' "$PACKAGE_DIR/VERSION")" = "$VERSION" ] || fail "安装包版本与安装器不一致。"

mkdir -p "$APP_ROOT" "$BIN_ROOT"

if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  fail "$CURRENT_LINK 已存在且不是符号链接；为避免覆盖用户文件，安装已停止。"
fi
if [ -e "$BIN_LINK" ] && [ ! -L "$BIN_LINK" ]; then
  fail "$BIN_LINK 已存在且不是符号链接；为避免覆盖用户文件，安装已停止。"
fi

NEW_DIR="$APP_ROOT/.$VERSION.new.$$"
BACKUP_DIR="$APP_ROOT/.$VERSION.backup.$$"
rm -rf "$NEW_DIR" "$BACKUP_DIR"
cp -R "$PACKAGE_DIR" "$NEW_DIR"

if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi

if mv "$NEW_DIR" "$TARGET_DIR"; then
  rm -rf "$BACKUP_DIR"
else
  if [ -e "$BACKUP_DIR" ]; then
    mv "$BACKUP_DIR" "$TARGET_DIR"
  fi
  fail "无法写入安装目录。"
fi

ln -sfn "$VERSION" "$CURRENT_LINK"
ln -sfn "../app/current/chengfeng-videocut" "$BIN_LINK"

printf '\n%s\n' "chengfeng-videocut $VERSION 已安装完成。"
printf '%s\n' "启动并打开：$BIN_LINK service ensure --open"
printf '%s\n' "查看状态：$BIN_LINK service status"
printf '%s\n' "查看日志：$BIN_LINK service logs"
printf '%s\n' "检查：$BIN_LINK doctor"
printf '%s\n' "前台诊断（不常驻）：$BIN_LINK start"
printf '%s\n' "安装器不会自动注册后台服务；首次 service ensure 时才会安装并启动。"
printf '%s\n' "如果希望直接输入 chengfeng-videocut，请把下面这一行加入 shell 配置："
printf '%s\n' 'export PATH="$HOME/.chengfeng-videocut/bin:$PATH"'

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  printf '%s\n' "提示：剪辑与导出还需要 FFmpeg（ffmpeg 和 ffprobe）。" >&2
fi

"$BUN_EXECUTABLE" "$TARGET_DIR/cli.js" --version
