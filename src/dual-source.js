import {
  createBlockfrostProvider, dualSourceConfig, fetchPoolInfo, fetchStakingState, fetchTipSlot,
} from './provider.js';
import { normalizePoolId } from './staking.js';
import { stakeRuntime } from './wallet.js';

const MAX_TIP_DIFFERENCE = 180;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function assetMap(amounts, source) {
  if (!Array.isArray(amounts) || amounts.length === 0) {
    throw new Error(`${source} 返回的 UTxO 资产列表无效`);
  }
  const values = new Map();
  for (const asset of amounts) {
    const unit = asset?.unit;
    const quantity = asset?.quantity;
    if (typeof unit !== 'string'
      || (unit !== 'lovelace' && (!/^[0-9a-f]{56,120}$/.test(unit) || unit.length % 2 !== 0))
      || typeof quantity !== 'string' || !/^\d+$/.test(quantity) || BigInt(quantity) <= 0n
      || values.has(unit)) {
      throw new Error(`${source} 返回了无效或重复的资产`);
    }
    values.set(unit, quantity);
  }
  if (!values.has('lovelace')) throw new Error(`${source} UTxO 缺少 lovelace`);
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function canonicalUtxos(utxos, walletAddresses, source) {
  if (!Array.isArray(utxos)) throw new Error(`${source} UTxO 返回格式无效`);
  const seen = new Set();
  return utxos.map((utxo) => {
    const txHash = utxo?.input?.txHash;
    const outputIndex = utxo?.input?.outputIndex;
    const address = utxo?.output?.address;
    if (typeof txHash !== 'string' || !/^[0-9a-f]{64}$/.test(txHash)
      || !Number.isSafeInteger(outputIndex) || outputIndex < 0
      || typeof address !== 'string' || !walletAddresses.has(address)) {
      throw new Error(`${source} 返回了无效或不属于当前钱包的 UTxO`);
    }
    const ref = `${txHash}#${outputIndex}`;
    if (seen.has(ref)) throw new Error(`${source} 返回了重复 UTxO: ${ref}`);
    seen.add(ref);
    return { ref, address, amount: assetMap(utxo.output.amount, source) };
  }).sort((left, right) => left.ref.localeCompare(right.ref));
}

function rawBlockfrostUtxo(row, expectedAddress) {
  if (row?.address !== expectedAddress) {
    throw new Error('Blockfrost 返回了查询地址之外的 UTxO');
  }
  return {
    input: { txHash: row?.tx_hash, outputIndex: row?.output_index },
    output: { address: row?.address, amount: row?.amount },
  };
}

async function blockfrostGet(provider, path, allowNotFound = false) {
  if (!provider?._axiosInstance?.get) throw new Error('Blockfrost provider 不支持严格读取');
  try {
    const response = await provider._axiosInstance.get(path);
    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    if (allowNotFound && status === 404) return null;
    throw new Error(`Blockfrost ${path.split('?')[0]} 查询失败${status ? ` (HTTP ${status})` : ''}`);
  }
}

async function safeBlockfrostCall(label, operation) {
  try { return await operation(); }
  catch { throw new Error(`Blockfrost ${label} 查询失败`); }
}

async function fetchBlockfrostUtxos(provider, wallet) {
  const rows = [];
  for (let offset = 0; offset < wallet.accounts.length; offset += 5) {
    const batch = wallet.accounts.slice(offset, offset + 5);
    const lists = await Promise.all(batch.map(async ({ address }) => {
      const found = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const data = await blockfrostGet(
          provider,
          `addresses/${address}/utxos?page=${page}&count=${PAGE_SIZE}&order=asc`,
        );
        if (!Array.isArray(data) || data.length > PAGE_SIZE) {
          throw new Error('Blockfrost UTxO 分页格式无效');
        }
        found.push(...data.map((row) => rawBlockfrostUtxo(row, address)));
        if (data.length < PAGE_SIZE) return found;
      }
      throw new Error(`Blockfrost 地址 ${address} 的 UTxO 超过安全分页上限`);
    }));
    rows.push(...lists.flat());
  }
  return rows;
}

const PROTOCOL_KEYS = [
  'minFeeA', 'minFeeB', 'maxTxSize', 'keyDeposit', 'poolDeposit',
  'coinsPerUtxoSize', 'maxValSize', 'collateralPercent', 'maxCollateralInputs',
];

function validateProtocol(params, source) {
  if (!params || typeof params !== 'object') throw new Error(`${source} 协议参数无效`);
  const result = {};
  for (const key of PROTOCOL_KEYS) {
    const value = params[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${source} 协议参数 ${key} 无效`);
    }
    result[key] = value;
  }
  return result;
}

function compareJson(left, right, message) {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(message);
}

async function fetchBlockfrostStakeState(provider, rewardAddress) {
  const data = await blockfrostGet(provider, `accounts/${rewardAddress}`, true);
  if (data === null) {
    return { registered: false, delegatedPool: null, rewardsLovelace: '0' };
  }
  if (data?.stake_address !== rewardAddress || typeof data.active !== 'boolean'
    || typeof data.withdrawable_amount !== 'string' || !/^\d+$/.test(data.withdrawable_amount)
    || (data.pool_id !== null && data.pool_id !== undefined
      && (typeof data.pool_id !== 'string' || !data.pool_id.startsWith('pool1')))) {
    throw new Error('Blockfrost 返回的质押账户状态无效');
  }
  return {
    registered: data.active,
    delegatedPool: typeof data.pool_id === 'string' ? data.pool_id : null,
    rewardsLovelace: data.withdrawable_amount,
  };
}

async function fetchBlockfrostPoolState(provider, poolId) {
  const data = await blockfrostGet(provider, `pools/${poolId}`, true);
  if (data === null) return null;
  if (data?.pool_id !== poolId || typeof data.active !== 'boolean'
    || typeof data.retired !== 'boolean'
    || (data.retiring_epoch !== null && data.retiring_epoch !== undefined
      && (!Number.isSafeInteger(data.retiring_epoch) || data.retiring_epoch < 0))) {
    throw new Error('Blockfrost 返回的质押池状态无效');
  }
  const status = data.retired ? 'retired'
    : data.retiring_epoch !== null && data.retiring_epoch !== undefined ? 'retiring'
      : data.active ? 'registered' : 'inactive';
  return { status, retiringEpoch: data.retiring_epoch ?? null };
}

export async function prepareChainSnapshot({
  wallet,
  koiosProvider,
  koiosUtxos,
  poolId,
  includeStaking = false,
  blockfrostProvider,
}) {
  const canonicalPoolId = poolId === undefined ? undefined : normalizePoolId(poolId);
  const stake = includeStaking ? stakeRuntime(wallet) : null;
  const [koiosParams, koiosTip, koiosStake, koiosPool] = await Promise.all([
    koiosProvider.fetchProtocolParameters(),
    fetchTipSlot(koiosProvider),
    includeStaking ? fetchStakingState(koiosProvider, stake.rewardAddress) : null,
    canonicalPoolId ? fetchPoolInfo(koiosProvider, canonicalPoolId) : null,
  ]);
  const config = blockfrostProvider
    ? { enabled: true }
    : dualSourceConfig(wallet.network);
  if (!config.enabled) {
    return {
      chainContext: { params: koiosParams, tipSlot: koiosTip, sourceVerification: 'koios' },
      stakingState: koiosStake,
      poolInfo: koiosPool,
      dualSource: { enabled: false, verified: false },
    };
  }

  const secondary = blockfrostProvider || createBlockfrostProvider(wallet.network);
  const [blockfrostUtxos, blockfrostParams, latestBlock, blockfrostStake, blockfrostPool] = await Promise.all([
    fetchBlockfrostUtxos(secondary, wallet),
    safeBlockfrostCall('协议参数', () => secondary.fetchProtocolParameters()),
    safeBlockfrostCall('最新区块', () => secondary.fetchLatestBlock()),
    includeStaking ? fetchBlockfrostStakeState(secondary, stake.rewardAddress) : null,
    canonicalPoolId ? fetchBlockfrostPoolState(secondary, canonicalPoolId) : null,
  ]);
  const blockfrostTip = Number(latestBlock?.slot);
  if (!Number.isSafeInteger(blockfrostTip) || blockfrostTip < 0) {
    throw new Error('Blockfrost 返回的 tip slot 无效');
  }
  const walletAddresses = new Set(wallet.accounts.map((account) => account.address));
  compareJson(
    canonicalUtxos(koiosUtxos, walletAddresses, 'Koios'),
    canonicalUtxos(blockfrostUtxos, walletAddresses, 'Blockfrost'),
    'Koios 与 Blockfrost 的完整 UTxO 集不一致，已停止交易',
  );
  compareJson(
    validateProtocol(koiosParams, 'Koios'),
    validateProtocol(blockfrostParams, 'Blockfrost'),
    'Koios 与 Blockfrost 的交易关键协议参数不一致，已停止交易',
  );
  const tipDifference = Math.abs(koiosTip - blockfrostTip);
  if (tipDifference > MAX_TIP_DIFFERENCE) {
    throw new Error(`Koios 与 Blockfrost 的 tip 相差 ${tipDifference} slots，已停止交易`);
  }

  if (includeStaking) {
    compareJson(
      {
        registered: koiosStake.registered,
        delegatedPool: koiosStake.delegatedPool,
        rewardsLovelace: koiosStake.rewardsLovelace,
      },
      blockfrostStake,
      'Koios 与 Blockfrost 的质押账户状态不一致，已停止交易',
    );
    if (koiosStake.registered
      && koiosStake.depositLovelace !== String(koiosParams.keyDeposit)) {
      throw new Error('Koios 质押押金与当前双源协议参数不一致，已停止交易');
    }
  }
  if (canonicalPoolId) {
    if (!koiosPool || !blockfrostPool
      || koiosPool.status !== blockfrostPool.status
      || koiosPool.retiringEpoch !== blockfrostPool.retiringEpoch) {
      throw new Error('Koios 与 Blockfrost 的目标质押池状态不一致，已停止交易');
    }
  }

  return {
    chainContext: {
      params: koiosParams,
      tipSlot: Math.max(koiosTip, blockfrostTip),
      sourceVerification: 'koios+blockfrost',
    },
    stakingState: koiosStake,
    poolInfo: koiosPool,
    dualSource: {
      enabled: true,
      verified: true,
      koiosTip,
      blockfrostTip,
      tipDifference,
      utxoCount: koiosUtxos.length,
    },
  };
}
