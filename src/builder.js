import { deserializeAddress, getOutputMinLovelace, serializeNativeScript } from '@meshsdk/core';
import {
  assertOfficialTransactionView, auditTransactionWithCardanoCli, buildRawTransaction,
  CARDANO_CLI_VERSION, maximumWitnessCount, minimumFeeForTransaction,
} from './cardano-cli.js';
import { accountRuntime } from './wallet.js';
import { dualSourceConfig, fetchTipSlot } from './provider.js';

const MAX_FEE_LOVELACE = 5_000_000n;
const TRANSACTION_TTL_SLOTS = 3600;

function normalizeAsset(asset) {
  if (!asset || typeof asset.unit !== 'string' || !/^-?\d+$/.test(String(asset.quantity))) {
    throw new Error('asset 必须包含 unit 和整数 quantity');
  }
  if (asset.unit !== 'lovelace'
    && (!/^[0-9a-f]+$/.test(asset.unit) || asset.unit.length < 56 || asset.unit.length > 120
      || asset.unit.length % 2 !== 0)) {
    throw new Error(`asset unit 无效: ${asset.unit}`);
  }
  const quantity = BigInt(asset.quantity);
  if (quantity <= 0n) throw new Error('输出 asset quantity 必须大于 0');
  return { unit: asset.unit, quantity: quantity.toString() };
}

function validateOutputAddress(address, network) {
  if (typeof address !== 'string' || !address.trim()) throw new Error('payment 缺少 address');
  const mainnet = address.startsWith('addr1');
  const testnet = address.startsWith('addr_test1');
  if ((network === 'mainnet' && !mainnet) || (network !== 'mainnet' && !testnet)) {
    throw new Error(`收款地址与 ${network} 网络不匹配: ${address}`);
  }
  try { deserializeAddress(address); }
  catch (error) { throw new Error(`收款地址无效: ${error.message}`); }
  return address;
}

export function normalizePayment(payment, network) {
  if (!payment || typeof payment.address !== 'string') throw new Error('payment 缺少 address');
  const address = network ? validateOutputAddress(payment.address, network) : payment.address;
  if (!Array.isArray(payment.amount) || payment.amount.length === 0) {
    throw new Error('payment.amount 必须是非空资产数组');
  }
  const normalized = payment.amount.map(normalizeAsset);
  const units = new Set();
  for (const asset of normalized) {
    if (units.has(asset.unit)) throw new Error(`同一输出包含重复 asset unit: ${asset.unit}`);
    units.add(asset.unit);
  }
  return { address, amount: normalized };
}

function ensureMinimumAda(payment, params) {
  const coinsPerUtxoSize = Number(params?.coinsPerUtxoSize);
  if (!Number.isSafeInteger(coinsPerUtxoSize) || coinsPerUtxoSize <= 0) {
    throw new Error('协议参数 coinsPerUtxoSize 无效');
  }
  const amount = payment.amount.map((asset) => ({ ...asset }));
  const lovelaceIndex = amount.findIndex((asset) => asset.unit === 'lovelace');
  const minimum = getOutputMinLovelace({ address: payment.address, amount }, coinsPerUtxoSize);
  if (lovelaceIndex < 0) amount.unshift({ unit: 'lovelace', quantity: minimum.toString() });
  else if (BigInt(amount[lovelaceIndex].quantity) < minimum) {
    throw new Error(`该输出至少需要 ${minimum} lovelace；请提高 ADA 数量或直接跳过 ADA 让程序自动添加`);
  }
  return { address: payment.address, amount };
}

function totalAssets(utxos) {
  const totals = new Map();
  for (const utxo of utxos) {
    for (const asset of utxo.output.amount) {
      totals.set(asset.unit, (totals.get(asset.unit) || 0n) + BigInt(asset.quantity));
    }
  }
  return totals;
}

function subtract(totals, unit, quantity, label) {
  const remaining = (totals.get(unit) || 0n) - BigInt(quantity);
  if (remaining < 0n) throw new Error(`${label}不足：${unit} 还差 ${-remaining}`);
  totals.set(unit, remaining);
}

function makeOutputs({ utxos, payments, changeAddress, fee, deposit = 0n, sendAllTo, params }) {
  const remaining = totalAssets(utxos);
  subtract(remaining, 'lovelace', BigInt(fee) + BigInt(deposit), 'ADA');
  if (sendAllTo) {
    const amount = [...remaining.entries()]
      .filter(([, quantity]) => quantity > 0n)
      .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
    if (!amount.some((asset) => asset.unit === 'lovelace')) throw new Error('全部发送后没有足够 ADA 支付手续费');
    return [{ address: sendAllTo, amount }];
  }
  for (const payment of payments) {
    for (const asset of payment.amount) subtract(remaining, asset.unit, asset.quantity, '钱包余额');
  }
  const changeAmount = [...remaining.entries()]
    .filter(([, quantity]) => quantity > 0n)
    .map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
  if (changeAmount.length === 0) return payments.map((payment) => structuredClone(payment));
  const lovelace = BigInt(changeAmount.find((asset) => asset.unit === 'lovelace')?.quantity || 0);
  const minimum = getOutputMinLovelace({ address: changeAddress, amount: changeAmount }, Number(params.coinsPerUtxoSize));
  if (lovelace < minimum) {
    throw new Error(`找零至少需要 ${minimum} lovelace，当前仅 ${lovelace}；请减少发送金额或使用全部发送`);
  }
  return [...payments.map((payment) => structuredClone(payment)), {
    address: changeAddress,
    amount: changeAmount,
  }];
}

function auditValueConservation(utxos, outputs, fee, deposit = 0n) {
  const inputs = totalAssets(utxos);
  const outputTotals = new Map();
  for (const output of outputs) {
    for (const asset of output.amount) {
      outputTotals.set(asset.unit, (outputTotals.get(asset.unit) || 0n) + BigInt(asset.quantity));
    }
  }
  for (const unit of new Set([...inputs.keys(), ...outputTotals.keys()])) {
    const expected = inputs.get(unit) || 0n;
    const actual = (outputTotals.get(unit) || 0n)
      + (unit === 'lovelace' ? BigInt(fee) + BigInt(deposit) : 0n);
    if (actual !== expected) {
      throw new Error(`安全检查失败：${unit} 不守恒（输入 ${expected}，输出、手续费及押金 ${actual}）`);
    }
  }
}

function auditFee(fee) {
  const value = BigInt(fee);
  if (value <= 0n || value > MAX_FEE_LOVELACE) {
    throw new Error(`安全检查失败：手续费 ${value} lovelace 超出允许范围 1..${MAX_FEE_LOVELACE}`);
  }
}

export async function buildOfficialTransaction({
  wallet, params, utxos, payments = [], sendAllTo, expiresAtSlot,
  deposit = 0n, extraWitnessScripts = [], certificates = [], certificateScript,
}) {
  const accounts = accountRuntime(wallet);
  const inputScripts = utxos.map((utxo) => {
    const account = accounts.get(utxo.output.address);
    if (!account) throw new Error(`provider 返回了钱包描述之外的地址: ${utxo.output.address}`);
    return account.payment_script;
  });
  const witnessScripts = [...inputScripts, ...extraWitnessScripts];
  for (const script of witnessScripts) {
    serializeNativeScript(script, undefined, wallet.network === 'mainnet' ? 1 : 0);
  }
  const witnessCount = maximumWitnessCount(witnessScripts);
  let fee = 200_000n;
  let txHex;
  let outputs;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    outputs = makeOutputs({
      utxos, payments, changeAddress: wallet.change_address, fee, deposit, sendAllTo, params,
    });
    txHex = await buildRawTransaction({
      utxos, outputs, fee, expiresAtSlot, inputScripts, certificates, certificateScript,
    });
    const requiredFee = minimumFeeForTransaction(txHex, params, witnessCount);
    if (requiredFee === fee) break;
    fee = requiredFee;
    txHex = undefined;
  }
  if (!txHex) throw new Error('官方 cardano-cli 手续费计算未能收敛');
  const officialAudit = await auditTransactionWithCardanoCli(txHex);
  assertOfficialTransactionView(officialAudit, {
    utxos,
    outputs,
    fee,
    expiresAtSlot,
    expectedScripts: witnessScripts,
    certificateCount: certificates.length,
  });
  auditFee(fee);
  auditValueConservation(utxos, outputs, fee, deposit);
  return { txHex, fee, outputs, witnessCount, officialAudit };
}

export async function buildTransaction({
  wallet, provider, utxos, payments, sendAllTo, chainContext, dualSource,
}) {
  if (utxos.length === 0) throw new Error('钱包没有可用 UTxO');
  if (utxos.length > 80) throw new Error(`钱包有 ${utxos.length} 个 UTxO；轻量版不会一次消费超过 80 个 UTxO`);
  const accounts = accountRuntime(wallet);
  if (!accounts.has(wallet.change_address)) throw new Error('安全检查失败：找零地址不属于当前钱包');
  if (dualSourceConfig(wallet.network).enabled
    && chainContext?.sourceVerification !== 'koios+blockfrost') {
    throw new Error('当前网络已启用严格双源验证，但缺少通过核验的链状态快照');
  }
  const resolvedContext = chainContext || await (async () => {
    const [params, tipSlot] = await Promise.all([
      provider.fetchProtocolParameters(), fetchTipSlot(provider),
    ]);
    return { params, tipSlot };
  })();
  const { params, tipSlot } = resolvedContext;
  if (tipSlot > Number.MAX_SAFE_INTEGER - TRANSACTION_TTL_SLOTS) {
    throw new Error('链上 tip slot 超出本工具的安全整数范围');
  }
  const expiresAtSlot = tipSlot + TRANSACTION_TTL_SLOTS;
  if (sendAllTo && payments?.length) throw new Error('全部发送不能同时指定普通 payment');
  const destination = sendAllTo ? validateOutputAddress(sendAllTo, wallet.network) : undefined;
  const normalizedPayments = destination ? [] : payments
    .map((payment) => normalizePayment(payment, wallet.network))
    .map((payment) => ensureMinimumAda(payment, params));
  const built = await buildOfficialTransaction({
    wallet, params, utxos, payments: normalizedPayments,
    sendAllTo: destination, expiresAtSlot,
  });
  const requestedAddresses = new Set(normalizedPayments.map(({ address }) => address));
  const changeOutputCount = destination ? 0 : built.outputs.filter((output) => (
    output.address === wallet.change_address && !requestedAddresses.has(output.address)
  )).length;
  return {
    txHex: built.txHex,
    fee: built.fee.toString(),
    inputs: utxos.map(({ input }) => ({ ...input })),
    outputs: built.outputs,
    changeAddress: wallet.change_address,
    changeOutputCount,
    sendAll: Boolean(destination),
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
