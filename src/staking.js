import {
  deserializePoolId, resolvePoolId,
} from '@meshsdk/core';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { buildOfficialTransaction } from './builder.js';
import { CARDANO_CLI_VERSION, createStakeCertificates } from './cardano-cli.js';
import {
  dualSourceConfig, fetchPoolInfo, fetchStakingState, fetchTipSlot,
} from './provider.js';
import { accountRuntime, stakeRuntime } from './wallet.js';

const MAX_FEE_LOVELACE = 5_000_000n;
const TRANSACTION_TTL_SLOTS = 3600;

export function normalizePoolId(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('需要 Pool ID');
  try {
    if (/^[0-9a-fA-F]{56}$/.test(raw)) return resolvePoolId(raw.toLowerCase());
    if (!raw.startsWith('pool1')) throw new Error('前缀错误');
    return resolvePoolId(deserializePoolId(raw));
  } catch {
    throw new Error('Pool ID 必须是有效的 pool1... bech32 或 56 位十六进制');
  }
}

export async function inspectStakeDelegation({ wallet, provider, poolId }) {
  const canonicalPoolId = normalizePoolId(poolId);
  const stake = stakeRuntime(wallet);
  const [state, pool] = await Promise.all([
    fetchStakingState(provider, stake.rewardAddress),
    fetchPoolInfo(provider, canonicalPoolId),
  ]);
  if (!pool) throw new Error(`Koios 找不到质押池 ${canonicalPoolId}`);
  return {
    pool,
    stake: {
      rewardAddress: stake.rewardAddress,
      scriptHash: stake.scriptHash,
      signingPath: stake.signingPath,
      registered: state.registered,
      currentPool: state.delegatedPool,
      rewardsLovelace: state.rewardsLovelace,
      depositLovelace: state.depositLovelace,
    },
    action: state.registered ? 'delegate' : 'register-and-delegate',
    alreadyDelegated: state.registered && state.delegatedPool === canonicalPoolId,
  };
}

function sumAssets(items, output = false) {
  const totals = new Map();
  for (const item of items) {
    const amounts = output ? item.amount : item.output.amount;
    for (const asset of amounts) {
      totals.set(asset.unit, (totals.get(asset.unit) || 0n) + BigInt(asset.quantity));
    }
  }
  return totals;
}

function auditValue(utxos, outputs, fee, deposit) {
  const inputs = sumAssets(utxos);
  const outputTotals = sumAssets(outputs, true);
  for (const unit of new Set([...inputs.keys(), ...outputTotals.keys()])) {
    const expected = inputs.get(unit) || 0n;
    const actual = (outputTotals.get(unit) || 0n)
      + (unit === 'lovelace' ? BigInt(fee) + BigInt(deposit) : 0n);
    if (expected !== actual) {
      throw new Error(`安全检查失败：${unit} 不守恒（输入 ${expected}，输出、手续费及押金 ${actual}）`);
    }
  }
}

export async function buildStakeDelegation({
  wallet,
  provider,
  utxos,
  poolId,
  chainContext,
  stakingState,
  poolInfo,
  dualSource,
}) {
  if (!Array.isArray(utxos) || utxos.length === 0) throw new Error('钱包没有可用于支付手续费的 UTxO');
  if (utxos.length > 80) throw new Error(`钱包有 ${utxos.length} 个 UTxO；轻量 MVP 不会一次消费超过 80 个 UTxO`);
  if (dualSourceConfig(wallet.network).enabled
    && chainContext?.sourceVerification !== 'koios+blockfrost') {
    throw new Error('当前网络已启用严格双源验证，但缺少通过核验的链状态快照');
  }
  const canonicalPoolId = normalizePoolId(poolId);
  let inspection;
  let params;
  let tipSlot;
  if (chainContext || stakingState || poolInfo) {
    if (!chainContext || !stakingState || !poolInfo) {
      throw new Error('质押构建快照不完整，已停止交易');
    }
    const runtime = stakeRuntime(wallet);
    inspection = {
      pool: poolInfo,
      stake: {
        rewardAddress: runtime.rewardAddress,
        scriptHash: runtime.scriptHash,
        signingPath: runtime.signingPath,
        registered: stakingState.registered,
        currentPool: stakingState.delegatedPool,
        rewardsLovelace: stakingState.rewardsLovelace,
        depositLovelace: stakingState.depositLovelace,
      },
      action: stakingState.registered ? 'delegate' : 'register-and-delegate',
      alreadyDelegated: stakingState.registered && stakingState.delegatedPool === canonicalPoolId,
    };
    ({ params, tipSlot } = chainContext);
  } else {
    [inspection, params, tipSlot] = await Promise.all([
      inspectStakeDelegation({ wallet, provider, poolId: canonicalPoolId }),
      provider.fetchProtocolParameters(),
      fetchTipSlot(provider),
    ]);
  }
  if (tipSlot > Number.MAX_SAFE_INTEGER - TRANSACTION_TTL_SLOTS) {
    throw new Error('链上 tip slot 超出本工具的安全整数范围');
  }
  const expiresAtSlot = tipSlot + TRANSACTION_TTL_SLOTS;
  if (!inspection.pool.status) throw new Error('Koios 未返回可靠的质押池状态，已停止构建');
  if (inspection.pool.status !== 'registered') {
    const retiring = inspection.pool.retiringEpoch === null
      ? '' : `（退役 epoch ${inspection.pool.retiringEpoch}）`;
    throw new Error(`质押池当前状态为 ${inspection.pool.status}${retiring}，拒绝构建委托`);
  }
  if (inspection.alreadyDelegated) throw new Error('当前钱包已经委托给这个质押池，无需重复构建');

  const keyDeposit = params?.keyDeposit;
  if (!Number.isSafeInteger(keyDeposit) || keyDeposit < 0 || keyDeposit > 1_000_000_000) {
    throw new Error('Koios 返回的 stake key deposit 协议参数无效，已停止构建');
  }
  const accounts = accountRuntime(wallet);
  const stake = stakeRuntime(wallet);
  if (!accounts.has(wallet.change_address)) throw new Error('安全检查失败：找零地址不属于当前钱包');

  for (const utxo of utxos) {
    if (!accounts.has(utxo.output.address)) {
      throw new Error(`provider 返回了钱包描述之外的地址: ${utxo.output.address}`);
    }
  }
  const deposit = inspection.stake.registered ? 0n : BigInt(keyDeposit);
  const certificateBundle = await createStakeCertificates({
    stakeScript: stake.script,
    poolId: inspection.pool.poolId,
    keyDeposit,
    registered: inspection.stake.registered,
  });
  let built;
  try {
    built = await buildOfficialTransaction({
      wallet,
      params,
      utxos,
      expiresAtSlot,
      deposit,
      extraWitnessScripts: [stake.script],
      certificates: certificateBundle.certificates,
      certificateScript: stake.script,
    });
  } finally {
    await certificateBundle.cleanup();
  }
  const { txHex, outputs } = built;
  if (!Array.isArray(outputs) || outputs.length === 0
    || outputs.some((output) => output.address !== wallet.change_address)) {
    throw new Error('安全检查失败：质押交易只能找零回当前钱包');
  }
  const fee = built.fee;
  if (fee <= 0n || fee > MAX_FEE_LOVELACE) {
    throw new Error(`安全检查失败：手续费 ${fee} lovelace 超出允许范围`);
  }
  auditValue(utxos, outputs, fee, deposit);

  const tx = CSL.Transaction.from_hex(txHex);
  const certificates = tx.body().certs();
  const expectedCertificateCount = inspection.stake.registered ? 1 : 2;
  if (!certificates || certificates.len() !== expectedCertificateCount) {
    throw new Error('安全检查失败：质押证书数量与预期不一致');
  }
  const expectedStakeHash = stake.scriptHash;
  if (!inspection.stake.registered) {
    const registration = certificates.get(0).as_stake_registration();
    if (!registration
      || registration.stake_credential().to_scripthash()?.to_hex() !== expectedStakeHash) {
      throw new Error('安全检查失败：注册证书的质押凭证与当前钱包不一致');
    }
  }
  const delegation = certificates.get(certificates.len() - 1).as_stake_delegation();
  if (!delegation
    || delegation.stake_credential().to_scripthash()?.to_hex() !== expectedStakeHash
    || resolvePoolId(delegation.pool_keyhash().to_hex()) !== inspection.pool.poolId) {
    throw new Error('安全检查失败：委托证书的质押凭证或 Pool ID 不一致');
  }

  return {
    txHex,
    fee: fee.toString(),
    deposit: deposit.toString(),
    inputs: utxos.map(({ input }) => ({ ...input })),
    outputs,
    changeAddress: wallet.change_address,
    rewardAddress: stake.rewardAddress,
    stakeScriptHash: stake.scriptHash,
    stakeSigningPath: stake.signingPath,
    action: inspection.action,
    pool: inspection.pool,
    previousPool: inspection.stake.currentPool,
    tipSlot,
    expiresAtSlot,
    validitySeconds: TRANSACTION_TTL_SLOTS,
    builder: `cardano-cli ${CARDANO_CLI_VERSION}`,
    officialCrossCheck: {
      parser: built.officialAudit.parser,
      transactionId: built.officialAudit.transactionId,
    },
    dualSource,
  };
}
