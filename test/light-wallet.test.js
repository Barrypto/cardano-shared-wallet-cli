import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROTOCOL_PARAMETERS } from '@meshsdk/core';
import { deserializeAddress, serializeNativeScript } from '@meshsdk/core';
import * as CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { bech32 } from 'bech32';
import { buildTransaction, normalizePayment } from '../src/builder.js';
import { deriveReceiveAddresses, deriveSharedWallet, normalizeHdMultisigExport } from '../src/derive.js';
import {
  dualSourceConfig, findNextUnusedAddress, formatQuantity, humanizeAssets, sumAssets,
} from '../src/provider.js';
import { createTerminalQr } from '../src/receive.js';
import { verifySignedTransaction } from '../src/transaction.js';
import { stakeRuntime, validateWallet } from '../src/wallet.js';
import { buildStakeDelegation } from '../src/staking.js';
import { prepareChainSnapshot } from '../src/dual-source.js';
import { auditWalletAddressesWithCardanoCli } from '../src/cardano-cli.js';

const script = {
  type: 'atLeast',
  required: 2,
  scripts: [
    { type: 'sig', keyHash: '00'.repeat(28) },
    { type: 'sig', keyHash: '11'.repeat(28) },
    { type: 'sig', keyHash: '22'.repeat(28) },
  ],
};
const address = serializeNativeScript(script, undefined, 0).address;
const wallet = {
  version: 1,
  name: 'test shared wallet',
  network: 'preprod',
  change_address: address,
  accounts: [{ address, payment_script: script }],
};

function testAccountXpub(byte) {
  const account = testAccountPrivate(byte).to_public();
  return bech32.encode('acct_shared_xvk', bech32.toWords(account.as_bytes()), 200);
}

function testAccountPrivate(byte) {
  const root = CSL.Bip32PrivateKey.from_bip39_entropy(Buffer.alloc(32, byte), Buffer.alloc(0));
  return root.derive(0x80000000 + 1854).derive(0x80000000 + 1815).derive(0x80000000);
}

function importedHdMultisigWallet() {
  return validateWallet({
    format: 'cardano-hd-multisig', version: 1, network: 'preprod',
    threshold: 2, account: 0, gapLimit: 3,
    cosigners: [
      { name: 'A', accountXpub: testAccountXpub(3) },
      { name: 'B', accountXpub: testAccountXpub(4) },
      { name: 'C', accountXpub: testAccountXpub(5) },
    ],
  });
}

function blockfrostMock({
  utxos,
  params = DEFAULT_PROTOCOL_PARAMETERS,
  tip = 1_000_050,
  account,
  pool,
} = {}) {
  return {
    fetchProtocolParameters: async () => params,
    fetchLatestBlock: async () => ({ slot: String(tip) }),
    _axiosInstance: {
      get: async (path) => {
        if (path.startsWith('addresses/')) {
          const requestedAddress = path.split('/')[1];
          return { data: (utxos || []).filter((utxo) => (
            utxo.output.address === requestedAddress
          )).map((utxo) => ({
            tx_hash: utxo.input.txHash,
            output_index: utxo.input.outputIndex,
            address: utxo.output.address,
            amount: utxo.output.amount,
          })) };
        }
        if (path.startsWith('accounts/')) {
          if (account === null || account === undefined) {
            const error = new Error('not found');
            error.response = { status: 404 };
            throw error;
          }
          return { data: account };
        }
        if (path.startsWith('pools/')) return { data: pool };
        throw new Error(`unexpected Blockfrost path ${path}`);
      },
    },
  };
}

test('derives every wallet with the single fixed payment/stake rule', () => {
  const cosigners = { 'cosigner#0': testAccountXpub(1), 'cosigner#1': testAccountXpub(2) };
  const template = { some: { at_least: 2, from: ['cosigner#0', 'cosigner#1'] } };
  assert.throws(() => deriveSharedWallet({
    name: 'no-stake', network: 'preprod', address_pool_gap: 2,
    payment_script_template: { cosigners, template },
  }), /delegation_script_template/);
  const derived = deriveSharedWallet({
    name: 'derived', network: 'preprod', address_pool_gap: 2,
    payment_script_template: { cosigners, template },
    delegation_script_template: { cosigners, template },
  });
  assert.equal(derived.accounts.length, 2);
  assert.deepEqual(derived.accounts.map((entry) => [entry.role, entry.index]), [
    ['external', 0], ['external', 1],
  ]);
  assert.equal(derived.change_address, derived.accounts[0].address);
  assert.ok(derived.accounts.every((entry) => entry.address.startsWith('addr_test1')));
  assert.ok(derived.accounts.every((entry) => deserializeAddress(entry.address).stakeScriptCredentialHash));
  assert.equal(new Set(derived.accounts.map((entry) => deserializeAddress(entry.address).stakeScriptCredentialHash)).size, 1);
  assert.equal(derived.derivation.payment_path, "m/1854'/1815'/0'/0/index");
  assert.equal(derived.derivation.delegation_path, "m/1854'/1815'/0'/2/0");
  assert.equal(validateWallet(derived).accounts.length, 2);
});

test('imports cardano-hd-multisig as base addresses without separate staking keys', async () => {
  const exported = {
    format: 'cardano-hd-multisig', version: 1, network: 'mainnet',
    threshold: 2, account: 0, gapLimit: 3,
    cosigners: [
      { name: 'A', accountXpub: testAccountXpub(3) },
      { name: 'B', accountXpub: testAccountXpub(4) },
      { name: 'C', accountXpub: testAccountXpub(5) },
    ],
  };
  const normalized = normalizeHdMultisigExport(exported);
  assert.equal(normalized.derivation.scheme, 'CIP-1854');
  assert.equal(normalized.derivation.delegation_path, "m/1854'/1815'/0'/2/0");
  const imported = validateWallet(exported);
  assert.equal(imported.accounts.length, 3);
  assert.ok(imported.accounts.every((entry) => entry.address.startsWith('addr1')));
  assert.ok(imported.accounts.every((entry) => !entry.address.startsWith('addr1w')));
  assert.ok(imported.derivation.delegation_script_template);
  const stakeHashes = imported.accounts.map((entry) => deserializeAddress(entry.address).stakeScriptCredentialHash);
  assert.equal(new Set(stakeHashes).size, 1);

  const expanded = deriveReceiveAddresses(imported, 50);
  assert.equal(expanded.length, 50);
  assert.deepEqual(expanded.slice(0, 3).map((entry) => entry.address),
    imported.accounts.map((entry) => entry.address));
  assert.ok(expanded.every((entry) => entry.address_type === 'base'));
  assert.equal(new Set(expanded.map((entry) => deserializeAddress(entry.address).stakeScriptCredentialHash)).size, 1);

  const used = new Set(expanded.slice(0, 2).map((entry) => entry.address));
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchAddressTxs: async (candidate) => used.has(candidate) ? [{ hash: 'used' }] : [],
  };
  const next = await findNextUnusedAddress(provider, imported, 10);
  assert.equal(next.index, 2);
  assert.equal(next.address, expanded[2].address);
  const qr = await createTerminalQr(next.address);
  assert.ok(qr.length > 100);
  const allTrackedUsed = new Set(expanded.slice(0, 3).map((entry) => entry.address));
  await assert.rejects(() => findNextUnusedAddress({
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchAddressTxs: async (candidate) => allTrackedUsed.has(candidate) ? [{ hash: 'used' }] : [],
  }, imported, 10), /超出当前钱包已跟踪地址池/);
});

test('official cardano-cli independently rebuilds every base address', async () => {
  const imported = importedHdMultisigWallet();
  const result = await auditWalletAddressesWithCardanoCli({
    wallet: imported,
    stakeScript: stakeRuntime(imported).script,
  });
  assert.equal(result.verified, true);
  assert.equal(result.addressCount, imported.accounts.length);
});

test('wallet import re-derives every address and rejects tampering', () => {
  const imported = importedHdMultisigWallet();
  assert.equal(imported.accounts.length, 3);
  const tampered = structuredClone(imported);
  tampered.accounts[0].payment_script.scripts[0].keyHash = 'ff'.repeat(28);
  assert.throws(() => validateWallet(tampered), /不匹配/);
  const noTemplate = structuredClone(imported);
  delete noTemplate.derivation;
  assert.throws(() => validateWallet(noTemplate), /派生模板/);
  const swapped = structuredClone(imported);
  [swapped.accounts[0], swapped.accounts[1]] = [swapped.accounts[1], swapped.accounts[0]];
  assert.throws(() => validateWallet(swapped), /external\/index/);
});

test('template import rejects unsafe or inconsistent m-of-n policies', () => {
  const first = testAccountXpub(6);
  const second = testAccountXpub(7);
  const safeCosigners = { a: first, b: second };
  const safeTemplate = { some: { at_least: 2, from: ['a', 'b'] } };
  const base = {
    name: 'template validation', network: 'preprod', address_pool_gap: 1,
    payment_script_template: { cosigners: safeCosigners, template: safeTemplate },
    delegation_script_template: { cosigners: safeCosigners, template: safeTemplate },
  };
  assert.equal(deriveSharedWallet(base).accounts.length, 1);
  assert.throws(() => deriveSharedWallet({
    ...base,
    payment_script_template: {
      cosigners: { a: first },
      template: { some: { at_least: 0, from: ['a'] } },
    },
  }), /m 必须介于 1 和 n/);
  assert.throws(() => deriveSharedWallet({
    ...base,
    payment_script_template: {
      cosigners: { a: first, b: first },
      template: { some: { at_least: 2, from: ['a', 'b'] } },
    },
  }), /重复的 account xpub/);
  assert.throws(() => deriveSharedWallet({
    ...base,
    payment_script_template: {
      cosigners: safeCosigners,
      template: { some: { at_least: 2, from: ['a', 'a'] } },
    },
  }), /恰好引用每个 cosigner 一次/);
  assert.throws(() => deriveSharedWallet({
    ...base,
    delegation_script_template: {
      cosigners: { a: first, b: testAccountXpub(8) },
      template: safeTemplate,
    },
  }), /payment\/delegation 必须使用完全相同/);
});

test('balances are summed without Number precision loss', () => {
  const assets = sumAssets([
    { output: { amount: [{ unit: 'lovelace', quantity: '9007199254740993' }] } },
    { output: { amount: [{ unit: 'lovelace', quantity: '7' }, { unit: 'abcd', quantity: '2' }] } },
  ]);
  assert.deepEqual(assets, [
    { unit: 'lovelace', quantity: '9007199254741000' },
    { unit: 'abcd', quantity: '2' },
  ]);
});

test('formats ADA and token registry decimals for humans', async () => {
  assert.equal(formatQuantity('57398077240', 6, true), '57,398.077240');
  const fakeFetch = async () => new Response(JSON.stringify({
    name: { value: 'NIGHT' }, ticker: { value: 'NIGHT' }, decimals: { value: 6 },
  }));
  const readable = await humanizeAssets([
    { unit: 'lovelace', quantity: '57398077240' },
    { unit: `${'06'.repeat(28)}4e49474854`, quantity: '8627576666' },
  ], 'mainnet', fakeFetch);
  assert.equal(readable.ada.amount, '57,398.077240 ADA');
  assert.equal(readable.tokens[0].amount, '8,627.576666 NIGHT');
  assert.equal(readable.tokens[0].asset_name, 'NIGHT');
});

test('builds an unsigned native-script transaction offline', async () => {
  const utxos = [{
    input: { txHash: 'aa'.repeat(32), outputIndex: 0 },
    output: { address, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
  }];
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
  };
  const result = await buildTransaction({
    wallet,
    provider,
    utxos,
    payments: [{ address, amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
  });
  assert.match(result.txHex, /^[0-9a-f]+$/);
  assert.equal(result.inputs.length, 1);
  assert.ok(BigInt(result.fee) > 0n);
  assert.equal(result.outputs[0].amount[0].quantity, '5000000');
  assert.equal(result.expiresAtSlot, 1_003_600);
  assert.equal(CSL.Transaction.from_hex(result.txHex).body().ttl_bignum().to_str(), '1003600');
});

test('token-only selection automatically adds the exact minimum ADA output', async () => {
  const tokenUnit = `${'ab'.repeat(28)}01`;
  const recipientScript = { type: 'sig', keyHash: '33'.repeat(28) };
  const recipient = serializeNativeScript(recipientScript, undefined, 0).address;
  const utxos = [{
    input: { txHash: 'a0'.repeat(32), outputIndex: 0 },
    output: { address, amount: [
      { unit: 'lovelace', quantity: '10000000' },
      { unit: tokenUnit, quantity: '9007199254740995' },
    ] },
  }];
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
  };
  const result = await buildTransaction({
    wallet,
    provider,
    utxos,
    payments: [{ address: recipient, amount: [{ unit: tokenUnit, quantity: '9007199254740993' }] }],
  });
  const recipientOutput = result.outputs.find((output) => output.address === recipient);
  assert.ok(recipientOutput);
  const sent = new Map(recipientOutput.amount.map((asset) => [asset.unit, asset.quantity]));
  assert.equal(sent.get(tokenUnit), '9007199254740993');
  assert.ok(BigInt(sent.get('lovelace')) > 0n);
});

test('strict dual-source snapshot accepts identical data and fails closed on disagreement', async () => {
  const utxos = [{
    input: { txHash: 'a1'.repeat(32), outputIndex: 0 },
    output: { address, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
  }];
  const koiosProvider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
  };
  const verified = await prepareChainSnapshot({
    wallet,
    koiosProvider,
    koiosUtxos: utxos,
    blockfrostProvider: blockfrostMock({ utxos }),
  });
  assert.equal(verified.dualSource.verified, true);
  assert.equal(verified.chainContext.tipSlot, 1_000_050);
  assert.equal(verified.dualSource.tipDifference, 50);

  const wrongValue = structuredClone(utxos);
  wrongValue[0].output.amount[0].quantity = '9999999';
  await assert.rejects(() => prepareChainSnapshot({
    wallet,
    koiosProvider,
    koiosUtxos: utxos,
    blockfrostProvider: blockfrostMock({ utxos: wrongValue }),
  }), /完整 UTxO 集不一致/);

  await assert.rejects(() => prepareChainSnapshot({
    wallet,
    koiosProvider,
    koiosUtxos: utxos,
    blockfrostProvider: blockfrostMock({
      utxos, params: { ...DEFAULT_PROTOCOL_PARAMETERS, keyDeposit: 3_000_000 },
    }),
  }), /协议参数不一致/);

  await assert.rejects(() => prepareChainSnapshot({
    wallet,
    koiosProvider,
    koiosUtxos: utxos,
    blockfrostProvider: blockfrostMock({ utxos, tip: 1_000_181 }),
  }), /tip 相差 181 slots/);

  const unavailable = blockfrostMock({ utxos });
  unavailable._axiosInstance.get = async () => {
    const error = new Error('down'); error.response = { status: 503 }; throw error;
  };
  await assert.rejects(() => prepareChainSnapshot({
    wallet, koiosProvider, koiosUtxos: utxos, blockfrostProvider: unavailable,
  }), /Blockfrost .*查询失败.*503/);
});

test('dual-source configuration is explicit, network-bound and secret-safe', () => {
  const names = [
    'CSW_DUAL_SOURCE_VERIFY', 'BLOCKFROST_PROJECT_ID',
    'BLOCKFROST_MAINNET_PROJECT_ID', 'BLOCKFROST_PREPROD_PROJECT_ID',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(dualSourceConfig('mainnet').enabled, false);
    process.env.CSW_DUAL_SOURCE_VERIFY = 'true';
    assert.throws(() => dualSourceConfig('mainnet'), /缺少 BLOCKFROST_MAINNET_PROJECT_ID/);
    process.env.BLOCKFROST_MAINNET_PROJECT_ID = 'preprod-secret-value';
    assert.throws(() => dualSourceConfig('mainnet'), /网络 mainnet 不匹配/);
    process.env.BLOCKFROST_MAINNET_PROJECT_ID = 'mainnet-secret-value';
    assert.equal(dualSourceConfig('mainnet').enabled, true);
    process.env.CSW_DUAL_SOURCE_VERIFY = 'false';
    assert.equal(dualSourceConfig('mainnet').enabled, false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('strict mode cannot be bypassed by calling the transaction builder directly', async () => {
  const previousMode = process.env.CSW_DUAL_SOURCE_VERIFY;
  const previousKey = process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  try {
    process.env.CSW_DUAL_SOURCE_VERIFY = 'true';
    process.env.BLOCKFROST_PREPROD_PROJECT_ID = 'preprod-secret-value';
    await assert.rejects(() => buildTransaction({
      wallet,
      provider: {
        fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
        fetchTipSlot: async () => 1_000_000,
      },
      utxos: [{
        input: { txHash: 'a2'.repeat(32), outputIndex: 0 },
        output: { address, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
      }],
      payments: [{ address, amount: [{ unit: 'lovelace', quantity: '2000000' }] }],
    }), /缺少通过核验的链状态快照/);
  } finally {
    if (previousMode === undefined) delete process.env.CSW_DUAL_SOURCE_VERIFY;
    else process.env.CSW_DUAL_SOURCE_VERIFY = previousMode;
    if (previousKey === undefined) delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
    else process.env.BLOCKFROST_PREPROD_PROJECT_ID = previousKey;
  }
});

test('send-all puts every asset in one recipient output and creates no change', async () => {
  const tokenUnit = `${'ab'.repeat(28)}4e49474854`;
  const utxos = [{
    input: { txHash: 'bb'.repeat(32), outputIndex: 0 },
    output: { address, amount: [
      { unit: 'lovelace', quantity: '10000000' },
      { unit: tokenUnit, quantity: '1234567' },
    ] },
  }];
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
  };
  const result = await buildTransaction({ wallet, provider, utxos, payments: [], sendAllTo: address });
  assert.equal(result.sendAll, true);
  assert.equal(result.changeOutputCount, 0);
  assert.equal(result.outputs.length, 1);
  const output = new Map(result.outputs[0].amount.map((asset) => [asset.unit, asset.quantity]));
  assert.equal(output.get(tokenUnit), '1234567');
  assert.equal(BigInt(output.get('lovelace')) + BigInt(result.fee), 10_000_000n);
});

test('builder rejects a change address outside the current wallet', async () => {
  const unsafeWallet = { ...wallet, change_address: `${address.slice(0, -1)}x` };
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
  };
  await assert.rejects(() => buildTransaction({
    wallet: unsafeWallet,
    provider,
    utxos: [{
      input: { txHash: 'cc'.repeat(32), outputIndex: 0 },
      output: { address, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
    }],
    payments: [{ address, amount: [{ unit: 'lovelace', quantity: '2000000' }] }],
  }), /找零地址不属于当前钱包/);
});

test('signed transaction must match unsigned body and satisfy multisig threshold', async () => {
  const privateKeys = Array.from({ length: 3 }, () => CSL.PrivateKey.generate_ed25519extended());
  const signingScript = {
    type: 'atLeast',
    required: 2,
    scripts: privateKeys.map((key) => ({ type: 'sig', keyHash: key.to_public().hash().to_hex() })),
  };
  const signingAddress = serializeNativeScript(signingScript, undefined, 0).address;
  const signingWallet = {
    version: 1,
    name: 'signing test',
    network: 'preprod',
    change_address: signingAddress,
    accounts: [{ address: signingAddress, payment_script: signingScript }],
  };
  const signingUtxos = [{
    input: { txHash: 'dd'.repeat(32), outputIndex: 0 },
    output: { address: signingAddress, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
  }];
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
  };
  const built = await buildTransaction({
    wallet: signingWallet,
    provider,
    utxos: signingUtxos,
    payments: [{ address: signingAddress, amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
  });
  const signed = CSL.FixedTransaction.from_hex(built.txHex);
  signed.sign_and_add_vkey_signature(privateKeys[0]);
  assert.throws(() => verifySignedTransaction({
    signedHex: signed.to_hex(), unsignedHex: built.txHex, wallet: signingWallet, utxos: signingUtxos,
  }), /尚未满足/);
  signed.sign_and_add_vkey_signature(privateKeys[1]);
  const verified = verifySignedTransaction({
    signedHex: signed.to_hex(), unsignedHex: built.txHex, wallet: signingWallet, utxos: signingUtxos,
  });
  assert.equal(verified.body_matches_unsigned, true);
  assert.equal(verified.valid_vkey_witnesses, 2);
  assert.equal(verified.satisfied_native_scripts, 1);
  const invalidFlag = CSL.FixedTransaction.from_hex(signed.to_hex());
  invalidFlag.set_is_valid(false);
  assert.throws(() => verifySignedTransaction({
    signedHex: invalidFlag.to_hex(), unsignedHex: built.txHex, wallet: signingWallet, utxos: signingUtxos,
  }), /is_valid/);
  const extraAuxiliaryData = CSL.FixedTransaction.from_hex(signed.to_hex());
  const auxiliaryData = CSL.AuxiliaryData.new();
  const auxiliaryScripts = CSL.NativeScripts.new();
  auxiliaryScripts.add(CSL.NativeScript.from_hex(serializeNativeScript(signingScript).scriptCbor));
  auxiliaryData.set_native_scripts(auxiliaryScripts);
  extraAuxiliaryData.set_auxiliary_data(auxiliaryData.to_bytes());
  assert.throws(() => verifySignedTransaction({
    signedHex: extraAuxiliaryData.to_hex(), unsignedHex: built.txHex, wallet: signingWallet, utxos: signingUtxos,
  }), /auxiliary data/);
  const extraNativeScript = CSL.FixedTransaction.from_hex(signed.to_hex());
  const alteredWitnesses = extraNativeScript.witness_set();
  const alteredScripts = alteredWitnesses.native_scripts();
  const unrelatedKey = CSL.PrivateKey.generate_ed25519extended();
  const unrelatedScript = { type: 'sig', keyHash: unrelatedKey.to_public().hash().to_hex() };
  alteredScripts.add(CSL.NativeScript.from_hex(serializeNativeScript(unrelatedScript).scriptCbor));
  alteredWitnesses.set_native_scripts(alteredScripts);
  extraNativeScript.set_witness_set(alteredWitnesses.to_bytes());
  assert.throws(() => verifySignedTransaction({
    signedHex: extraNativeScript.to_hex(), unsignedHex: built.txHex, wallet: signingWallet, utxos: signingUtxos,
  }), /native script witnesses/);
  const other = await buildTransaction({
    wallet: signingWallet,
    provider,
    utxos: signingUtxos,
    payments: [{ address: signingAddress, amount: [{ unit: 'lovelace', quantity: '4000000' }] }],
  });
  assert.throws(() => verifySignedTransaction({
    signedHex: signed.to_hex(), unsignedHex: other.txHex, wallet: signingWallet, utxos: signingUtxos,
  }), /transaction body.*不一致/);
});

test('builder rejects an abnormal provider-supplied fee', async () => {
  const utxos = [{
    input: { txHash: 'ee'.repeat(32), outputIndex: 0 },
    output: { address, amount: [{ unit: 'lovelace', quantity: '100000000' }] },
  }];
  const provider = {
    fetchProtocolParameters: async () => ({ ...DEFAULT_PROTOCOL_PARAMETERS, minFeeB: 6_000_000 }),
    fetchTipSlot: async () => 1_000_000,
  };
  await assert.rejects(() => buildTransaction({
    wallet,
    provider,
    utxos,
    payments: [{ address, amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
  }), /手续费.*超出允许范围/);
});

test('builds register-and-delegate with one-hour TTL and verifies role-2 multisig', async () => {
  const stakeWallet = importedHdMultisigWallet();
  const poolId = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
  const stakeUtxos = [{
    input: { txHash: 'fa'.repeat(32), outputIndex: 0 },
    output: {
      address: stakeWallet.accounts[0].address,
      amount: [{ unit: 'lovelace', quantity: '10000000' }],
    },
  }];
  const provider = {
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTipSlot: async () => 1_000_000,
    _axiosInstance: {
      post: async (route) => {
        if (route === '/account_info') return { data: [] };
        if (route === '/pool_info') return { data: [{
          pool_id_bech32: poolId,
          pool_status: 'registered',
          margin: 0.02,
          fixed_cost: '170000000',
          live_stake: '123000000000',
          live_saturation: 0.5,
          retiring_epoch: null,
          meta_json: { ticker: 'TEST', name: 'Test Pool' },
        }] };
        throw new Error(`unexpected route ${route}`);
      },
    },
  };
  const stakeAddress = stakeWallet.accounts[0].address;
  const secondary = blockfrostMock({
    utxos: stakeUtxos,
    account: null,
    pool: {
      pool_id: poolId, active: true, retired: false, retiring_epoch: null,
    },
  });
  const snapshot = await prepareChainSnapshot({
    wallet: stakeWallet,
    koiosProvider: provider,
    koiosUtxos: stakeUtxos,
    poolId,
    includeStaking: true,
    blockfrostProvider: secondary,
  });
  assert.equal(snapshot.dualSource.verified, true);
  assert.equal(snapshot.stakingState.registered, false);
  assert.equal(stakeAddress.startsWith('addr_test1'), true);
  await assert.rejects(() => prepareChainSnapshot({
    wallet: stakeWallet,
    koiosProvider: provider,
    koiosUtxos: stakeUtxos,
    poolId,
    includeStaking: true,
    blockfrostProvider: blockfrostMock({
      utxos: stakeUtxos,
      account: {
        stake_address: stakeRuntime(stakeWallet).rewardAddress,
        active: true,
        withdrawable_amount: '0',
        pool_id: poolId,
      },
      pool: { pool_id: poolId, active: true, retired: false, retiring_epoch: null },
    }),
  }), /质押账户状态不一致/);
  const built = await buildStakeDelegation({
    wallet: stakeWallet,
    provider,
    utxos: stakeUtxos,
    poolId,
    chainContext: snapshot.chainContext,
    stakingState: snapshot.stakingState,
    poolInfo: snapshot.poolInfo,
    dualSource: snapshot.dualSource,
  });
  assert.equal(built.action, 'register-and-delegate');
  assert.equal(built.deposit, String(DEFAULT_PROTOCOL_PARAMETERS.keyDeposit));
  assert.equal(built.expiresAtSlot, 1_003_650);
  const unsigned = CSL.Transaction.from_hex(built.txHex);
  assert.equal(unsigned.body().ttl_bignum().to_str(), '1003650');
  assert.equal(unsigned.body().certs().len(), 2);

  const signed = CSL.FixedTransaction.from_hex(built.txHex);
  for (const byte of [3, 4]) {
    signed.sign_and_add_vkey_signature(testAccountPrivate(byte).derive(0).derive(0).to_raw_key());
  }
  assert.throws(() => verifySignedTransaction({
    signedHex: signed.to_hex(), unsignedHex: built.txHex,
    wallet: stakeWallet, utxos: stakeUtxos, currentSlot: 1_000_100,
  }), /role 2/);
  for (const byte of [3, 4]) {
    signed.sign_and_add_vkey_signature(testAccountPrivate(byte).derive(2).derive(0).to_raw_key());
  }
  const verified = verifySignedTransaction({
    signedHex: signed.to_hex(), unsignedHex: built.txHex,
    wallet: stakeWallet, utxos: stakeUtxos, currentSlot: 1_000_100,
  });
  assert.equal(verified.satisfied_native_scripts, 2);
  assert.throws(() => verifySignedTransaction({
    signedHex: signed.to_hex(), unsignedHex: built.txHex,
    wallet: stakeWallet, utxos: stakeUtxos, currentSlot: 1_003_650,
  }), /已经过期/);
});

test('payment requires an explicit non-empty asset array', () => {
  assert.throws(() => normalizePayment({
    address,
    amount: { unit: 'lovelace', quantity: 3_000_000 },
  }), /非空资产数组/);
  assert.throws(() => normalizePayment({ address, amount: [] }), /非空资产数组/);
});

test('payment rejects duplicate or malformed asset units', () => {
  assert.throws(() => normalizePayment({
    address,
    amount: [
      { unit: 'lovelace', quantity: '2000000' },
      { unit: 'lovelace', quantity: '1' },
    ],
  }), /重复/);
  assert.throws(() => normalizePayment({
    address,
    amount: [{ unit: 'not-a-cardano-asset', quantity: '1' }],
  }), /unit 无效/);
});

test('cardano-hd-multisig descriptor rejects duplicate xpubs and unsupported account', () => {
  const xpub = testAccountXpub(9);
  const base = {
    format: 'cardano-hd-multisig', version: 1, network: 'mainnet', threshold: 1,
    account: 0, gapLimit: 1,
    cosigners: [{ name: 'A', accountXpub: xpub }],
  };
  assert.throws(() => validateWallet({
    ...base,
    threshold: 2,
    cosigners: [{ name: 'A', accountXpub: xpub }, { name: 'B', accountXpub: xpub }],
  }), /重复/);
  assert.throws(() => validateWallet({ ...base, account: 1 }), /account 必须是 0/);
  assert.throws(() => validateWallet({ ...base, unexpected: true }), /未知字段/);
});
