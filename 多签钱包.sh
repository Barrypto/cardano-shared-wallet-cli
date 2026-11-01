#!/bin/zsh
set -euo pipefail
umask 077

SCRIPT_DIR="${0:A:h}"

# Running this file directly must behave exactly like the installed
# csw-wallet launcher. Depending on whether zsh resolves the `current`
# symlink, SCRIPT_DIR is either <root>/current or <root>/releases/<id>.
INSTALL_ROOT=""
if [[ -d "$SCRIPT_DIR/../runtime" ]]; then
  INSTALL_ROOT="${SCRIPT_DIR:h}"
elif [[ -d "$SCRIPT_DIR/../../runtime" ]]; then
  INSTALL_ROOT="${SCRIPT_DIR:h:h}"
fi

NODE_BINARY="node"
if [[ -n "$INSTALL_ROOT" ]]; then
  local_runtime="$INSTALL_ROOT/runtime"
  cardano_cli_candidates=("$local_runtime"/cardano-cli-11.6.0.0-*/cardano-cli(N))
  node_candidates=("$local_runtime"/node-v22.*-*/bin/node(N))
  if (( ${#cardano_cli_candidates[@]} > 0 )); then
    export PATH="${cardano_cli_candidates[1]:h}:$PATH"
  fi
  if (( ${#node_candidates[@]} > 0 )); then
    NODE_BINARY="${node_candidates[1]}"
  fi
fi

CLI=("$NODE_BINARY" "$SCRIPT_DIR/src/cli.js")
ACTIVE_WALLET=""
ACTIVE_WALLET_LABEL=""
CSW_DATA_HOME="${CSW_HOME:-$HOME/.csw}"
CSW_DATA_HOME="${CSW_DATA_HOME:A}"
BLOCKFROST_CONFIG_FILE="$CSW_DATA_HOME/blockfrost.env"
BLOCKFROST_SAVED_MAINNET=""
BLOCKFROST_SAVED_PREPROD=""

valid_blockfrost_id() {
  local network="$1"
  local project_id="$2"
  [[ "$project_id" == "${network}"* ]] \
    && (( ${#project_id} >= 20 && ${#project_id} <= 128 )) \
    && [[ "$project_id" != *[^A-Za-z0-9]* ]]
}

load_blockfrost_config() {
  [[ -f "$BLOCKFROST_CONFIG_FILE" ]] || return 0
  [[ ! -L "$BLOCKFROST_CONFIG_FILE" ]] || {
    print -u2 "拒绝读取符号链接配置：$BLOCKFROST_CONFIG_FILE"
    return 1
  }
  [[ -O "$BLOCKFROST_CONFIG_FILE" ]] || {
    print -u2 "Blockfrost 配置文件不属于当前用户：$BLOCKFROST_CONFIG_FILE"
    return 1
  }
  chmod 600 "$BLOCKFROST_CONFIG_FILE"

  local key value
  while IFS='=' read -r key value; do
    [[ -z "$key" ]] && continue
    case "$key" in
      BLOCKFROST_MAINNET_PROJECT_ID)
        valid_blockfrost_id mainnet "$value" || {
          print -u2 "Blockfrost 主网 Project ID 格式无效"; return 1;
        }
        BLOCKFROST_SAVED_MAINNET="$value"
        export BLOCKFROST_MAINNET_PROJECT_ID="$value"
        ;;
      BLOCKFROST_PREPROD_PROJECT_ID)
        valid_blockfrost_id preprod "$value" || {
          print -u2 "Blockfrost Preprod Project ID 格式无效"; return 1;
        }
        BLOCKFROST_SAVED_PREPROD="$value"
        export BLOCKFROST_PREPROD_PROJECT_ID="$value"
        ;;
      *)
        print -u2 "Blockfrost 配置包含不允许的字段：$key"
        return 1
        ;;
    esac
  done < "$BLOCKFROST_CONFIG_FILE"
}

save_blockfrost_config() {
  mkdir -p "$CSW_DATA_HOME"
  chmod 700 "$CSW_DATA_HOME"
  local temporary="$BLOCKFROST_CONFIG_FILE.tmp.$$"
  : >| "$temporary"
  [[ -n "$BLOCKFROST_SAVED_MAINNET" ]] \
    && print -r -- "BLOCKFROST_MAINNET_PROJECT_ID=$BLOCKFROST_SAVED_MAINNET" >> "$temporary"
  [[ -n "$BLOCKFROST_SAVED_PREPROD" ]] \
    && print -r -- "BLOCKFROST_PREPROD_PROJECT_ID=$BLOCKFROST_SAVED_PREPROD" >> "$temporary"
  chmod 600 "$temporary"
  command mv -f -- "$temporary" "$BLOCKFROST_CONFIG_FILE"
}

show_blockfrost_config() {
  print ""
  print "Blockfrost 双源验证配置"
  [[ -n "${BLOCKFROST_MAINNET_PROJECT_ID:-}" ]] \
    && print "Mainnet：已配置（内容隐藏）" || print "Mainnet：未配置"
  [[ -n "${BLOCKFROST_PREPROD_PROJECT_ID:-}" ]] \
    && print "Preprod：已配置（内容隐藏）" || print "Preprod：未配置"
  print "配置文件：$BLOCKFROST_CONFIG_FILE（权限 600）"
  if [[ -n "$ACTIVE_WALLET" ]]; then
    print ""
    "${CLI[@]}" security status "$ACTIVE_WALLET" --format line
  fi
}

configure_blockfrost_id() {
  local network="$1"
  local variable project_id
  case "$network" in
    mainnet) variable="BLOCKFROST_MAINNET_PROJECT_ID" ;;
    preprod) variable="BLOCKFROST_PREPROD_PROJECT_ID" ;;
    *) print -u2 "不支持的 Blockfrost 网络：$network"; return 1 ;;
  esac

  print ""
  print "请输入 $network 的 Blockfrost Project ID。"
  print "输入内容不会回显，也不会写入项目或钱包 JSON。"
  read -s "project_id?$variable："
  print ""
  valid_blockfrost_id "$network" "$project_id" || {
    print -u2 "Project ID 格式无效，必须以 $network 开头且只包含字母和数字。"
    return 1
  }

  if [[ "$network" == "mainnet" ]]; then
    BLOCKFROST_SAVED_MAINNET="$project_id"
    export BLOCKFROST_MAINNET_PROJECT_ID="$project_id"
  else
    BLOCKFROST_SAVED_PREPROD="$project_id"
    export BLOCKFROST_PREPROD_PROJECT_ID="$project_id"
  fi
  save_blockfrost_config
  print "$network Project ID 已保存，双源验证将自动启用。"
  show_blockfrost_config
}

clear_blockfrost_id() {
  local network="$1"
  if [[ "$network" == "mainnet" ]]; then
    BLOCKFROST_SAVED_MAINNET=""
    unset BLOCKFROST_MAINNET_PROJECT_ID
  else
    BLOCKFROST_SAVED_PREPROD=""
    unset BLOCKFROST_PREPROD_PROJECT_ID
  fi
  save_blockfrost_config
  print "$network Project ID 已从本工具配置中清除。"
}

blockfrost_menu() {
  local choice
  while true; do
    show_blockfrost_config
    print "1) 配置 Mainnet Project ID"
    print "2) 配置 Preprod Project ID"
    print "3) 清除 Mainnet Project ID"
    print "4) 清除 Preprod Project ID"
    print "0) 返回"
    read "choice?请选择："
    case "$choice" in
      1) configure_blockfrost_id mainnet || true ;;
      2) configure_blockfrost_id preprod || true ;;
      3) clear_blockfrost_id mainnet ;;
      4) clear_blockfrost_id preprod ;;
      0) return 0 ;;
      *) print -u2 "无效选项" ;;
    esac
  done
}

load_blockfrost_config

choose_wallet() {
  local raw choice
  raw="$("${CLI[@]}" wallet list --format menu)"
  local -a rows
  if [[ -n "$raw" ]]; then
    rows=("${(@f)raw}")
  else
    rows=()
  fi
  if (( ${#rows[@]} == 0 )); then
    print -u2 "当前没有已导入钱包，请进入“钱包管理”选择导入或创建。"
    return 1
  fi

  print ""
  print "请选择钱包："
  local index id name network count row
  for (( index = 1; index <= ${#rows[@]}; index++ )); do
    row="${rows[$index]}"
    IFS=$'\t' read -r id name network count <<< "$row"
    print "$index) $name  [$network，$count 个收款地址]"
  done
  read "choice?只需输入序号："
  [[ "$choice" == <-> ]] && (( choice >= 1 && choice <= ${#rows[@]} )) || {
    print -u2 "无效的钱包序号"; return 1;
  }
  row="${rows[$choice]}"
  IFS=$'\t' read -r id name network count <<< "$row"
  ACTIVE_WALLET="$id"
  ACTIVE_WALLET_LABEL="$name [$network]"
  print "已选择：$ACTIVE_WALLET_LABEL"
}

ensure_active_wallet() {
  [[ -n "$ACTIVE_WALLET" ]] || choose_wallet
}

show_transaction_security() {
  "${CLI[@]}" security status "$ACTIVE_WALLET" --format line
}

usage() {
  cat <<'EOF'
Cardano 多签钱包常用命令

用法：
  ./多签钱包.sh balance
  ./多签钱包.sh utxos
  ./多签钱包.sh send
  ./多签钱包.sh build-ada <收款地址> <ADA数量> [输出前缀]
  ./多签钱包.sh build-all <收款地址> [输出前缀]
  ./多签钱包.sh stake [pool1...] [输出前缀]
  ./多签钱包.sh verify <已签名交易文件> <对应的本机未签名交易文件>
  ./多签钱包.sh wallets
  ./多签钱包.sh import-wallet <钱包JSON>
  ./多签钱包.sh delete-wallet <钱包ID>
  ./多签钱包.sh addresses <钱包ID或JSON> <地址数量>
  ./多签钱包.sh receive <钱包ID或JSON> [扫描数量]
  ./多签钱包.sh create-wallet
  ./多签钱包.sh security
  ./多签钱包.sh blockfrost
  ./多签钱包.sh help

不带参数运行会显示中文交互菜单。

示例：
  ./多签钱包.sh balance
  ./多签钱包.sh build-ada addr1... 1.5 ./out/payment-001
  ./多签钱包.sh build-all addr1... ./out/send-all
  ./多签钱包.sh stake pool1... ./out/stake-001
  ./多签钱包.sh verify ./out/payment-001.signed.cbor ./out/payment-001.cbor
  ./多签钱包.sh import-wallet ./wallet.json
  ./多签钱包.sh addresses <钱包ID> 50
EOF
}

decimal_to_raw_quantity() {
  node -e '
    try {
      const [value, decimalsText, maximumText] = process.argv.slice(1);
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("数量必须是正数，不能使用科学计数法");
      const decimals = Number(decimalsText);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("币种 decimals 无效");
      const [whole, fraction = ""] = value.split(".");
      if (fraction.length > decimals) throw new Error(`该币种最多允许 ${decimals} 位小数`);
      const raw = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction || "0").padEnd(decimals, "0"));
      if (raw <= 0n) throw new Error("发送数量必须大于 0");
      if (raw > BigInt(maximumText)) throw new Error("发送数量超过钱包余额");
      process.stdout.write(raw.toString());
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  ' "$1" "$2" "$3"
}

interactive_payment_wizard() {
  ensure_active_wallet || return 1
  show_transaction_security

  print ""
  print "正在读取钱包余额和币种……"
  local raw
  raw="$("${CLI[@]}" wallet balance "$ACTIVE_WALLET" --format menu)" || return 1
  local -a rows
  rows=("${(@f)raw}")
  (( ${#rows[@]} > 0 )) || { print -u2 "钱包没有可发送的资产"; return 1; }

  local address
  read "address?第 1 步 - 输入收款地址："
  [[ -n "$address" ]] || { print -u2 "收款地址不能为空"; return 1; }

  local -a asset_arguments summaries
  asset_arguments=()
  summaries=()
  local -A selected_units
  local choice row unit label display available decimals amount raw_quantity answer

  print ""
  print "第 2 步 - 选择要发送的币种"
  print "输入币种序号后填写数量；不发送该币种就不要选择。"
  print "选择完成后直接按回车。"
  while true; do
    print ""
    local index
    for (( index = 1; index <= ${#rows[@]}; index++ )); do
      row="${rows[$index]}"
      IFS=$'\t' read -r unit label display available decimals <<< "$row"
      if [[ -n "${selected_units[$unit]:-}" ]]; then
        print "$index) $label — $display  [已选择]"
      else
        print "$index) $label — $display"
      fi
    done

    read "choice?币种序号（直接回车完成）："
    [[ -z "$choice" ]] && break
    [[ "$choice" == <-> ]] && (( choice >= 1 && choice <= ${#rows[@]} )) || {
      print -u2 "无效的币种序号"; continue;
    }
    row="${rows[$choice]}"
    IFS=$'\t' read -r unit label display available decimals <<< "$row"
    if [[ -n "${selected_units[$unit]:-}" ]]; then
      print -u2 "$label 已经选择过"; continue
    fi

    read "amount?$label 发送数量（可用：$display；直接回车跳过）："
    [[ -z "$amount" ]] && continue
    if ! raw_quantity="$(decimal_to_raw_quantity "$amount" "$decimals" "$available" 2>&1)"; then
      print -u2 "数量无效：$raw_quantity"
      continue
    fi
    selected_units[$unit]=1
    asset_arguments+=(--asset "$unit:$raw_quantity")
    summaries+=("$label：$amount")
  done

  (( ${#asset_arguments[@]} > 0 )) || { print -u2 "没有选择任何币种，已取消"; return 1; }

  print ""
  print "第 3 步 - 核对交易"
  print "收款地址：$address"
  local summary
  for summary in "${summaries[@]}"; do print "发送：$summary"; done
  if [[ -z "${selected_units[lovelace]:-}" ]]; then
    print "附带 ADA：自动计算链上要求的最小金额"
  fi
  print "找零：只返回当前钱包经过验证的找零地址"
  print "有效期：构建后约 1 小时"
  read "answer?确认无误请输入 BUILD："
  [[ "$answer" == "BUILD" ]] || { print "已取消"; return 1; }

  local output="$SCRIPT_DIR/out/payment-$(date +%Y%m%d-%H%M%S)"
  "${CLI[@]}" tx build "$ACTIVE_WALLET" --to "$address" "${asset_arguments[@]}" --out "$output"
  print ""
  print "下一步：将生成的 .cbor 导入 Eternl，多方签名后回到本工具验证。"
}

create_wallet_wizard() {
  local name network_choice network n m gap output answer
  print ""
  print "创建新的 Cardano 多签钱包"
  print "安全提示：这里只能输入 acct_shared_xvk 公钥。"
  print "不要输入助记词、私钥、密码或任何 *_xsk。"
  print ""

  read "name?第 1/7 步 - 钱包名称："
  [[ -n "$name" ]] || { print -u2 "钱包名称不能为空"; return 1; }

  print "第 2/7 步 - 选择网络"
  print "1) mainnet 主网"
  print "2) preprod 测试网"
  read "network_choice?请选择："
  case "$network_choice" in
    1) local network="mainnet" ;;
    2) local network="preprod" ;;
    *) print -u2 "无效网络"; return 1 ;;
  esac

  read "n?第 3/7 步 - 一共有多少位 cosigner（n，1..10）："
  [[ "$n" == <-> ]] && (( n >= 1 && n <= 10 )) || { print -u2 "n 必须是 1..10 的整数"; return 1; }
  read "m?第 4/7 步 - 至少需要几位签名（m，1..$n）："
  [[ "$m" == <-> ]] && (( m >= 1 && m <= n )) || { print -u2 "m 必须是 1..$n 的整数"; return 1; }
  read "gap?第 5/7 步 - 初始派生地址数量（直接回车默认 20）："
  gap="${gap:-20}"
  [[ "$gap" == <-> ]] && (( gap >= 1 && gap <= 100 )) || { print -u2 "地址数量必须是 1..100"; return 1; }

  print "第 6/7 步 - 逐个输入 account extended public key"
  local -a cosigner_args
  cosigner_args=()
  local i xpub
  for (( i = 1; i <= n; i++ )); do
    read "xpub?Cosigner $i 的 acct_shared_xvk："
    [[ "$xpub" == acct_shared_xvk1* ]] || { print -u2 "Cosigner $i 不是 acct_shared_xvk 公钥"; return 1; }
    cosigner_args+=(--cosigner "$xpub")
  done

  local export_dir="$CSW_DATA_HOME/exports"
  mkdir -p "$export_dir"
  chmod 700 "$export_dir"
  local default_output="$export_dir/shared-wallet-$(date +%Y%m%d-%H%M%S).json"
  read "output?第 7/7 步 - 保存路径（直接回车使用 $default_output）："
  output="${output:-$default_output}"
  print ""
  print "名称：$name"
  print "网络：$network"
  print "策略：$m-of-$n"
  print "初始地址数量：$gap"
  print "保存到：$output"
  read "answer?确认创建？输入 CREATE："
  [[ "$answer" == "CREATE" ]] || { print "已取消"; return 1; }

  local -a create_command
  create_command=("${CLI[@]}" wallet create-template --name "$name" --network "$network" \
    --threshold "$m" --gap "$gap" "${cosigner_args[@]}" --out "$output" --import true)
  if ! "${create_command[@]}"; then
    print -u2 "钱包创建失败，未加入钱包列表。请根据上方错误修正后重试。"
    return 1
  fi
  print "钱包已经创建并加入钱包列表。"
}

run_command() {
  local command="${1:-}"
  shift || true
  case "$command" in
    balance)
      ensure_active_wallet
      "${CLI[@]}" wallet balance "$ACTIVE_WALLET"
      ;;
    utxos)
      ensure_active_wallet
      "${CLI[@]}" wallet utxos "$ACTIVE_WALLET"
      ;;
    send)
      interactive_payment_wizard
      ;;
    build-ada)
      ensure_active_wallet
      show_transaction_security
      local address="${1:?缺少收款地址}"
      local amount="${2:?缺少 ADA 数量}"
      local output="${3:-$SCRIPT_DIR/out/payment-$(date +%Y%m%d-%H%M%S)}"
      print "即将构建：发送 $amount ADA 到 $address"
      print "输出前缀：$output"
      read "answer?确认地址和金额无误？输入 YES 继续："
      [[ "$answer" == "YES" ]] || { print "已取消"; return 1; }
      "${CLI[@]}" tx build "$ACTIVE_WALLET" --to "$address" --ada "$amount" --out "$output"
      ;;
    build-all)
      ensure_active_wallet
      show_transaction_security
      local address="${1:?缺少收款地址}"
      local output="${2:-$SCRIPT_DIR/out/send-all-$(date +%Y%m%d-%H%M%S)}"
      print ""
      print "警告：将发送钱包内全部 ADA 和全部原生代币。"
      print "收款地址：$address"
      print "输出前缀：$output"
      read "answer?确认清空当前钱包？输入 SEND-ALL 继续："
      [[ "$answer" == "SEND-ALL" ]] || { print "已取消"; return 1; }
      "${CLI[@]}" tx build "$ACTIVE_WALLET" --to "$address" --all true --out "$output"
      ;;
    stake)
      ensure_active_wallet
      show_transaction_security
      local pool_id="${1:-}"
      local output="${2:-$SCRIPT_DIR/out/stake-delegation-$(date +%Y%m%d-%H%M%S)}"
      if [[ -z "$pool_id" ]]; then
        print "第 1/3 步：输入目标质押池 Pool ID"
        read "pool_id?Pool ID（pool1...）："
      fi
      [[ -n "$pool_id" ]] || { print -u2 "Pool ID 不能为空"; return 1; }
      print ""
      print "第 2/3 步：查询质押池和当前钱包质押状态"
      "${CLI[@]}" stake info "$ACTIVE_WALLET" --pool "$pool_id"
      print ""
      print "请核对 Pool ID、ticker、名称、状态、费率和当前委托。"
      print "首次质押会自动加入 stake registration，押金按当前链上协议参数计算。"
      print "质押不会把 ADA 转给池；找零只回当前钱包。"
      print "构建后的交易有效期固定为 1 小时，过期必须重新构建。"
      read "answer?第 3/3 步：确认委托请输入 DELEGATE："
      [[ "$answer" == "DELEGATE" ]] || { print "已取消"; return 1; }
      "${CLI[@]}" stake build "$ACTIVE_WALLET" --pool "$pool_id" --out "$output"
      print ""
      print "下一步：将输出的 .cbor 导入 Eternl，多方签名后回到本工具做本地验证。"
      ;;
    verify)
      ensure_active_wallet
      show_transaction_security
      local signed="${1:?缺少已签名交易文件}"
      local unsigned="${2:?缺少对应的本机未签名交易文件}"
      [[ -f "$signed" ]] || { print -u2 "找不到已签名交易：$signed"; return 1; }
      [[ -f "$unsigned" ]] || { print -u2 "找不到本机未签名交易：$unsigned"; return 1; }
      print "本地只验证签名和多签门槛，不会广播交易。"
      print "验证通过后请在 Eternl 等工具自行提交上链。"
      read "answer?输入 VERIFY 继续验证："
      [[ "$answer" == "VERIFY" ]] || { print "已取消"; return 1; }
      "${CLI[@]}" tx verify "$ACTIVE_WALLET" "$signed" --unsigned "$unsigned"
      ;;
    wallets)
      "${CLI[@]}" wallet list
      ;;
    import-wallet)
      local file="${1:-}"
      [[ -n "$file" ]] || { print -u2 "必须提供钱包 JSON 路径"; return 1; }
      [[ -f "$file" ]] || { print -u2 "找不到钱包文件：$file"; return 1; }
      print "即将校验并导入：$file"
      "${CLI[@]}" wallet import "$file"
      ;;
    delete-wallet)
      local id="${1:-}"
      if [[ -z "$id" ]]; then
        choose_wallet || return 1
        id="$ACTIVE_WALLET"
      fi
      print ""
      print "只会删除 $CSW_DATA_HOME/wallets/$id.json"
      print "不会删除你的原始钱包 JSON。"
      read "answer?确认删除？请输入 DELETE $id："
      [[ "$answer" == "DELETE $id" ]] || { print "已取消"; return 1; }
      "${CLI[@]}" wallet delete "$id"
      ;;
    addresses)
      local wallet="${1:-}"
      local count="${2:-}"
      if [[ -z "$wallet" ]]; then choose_wallet || return 1; wallet="$ACTIVE_WALLET"; fi
      if [[ -z "$count" ]]; then read "count?想查看多少个收款地址："; fi
      "${CLI[@]}" wallet addresses "$wallet" --count "$count"
      ;;
    receive)
      local wallet="${1:-}"
      local scan="${2:-100}"
      if [[ -z "$wallet" ]]; then choose_wallet || return 1; wallet="$ACTIVE_WALLET"; fi
      "${CLI[@]}" wallet receive "$wallet" --scan "$scan"
      ;;
    create-wallet)
      create_wallet_wizard
      ;;
    security)
      ensure_active_wallet
      "${CLI[@]}" security status "$ACTIVE_WALLET"
      ;;
    blockfrost)
      blockfrost_menu
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      print -u2 "未知命令：$command"
      usage
      return 1
      ;;
  esac
}

wallet_management_menu() {
  local choice file count
  while true; do
    print ""
    print "钱包管理"
    print "1) 导入已有钱包 JSON"
    print "2) 输入公钥和 m-of-n 创建新钱包"
    print "3) 删除已导入钱包"
    print "4) 按数量派生并查看收款地址"
    print "5) 查看已导入钱包列表"
    print "0) 返回主菜单"
    read "choice?请选择："
    case "$choice" in
      1)
        read "file?钱包 JSON 路径（不能为空）："
        [[ -n "$file" ]] || { print -u2 "钱包 JSON 路径不能为空"; continue; }
        run_command import-wallet "$file" || true
        ;;
      2)
        run_command create-wallet || true
        ;;
      3)
        if run_command delete-wallet; then
          ACTIVE_WALLET=""
          ACTIVE_WALLET_LABEL=""
        fi
        ;;
      4)
        read "count?想查看多少个收款地址（显示 index 0 到 数量-1）："
        run_command addresses "" "$count" || true
        ;;
      5)
        run_command wallets || true
        ;;
      0) return 0 ;;
      *) print -u2 "无效选项" ;;
    esac
  done
}

menu() {
  local choice address answer signed unsigned
  while true; do
    print ""
    print "Cardano 多签钱包工具"
    print "当前钱包：${ACTIVE_WALLET_LABEL:-未选择}"
    print "1) 查询余额"
    print "2) 查看 UTxO"
    print "3) 收款：显示下一个未使用地址和二维码"
    print "4) 交互式发送 ADA / 原生代币 / NFT"
    print "5) 发送钱包内全部 ADA 和代币"
    print "6) 构建质押委托交易（输入 Pool ID，Eternl 签名）"
    print "7) 本地验证 Eternl 已签名交易（不广播）"
    print "8) 切换钱包"
    print "9) 钱包管理（导入、创建、删除、查看地址）"
    print "10) 配置 Blockfrost Project ID / 查看双源状态"
    print "0) 退出"
    read "choice?请选择："
    case "$choice" in
      1) run_command balance || true ;;
      2) run_command utxos || true ;;
      3)
        run_command receive "$ACTIVE_WALLET" 100 || true
        ;;
      4) interactive_payment_wizard || true ;;
      5)
        print "第 1/2 步：填写接收全部资产的地址"
        read "address?收款地址："
        print "第 2/2 步：检查警告并确认构建"
        run_command build-all "$address" || true
        ;;
      6)
        run_command stake || true
        ;;
      7)
        read "signed?已签名交易文件路径："
        [[ -f "$signed" ]] || { print -u2 "找不到文件：$signed"; continue; }
        read "unsigned?对应的本机原始未签名交易文件路径："
        [[ -f "$unsigned" ]] || { print -u2 "找不到文件：$unsigned"; continue; }
        run_command verify "$signed" "$unsigned" || true
        ;;
      8) choose_wallet || true ;;
      9) wallet_management_menu ;;
      10) blockfrost_menu ;;
      0) return 0 ;;
      *) print -u2 "无效选项" ;;
    esac
  done
}

cd "$SCRIPT_DIR"
if (( $# == 0 )); then choose_wallet || true; menu; else run_command "$@"; fi
