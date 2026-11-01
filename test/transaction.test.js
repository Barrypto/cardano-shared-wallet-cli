import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_TRANSACTION_BYTES, adaToLovelace, exportTransaction, normalizeTransaction, readTransaction,
} from '../src/transaction.js';
import { isolatedTransactionStakeContext } from '../src/isolated-cbor.js';

test('ADA decimal is converted exactly', () => {
  assert.equal(adaToLovelace('1'), 1_000_000);
  assert.equal(adaToLovelace('1.234567'), 1_234_567);
  assert.equal(adaToLovelace('0.000001'), 1);
  assert.throws(() => adaToLovelace('1.0000001'));
});

test('transaction accepts hex, base64 and envelope JSON', () => {
  const base64 = Buffer.from('hello').toString('base64');
  assert.equal(normalizeTransaction('68656c6c6f'), '68656c6c6f');
  assert.equal(normalizeTransaction(base64), '68656c6c6f');
  assert.equal(normalizeTransaction(JSON.stringify({ cborHex: '68656c6c6f' })), '68656c6c6f');
});

test('transaction input enforces the CBOR byte limit', () => {
  const oversized = Buffer.alloc(MAX_TRANSACTION_BYTES + 1).toString('hex');
  assert.throws(() => normalizeTransaction(oversized), /安全上限/);
});

test('untrusted CBOR is rejected inside the isolated parser', async () => {
  await assert.rejects(() => isolatedTransactionStakeContext('00'), /交易 CBOR 无法解析/);
});

test('export writes round-trippable formats', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'csw-'));
  const hex = '8400a0';
  const files = await exportTransaction(hex, join(dir, 'unsigned'));
  assert.deepEqual(await readFile(files.cbor), Buffer.from(hex, 'hex'));
  assert.equal(await readTransaction(files.hex), hex);
  assert.equal(await readTransaction(files.envelope), hex);
});
