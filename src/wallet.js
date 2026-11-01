import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deserializeAddress, serializeNativeScript } from '@meshsdk/core';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import {
  deriveReceiveAddresses, deriveSharedWallet, deriveStakeScript, normalizeHdMultisigExport,
} from './derive.js';
import { auditWalletAddressesWithCardanoCli } from './cardano-cli.js';

const NETWORKS = new Set(['mainnet', 'preprod', 'preview']);
const MAX_JSON_BYTES = 128 * 1024;

async function readJsonFile(file) {
  const bytes = await readFile(file);
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`JSON 文件超过 ${MAX_JSON_BYTES} 字节限制`);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`JSON 格式无效: ${error.message}`); }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function walletHome() {
  return resolve(process.env.CSW_HOME || join(homedir(), '.csw'));
}

export function validateWallet(input) {
  const normalized = normalizeHdMultisigExport(input);
  const wallet = structuredClone(
    !normalized.accounts && normalized.payment_script_template ? deriveSharedWallet(normalized) : normalized,
  );
  if (wallet.version !== 1) throw new Error('钱包描述文件 version 必须是 1');
  if (typeof wallet.name !== 'string' || !wallet.name.trim()) throw new Error('钱包缺少 name');
  if (!NETWORKS.has(wallet.network)) throw new Error('network 必须是 mainnet、preprod 或 preview');
  if (!Array.isArray(wallet.accounts) || wallet.accounts.length === 0) {
    throw new Error('accounts 必须至少包含一个 address/payment_script');
  }
  const derivation = wallet.derivation;
  if (!derivation?.payment_script_template || !derivation?.delegation_script_template) {
    throw new Error('钱包缺少 payment/delegation 公钥派生模板，无法验证固定派生规则');
  }
  const gap = derivation.address_pool_gap;
  if (!Number.isInteger(gap) || gap < 1 || gap > 100 || wallet.accounts.length !== gap) {
    throw new Error('accounts 必须完整覆盖 address_pool_gap（1..100）');
  }

  const seen = new Set();
  wallet.accounts = wallet.accounts.map((account, index) => {
    if (!account || typeof account.address !== 'string' || !account.payment_script) {
      throw new Error(`accounts[${index}] 缺少 address 或 payment_script`);
    }
    if (account.role !== 'external' || account.index !== index) {
      throw new Error(`accounts[${index}] 必须是 external/index ${index} 的收款地址`);
    }
    if (seen.has(account.address)) throw new Error(`重复地址: ${account.address}`);
    seen.add(account.address);
    const isMainnetAddress = account.address.startsWith('addr1');
    const isTestnetAddress = account.address.startsWith('addr_test1');
    if ((wallet.network === 'mainnet' && !isMainnetAddress)
      || (wallet.network !== 'mainnet' && !isTestnetAddress)) {
      throw new Error(`地址与 ${wallet.network} 网络不匹配: ${account.address}`);
    }

    let serialized;
    let decoded;
    try {
      serialized = serializeNativeScript(account.payment_script, undefined, wallet.network === 'mainnet' ? 1 : 0);
      decoded = deserializeAddress(account.address);
    } catch (error) {
      throw new Error(`accounts[${index}] 地址或 native script 无效: ${error.message}`);
    }
    if (!decoded.scriptHash) throw new Error(`地址不是 payment-script 地址: ${account.address}`);
    if (!decoded.stakeScriptCredentialHash) {
      throw new Error(`地址不是 script-payment + script-stake 的 base address: ${account.address}`);
    }
    const scriptHash = deserializeAddress(serialized.address).scriptHash;
    if (decoded.scriptHash !== scriptHash) throw new Error(`payment_script 与地址不匹配: ${account.address}`);
    return { ...account, address: account.address, payment_script: account.payment_script };
  });

  if (typeof wallet.change_address !== 'string' || !seen.has(wallet.change_address)) {
    throw new Error('change_address 必须是 accounts 中已经校验的地址');
  }
  const independentlyDerived = deriveReceiveAddresses(wallet, gap);
  if (wallet.accounts.some((account, index) => account.address !== independentlyDerived[index].address)) {
    throw new Error('派生安全检查失败：保存的地址与模板重新派生的结果不一致');
  }
  if (wallet.change_address !== independentlyDerived[0].address) {
    throw new Error('默认找零地址必须是 index 0 的收款地址');
  }
  return wallet;
}

export function walletId(wallet) {
  return createHash('sha256').update(JSON.stringify(stable(wallet))).digest('hex').slice(0, 16);
}

export async function importWallet(file) {
  const wallet = validateWallet(await readJsonFile(resolve(file)));
  await auditWalletAddressesWithCardanoCli({ wallet, stakeScript: deriveStakeScript(wallet) });
  const id = walletId(wallet);
  const dir = join(walletHome(), 'wallets');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${id}.json`);
  try {
    await writeFile(target, `${JSON.stringify(wallet, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = validateWallet(await readJsonFile(target));
    if (JSON.stringify(stable(existing)) !== JSON.stringify(stable(wallet))) {
      throw new Error(`钱包 ID 冲突或已有文件内容不一致: ${target}`);
    }
  }
  return { id, file: target, wallet };
}

export async function createWalletTemplate({ name, network, threshold, gapLimit, cosigners, output }) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('钱包名称不能为空');
  if (!NETWORKS.has(network)) throw new Error('network 必须是 mainnet、preprod 或 preview');
  if (!Array.isArray(cosigners) || cosigners.length < 1 || cosigners.length > 10) {
    throw new Error('cosigner 数量必须是 1..10');
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > cosigners.length) {
    throw new Error(`签名门槛 m 必须是 1..${cosigners.length}`);
  }
  if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > 100) {
    throw new Error('初始地址数量必须是 1..100');
  }
  const descriptor = {
    format: 'cardano-hd-multisig',
    version: 1,
    name: name.trim(),
    network,
    threshold,
    account: 0,
    gapLimit,
    cosigners: cosigners.map((accountXpub, index) => ({
      name: `Cosigner ${index + 1}`,
      accountXpub,
    })),
  };
  const wallet = validateWallet(descriptor); // Validates every xpub, script and derived base address.
  await auditWalletAddressesWithCardanoCli({ wallet, stakeScript: deriveStakeScript(wallet) });
  const file = resolve(output);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`输出文件已存在，拒绝覆盖: ${file}`);
    throw error;
  }
  return { file, descriptor };
}

async function exists(path) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

export async function loadWallet(reference) {
  const isManagedId = typeof reference === 'string' && /^[0-9a-f]{16}$/.test(reference);
  const direct = resolve(reference);
  const path = isManagedId ? join(walletHome(), 'wallets', `${reference}.json`) : direct;
  if (!await exists(path)) throw new Error(`找不到钱包 ${reference}；请先执行 wallet import`);
  const wallet = validateWallet(await readJsonFile(path));
  await auditWalletAddressesWithCardanoCli({ wallet, stakeScript: deriveStakeScript(wallet) });
  if (isManagedId && walletId(wallet) !== reference) {
    throw new Error(`已导入钱包 ${reference} 的内容哈希与 ID 不一致，文件可能被修改`);
  }
  return { id: basename(path, '.json'), file: path, wallet };
}

export async function listWallets() {
  const dir = join(walletHome(), 'wallets');
  if (!await exists(dir)) return [];
  const allJson = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const unexpected = allJson.find((name) => !/^[0-9a-f]{16}\.json$/.test(name));
  if (unexpected) throw new Error(`钱包目录包含非标准文件，拒绝静默忽略: ${join(dir, unexpected)}`);
  const files = allJson;
  const wallets = [];
  for (const file of files) {
    const id = basename(file, '.json');
    try {
      const loaded = await loadWallet(id);
      wallets.push({
        id: loaded.id,
        name: loaded.wallet.name,
        network: loaded.wallet.network,
        addresses: loaded.wallet.accounts.length,
      });
    } catch (error) {
      throw new Error(`已导入钱包 ${id} 校验失败: ${error.message}`);
    }
  }
  return wallets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function deleteWallet(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) {
    throw new Error('删除钱包时必须提供 wallet list 显示的 16 位钱包 ID');
  }
  const file = join(walletHome(), 'wallets', `${id}.json`);
  if (!await exists(file)) throw new Error(`找不到已导入的钱包 ${id}`);
  await unlink(file);
  return { id, file, deleted: true };
}

export function accountRuntime(wallet) {
  const networkId = wallet.network === 'mainnet' ? 1 : 0;
  return new Map(wallet.accounts.map((account) => [account.address, {
    ...account,
    scriptCbor: serializeNativeScript(account.payment_script, undefined, networkId).scriptCbor,
  }]));
}

export function stakeRuntime(wallet) {
  const networkId = wallet.network === 'mainnet' ? 1 : 0;
  const script = deriveStakeScript(wallet);
  const scriptCbor = serializeNativeScript(script, undefined, networkId).scriptCbor;
  const nativeScript = CSL.NativeScript.from_hex(scriptCbor);
  const scriptHash = nativeScript.hash().to_hex();
  const credential = CSL.Credential.from_scripthash(nativeScript.hash());
  const rewardAddress = CSL.RewardAddress.new(networkId, credential).to_address().to_bech32();
  const addressStakeHash = deserializeAddress(wallet.change_address).stakeScriptCredentialHash;
  if (addressStakeHash !== scriptHash) {
    throw new Error('安全检查失败：质押脚本与钱包 base address 的 stake credential 不一致');
  }
  return {
    script,
    scriptCbor,
    scriptHash,
    rewardAddress,
    signingPath: "m/1854'/1815'/0'/2/0",
  };
}
