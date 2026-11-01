import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./cbor-worker.js', import.meta.url));
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=96', WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('CBOR 本地验证超时，已终止隔离进程'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('CBOR 验证进程输出超过安全上限'));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish(new Error(`无法启动 CBOR 隔离验证进程: ${error.message}`)));
    child.on('close', () => {
      if (settled) return;
      try {
        const response = JSON.parse(Buffer.concat(stdout).toString('utf8'));
        if (!response.ok) throw new Error(response.error || 'CBOR 验证失败');
        finish(undefined, response.result);
      } catch (error) {
        const detail = Buffer.concat(stderr).toString('utf8').trim();
        finish(new Error(detail || error.message));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function isolatedTransactionStakeContext(txHex) {
  return runWorker({ action: 'stake-context', txHex });
}

export function isolatedVerifySignedTransaction(payload) {
  return runWorker({ action: 'verify', payload });
}
