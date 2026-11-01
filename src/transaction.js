import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { resolvePoolId, serializeNativeScript } from '@meshsdk/core';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { stakeRuntime } from './wallet.js';

export const MAX_TRANSACTION_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_SOURCE_BYTES = MAX_TRANSACTION_BYTES * 3;

function enforceTransactionSize(hex) {
  const bytes = hex.length / 2;
  if (bytes > MAX_TRANSACTION_BYTES) {
    throw new Error(`交易 CBOR 超过 ${MAX_TRANSACTION_BYTES} 字节安全上限`);
  }
  return hex;
}

export function adaToLovelace(value) {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) {
    throw new Error(`ADA 数量无效: ${value}（最多 6 位小数）`);
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('数量超过本 CLI 可安全编码的 JSON 整数范围');
  }
  return Number(amount);
}

export function normalizeTransaction(value) {
  const input = value.trim();
  if (!input) throw new Error('交易内容为空');

  if (input.startsWith('{')) {
    const parsed = JSON.parse(input);
    const nested = parsed.cborHex ?? parsed.transaction ?? parsed.cbor ?? parsed.base64;
    if (typeof nested !== 'string') throw new Error('JSON 中找不到 cborHex 或 transaction');
    return normalizeTransaction(nested);
  }

  if (/^(?:[0-9a-fA-F]{2})+$/.test(input)) {
    return enforceTransactionSize(input.toLowerCase());
  }

  const buffer = Buffer.from(input, 'base64');
  if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) {
    throw new Error('交易必须是 CBOR hex、base64 或包含 cborHex/transaction 的 JSON');
  }
  return enforceTransactionSize(buffer.toString('hex'));
}

export async function readTransaction(source) {
  if (source === '-') {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_TEXT_SOURCE_BYTES) throw new Error('标准输入中的交易文件超过安全上限');
      chunks.push(chunk);
    }
    return normalizeTransaction(Buffer.concat(chunks).toString('utf8'));
  }
  const metadata = await stat(source);
  if (metadata.size > MAX_TEXT_SOURCE_BYTES) throw new Error('交易文件超过安全上限');
  const bytes = await readFile(source);
  if (extname(source).toLowerCase() === '.cbor') return enforceTransactionSize(bytes.toString('hex'));
  return normalizeTransaction(bytes.toString('utf8'));
}

export async function exportTransaction(hex, outputPrefix, era = 'ConwayEra') {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length === 0) throw new Error('cardano-wallet 返回了空交易');
  await mkdir(dirname(outputPrefix), { recursive: true });

  const files = {
    cbor: `${outputPrefix}.cbor`,
    hex: `${outputPrefix}.hex`,
    base64: `${outputPrefix}.base64`,
    envelope: `${outputPrefix}.json`,
  };
  await Promise.all([
    writeFile(files.cbor, bytes),
    writeFile(files.hex, `${bytes.toString('hex')}\n`, 'utf8'),
    writeFile(files.base64, `${bytes.toString('base64')}\n`, 'utf8'),
    writeFile(files.envelope, `${JSON.stringify({
      type: `Unwitnessed Tx ${era}`,
      description: 'Unsigned shared-wallet transaction constructed by csw',
      cborHex: bytes.toString('hex'),
    }, null, 2)}\n`, 'utf8'),
  ]);
  return files;
}

export function transactionStakeContext(txHex) {
  let tx;
  try { tx = CSL.FixedTransaction.from_hex(txHex); }
  catch (error) { throw new Error(`交易 CBOR 无法解析: ${error.message}`); }
  const certs = tx.body().certs();
  if (!certs || certs.len() === 0) return { hasCertificates: false, poolId: undefined };
  let poolId;
  for (let index = 0; index < certs.len(); index += 1) {
    const delegation = certs.get(index).as_stake_delegation();
    if (delegation) {
      const found = resolvePoolId(delegation.pool_keyhash().to_hex());
      if (poolId && poolId !== found) throw new Error('交易包含多个不同的质押池');
      poolId = found;
    }
  }
  return { hasCertificates: true, poolId };
}

function scriptSatisfied(script, validKeyHashes) {
  if (script?.type === 'sig') return validKeyHashes.has(script.keyHash);
  if (script?.type === 'all') return script.scripts.every((child) => scriptSatisfied(child, validKeyHashes));
  if (script?.type === 'any') return script.scripts.some((child) => scriptSatisfied(child, validKeyHashes));
  if (script?.type === 'atLeast') {
    return script.scripts.filter((child) => scriptSatisfied(child, validKeyHashes)).length >= script.required;
  }
  return false;
}

function sameOptionalBytes(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function nativeScriptHashes(witnesses) {
  const scripts = witnesses.native_scripts();
  const hashes = [];
  if (scripts) {
    for (let index = 0; index < scripts.len(); index += 1) hashes.push(scripts.get(index).hash().to_hex());
  }
  return hashes.sort();
}

function rejectUnsupportedWitnesses(witnesses) {
  const unsupported = [
    ['bootstrap witnesses', witnesses.bootstraps()],
    ['Plutus scripts', witnesses.plutus_scripts()],
    ['Plutus data', witnesses.plutus_data()],
    ['redeemers', witnesses.redeemers()],
  ];
  const found = unsupported.find(([, value]) => value !== undefined);
  if (found) throw new Error(`签名交易包含当前工具不支持的 ${found[0]}`);
}

export function verifySignedTransaction({ signedHex, unsignedHex, wallet, utxos, currentSlot }) {
  let signed;
  let unsigned;
  try {
    signed = CSL.FixedTransaction.from_hex(signedHex);
    unsigned = CSL.FixedTransaction.from_hex(unsignedHex);
  } catch (error) {
    throw new Error(`交易 CBOR 无法解析: ${error.message}`);
  }
  if (!Buffer.from(signed.raw_body()).equals(Buffer.from(unsigned.raw_body()))) {
    throw new Error('签名交易的 transaction body 与本机原始未签名交易不一致，验证失败');
  }
  if (!unsigned.is_valid() || !signed.is_valid() || signed.is_valid() !== unsigned.is_valid()) {
    throw new Error('签名交易的 is_valid 必须与原始交易一致且为 true');
  }
  if (!sameOptionalBytes(signed.raw_auxiliary_data(), unsigned.raw_auxiliary_data())) {
    throw new Error('签名交易的 auxiliary data 与本机原始未签名交易不一致');
  }
  const ttl = signed.body().ttl_bignum();
  if (!ttl) throw new Error('交易缺少一小时有效期 TTL，验证失败');
  if (currentSlot !== undefined) {
    if (!Number.isSafeInteger(currentSlot) || currentSlot < 0) throw new Error('当前链上 slot 无效');
    if (BigInt(currentSlot) >= BigInt(ttl.to_str())) throw new Error('交易的一小时有效期已经过期，请重新构建');
    if (BigInt(ttl.to_str()) > BigInt(currentSlot) + 3600n) {
      throw new Error('交易 TTL 超过允许的一小时有效期，验证失败');
    }
  }

  const txHash = signed.transaction_hash();
  const witnesses = signed.witness_set();
  const unsignedWitnesses = unsigned.witness_set();
  rejectUnsupportedWitnesses(unsignedWitnesses);
  rejectUnsupportedWitnesses(witnesses);
  const expectedNativeScripts = nativeScriptHashes(unsignedWitnesses);
  const signedNativeScripts = nativeScriptHashes(witnesses);
  if (JSON.stringify(signedNativeScripts) !== JSON.stringify(expectedNativeScripts)) {
    throw new Error('签名交易的 native script witnesses 与本机原始未签名交易不一致');
  }
  const vkeys = witnesses.vkeys();
  if (!vkeys || vkeys.len() === 0) throw new Error('签名交易没有 vkey witnesses');
  const validKeyHashes = new Set();
  for (let index = 0; index < vkeys.len(); index += 1) {
    const witness = vkeys.get(index);
    const publicKey = witness.vkey().public_key();
    if (!publicKey.verify(txHash.to_bytes(), witness.signature())) {
      throw new Error(`第 ${index + 1} 个 vkey witness 签名无效`);
    }
    validKeyHashes.add(publicKey.hash().to_hex());
  }

  const nativeScripts = witnesses.native_scripts();
  if (!nativeScripts || nativeScripts.len() === 0) throw new Error('签名交易缺少 native script witnesses');
  const witnessedScriptHashes = new Set();
  for (let index = 0; index < nativeScripts.len(); index += 1) {
    witnessedScriptHashes.add(nativeScripts.get(index).hash().to_hex());
  }

  const available = new Map(utxos.map((utxo) => [
    `${utxo.input.txHash}#${utxo.input.outputIndex}`, utxo,
  ]));
  const accounts = new Map(wallet.accounts.map((account) => [account.address, account]));
  const inputs = signed.body().inputs();
  const checkedScripts = new Set();
  for (let index = 0; index < inputs.len(); index += 1) {
    const input = inputs.get(index);
    const key = `${input.transaction_id().to_hex()}#${input.index()}`;
    const utxo = available.get(key);
    if (!utxo) throw new Error(`交易输入不属于当前钱包的未花费输出: ${key}`);
    const account = accounts.get(utxo.output.address);
    if (!account) throw new Error(`交易输入地址不属于当前钱包: ${utxo.output.address}`);
    const serialized = serializeNativeScript(account.payment_script, undefined, wallet.network === 'mainnet' ? 1 : 0);
    const scriptHash = CSL.NativeScript.from_hex(serialized.scriptCbor).hash().to_hex();
    if (!witnessedScriptHashes.has(scriptHash)) throw new Error(`交易缺少 input ${key} 的 native script`);
    if (!checkedScripts.has(scriptHash) && !scriptSatisfied(account.payment_script, validKeyHashes)) {
      throw new Error(`交易签名尚未满足 input ${key} 的多签门槛`);
    }
    checkedScripts.add(scriptHash);
  }
  const remainingScripts = expectedNativeScripts.filter((hash) => !checkedScripts.has(hash));
  if (remainingScripts.length > 0) {
    let stake;
    try { stake = stakeRuntime(wallet); }
    catch (error) { throw new Error(`交易包含无法关联到当前钱包的 native script: ${error.message}`); }
    for (const scriptHash of remainingScripts) {
      if (scriptHash !== stake.scriptHash) {
        throw new Error(`交易包含当前钱包无法识别的 native script: ${scriptHash}`);
      }
      if (!scriptSatisfied(stake.script, validKeyHashes)) {
        throw new Error('交易签名尚未满足质押证书的 role 2 多签门槛');
      }
      const certs = signed.body().certs();
      if (!certs || certs.len() < 1 || certs.len() > 2) {
        throw new Error('质押 native script 没有对应的受支持质押证书');
      }
      const shapes = [];
      for (let index = 0; index < certs.len(); index += 1) {
        const cert = certs.get(index);
        const registration = cert.as_stake_registration();
        const delegation = cert.as_stake_delegation();
        const credential = registration?.stake_credential() || delegation?.stake_credential();
        if (!credential || credential.to_scripthash()?.to_hex() !== stake.scriptHash) {
          throw new Error('交易包含不受支持或不属于当前钱包的质押证书');
        }
        shapes.push(registration ? 'register' : 'delegate');
      }
      if (!['delegate', 'register,delegate'].includes(shapes.join(','))) {
        throw new Error('质押证书组合必须是 delegate 或 register + delegate');
      }
      checkedScripts.add(scriptHash);
    }
  }
  return {
    transaction_id: txHash.to_hex(),
    input_count: inputs.len(),
    valid_vkey_witnesses: validKeyHashes.size,
    satisfied_native_scripts: checkedScripts.size,
    body_matches_unsigned: true,
    expires_at_slot: ttl.to_str(),
    current_slot: currentSlot ?? null,
  };
}
