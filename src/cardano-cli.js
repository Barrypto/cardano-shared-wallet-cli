import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { serializeNativeScript } from '@meshsdk/core';

export const CARDANO_CLI_VERSION = '11.6.0.0';
const execFileAsync = promisify(execFile);
const MAX_CLI_OUTPUT = 2 * 1024 * 1024;
const CLI_TIMEOUT_MS = 20_000;
let checkedBinary;

function binaryPath() {
  return process.env.CARDANO_CLI || 'cardano-cli';
}

async function runCli(args) {
  const binary = binaryPath();
  if (checkedBinary !== binary) {
    let stdout;
    try {
      ({ stdout } = await execFileAsync(binary, ['--version'], {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: MAX_CLI_OUTPUT,
      }));
    } catch (error) {
      throw new Error(`找不到官方 cardano-cli ${CARDANO_CLI_VERSION}；请重新运行一键安装脚本（${error.message}）`);
    }
    const found = String(stdout).match(/cardano-cli\s+([0-9.]+)/)?.[1];
    if (found !== CARDANO_CLI_VERSION) {
      throw new Error(`cardano-cli 版本必须是 ${CARDANO_CLI_VERSION}，当前是 ${found || '未知版本'}`);
    }
    checkedBinary = binary;
  }
  try {
    return await execFileAsync(binary, args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_CLI_OUTPUT,
      env: { ...process.env, LC_ALL: 'C' },
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(`官方 cardano-cli 执行失败：${detail}`);
  }
}

function cliAsset(unit) {
  if (unit === 'lovelace') return 'lovelace';
  const policyId = unit.slice(0, 56);
  const assetName = unit.slice(56);
  return assetName ? `${policyId}.${assetName}` : policyId;
}

function outputArgument(output) {
  const value = output.amount
    .map(({ unit, quantity }) => `${quantity} ${cliAsset(unit)}`)
    .join('+');
  return `${output.address}+${value}`;
}

function signatureLeafCount(script) {
  if (script?.type === 'sig') return 1;
  if (Array.isArray(script?.scripts)) {
    return script.scripts.reduce((sum, child) => sum + signatureLeafCount(child), 0);
  }
  throw new Error('native script 包含不受支持的节点');
}

export function maximumWitnessCount(scripts) {
  const unique = new Map();
  for (const script of scripts) {
    const serialized = serializeNativeScript(script, undefined, 0);
    const native = CSL.NativeScript.from_hex(serialized.scriptCbor);
    unique.set(native.hash().to_hex(), script);
  }
  return [...unique.values()].reduce((sum, script) => sum + signatureLeafCount(script), 0);
}

export function minimumFeeForTransaction(txHex, params, witnessCount) {
  const minFeeA = Number(params?.minFeeA);
  const minFeeB = Number(params?.minFeeB);
  if (!Number.isSafeInteger(minFeeA) || minFeeA <= 0
    || !Number.isSafeInteger(minFeeB) || minFeeB <= 0) {
    throw new Error('协议参数 minFeeA/minFeeB 无效');
  }
  if (!Number.isSafeInteger(witnessCount) || witnessCount < 1 || witnessCount > 1000) {
    throw new Error('预计签名 witness 数量无效');
  }
  const transaction = CSL.FixedTransaction.from_hex(txHex);
  for (let index = 0; index < witnessCount; index += 1) {
    const seed = createHash('sha256').update(`csw-fee-witness-${index}`).digest();
    const key = CSL.PrivateKey.from_normal_bytes(seed);
    transaction.sign_and_add_vkey_signature(key);
  }
  return BigInt(minFeeA) * BigInt(transaction.to_bytes().length) + BigInt(minFeeB);
}

function scriptHashes(scripts) {
  return [...new Set(scripts.map((script) => {
    const serialized = serializeNativeScript(script, undefined, 0);
    return CSL.NativeScript.from_hex(serialized.scriptCbor).hash().to_hex();
  }))].sort();
}

function assertBodyMatchesRequest(txHex, {
  utxos, outputs, fee, expiresAtSlot, expectedScripts, certificateCount,
}) {
  const tx = CSL.FixedTransaction.from_hex(txHex);
  const body = tx.body();
  if (!tx.is_valid()) throw new Error('安全检查失败：cardano-cli 生成的交易 is_valid 不是 true');
  const actualInputs = new Set();
  for (let index = 0; index < body.inputs().len(); index += 1) {
    const input = body.inputs().get(index);
    actualInputs.add(`${input.transaction_id().to_hex()}#${input.index()}`);
  }
  const expectedInputs = new Set(utxos.map(({ input }) => `${input.txHash}#${input.outputIndex}`));
  if (actualInputs.size !== expectedInputs.size
    || [...expectedInputs].some((input) => !actualInputs.has(input))) {
    throw new Error('安全检查失败：cardano-cli 生成的交易输入与请求不一致');
  }
  if (body.fee().to_str() !== String(fee)) {
    throw new Error('安全检查失败：cardano-cli 生成的手续费与请求不一致');
  }
  if (body.ttl_bignum()?.to_str() !== String(expiresAtSlot)) {
    throw new Error('安全检查失败：cardano-cli 生成的 TTL 与请求不一致');
  }
  const certificates = body.certs();
  if ((certificates?.len() || 0) !== certificateCount) {
    throw new Error('安全检查失败：cardano-cli 生成的证书数量与请求不一致');
  }
  const witnesses = tx.witness_set();
  const unsupportedWitnesses = [
    witnesses.bootstraps(), witnesses.plutus_scripts(), witnesses.plutus_data(), witnesses.redeemers(),
  ];
  if (unsupportedWitnesses.some((value) => value !== undefined)) {
    throw new Error('安全检查失败：cardano-cli 生成了不受支持的 witness 类型');
  }
  const nativeScripts = witnesses.native_scripts();
  const actualScriptHashes = [];
  if (nativeScripts) {
    for (let index = 0; index < nativeScripts.len(); index += 1) {
      actualScriptHashes.push(nativeScripts.get(index).hash().to_hex());
    }
  }
  if (JSON.stringify(actualScriptHashes.sort()) !== JSON.stringify(scriptHashes(expectedScripts))) {
    throw new Error('安全检查失败：cardano-cli 生成的 native-script witness 与请求不一致');
  }
  const actualOutputs = [];
  for (let index = 0; index < body.outputs().len(); index += 1) {
    const output = body.outputs().get(index);
    const value = output.amount();
    const amount = [{ unit: 'lovelace', quantity: value.coin().to_str() }];
    const multiasset = value.multiasset();
    if (multiasset) {
      const policies = multiasset.keys();
      for (let policyIndex = 0; policyIndex < policies.len(); policyIndex += 1) {
        const policy = policies.get(policyIndex);
        const assets = multiasset.get(policy);
        const names = assets.keys();
        for (let assetIndex = 0; assetIndex < names.len(); assetIndex += 1) {
          const name = names.get(assetIndex);
          amount.push({
            unit: `${policy.to_hex()}${Buffer.from(name.name()).toString('hex')}`,
            quantity: assets.get(name).to_str(),
          });
        }
      }
    }
    actualOutputs.push({
      address: output.address().to_bech32(),
      amount: amount.sort((a, b) => a.unit.localeCompare(b.unit)),
    });
  }
  const normalizedExpected = outputs.map((output) => ({
    address: output.address,
    amount: output.amount
      .map((asset) => ({ unit: asset.unit, quantity: String(asset.quantity) }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
  }));
  if (JSON.stringify(actualOutputs) !== JSON.stringify(normalizedExpected)) {
    throw new Error('安全检查失败：cardano-cli 生成的交易输出与请求不一致');
  }
  return tx;
}

export async function buildRawTransaction({
  utxos, outputs, fee, expiresAtSlot, inputScripts, certificates = [], certificateScript,
}) {
  const directory = await mkdtemp(join(tmpdir(), 'csw-cardano-cli-'));
  try {
    const args = ['latest', 'transaction', 'build-raw'];
    for (let index = 0; index < utxos.length; index += 1) {
      const utxo = utxos[index];
      const scriptFile = join(directory, `input-${index}.script.json`);
      await writeFile(scriptFile, `${JSON.stringify(inputScripts[index], null, 2)}\n`, { mode: 0o600 });
      args.push('--tx-in', `${utxo.input.txHash}#${utxo.input.outputIndex}`,
        '--tx-in-script-file', scriptFile);
    }
    for (const output of outputs) args.push('--tx-out', outputArgument(output));
    for (let index = 0; index < certificates.length; index += 1) {
      args.push('--certificate-file', certificates[index]);
      if (certificateScript) {
        const scriptFile = join(directory, `certificate-${index}.script.json`);
        await writeFile(scriptFile, `${JSON.stringify(certificateScript, null, 2)}\n`, { mode: 0o600 });
        args.push('--certificate-script-file', scriptFile);
      }
    }
    const outputFile = join(directory, 'transaction.json');
    args.push('--fee', String(fee), '--invalid-hereafter', String(expiresAtSlot), '--out-file', outputFile);
    await runCli(args);
    const envelope = JSON.parse(await readFile(outputFile, 'utf8'));
    if (typeof envelope.cborHex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(envelope.cborHex)) {
      throw new Error('官方 cardano-cli 没有返回有效的交易 CBOR');
    }
    const txHex = envelope.cborHex.toLowerCase();
    const expectedScripts = [...inputScripts];
    if (certificateScript && certificates.length > 0) expectedScripts.push(certificateScript);
    assertBodyMatchesRequest(txHex, {
      utxos, outputs, fee, expiresAtSlot, expectedScripts, certificateCount: certificates.length,
    });
    return txHex;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createStakeCertificates({ stakeScript, poolId, keyDeposit, registered }) {
  const directory = await mkdtemp(join(tmpdir(), 'csw-cardano-cli-certs-'));
  const scriptFile = join(directory, 'stake.script.json');
  await writeFile(scriptFile, `${JSON.stringify(stakeScript, null, 2)}\n`, { mode: 0o600 });
  const certificates = [];
  try {
    if (!registered) {
      const registration = join(directory, 'registration.cert');
      await runCli([
        'latest', 'stake-address', 'registration-certificate',
        '--stake-script-file', scriptFile,
        '--key-reg-deposit-amt', String(keyDeposit),
        '--out-file', registration,
      ]);
      certificates.push(registration);
    }
    const delegation = join(directory, 'delegation.cert');
    await runCli([
      'latest', 'stake-address', 'stake-delegation-certificate',
      '--stake-script-file', scriptFile,
      '--stake-pool-id', poolId,
      '--out-file', delegation,
    ]);
    certificates.push(delegation);
    return {
      certificates,
      directory,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function networkArguments(network) {
  if (network === 'mainnet') return ['--mainnet'];
  if (network === 'preprod') return ['--testnet-magic', '1'];
  if (network === 'preview') return ['--testnet-magic', '2'];
  throw new Error(`cardano-cli 不支持钱包网络 ${network}`);
}

export async function auditWalletAddressesWithCardanoCli({ wallet, stakeScript }) {
  const directory = await mkdtemp(join(tmpdir(), 'csw-cardano-cli-addresses-'));
  try {
    const stakeFile = join(directory, 'stake.script.json');
    await writeFile(stakeFile, `${JSON.stringify(stakeScript, null, 2)}\n`, { mode: 0o600 });
    for (let index = 0; index < wallet.accounts.length; index += 1) {
      const account = wallet.accounts[index];
      const paymentFile = join(directory, `payment-${index}.script.json`);
      await writeFile(paymentFile, `${JSON.stringify(account.payment_script, null, 2)}\n`, { mode: 0o600 });
      const { stdout } = await runCli([
        'latest', 'address', 'build',
        '--payment-script-file', paymentFile,
        '--stake-script-file', stakeFile,
        ...networkArguments(wallet.network),
      ]);
      const officialAddress = String(stdout).trim();
      if (officialAddress !== account.address) {
        throw new Error(`官方 cardano-cli 地址复核失败：index ${index} 的地址不一致`);
      }
    }
    return { verified: true, addressCount: wallet.accounts.length, builder: `cardano-cli ${CARDANO_CLI_VERSION}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseJsonNumbersAsStrings(source) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    const number = source.slice(index).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      result += `"${number[0]}"`;
      index += number[0].length - 1;
    } else result += character;
  }
  return JSON.parse(result);
}

export async function auditTransactionWithCardanoCli(txHex) {
  const directory = await mkdtemp(join(tmpdir(), 'csw-cardano-cli-audit-'));
  try {
    const transactionFile = join(directory, 'transaction.json');
    await writeFile(transactionFile, `${JSON.stringify({
      type: 'Tx ConwayEra',
      description: 'Transaction audited by cardano-shared-wallet-cli',
      cborHex: txHex,
    }, null, 2)}\n`, { mode: 0o600 });
    const [{ stdout: viewOutput }, { stdout: txidOutput }] = await Promise.all([
      runCli(['debug', 'transaction', 'view', '--output-json', '--tx-file', transactionFile]),
      runCli(['latest', 'transaction', 'txid', '--tx-file', transactionFile, '--output-text']),
    ]);
    const view = parseJsonNumbersAsStrings(viewOutput);
    const transactionId = String(txidOutput).trim();
    if (!/^[0-9a-f]{64}$/.test(transactionId)) {
      throw new Error('官方 cardano-cli 没有返回有效的 transaction id');
    }
    const cslTransactionId = CSL.FixedTransaction.from_hex(txHex).transaction_hash().to_hex();
    if (transactionId !== cslTransactionId) {
      throw new Error('安全检查失败：cardano-cli 与 CSL 计算的 transaction id 不一致');
    }
    return { view, transactionId, parser: `cardano-cli ${CARDANO_CLI_VERSION}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function assertOfficialTransactionView(audit, {
  utxos, outputs, fee, expiresAtSlot, expectedScripts, certificateCount,
}) {
  const { view } = audit;
  if (view.era !== 'Conway') throw new Error('安全检查失败：cardano-cli 解析出的交易 era 不是 Conway');
  if (view.fee !== `${fee} Lovelace`) throw new Error('安全检查失败：cardano-cli 解析出的手续费不一致');
  if (view['validity range']?.['upper bound'] !== String(expiresAtSlot)) {
    throw new Error('安全检查失败：cardano-cli 解析出的 TTL 不一致');
  }
  const expectedInputs = utxos.map(({ input }) => `${input.txHash}#${input.outputIndex}`).sort();
  if (JSON.stringify([...(view.inputs || [])].sort()) !== JSON.stringify(expectedInputs)) {
    throw new Error('安全检查失败：cardano-cli 解析出的交易输入不一致');
  }
  const officialOutputs = (view.outputs || []).map((output) => {
    const amount = [];
    for (const [key, value] of Object.entries(output.amount || {})) {
      if (key === 'lovelace') amount.push({ unit: 'lovelace', quantity: String(value) });
      else {
        const policyId = key.match(/^policy ([0-9a-f]{56})$/)?.[1];
        if (!policyId || !value || typeof value !== 'object') {
          throw new Error(`cardano-cli 返回了无法识别的资产字段: ${key}`);
        }
        for (const [assetKey, quantity] of Object.entries(value)) {
          const assetName = assetKey.match(/^asset ([0-9a-f]*)(?: \(|$)/)?.[1];
          if (assetName === undefined) throw new Error(`cardano-cli 返回了无法识别的 asset name: ${assetKey}`);
          amount.push({ unit: `${policyId}${assetName}`, quantity: String(quantity) });
        }
      }
    }
    return { address: output.address, amount: amount.sort((a, b) => a.unit.localeCompare(b.unit)) };
  });
  const expectedOutputs = outputs.map((output) => ({
    address: output.address,
    amount: output.amount
      .map((asset) => ({ unit: asset.unit, quantity: String(asset.quantity) }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
  }));
  if (JSON.stringify(officialOutputs) !== JSON.stringify(expectedOutputs)) {
    throw new Error('安全检查失败：cardano-cli 解析出的输出地址、资产或数量不一致');
  }
  const officialScripts = (view.scripts || []).map((script) => script['script hash']).sort();
  if (JSON.stringify(officialScripts) !== JSON.stringify(scriptHashes(expectedScripts))) {
    throw new Error('安全检查失败：cardano-cli 解析出的 native scripts 不一致');
  }
  const officialCertificateCount = Array.isArray(view.certificates) ? view.certificates.length : 0;
  if (officialCertificateCount !== certificateCount) {
    throw new Error('安全检查失败：cardano-cli 解析出的证书数量不一致');
  }
  return true;
}
