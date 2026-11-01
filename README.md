# Cardano 多签钱包 CLI

这是一个无需 GUI、无需完整节点、不会接触私钥的 Cardano native-script 多签钱包工具。

它使用公开的 account extended public keys 派生多签 Base Address，通过 Koios 读取链上状态，
并可用 Blockfrost 对交易关键数据做严格双源核验。在本地构建交易后，交给 Eternl 进行
多方签名和提交。

## 能做什么

- 导入或创建 `m-of-n` 多签钱包公开描述文件；
- 派生 Base Address，查看余额、原生代币和 UTxO；
- 在终端显示下一个未使用收款地址及字符二维码；
- 构建普通 ADA、原生代币和全部资产转账；
- 查询质押池并构建 stake registration/delegation 交易；
- 验证 Eternl 返回的签名交易、native script 和多签门槛；
- 同时支持 Cardano Mainnet 和 Preprod；
- 可启用 Koios + Blockfrost 双源 fail-closed 验证；
- 所有交易固定约一小时有效期；
- 不提供交易广播功能。

## 工作流程

```text
公开钱包描述文件
        │
        ▼
本地派生 Base Address ──主查询────> Koios
        │
        └───────────────严格复核──> Blockfrost（配置后启用）
        │
        ▼
官方 cardano-cli 11.6.0.0
离线构建 unsigned CBOR
        │
        ▼
Eternl 多方 partial sign
        │
        ▼
本工具本地验证
        │
        ▼
验证通过后在 Eternl Submit
```

程序不运行 `cardano-node` 或 `cardano-wallet`。Koios 和可选的 Blockfrost 只负责提供
UTxO、协议参数、tip、质押账户和质押池信息；最终 transaction body 和 native-script
witness 由官方 `cardano-cli` 离线生成，不会把私钥交给任何服务。

## 安装

### 一键安装并运行

macOS 或 Linux 在终端执行一行命令：

```bash
curl --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/BlizzardSaber/cardano-shared-wallet-cli/main/install.sh?release=20261101-4' | bash
```

安装脚本会把项目代码放到桌面的 `cardano-shared-wallet-cli` 文件夹，并自动安装：

- Node.js 22 LTS 独立运行时；
- 官方 `cardano-cli 11.6.0.0`；
- `package-lock.json` 锁定的 npm 依赖；
- Linux 缺少 zsh 时，通过系统包管理器补装 zsh。

Node.js 和 `cardano-cli` 都会先使用发布方的 SHA-256 清单验证，校验失败立即停止。
支持 Apple Silicon macOS、x86_64 Linux 和 ARM64 Linux。官方 11.6.0.0 没有 Intel Mac
发行包，因此安装器会明确拒绝 Intel Mac，不会悄悄换用旧版本。

macOS 默认使用 `~/Desktop`。Linux 优先读取 `xdg-user-dir DESKTOP`，因此支持“桌面”等
本地化目录；系统没有 `xdg-user-dir` 时回退到 `~/Desktop`。如果目标文件夹已存在且不是
本工具创建的安装目录，脚本会停止，不会覆盖其中内容。

桌面目录只展示用户需要的内容：

- `桌面/cardano-shared-wallet-cli/多签钱包.sh`：唯一的用户入口；
- `桌面/cardano-shared-wallet-cli/卸载.sh`：安全卸载入口；
- `桌面/cardano-shared-wallet-cli/out/`：构建的交易文件。

安装器内部使用的版本、Node.js 和 `cardano-cli` 位于隐藏的 `.app/`，用户不需要进入或
选择其中任何版本。钱包公开描述仍保存在 `~/.csw/wallets/`，不放在桌面项目目录中。

以后可直接运行：

```bash
~/Desktop/cardano-shared-wallet-cli/多签钱包.sh
```

也可以使用命令行快捷入口 `~/.local/bin/csw-wallet`，两者启动的是同一个当前版本。

### 一键卸载

直接运行桌面目录中的：

```bash
~/Desktop/cardano-shared-wallet-cli/卸载.sh
```

也可以使用远程一行命令：

```bash
curl --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/BlizzardSaber/cardano-shared-wallet-cli/main/uninstall.sh?release=20261101-1' | bash
```

默认会把程序、内置 Node.js、官方 `cardano-cli` 和本工具创建的命令行启动器移动到
系统废纸篓，因此可以恢复。钱包公开描述和 Blockfrost 配置位于 `~/.csw`，默认保留。

如需彻底卸载并同时把 `~/.csw` 移入废纸篓：

```bash
curl --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/BlizzardSaber/cardano-shared-wallet-cli/main/uninstall.sh?release=20261101-1' | CSW_PURGE_DATA=1 bash
```

即使使用彻底卸载，链上钱包和资产也不会消失；被移除的只是本机公开钱包描述、配置和
程序文件。本工具从不保存私钥或助记词。

一行安装命令会执行远程脚本。希望先审阅内容的用户，可以先查看
[`install.sh`](./install.sh)，再按下面的手动方式安装。

### 手动安装

需要 Node.js 20 或更高版本，以及 PATH 中准确版本的 `cardano-cli 11.6.0.0`：

```bash
git clone https://github.com/BlizzardSaber/cardano-shared-wallet-cli.git
cd cardano-shared-wallet-cli
npm install
cardano-cli --version
```

直接使用中文脚本：

```bash
./多签钱包.sh
```

也可以将底层命令安装为 `csw`：

```bash
npm link
csw help
```

## 网络支持

| 网络 | 普通地址 | 质押地址 | Koios |
| --- | --- | --- | --- |
| Mainnet | `addr1...` | `stake1...` | `https://api.koios.rest/api/v1/` |
| Preprod | `addr_test1...` | `stake_test1...` | `https://preprod.koios.rest/api/v1/` |

创建 Preprod 钱包时，在 Shell 向导中选择：

```text
2) preprod 测试网
```

钱包网络、收款地址和质押池必须属于同一网络。名字中含“测试”并不代表钱包一定是
Preprod，实际网络以钱包 JSON 的 `network` 字段为准。

## 固定派生规则

所有钱包只使用一种规则：

- account：`0`；
- payment：`m/1854'/1815'/0'/0/index`；
- stake：`m/1854'/1815'/0'/2/0`；
- 地址：payment script + stake script 的 Base Address；
- 默认找零：当前钱包 index 0 地址；
- payment 和 delegation 使用相同 cosigner 顺序与 `m-of-n` 门槛。

每次加载钱包时，程序都会先由 CSL 从 account public keys 重新派生全部已保存地址，再让
官方 `cardano-cli address build` 使用每个 payment script 和固定 stake script 重建全部
Base Address。两套结果都必须与钱包文件逐字一致。`cardano-cli 11.6.0.0` 本身不提供
CIP-1854 account xpub 的非硬化子公钥派生命令，因此“子公钥派生”仍由 CSL 完成；官方
CLI 独立覆盖脚本哈希、网络和 Base Address 组装。

## 导入钱包

推荐导入 `cardano-hd-multisig` 格式：

```json
{
  "format": "cardano-hd-multisig",
  "version": 1,
  "name": "My 2-of-3 Wallet",
  "network": "preprod",
  "threshold": 2,
  "account": 0,
  "gapLimit": 20,
  "cosigners": [
    { "name": "Signer 1", "accountXpub": "acct_shared_xvk1..." },
    { "name": "Signer 2", "accountXpub": "acct_shared_xvk1..." },
    { "name": "Signer 3", "accountXpub": "acct_shared_xvk1..." }
  ]
}
```

导入：

```bash
./多签钱包.sh import-wallet ./wallet.json
```

导入副本保存在 `~/.csw/wallets/`，内容只有公开信息。程序拒绝助记词、私钥、`*_xsk`、
重复 xpub、无效门槛以及不一致的 payment/delegation 模板。

如果没有 JSON，可以运行：

```bash
./多签钱包.sh create-wallet
```

向导会依次询问名称、网络、cosigner 数量 `n`、门槛 `m`、地址数量和每位 cosigner 的
`acct_shared_xvk`。创建的公开描述默认保存在 `~/.csw/exports/`，并自动加入钱包列表。

## 中文交互菜单

```bash
./多签钱包.sh
```

菜单包含：

1. 查询余额；
2. 查看 UTxO；
3. 显示下一个未使用收款地址和终端二维码；
4. 交互式发送 ADA、原生代币或 NFT；
5. 发送全部 ADA 和原生代币；
6. 构建质押委托交易；
7. 本地验证 Eternl 已签名交易；
8. 切换钱包；
9. 钱包管理：导入、创建、删除、派生地址和查看列表；
10. 配置 Blockfrost Mainnet/Preprod Project ID 并查看双源状态。

已有钱包均通过序号选择，不需要手工输入钱包文件名或 ID。导入钱包时必须明确填写
钱包 JSON 路径，不使用任何示例钱包或默认文件。

## 查询余额与收款

```bash
./多签钱包.sh balance
./多签钱包.sh utxos
./多签钱包.sh receive
```

余额会显示人类可读的 ADA 数量。主网原生代币会尝试读取 Cardano Token Registry，
同时保留 unit、policy ID、asset name hex、fingerprint 和原始整数数量。

收款功能会查询地址完整交易历史，显示下一个从未使用的 Base Address，并直接在终端
绘制二维码，不生成 PNG。下一个地址必须位于钱包当前 `gapLimit` 范围内，否则停止。

## 交互式构建交易

运行中文菜单并选择第 4 项：

```bash
./多签钱包.sh
```

向导会：

- 要求填写收款地址；
- 读取当前钱包真实余额并列出 ADA、原生代币和 NFT，代币同时显示 fingerprint 防止同名混淆；
- 通过序号选择币种并填写人类可读数量；
- 直接回车跳过币种或结束选择；
- 检查数量没有超过余额，并按 Token Registry 的 decimals 精确转换；
- 没有选择 ADA 但选择了代币时，自动附带链上要求的最小 ADA；
- 最后集中显示地址、币种、数量、找零规则和有效期，再要求输入 `BUILD`。

仅发送 ADA 或发送全部资产也可以直接执行：

```bash
./多签钱包.sh build-ada addr1... 12.5
./多签钱包.sh build-all addr1...
```

构建结果默认写入自动创建的 `out/`，包括：

- `.cbor`：导入 Eternl；
- `.hex`：CBOR hex；
- `.base64`：备用编码；
- `.json`：Unwitnessed Tx ConwayEra envelope。

普通交易由官方 `cardano-cli latest transaction build-raw` 生成；完成后再通过
`cardano-cli debug transaction view` 和 `transaction txid` 重新解析，并与 CSL 独立结果
交叉验证：

- 所有输入都属于当前钱包；
- 所有 payment native script 与输入地址匹配；
- 找零只能返回经过验证的钱包地址；
- 每种资产满足“输入 = 输出 + 手续费”；
- 全部发送交易不能产生额外找零；
- 手续费不得超过 5 ADA。

## 构建质押委托

运行菜单第 6 项，或者：

```bash
./多签钱包.sh stake
```

流程：

1. 输入 `pool1...` Pool ID；
2. 显示 pool ticker、名称、主页、状态、margin、固定成本、饱和度和 live stake；
3. 显示当前钱包 reward address、注册状态、当前委托池、奖励和押金；
4. 输入 `DELEGATE` 确认；
5. 生成给 Eternl 签名的交易。

未注册的 stake credential 会构建 `register + delegate`，注册押金读取当前协议参数
`keyDeposit`；已注册时只构建 `delegate`。已经委托到同一池、池不存在、池正在退役、
已经退役或状态不可靠时，程序拒绝构建。

质押不会把 ADA 转给池。程序要求所有找零回到当前钱包，并验证：

```text
输入 = 找零 + 手续费 + 首次注册押金
```

质押交易需要两类签名分别达到 m-of-n：

- 支付输入：`role 0 / address index`；
- 质押证书：`role 2 / index 0`。

Eternl partial signing 时必须保留已有 witnesses。

## 一小时有效期

每一笔普通交易、全部发送交易和质押交易都设置：

```text
TTL = 构建时双源确认的最新 tip slot + 3600
```

即约一小时。构建输出会显示 tip slot 和 expires-at slot。过期交易在链上无效，本地
验证也会拒绝，必须重新获取 UTxO 并重新构建。

## Eternl 签名与本地验证

将生成的 `.cbor` 导入 Eternl，依次让足够数量的 signer 执行 partial signing，最后导出
包含全部 witnesses 的 signed transaction。

验证：

```bash
./多签钱包.sh verify ./out/transaction.signed.cbor ./out/transaction.cbor
```

交易文件最大 2 MiB；解析在限制为 96 MiB 内存、10 秒超时的隔离子进程中执行。
官方 CLI 会先独立解析 signed/unsigned 交易并计算 transaction id；两者以及 CSL 计算的
transaction id 必须一致。`cardano-cli 11.6.0.0` 没有离线 Ed25519/native-script verify
命令，因此不会把“能解析”误称为“签名有效”。密码学验证仍由隔离的 CSL 验证器完成。
验证器会检查：

- signed transaction body 与本机 unsigned body 逐字节一致；
- `is_valid=true`；
- auxiliary data 未被改变；
- native script witness 集合未被增加、删除或替换；
- 每个 Ed25519 签名正确；
- 每个支付输入满足 payment script 的 m-of-n；
- 质押证书满足 stake script 的 m-of-n；
- 质押证书属于当前钱包，组合只能是 `delegate` 或 `register + delegate`；
- TTL 存在、没有超过一小时并且尚未过期；
- 不包含当前工具不支持的 Plutus、redeemer 或 bootstrap witness。

验证通过后，本工具仍不会广播。请回到 Eternl 点击 Submit。

## 底层 CLI

```bash
csw wallet import <wallet.json>
csw wallet create-template --name <名称> --network <mainnet|preprod> \
  --threshold <m> --gap <数量> --cosigner <acct_shared_xvk> [...] --out <wallet.json>
csw wallet list
csw wallet delete <wallet-id>
csw wallet addresses <wallet-id> --count <数量>
csw wallet receive <wallet-id> --scan 100
csw wallet balance <wallet-id>
csw wallet utxos <wallet-id>

csw tx build <wallet-id> --to <address> --ada <数量> --out <prefix>
csw tx build <wallet-id> --to <address> --asset <unit>:<整数数量> [--asset ...] --out <prefix>
csw tx build <wallet-id> --to <address> --all true --out <prefix>
csw tx verify <wallet-id> <signed-file> --unsigned <unsigned-file>

csw stake info <wallet-id> --pool <pool1...>
csw stake build <wallet-id> --pool <pool1...> --out <prefix>
csw security status <wallet-id>
```

## Koios 与 Blockfrost 双源验证

公共 Koios 通常无需 API key。也可以使用自己的实例：

```bash
export KOIOS_URL=https://your-koios.example/api/v1/
export KOIOS_API_KEY=your_key
```

Koios 查询会暴露被查询的公开地址。对隐私要求较高时，应使用可信或自建 Koios。

Blockfrost 双源验证会在配置当前网络的 Project ID 后自动启用：

```bash
./多签钱包.sh blockfrost
```

菜单会分别配置或清除 Mainnet、Preprod Project ID。输入时不会回显，凭据保存在
`~/.csw/blockfrost.env`，目录权限为 `700`、文件权限为 `600`，不会进入项目、钱包 JSON
或命令输出。

也可以只为当前终端会话设置环境变量：

```bash
# Mainnet
export BLOCKFROST_MAINNET_PROJECT_ID=mainnet...

# Preprod
export BLOCKFROST_PREPROD_PROJECT_ID=preprod...
```

也可以要求必须启用；缺少对应 Project ID 时会直接报错：

```bash
export CSW_DUAL_SOURCE_VERIFY=true
```

只查看当前钱包状态：

```bash
./多签钱包.sh security
```

Mainnet 钱包只能接受 `mainnet...` Project ID，Preprod 钱包只能接受 `preprod...`
Project ID。Shell 启动时只读取上述两个允许字段，不会把配置文件当作脚本执行。

双源严格模式用于构建和本地验签，比较：

- 当前钱包所有地址的完整 UTxO 集、out-ref、地址和每种资产数量；
- 构建使用的手续费、交易大小、stake deposit、UTxO 成本等协议参数；
- 两边最新 tip，差距不得超过 180 slots；
- 质押账户注册状态、当前 Pool ID、奖励和押金；
- 目标质押池是否存在、状态和退役 epoch。

任一服务失败、分页异常、字段无效或关键数据不一致时都会停止交易。TTL 使用两边较新的
tip 计算。余额和交易历史等只读展示仍以 Koios 为主，避免无意义地消耗 Blockfrost 配额。

如需临时关闭已经自动启用的双源验证：

```bash
export CSW_DUAL_SOURCE_VERIFY=false
```

关闭后，构建输出中的 `source_verification` 会明确显示 `enabled: false`。对主网高价值钱包
不建议关闭。双源验证提高数据完整性，但不能等同于自己运行完整节点，而且两个服务都会
看到被查询的公开地址。

## 项目结构

```text
src/derive.js       公钥、脚本和 Base Address 派生
src/wallet.js       钱包导入、存储和严格校验
src/provider.js     Koios 查询与余额格式化
src/dual-source.js  Blockfrost 严格读取和双源一致性验证
src/cardano-cli.js  固定版本官方 CLI 调用、交易构建和逐字段复核
src/builder.js      普通交易金额计算、费用上界和资产守恒检查
src/staking.js      质押池检查与委托交易构建
src/transaction.js  交易导出和本地签名验证
src/isolated-cbor.js / src/cbor-worker.js 受限进程中的不可信 CBOR 解析
src/receive.js      终端字符二维码
src/cli.js          底层命令入口
test/               自动化测试
多签钱包.sh         中文交互入口
install.sh          一键安装、依赖校验和启动器生成
uninstall.sh        可恢复的一键卸载与可选用户数据清理
```

## 测试

```bash
npm test
npm audit --omit=dev
```

当前测试覆盖钱包派生、防篡改校验、余额精度、普通交易、全部发送、异常手续费、
stake registration/delegation、role 0/role 2 多签验证、TTL 过期，以及双源 UTxO、
协议参数、tip、服务故障和质押状态不一致时的 fail-closed 行为。

## 安全审计记录

最近一次审计：2026-11-01。

- 25 项自动化测试全部通过；
- `npm audit --omit=dev`：0 个已知漏洞；
- 未发现交易广播、动态代码执行或私钥处理入口；外部进程仅以参数数组调用固定版本
  `cardano-cli`，以及启动受内存和超时限制的本地 CBOR 验证进程，不经过 shell；
- 普通转账、全部发送、stake registration/delegation 的最终 transaction body 均由官方
  `cardano-cli 11.6.0.0` 生成；CSL 不再负责生成最终 body；
- `cardano-cli` 和 Node.js 安装包均验证官方 SHA-256，npm 生产依赖精确锁定；
- CSL 对输出地址、资产、输入、手续费、TTL、证书和签名做独立交叉验证；
- 官方 CLI 对每个 Base Address 做重建复核，并对构建/签名交易重新解析字段和计算 txid；
- 外部交易文件限制为 2 MiB，CBOR 解析隔离在 96 MiB/10 秒的子进程中；
- Blockfrost Project ID 以权限 `600` 的独立配置保存，运行时只进入进程环境，不进入返回对象、钱包文件或日志；
- 双源严格模式无法通过直接调用底层普通/质押构建器绕过；
- Koios 或 Blockfrost 故障、UTxO/协议参数/质押状态分歧、分页异常和 tip 差距过大均 fail closed；
- 两个已导入钱包均能通过完整重新派生校验，钱包文件权限为仅当前用户读写；
- 主网 Koios 完成过只读、内存内构建回归，没有写出或广播交易；
- Blockfrost 的真实联网核验需要用户自己的 Project ID；无凭据时只执行 mock 行为测试，
  并在每次构建或验签前明确警告双源尚未启用。

未消除的信任边界：双源仍然依赖第三方索引服务，并不等同于本地完整节点；Eternl 的
导入、role 0/role 2 partial signing 和 Submit 行为属于外部钱包边界，必须先在 Preprod
完成端到端验证。

## 安全边界

- 本项目只接受公开 xpub，不接受、生成或保存私钥和助记词；
- 不运行完整节点，链上状态依赖 Koios 和配置后的 Blockfrost；
- 配置 Blockfrost 后，交易关键状态必须通过 Koios + Blockfrost 双源一致性检查；
- 不提供广播功能；
- 当前构建器显式消费所有已知 UTxO，超过 80 个时停止；
- 当前支持支付和 stake registration/delegation；
- 暂不支持奖励提取、stake deregistration、governance、minting、metadata 和 Plutus；
- 不支持含 `active_from` 或 `active_until` 的 timelock 模板；
- 真金白银使用前，应先在 Preprod 完成构建、Eternl 多方签名、验证和提交全流程测试。

## 技术参考

- [Cardano Developer Portal：Addresses](https://developers.cardano.org/docs/learn/core-concepts/addresses/)
- [Cardano Developer Portal：Native scripts](https://developers.cardano.org/docs/learn/cardano-cli/simple-scripts/)
- [Cardano Developer Portal：cardano-cli 离线 build-raw](https://developers.cardano.org/docs/get-started/infrastructure/cardano-cli/basic-operations/simple-transactions/)
- [官方 cardano-cli 仓库](https://github.com/IntersectMBO/cardano-cli)
- [Cardano Serialization Library](https://github.com/Emurgo/cardano-serialization-lib)
- [Mesh：Koios Provider](https://meshjs.dev/providers/koios)
- [Mesh：Blockfrost Provider](https://meshjs.dev/providers/blockfrost)
- [Blockfrost：Cardano OpenAPI](https://github.com/blockfrost/openapi)
