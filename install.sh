#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="BlizzardSaber/cardano-shared-wallet-cli"
SOURCE_URL="https://github.com/${REPOSITORY}/archive/refs/heads/main.tar.gz"
NODE_DIST_URL="https://nodejs.org/dist/latest-v22.x"
CARDANO_CLI_VERSION="11.6.0.0"
CARDANO_CLI_RELEASE_URL="https://github.com/IntersectMBO/cardano-cli/releases/download/cardano-cli-${CARDANO_CLI_VERSION}"

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

DESKTOP_DIR="$(desktop_directory)"
INSTALL_ROOT="${CSW_INSTALL_DIR:-$DESKTOP_DIR/cardano-shared-wallet-cli}"
APP_ROOT="$INSTALL_ROOT/.app"
BIN_DIR="${CSW_BIN_DIR:-$HOME/.local/bin}"

say() {
  printf '\n%s\n' "$*"
}

fail() {
  printf '安装失败：%s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "安装 zsh 需要管理员权限，但系统没有 sudo"
  fi
}

ensure_zsh() {
  command -v zsh >/dev/null 2>&1 && return 0

  say "系统没有 zsh，正在安装必要依赖……"
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y zsh
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y zsh
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y zsh
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --needed --noconfirm zsh
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add zsh
  elif command -v brew >/dev/null 2>&1; then
    brew install zsh
  else
    fail "无法自动安装 zsh，请先安装 zsh 后重新运行"
  fi

  require_command zsh
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    fail "找不到 SHA-256 校验工具（sha256sum、shasum 或 openssl）"
  fi
}

require_command curl
require_command tar
require_command awk
ensure_zsh

if [[ -e "$INSTALL_ROOT" \
  && ! -d "$INSTALL_ROOT/.app" \
  && ! -d "$INSTALL_ROOT/releases" \
  && ! -L "$INSTALL_ROOT/current" ]]; then
  existing_entry="$(find "$INSTALL_ROOT" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  [[ -z "$existing_entry" ]] || fail "目标目录已存在且不是本工具的安装目录：$INSTALL_ROOT"
fi

# Migrate the original visible current/releases/runtime layout into a hidden
# application directory. The public desktop folder then has one obvious entry.
if [[ ! -d "$APP_ROOT" && ( -d "$INSTALL_ROOT/releases" || -d "$INSTALL_ROOT/runtime" || -L "$INSTALL_ROOT/current" ) ]]; then
  say "正在整理旧版目录结构……"
  mkdir -p "$APP_ROOT"
  [[ ! -d "$INSTALL_ROOT/releases" ]] || mv "$INSTALL_ROOT/releases" "$APP_ROOT/releases"
  [[ ! -d "$INSTALL_ROOT/runtime" ]] || mv "$INSTALL_ROOT/runtime" "$APP_ROOT/runtime"
  if [[ -L "$INSTALL_ROOT/current" ]]; then
    legacy_release_name="$(basename "$(readlink "$INSTALL_ROOT/current")")"
    if [[ -d "$APP_ROOT/releases/$legacy_release_name" ]]; then
      ln -sfn "$APP_ROOT/releases/$legacy_release_name" "$APP_ROOT/current"
    fi
    unlink "$INSTALL_ROOT/current"
  fi
fi

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "目前只支持 macOS 和 Linux" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) architecture="x64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

if [[ "$platform" == "darwin" && "$architecture" == "arm64" ]]; then
  cardano_cli_target="aarch64-darwin"
elif [[ "$platform" == "linux" && "$architecture" == "arm64" ]]; then
  cardano_cli_target="aarch64-linux"
elif [[ "$platform" == "linux" && "$architecture" == "x64" ]]; then
  cardano_cli_target="x86_64-linux"
elif [[ "$platform" == "darwin" && "$architecture" == "x64" ]]; then
  fail "官方 cardano-cli ${CARDANO_CLI_VERSION} 不提供 Intel Mac 发行包；请使用 Apple Silicon Mac 或 Linux"
else
  fail "官方 cardano-cli 不支持当前平台：${platform}-${architecture}"
fi

temporary_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

say "正在下载并校验 Node.js 22 LTS……"
checksums="$temporary_dir/SHASUMS256.txt"
curl --proto '=https' --tlsv1.2 -fsSL "$NODE_DIST_URL/SHASUMS256.txt" -o "$checksums"
node_archive="$(awk -v target="-${platform}-${architecture}.tar.gz" '$2 ~ target "$" { print $2; exit }' "$checksums")"
[[ -n "$node_archive" ]] || fail "Node.js 没有适用于 ${platform}-${architecture} 的发行包"
expected_sha="$(awk -v file="$node_archive" '$2 == file { print $1; exit }' "$checksums")"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail "无法读取 Node.js 官方校验值"

curl --proto '=https' --tlsv1.2 -fsSL "$NODE_DIST_URL/$node_archive" -o "$temporary_dir/$node_archive"
actual_sha="$(sha256_file "$temporary_dir/$node_archive")"
[[ "$actual_sha" == "$expected_sha" ]] || fail "Node.js 下载文件 SHA-256 校验失败"

runtime_root="$APP_ROOT/runtime"
node_release_name="${node_archive%.tar.gz}"
node_release_dir="$runtime_root/$node_release_name"
mkdir -p "$runtime_root"
if [[ ! -x "$node_release_dir/bin/node" ]]; then
  mkdir -p "$temporary_dir/node"
  tar -xzf "$temporary_dir/$node_archive" -C "$temporary_dir/node"
  extracted_node="$temporary_dir/node/$node_release_name"
  [[ -x "$extracted_node/bin/node" ]] || fail "Node.js 发行包内容不完整"
  mv "$extracted_node" "$node_release_dir"
fi

say "正在下载并校验官方 cardano-cli ${CARDANO_CLI_VERSION}……"
cardano_cli_archive="cardano-cli-${CARDANO_CLI_VERSION}-${cardano_cli_target}.tar.gz"
cardano_cli_checksums="cardano-cli-${CARDANO_CLI_VERSION}-sha256sums.txt"
curl --proto '=https' --tlsv1.2 -fsSL \
  "$CARDANO_CLI_RELEASE_URL/$cardano_cli_checksums" -o "$temporary_dir/$cardano_cli_checksums"
cardano_cli_expected_sha="$(awk -v file="$cardano_cli_archive" '$2 == file || $2 == "*" file { print $1; exit }' "$temporary_dir/$cardano_cli_checksums")"
[[ "$cardano_cli_expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail "无法读取官方 cardano-cli SHA-256 校验值"
curl --proto '=https' --tlsv1.2 -fsSL \
  "$CARDANO_CLI_RELEASE_URL/$cardano_cli_archive" -o "$temporary_dir/$cardano_cli_archive"
cardano_cli_actual_sha="$(sha256_file "$temporary_dir/$cardano_cli_archive")"
[[ "$cardano_cli_actual_sha" == "$cardano_cli_expected_sha" ]] || fail "cardano-cli 下载文件 SHA-256 校验失败"

cardano_cli_dir="$runtime_root/cardano-cli-${CARDANO_CLI_VERSION}-${cardano_cli_target}"
if [[ ! -x "$cardano_cli_dir/cardano-cli" ]]; then
  mkdir -p "$cardano_cli_dir" "$temporary_dir/cardano-cli"
  tar -xzf "$temporary_dir/$cardano_cli_archive" -C "$temporary_dir/cardano-cli"
  extracted_cardano_cli="$temporary_dir/cardano-cli/cardano-cli-${cardano_cli_target}"
  [[ -f "$extracted_cardano_cli" ]] || fail "cardano-cli 发行包内容不完整"
  chmod +x "$extracted_cardano_cli"
  mv "$extracted_cardano_cli" "$cardano_cli_dir/cardano-cli"
fi
cardano_cli_found_version="$($cardano_cli_dir/cardano-cli --version | awk 'NR == 1 { print $2 }')"
[[ "$cardano_cli_found_version" == "$CARDANO_CLI_VERSION" ]] || fail "cardano-cli 版本校验失败"

say "正在拉取项目代码……"
source_archive="$temporary_dir/source.tar.gz"
source_extract="$temporary_dir/source"
mkdir -p "$source_extract"
curl --proto '=https' --tlsv1.2 -fsSL "$SOURCE_URL" -o "$source_archive"
tar -xzf "$source_archive" -C "$source_extract"
source_dir="$(find "$source_extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$source_dir" && -f "$source_dir/package-lock.json" ]] || fail "项目源代码包内容不完整"

release_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
release_dir="$APP_ROOT/releases/$release_id"
mkdir -p "$release_dir" "$INSTALL_ROOT/out" "$BIN_DIR"
cp -R "$source_dir"/. "$release_dir"/
chmod +x "$release_dir/install.sh" "$release_dir/多签钱包.sh" "$release_dir/src/cli.js"
chmod +x "$release_dir/uninstall.sh"
ln -s "$INSTALL_ROOT/out" "$release_dir/out"

say "正在安装锁定版本的 npm 依赖……"
PATH="$node_release_dir/bin:$PATH" npm --prefix "$release_dir" ci --omit=dev --ignore-scripts

ln -sfn "$release_dir" "$APP_ROOT/current"

quoted_root="$(printf '%q' "$INSTALL_ROOT")"
quoted_node_bin="$(printf '%q' "$node_release_dir/bin")"
quoted_cardano_cli_bin="$(printf '%q' "$cardano_cli_dir")"

cat > "$INSTALL_ROOT/多签钱包.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
CSW_PUBLIC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec zsh "$CSW_PUBLIC_ROOT/.app/current/多签钱包.sh" "$@"
EOF

cat > "$INSTALL_ROOT/卸载.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
CSW_PUBLIC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$CSW_PUBLIC_ROOT/.app/current/uninstall.sh" "$@"
EOF

cat > "$BIN_DIR/csw-wallet" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CSW_APP_HOME=$quoted_root
export PATH=$quoted_cardano_cli_bin:$quoted_node_bin:\$PATH
exec zsh "\$CSW_APP_HOME/.app/current/多签钱包.sh" "\$@"
EOF

cat > "$BIN_DIR/csw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
CSW_APP_HOME=$quoted_root
export PATH=$quoted_cardano_cli_bin:$quoted_node_bin:\$PATH
exec node "\$CSW_APP_HOME/.app/current/src/cli.js" "\$@"
EOF

chmod +x "$INSTALL_ROOT/多签钱包.sh" "$INSTALL_ROOT/卸载.sh" "$BIN_DIR/csw-wallet" "$BIN_DIR/csw"

say "安装完成"
printf '桌面入口：%s/多签钱包.sh\n' "$INSTALL_ROOT"
printf '卸载入口：%s/卸载.sh\n' "$INSTALL_ROOT"
printf '命令行快捷入口：%s/csw-wallet\n' "$BIN_DIR"
printf '底层命令：%s/csw\n' "$BIN_DIR"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  printf '\n以后只需运行：\n%s/多签钱包.sh\n' "$INSTALL_ROOT"
fi

if [[ "${CSW_NO_LAUNCH:-0}" != "1" ]]; then
  if [[ -r /dev/tty ]]; then
    say "正在启动 Cardano 多签钱包……"
    PATH="$cardano_cli_dir:$node_release_dir/bin:$PATH" exec "$INSTALL_ROOT/多签钱包.sh" </dev/tty
  else
    printf '\n当前环境没有交互终端，请稍后运行：%s/多签钱包.sh\n' "$INSTALL_ROOT"
  fi
fi
