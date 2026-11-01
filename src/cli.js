#!/usr/bin/env node
import { resolve } from 'node:path';
import { deserializeAddress } from '@meshsdk/core';
import {
  adaToLovelace, exportTransaction, readTransaction,
} from './transaction.js';
import { isolatedTransactionStakeContext, isolatedVerifySignedTransaction } from './isolated-cbor.js';
import { buildTransaction } from './builder.js';
import { auditTransactionWithCardanoCli, CARDANO_CLI_VERSION } from './cardano-cli.js';
import {
  createProvider, dualSourceConfig, fetchWalletUtxos, findNextUnusedAddress, formatQuantity, humanizeAssets, sumAssets,
} from './provider.js';
import { deriveReceiveAddresses } from './derive.js';
import { createWalletTemplate, deleteWallet, importWallet, listWallets, loadWallet } from './wallet.js';
import { createTerminalQr } from './receive.js';
import { buildStakeDelegation, inspectStakeDelegation } from './staking.js';
import { prepareChainSnapshot } from './dual-source.js';

const HELP = `Cardano native-script shared wallet CLI (node-free)

用法:
  csw wallet import <wallet.json>
  csw wallet create-template --name <名称> --network <网络> --threshold <m> --gap <数量> --cosigner <acct_shared_xvk> [...] --out <文件> [--import true]
  csw wallet list
  csw wallet delete <wallet-id>
  csw wallet addresses <wallet-id|wallet.json> --count <数量>
  csw wallet receive <wallet-id|wallet.json> [--scan <数量>]
  csw wallet balance <wallet-id|wallet.json> [--format json|menu]
  csw wallet utxos <wallet-id|wallet.json>
  csw tx build <wallet> --to <address> [--ada <ADA>|--lovelace <N>] [--asset <unit>:<整数数量> ...] [--out <prefix>]
  csw tx build <wallet> --to <address> --all true [--out <prefix>]
  csw tx verify <wallet> <signed-transaction-file> --unsigned <original-unsigned-file>
  csw stake info <wallet> --pool <pool1...>
  csw stake build <wallet> --pool <pool1...> [--out <prefix>] [--era <Era>]
  csw security status <wallet>

环境变量:
  CSW_HOME          钱包公开描述文件目录（默认 ~/.csw）
  KOIOS_URL         可选，自定义 Koios API URL
  KOIOS_API_KEY     可选，提高 Koios rate limit
  BLOCKFROST_MAINNET_PROJECT_ID  配置后为主网自动启用严格双源验证
  BLOCKFROST_PREPROD_PROJECT_ID  配置后为 Preprod 自动启用严格双源验证
  CSW_DUAL_SOURCE_VERIFY         true 强制启用；false 显式关闭

本程序不运行 cardano-node，不接收助记词或私钥，也不广播交易；
交易签名后在本地验证，提交上链请在 Eternl 等工具完成。`;

const KNOWN_OPTIONS = new Set([
  'help', 'name', 'network', 'threshold', 'gap', 'cosigner', 'out', 'import',
  'format', 'count', 'scan', 'pool', 'era', 'all', 'to', 'ada', 'lovelace',
  'asset', 'unsigned',
]);

function parse(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) { positionals.push(item); continue; }
    const key = item.slice(2);
    if (!KNOWN_OPTIONS.has(key)) throw new Error(`未知参数 --${key}`);
    if (key === 'help') { options.help = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 --${key} 缺少值`);
    i += 1;
    if (key === 'asset' || key === 'cosigner') (options[key] ??= []).push(value);
    else options[key] = value;
  }
  return { positionals, options };
}

function need(value, message) { if (!value) throw new Error(message); return value; }
function print(value) { console.log(JSON.stringify(value, null, 2)); }

function parseAssetOption(value) {
  const separator = value.lastIndexOf(':');
  if (separator < 1) throw new Error('--asset 格式必须是 <unit>:<整数数量>');
  const unit = value.slice(0, separator);
  const quantity = value.slice(separator + 1);
  if (!/^\d+$/.test(quantity) || BigInt(quantity) <= 0n) {
    throw new Error('--asset 数量必须是正整数');
  }
  return { unit, quantity };
}

function menuText(value) {
  return String(value ?? '').replace(/[\t\r\n\x00-\x1f\x7f]/g, ' ').trim();
}

async function walletContext(reference) {
  const loaded = await loadWallet(need(reference, '需要 wallet-id 或钱包描述文件'));
  return { ...loaded, provider: createProvider(loaded.wallet.network) };
}

function adaDisplay(lovelace) {
  return `${formatQuantity(String(lovelace ?? '0'), 6, true)} ADA`;
}

function stakingDisplay(id, wallet, inspection) {
  const { pool, stake } = inspection;
  return {
    id,
    name: wallet.name,
    network: wallet.network,
    pool: {
      id: pool.poolId,
      ticker: pool.ticker,
      name: pool.name,
      homepage: pool.homepage,
      status: pool.status,
      margin: pool.margin === null ? null : `${(pool.margin * 100).toFixed(2)}%`,
      fixed_cost: pool.fixedCostLovelace === null ? null : adaDisplay(pool.fixedCostLovelace),
      saturation: pool.saturation === null ? null : `${pool.saturation.toFixed(2)}%`,
      live_stake: pool.liveStakeLovelace === null ? null : adaDisplay(pool.liveStakeLovelace),
      retiring_epoch: pool.retiringEpoch,
    },
    wallet_staking: {
      reward_address: stake.rewardAddress,
      stake_script_hash: stake.scriptHash,
      signing_path: stake.signingPath,
      registered: stake.registered,
      current_pool: stake.currentPool,
      rewards: adaDisplay(stake.rewardsLovelace),
      current_deposit: stake.depositLovelace === null ? null : adaDisplay(stake.depositLovelace),
    },
    action: inspection.action,
    already_delegated: inspection.alreadyDelegated,
  };
}

async function main(argv) {
  const { positionals: p, options: o } = parse(argv);
  if (p.length === 0 || p[0] === 'help' || o.help) { console.log(HELP); return; }

  if (p[0] === 'wallet' && p[1] === 'import') {
    const result = await importWallet(need(p[2], '需要 wallet.json'));
    print({
      id: result.id,
      file: result.file,
      name: result.wallet.name,
      network: result.wallet.network,
      address_type: 'base',
      staking_key_source: 'derived-from-account-xpub',
      derived_addresses: result.wallet.accounts.length,
    }); return;
  }
  if (p[0] === 'wallet' && p[1] === 'create-template') {
    if (o.import !== undefined && o.import !== 'true') throw new Error('--import 的值必须是 true');
    const created = await createWalletTemplate({
      name: need(o.name, '需要 --name'),
      network: need(o.network, '需要 --network'),
      threshold: Number(need(o.threshold, '需要 --threshold <m>')),
      gapLimit: Number(need(o.gap, '需要 --gap <初始地址数量>')),
      cosigners: o.cosigner || [],
      output: need(o.out, '需要 --out <文件>'),
    });
    const imported = o.import === 'true' ? await importWallet(created.file) : null;
    print({
      created: true,
      file: created.file,
      name: created.descriptor.name,
      network: created.descriptor.network,
      policy: `${created.descriptor.threshold}-of-${created.descriptor.cosigners.length}`,
      initial_address_count: created.descriptor.gapLimit,
      public_keys_only: true,
      imported: imported ? { id: imported.id, file: imported.file } : null,
    }); return;
  }
  if (p[0] === 'wallet' && p[1] === 'list') {
    const wallets = await listWallets();
    if (o.format === undefined || o.format === 'json') print(wallets);
    else if (o.format === 'menu') {
      for (const wallet of wallets) {
        const safeName = wallet.name.replace(/[\x00-\x1f\x7f]/g, ' ');
        console.log(`${wallet.id}\t${safeName}\t${wallet.network}\t${wallet.addresses}`);
      }
    } else throw new Error('--format 只支持 json 或 menu');
    return;
  }
  if (p[0] === 'security' && p[1] === 'status') {
    const { id, wallet } = await loadWallet(need(p[2], '需要 wallet-id 或钱包描述文件'));
    const config = dualSourceConfig(wallet.network);
    if (o.format === 'line') {
      console.log(config.enabled
        ? '安全数据源：Koios + Blockfrost 严格双源验证已启用'
        : `警告：当前仅使用 Koios，双源验证未启用（请配置 ${config.envName}）`);
      return;
    }
    if (o.format !== undefined && o.format !== 'json') {
      throw new Error('--format 只支持 json 或 line');
    }
    print({
      id,
      name: wallet.name,
      network: wallet.network,
      dual_source_verification: config.enabled ? 'enabled' : 'disabled',
      blockfrost_credential: config.enabled ? 'configured (hidden)' : 'not active',
      required_environment_variable: config.envName,
      auto_enable_rule: `${config.envName} 存在时自动启用；CSW_DUAL_SOURCE_VERIFY=false 可显式关闭`,
      strict_policy: '构建和本地验签时，任一数据源失败或关键数据不一致即停止',
      transaction_builder: `official cardano-cli ${CARDANO_CLI_VERSION}`,
      address_cross_check: 'CSL derives child keys; cardano-cli rebuilds every payment-script + stake-script base address',
      transaction_cross_check: 'cardano-cli debug view + txid are compared with CSL parsing',
      signature_verification: 'isolated CSL Ed25519 + native-script m-of-n verification (cardano-cli has no offline verify command)',
      cbor_parser_isolation: '2 MiB input, 96 MiB worker memory, 10 second timeout',
      broadcasting: 'disabled',
    }); return;
  }
  if (p[0] === 'wallet' && p[1] === 'delete') {
    print(await deleteWallet(need(p[2], '需要 wallet-id'))); return;
  }
  if (p[0] === 'wallet' && p[1] === 'addresses') {
    const { id, wallet } = await walletContext(p[2]);
    const count = Number(need(o.count, '需要 --count <数量>'));
    const addresses = deriveReceiveAddresses(wallet, count);
    print({ id, name: wallet.name, network: wallet.network, count: addresses.length, addresses }); return;
  }
  if (p[0] === 'wallet' && p[1] === 'receive') {
    const { id, wallet, provider } = await walletContext(p[2]);
    const scanCount = Number(o.scan ?? 100);
    if (!Number.isInteger(scanCount) || scanCount < 1 || scanCount > 1000) {
      throw new Error('--scan 必须是 1..1000 的整数');
    }
    const next = await findNextUnusedAddress(provider, wallet, scanCount);
    const terminalQr = await createTerminalQr(next.address);
    const decoded = deserializeAddress(next.address);
    const template = wallet.derivation?.payment_script_template?.template;
    const required = template?.some?.at_least;
    const total = template?.some?.from?.length;
    const policy = Number.isInteger(required) && Number.isInteger(total) ? `${required}-of-${total}` : 'custom native script';
    const stakePath = "m/1854'/1815'/0'/2/0";
    console.log(`\n网络：${wallet.network}`);
    console.log(`策略：${policy}`);
    console.log(`支付路径：${next.path}`);
    console.log(`质押路径：${stakePath}`);
    console.log(`Payment script hash：${decoded.scriptHash}`);
    console.log(`Stake script hash：${decoded.stakeScriptCredentialHash || '无'}`);
    console.log(`\n下一个从未使用过的收款地址（index ${next.index}）：\n${next.address}\n`);
    console.log(terminalQr);
    print({
      id,
      name: wallet.name,
      network: wallet.network,
      index: next.index,
      highest_used_index: next.highest_used_index,
      scanned_address_count: next.scanned_address_count,
      path: next.path,
      address: next.address,
      address_type: next.address_type,
      policy,
      payment_script_hash: decoded.scriptHash,
      stake_script_hash: decoded.stakeScriptCredentialHash || null,
      usage_check: 'no-chain-transaction-history',
      qr: 'displayed-in-terminal',
    }); return;
  }
  if (p[0] === 'wallet' && (p[1] === 'balance' || p[1] === 'utxos')) {
    const { id, wallet, provider } = await walletContext(p[2]);
    const utxos = await fetchWalletUtxos(provider, wallet);
    if (p[1] === 'utxos') print(utxos);
    else {
      const readable = await humanizeAssets(sumAssets(utxos), wallet.network);
      if (o.format === 'menu') {
        console.log(`lovelace\tADA\t${readable.ada.amount}\t${readable.ada.lovelace}\t6`);
        for (const token of readable.tokens) {
          const title = menuText(token.ticker || token.name || 'Unknown token');
          const label = menuText(`${title} [${token.fingerprint}]`);
          console.log(`${token.unit}\t${label}\t${menuText(token.amount)}\t${token.raw_quantity}\t${token.decimals}`);
        }
      } else {
        if (o.format !== undefined && o.format !== 'json') {
          throw new Error('--format 只支持 json 或 menu');
        }
        print({
          id,
          name: wallet.name,
          network: wallet.network,
          utxo_count: utxos.length,
          ...readable,
        });
      }
    }
    return;
  }
  if (p[0] === 'stake' && p[1] === 'info') {
    const { id, wallet, provider } = await walletContext(p[2]);
    const inspection = await inspectStakeDelegation({
      wallet, provider, poolId: need(o.pool, '需要 --pool <pool1...>'),
    });
    print(stakingDisplay(id, wallet, inspection)); return;
  }
  if (p[0] === 'stake' && p[1] === 'build') {
    const { id, wallet, provider } = await walletContext(p[2]);
    const utxos = await fetchWalletUtxos(provider, wallet);
    const snapshot = await prepareChainSnapshot({
      wallet, koiosProvider: provider, koiosUtxos: utxos,
      poolId: need(o.pool, '需要 --pool <pool1...>'), includeStaking: true,
    });
    const result = await buildStakeDelegation({
      wallet,
      provider,
      utxos,
      poolId: o.pool,
      chainContext: snapshot.chainContext,
      stakingState: snapshot.stakingState,
      poolInfo: snapshot.poolInfo,
      dualSource: snapshot.dualSource,
    });
    const prefix = resolve(o.out || `out/stake-delegation-${Date.now()}`);
    const files = await exportTransaction(result.txHex, prefix, o.era || 'ConwayEra');
    print({
      id,
      mode: result.action,
      pool: result.pool,
      previous_pool: result.previousPool,
      reward_address: result.rewardAddress,
      stake_script_hash: result.stakeScriptHash,
      stake_signing_path: result.stakeSigningPath,
      payment_signing_paths: "m/1854'/1815'/0'/0/<address index>",
      fee_lovelace: result.fee,
      fee: adaDisplay(result.fee),
      registration_deposit_lovelace: result.deposit,
      registration_deposit: adaDisplay(result.deposit),
      input_count: result.inputs.length,
      verified_change_address: result.changeAddress,
      outputs: result.outputs,
      validity: {
        tip_slot_at_build: result.tipSlot,
        expires_at_slot: result.expiresAtSlot,
        duration: '1 hour (3600 slots)',
      },
      source_verification: result.dualSource,
      transaction_builder: result.builder,
      official_cli_cross_check: result.officialCrossCheck,
      files,
      next: '将 .cbor 导入 Eternl，多方签名后用 tx verify 本地验证，再由 Eternl Submit',
    }); return;
  }
  if (p[0] === 'tx' && p[1] === 'build') {
    const { wallet, provider } = await walletContext(p[2]);
    const payments = [];
    if (o.all !== undefined && o.all !== 'true') throw new Error('--all 的值必须是 true');
    if (o.all !== undefined && !o.to) throw new Error('--all true 必须同时指定 --to');
    if (o.all !== undefined && (o.ada !== undefined || o.lovelace !== undefined || o.asset?.length)) {
      throw new Error('--all true 不能同时使用 --ada、--lovelace 或 --asset');
    }
    if (o.asset?.length && !o.to) throw new Error('--asset 必须同时指定 --to');
    if (o.to && o.all === undefined) {
      if (o.ada !== undefined && o.lovelace !== undefined) {
        throw new Error('--ada 和 --lovelace 不能同时使用');
      }
      const amount = [];
      if (o.ada !== undefined) amount.push({ unit: 'lovelace', quantity: String(adaToLovelace(o.ada)) });
      if (o.lovelace !== undefined) amount.push({ unit: 'lovelace', quantity: o.lovelace });
      for (const asset of o.asset || []) amount.push(parseAssetOption(asset));
      if (amount.length === 0) throw new Error('至少使用 --ada、--lovelace 或 --asset 指定一种资产');
      payments.push({ address: o.to, amount });
    }
    if (payments.length === 0 && o.all === undefined) throw new Error('需要 --to 和至少一种发送资产');
    const utxos = await fetchWalletUtxos(provider, wallet);
    const snapshot = await prepareChainSnapshot({
      wallet, koiosProvider: provider, koiosUtxos: utxos,
    });
    const result = await buildTransaction({
      wallet,
      provider,
      utxos,
      payments,
      sendAllTo: o.all === 'true' ? o.to : undefined,
      chainContext: snapshot.chainContext,
      dualSource: snapshot.dualSource,
    });
    const prefix = resolve(o.out || `out/unsigned-${Date.now()}`);
    const files = await exportTransaction(result.txHex, prefix, o.era || 'ConwayEra');
    print({
      mode: result.sendAll ? 'send-all-assets' : 'normal',
      fee_lovelace: result.fee,
      fee_ada: `${(BigInt(result.fee) / 1_000_000n).toString()}.${(BigInt(result.fee) % 1_000_000n).toString().padStart(6, '0')}`,
      input_count: result.inputs.length,
      verified_change_address: result.changeAddress,
      change_output_count: result.changeOutputCount,
      outputs: result.outputs,
      validity: {
        tip_slot_at_build: result.tipSlot,
        expires_at_slot: result.expiresAtSlot,
        duration: '1 hour (3600 slots)',
      },
      source_verification: result.dualSource,
      transaction_builder: result.builder,
      official_cli_cross_check: result.officialCrossCheck,
      files,
    }); return;
  }
  if (p[0] === 'tx' && p[1] === 'verify') {
    const { wallet, provider } = await walletContext(p[2]);
    const txHex = await readTransaction(need(p[3], '需要已签名交易文件或 -'));
    const unsignedHex = await readTransaction(need(o.unsigned, '本地验证必须提供 --unsigned <本机原始未签名交易文件>'));
    const [signedOfficialAudit, unsignedOfficialAudit] = await Promise.all([
      auditTransactionWithCardanoCli(txHex),
      auditTransactionWithCardanoCli(unsignedHex),
    ]);
    if (signedOfficialAudit.transactionId !== unsignedOfficialAudit.transactionId) {
      throw new Error('官方 cardano-cli 判断签名交易与未签名交易的 transaction id 不一致');
    }
    const utxos = await fetchWalletUtxos(provider, wallet);
    const stakeContext = await isolatedTransactionStakeContext(unsignedHex);
    const snapshot = await prepareChainSnapshot({
      wallet,
      koiosProvider: provider,
      koiosUtxos: utxos,
      includeStaking: stakeContext.hasCertificates,
      poolId: stakeContext.poolId,
    });
    const currentSlot = snapshot.chainContext.tipSlot;
    const verification = await isolatedVerifySignedTransaction({
      signedHex: txHex, unsignedHex, wallet, utxos, currentSlot,
    });
    if (verification.transaction_id !== signedOfficialAudit.transactionId) {
      throw new Error('官方 cardano-cli 与 CSL 验证器计算的 transaction id 不一致');
    }
    print({
      ...verification,
      official_cli_cross_check: {
        parser: signedOfficialAudit.parser,
        transaction_id_matches: true,
        note: 'cardano-cli 负责独立解析与 txid 复核；Ed25519 和 m-of-n 仍由隔离的 CSL 验证器检查',
      },
      source_verification: snapshot.dualSource,
      verified: true,
      note: '本 CLI 不提供广播功能，验证通过后请在 Eternl 等工具提交',
    }); return;
  }
  throw new Error(`未知命令: ${p.join(' ')}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
});
