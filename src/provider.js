import { BlockfrostProvider, KoiosProvider } from '@meshsdk/core';
import { resolveFingerprint } from '@meshsdk/core';
import { deriveReceiveAddresses } from './derive.js';

const KOIOS_NETWORKS = {
  mainnet: 'api',
  preprod: 'preprod',
  preview: 'preview',
};

export function createProvider(network) {
  const koiosNetwork = KOIOS_NETWORKS[network];
  if (!koiosNetwork) throw new Error(`不支持的网络: ${network}`);
  const token = process.env.KOIOS_API_KEY;
  if (!process.env.KOIOS_URL) {
    return typeof token === 'string' && token ? new KoiosProvider(koiosNetwork, token) : new KoiosProvider(koiosNetwork);
  }

  // Mesh's custom-URL overload currently emits "Bearer undefined" when the
  // optional token is absent. Remove only that generated header for public or
  // self-hosted Koios endpoints.
  const provider = new KoiosProvider(process.env.KOIOS_URL, token);
  if (!token) delete provider._axiosInstance.defaults.headers.Authorization;
  return provider;
}

const BLOCKFROST_ENV = {
  mainnet: 'BLOCKFROST_MAINNET_PROJECT_ID',
  preprod: 'BLOCKFROST_PREPROD_PROJECT_ID',
  preview: 'BLOCKFROST_PREVIEW_PROJECT_ID',
};

function resolveDualSourceConfig(network) {
  const mode = process.env.CSW_DUAL_SOURCE_VERIFY;
  if (mode !== undefined && !['true', 'false'].includes(mode)) {
    throw new Error('CSW_DUAL_SOURCE_VERIFY 只能是 true 或 false');
  }
  const envName = BLOCKFROST_ENV[network];
  if (!envName) throw new Error(`Blockfrost 不支持的钱包网络: ${network}`);
  const projectId = process.env[envName] || process.env.BLOCKFROST_PROJECT_ID || '';
  const enabled = mode === 'true' || (mode !== 'false' && projectId.length > 0);
  if (enabled && !projectId) {
    throw new Error(`已启用双源验证，但缺少 ${envName}`);
  }
  if (enabled && !projectId.startsWith(network)) {
    throw new Error(`${envName} 与钱包网络 ${network} 不匹配`);
  }
  return { enabled, projectId, envName };
}

export function dualSourceConfig(network) {
  const { enabled, envName } = resolveDualSourceConfig(network);
  return { enabled, envName };
}

export function createBlockfrostProvider(network) {
  const config = resolveDualSourceConfig(network);
  if (!config.enabled) return null;
  return new BlockfrostProvider(config.projectId);
}

async function koiosPost(provider, route, body) {
  if (!provider?._axiosInstance?.post) throw new Error('当前 provider 不支持 Koios 查询');
  try {
    const response = await provider._axiosInstance.post(route, body);
    if (!Array.isArray(response.data)) throw new Error('返回值不是数组');
    return response.data;
  } catch (error) {
    const detail = error?.response?.data?.message || error?.response?.statusText || error.message;
    throw new Error(`Koios ${route} 查询失败: ${detail}`);
  }
}

export async function fetchTipSlot(provider) {
  if (typeof provider?.fetchTipSlot === 'function') {
    const slot = await provider.fetchTipSlot();
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('provider 返回的 tip slot 无效');
    return slot;
  }
  if (!provider?._axiosInstance?.get) throw new Error('当前 provider 不支持 Koios tip 查询');
  let rows;
  try {
    const response = await provider._axiosInstance.get('/tip');
    rows = response.data;
  } catch (error) {
    const detail = error?.response?.data?.message || error?.response?.statusText || error.message;
    throw new Error(`Koios /tip 查询失败: ${detail}`);
  }
  const slot = rows?.[0]?.abs_slot;
  const valid = (typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0)
    || (typeof slot === 'string' && /^\d+$/.test(slot) && BigInt(slot) <= BigInt(Number.MAX_SAFE_INTEGER));
  if (!Array.isArray(rows) || rows.length !== 1 || !valid) {
    throw new Error('Koios 返回的 tip slot 无效，已停止构建交易');
  }
  return Number(slot);
}

export async function fetchStakingState(provider, rewardAddress) {
  const rows = await koiosPost(provider, '/account_info', { _stake_addresses: [rewardAddress] });
  if (rows.length > 1 || rows.some((row) => row?.stake_address !== rewardAddress)) {
    throw new Error('Koios 返回的质押账户信息无效，已停止质押操作');
  }
  const row = rows[0];
  if (!row) {
    return {
      registered: false, delegatedPool: null, rewardsLovelace: '0', depositLovelace: null,
    };
  }
  const registered = row.status === 'registered';
  const acceptedInactive = row.status === 'not registered' || row.status === 'not_registered';
  const rewards = row.rewards_available;
  const delegated = row.delegated_pool;
  const deposit = row.deposit;
  if ((!registered && !acceptedInactive)
    || typeof rewards !== 'string' || !/^\d+$/.test(rewards)
    || (delegated !== null && delegated !== undefined
      && (typeof delegated !== 'string' || !delegated.startsWith('pool1')))
    || (registered && (typeof deposit !== 'string' || !/^\d+$/.test(deposit)))
    || (deposit !== null && deposit !== undefined
      && (typeof deposit !== 'string' || !/^\d+$/.test(deposit)))) {
    throw new Error('Koios 返回的质押账户状态字段无效，已停止质押操作');
  }
  return {
    registered,
    delegatedPool: typeof delegated === 'string' ? delegated : null,
    rewardsLovelace: rewards,
    depositLovelace: typeof deposit === 'string' ? deposit : null,
  };
}

function displayText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
}

export async function fetchPoolInfo(provider, poolId) {
  const rows = await koiosPost(provider, '/pool_info', { _pool_bech32_ids: [poolId] });
  if (rows.some((row) => !row || typeof row.pool_id_bech32 !== 'string')) {
    throw new Error('Koios 返回的质押池信息无效，已停止质押操作');
  }
  const row = rows.find((entry) => entry.pool_id_bech32 === poolId);
  if (!row) return null;
  const meta = row.meta_json && typeof row.meta_json === 'object' && !Array.isArray(row.meta_json)
    ? row.meta_json : {};
  const numeric = (value, minimum = 0, maximum = Number.MAX_VALUE) => (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
      ? value : null
  );
  const lovelace = (value) => (typeof value === 'string' && /^\d+$/.test(value) ? value : null);
  return {
    poolId,
    ticker: displayText(meta.ticker),
    name: displayText(meta.name),
    homepage: displayText(meta.homepage),
    status: displayText(row.pool_status),
    margin: numeric(row.margin, 0, 1),
    fixedCostLovelace: lovelace(row.fixed_cost),
    liveStakeLovelace: lovelace(row.live_stake),
    // Koios reports live_saturation as a percentage (100 means saturated).
    saturation: numeric(row.live_saturation, 0, 10_000),
    retiringEpoch: Number.isSafeInteger(row.retiring_epoch) && row.retiring_epoch >= 0
      ? row.retiring_epoch : null,
  };
}

export async function fetchWalletUtxos(provider, wallet) {
  // Mesh's Koios adapter returns [] for some HTTP failures. A protocol-params
  // request first prevents an outage/auth failure from looking like zero balance.
  try { await provider.fetchProtocolParameters(); }
  catch (error) { throw new Error(`Koios 不可用: ${error.message || JSON.stringify(error)}`); }
  const lists = [];
  for (let offset = 0; offset < wallet.accounts.length; offset += 5) {
    const batch = wallet.accounts.slice(offset, offset + 5);
    lists.push(...await Promise.all(batch.map(async ({ address }) => {
      try { return await provider.fetchAddressUTxOs(address); }
      catch (error) { throw new Error(`查询 ${address} 的 UTxO 失败: ${error.message}`); }
    })));
  }
  return lists.flat();
}

export async function findNextUnusedAddress(provider, wallet, scanCount = 100) {
  const candidates = deriveReceiveAddresses(wallet, scanCount);
  try { await provider.fetchProtocolParameters(); }
  catch (error) { throw new Error(`Koios 不可用，不能可靠判断地址是否使用过: ${error.message}`); }

  const gap = Math.min(wallet.derivation?.address_pool_gap ?? 20, scanCount);
  let highestUsed = -1;
  let scanned = 0;
  for (let offset = 0; offset < candidates.length; offset += 5) {
    const batch = candidates.slice(offset, offset + 5);
    const histories = await Promise.all(batch.map(async (candidate) => {
      try {
        const transactions = await provider.fetchAddressTxs(candidate.address, { maxPage: 1, order: 'desc' });
        if (!Array.isArray(transactions)) throw new Error('返回格式无效');
        return transactions;
      } catch (error) {
        throw new Error(`查询 index ${candidate.index} 地址历史失败: ${error.message}`);
      }
    }));
    histories.forEach((transactions, index) => {
      if (transactions.length > 0) highestUsed = batch[index].index;
    });
    scanned += batch.length;
    if (scanned - highestUsed - 1 >= gap) break;
  }
  const nextIndex = highestUsed + 1;
  if (nextIndex >= candidates.length) {
    throw new Error(`扫描到的最高已用地址是 index ${highestUsed}；请提高扫描数量`);
  }
  const tracked = wallet.accounts.some((account) => account.address === candidates[nextIndex].address);
  if (!tracked) {
    throw new Error(`下一个地址 index ${nextIndex} 超出当前钱包已跟踪地址池；请扩大 gapLimit 后重新导入，禁止直接收款`);
  }
  return {
    ...candidates[nextIndex],
    highest_used_index: highestUsed,
    scanned_address_count: scanned,
  };
}

export function sumAssets(utxos) {
  const totals = new Map();
  for (const utxo of utxos) {
    for (const asset of utxo.output.amount) {
      totals.set(asset.unit, (totals.get(asset.unit) || 0n) + BigInt(asset.quantity));
    }
  }
  return [...totals.entries()]
    .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }))
    .sort((a, b) => a.unit === 'lovelace' ? -1 : b.unit === 'lovelace' ? 1 : a.unit.localeCompare(b.unit));
}

export function formatQuantity(raw, decimals, grouped = false) {
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals) : '';
  const displayWhole = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole;
  return `${negative ? '-' : ''}${displayWhole}${decimals ? `.${fraction}` : ''}`;
}

function decodeAssetName(hex) {
  if (!hex) return '';
  try {
    const text = Buffer.from(hex, 'hex').toString('utf8');
    return /^[\x20-\x7e]+$/.test(text) ? text : null;
  } catch { return null; }
}

async function registryMetadata(unit, fetchImpl) {
  const response = await fetchImpl(`https://tokens.cardano.org/metadata/${unit}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  const data = await response.json();
  return {
    name: data.name?.value,
    ticker: data.ticker?.value,
    decimals: Number.isInteger(data.decimals?.value)
      && data.decimals.value >= 0 && data.decimals.value <= 255 ? data.decimals.value : 0,
  };
}

export async function humanizeAssets(assets, network, fetchImpl = globalThis.fetch) {
  const lovelace = assets.find((asset) => asset.unit === 'lovelace')?.quantity || '0';
  const tokens = await Promise.all(assets.filter((asset) => asset.unit !== 'lovelace').map(async (asset) => {
    const policyId = asset.unit.slice(0, 56);
    const assetNameHex = asset.unit.slice(56);
    let metadata = null;
    if (network === 'mainnet') {
      try { metadata = await registryMetadata(asset.unit, fetchImpl); } catch { /* Optional display metadata. */ }
    }
    const decodedName = decodeAssetName(assetNameHex);
    const decimals = metadata?.decimals ?? 0;
    const symbol = metadata?.ticker || metadata?.name || decodedName || 'UNKNOWN';
    const quantity = formatQuantity(asset.quantity, decimals);
    return {
      name: metadata?.name || decodedName || 'Unknown token',
      ticker: metadata?.ticker || null,
      amount: `${formatQuantity(asset.quantity, decimals, true)} ${symbol}`,
      quantity,
      decimals,
      raw_quantity: asset.quantity,
      fingerprint: resolveFingerprint(policyId, assetNameHex),
      policy_id: policyId,
      asset_name: decodedName,
      asset_name_hex: assetNameHex,
      unit: asset.unit,
      metadata_source: metadata ? 'Cardano Token Registry' : null,
    };
  }));
  return {
    ada: {
      amount: `${formatQuantity(lovelace, 6, true)} ADA`,
      quantity: formatQuantity(lovelace, 6),
      lovelace,
    },
    tokens,
  };
}
