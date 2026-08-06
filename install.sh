#!/bin/sh
set -eu

# curl | sh 入口只做两件事：固定版本地取回 install.cjs，并用同一 Release 的
# SHA256SUMS 校验它。真正的安装事务在 install.cjs 中实现，避免 macOS 与 Windows
# 各自演化出“先切 current、后验证”的两套语义。

REPOSITORY="Agentchengfeng/chengfeng-videocut"
VERSION="0.5.0"
CHECKSUM_NAME="SHA256SUMS.txt"
INSTALLER_NAME="install.cjs"
DOWNLOAD_BASE="${CHENGFENG_VIDEOCUT_DOWNLOAD_BASE:-https://github.com/$REPOSITORY/releases/download/v$VERSION}"

fail() {
  printf '%s\n' "错误：$1" >&2
  exit 1
}

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
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

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "找不到 shasum 或 sha256sum，无法验证安装器。"
  fi
}

command -v curl >/dev/null 2>&1 || fail "需要 curl 才能下载安装器。"
[ -n "${HOME:-}" ] || fail "HOME 未设置，无法确定安装目录。"
if ! BUN_EXECUTABLE=$(find_bun); then
  fail "需要先安装 Bun 1.2 或更高版本：https://bun.sh/docs/installation"
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/chengfeng-videocut.XXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

curl -fL --retry 3 --connect-timeout 15 "$DOWNLOAD_BASE/$CHECKSUM_NAME" -o "$TMP_DIR/$CHECKSUM_NAME"
curl -fL --retry 3 --connect-timeout 15 "$DOWNLOAD_BASE/$INSTALLER_NAME" -o "$TMP_DIR/$INSTALLER_NAME"
EXPECTED_HASH=$(awk -v file="$INSTALLER_NAME" '$2 == file { print $1; exit }' "$TMP_DIR/$CHECKSUM_NAME")
[ -n "$EXPECTED_HASH" ] || fail "$CHECKSUM_NAME 中没有 $INSTALLER_NAME 的校验值。"
[ "$(sha256_of "$TMP_DIR/$INSTALLER_NAME")" = "$EXPECTED_HASH" ] || fail "install.cjs SHA-256 校验失败；安装已停止。"

"$BUN_EXECUTABLE" "$TMP_DIR/$INSTALLER_NAME"
