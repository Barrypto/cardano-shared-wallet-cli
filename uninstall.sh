#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

desktop_directory() {
  local detected=""
  if [[ "$(uname -s)" == "Linux" ]] && command -v xdg-user-dir >/dev/null 2>&1; then
    detected="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  fi
  if [[ -n "$detected" && "$detected" == /* && "$detected" != "$HOME" ]]; then
    printf '%s\n' "$detected"
  else
    printf '%s\n' "$HOME/Desktop"
  fi
}

fail() {
  printf '卸载失败：%s\n' "$*" >&2
  exit 1
}

DESKTOP_DIR="$(desktop_directory)"
INSTALL_ROOT="${CSW_INSTALL_DIR:-$DESKTOP_DIR/cardano-shared-wallet-cli}"
BIN_DIR="${CSW_BIN_DIR:-$HOME/.local/bin}"
DATA_ROOT="${CSW_HOME:-$HOME/.csw}"

[[ "$INSTALL_ROOT" == /* && "$INSTALL_ROOT" != "/" && "$INSTALL_ROOT" != "$HOME" ]] \
  || fail "安装目录不安全：$INSTALL_ROOT"
[[ ! -L "$INSTALL_ROOT" ]] || fail "拒绝卸载符号链接形式的安装目录：$INSTALL_ROOT"
[[ -d "$INSTALL_ROOT/.app" && -f "$INSTALL_ROOT/多签钱包.sh" ]] \
  || fail "目标不是本工具创建的安装目录：$INSTALL_ROOT"
[[ "${CSW_PURGE_DATA:-0}" == "0" || "${CSW_PURGE_DATA:-0}" == "1" ]] \
  || fail "CSW_PURGE_DATA 只允许 0 或 1"
if [[ "${CSW_PURGE_DATA:-0}" == "1" ]]; then
  [[ "$DATA_ROOT" == /* && "$DATA_ROOT" != "/" && "$DATA_ROOT" != "$HOME" ]] \
    || fail "用户数据目录不安全：$DATA_ROOT"
fi

case "$(uname -s)" in
  Darwin) trash_root="$HOME/.Trash" ;;
  Linux) trash_root="${XDG_DATA_HOME:-$HOME/.local/share}/Trash/files" ;;
  *) fail "目前只支持 macOS 和 Linux" ;;
esac
mkdir -p "$trash_root"
trash_batch="$trash_root/cardano-shared-wallet-cli-uninstall-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
mkdir -m 700 "$trash_batch"

move_launcher_if_owned() {
  local launcher="$1"
  [[ -e "$launcher" || -L "$launcher" ]] || return 0
  if [[ -f "$launcher" ]] && grep -q 'CSW_APP_HOME=' "$launcher" \
    && grep -q '/.app/current/' "$launcher"; then
    mv "$launcher" "$trash_batch/$(basename "$launcher")"
  else
    printf '保留无法确认归属的启动器：%s\n' "$launcher" >&2
  fi
}

move_launcher_if_owned "$BIN_DIR/csw-wallet"
move_launcher_if_owned "$BIN_DIR/csw"
mv "$INSTALL_ROOT" "$trash_batch/application"

data_status="已保留"
if [[ "${CSW_PURGE_DATA:-0}" == "1" ]]; then
  if [[ -d "$DATA_ROOT" ]]; then
    mv "$DATA_ROOT" "$trash_batch/user-data"
    data_status="已移到废纸篓"
  else
    data_status="不存在"
  fi
fi

printf '\n卸载完成。\n'
printf '程序、运行时和本工具启动器已移到：%s\n' "$trash_batch"
printf '用户数据 %s：%s\n' "$data_status" "$DATA_ROOT"
if [[ "${CSW_PURGE_DATA:-0}" != "1" ]]; then
  printf '如需同时移除钱包公开描述和 Blockfrost 配置，请使用 CSW_PURGE_DATA=1。\n'
fi
