import { transactionStakeContext, verifySignedTransaction } from './transaction.js';

const MAX_REQUEST_BYTES = 14 * 1024 * 1024;

async function readRequest() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new Error('CBOR 验证请求超过安全上限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const request = await readRequest();
  let result;
  if (request.action === 'stake-context') result = transactionStakeContext(request.txHex);
  else if (request.action === 'verify') result = verifySignedTransaction(request.payload);
  else throw new Error('未知的 CBOR 验证操作');
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error.message || error) })}\n`);
  process.exitCode = 1;
}
