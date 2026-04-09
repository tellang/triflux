// hub/lib/ssh-retry.mjs — SSH command retry with exponential backoff
// transient SSH 에러(connection reset, broken pipe 등)를 감지하여 자동 재시도한다.

import { execFileSync } from "node:child_process";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;

/** transient SSH 에러 패턴 */
const TRANSIENT_RE =
  /connection (reset|refused|timed out)|broken pipe|network is unreachable|ssh_exchange_identification|kex_exchange_identification/i;

/**
 * execFileSync('ssh', args) 를 retry 래핑한다.
 * transient 에러만 재시도하고, 그 외 에러는 즉시 throw.
 *
 * @param {string[]} args — ssh 인자 배열
 * @param {object} [opts] — execFileSync 옵션 + retry 설정
 * @param {number} [opts.maxRetries=2]
 * @param {number} [opts.baseDelayMs=1000]
 * @returns {string|Buffer} ssh stdout
 */
export function execSshWithRetry(args, opts = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    ...execOpts
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return execFileSync("ssh", args, execOpts);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && isTransientSshError(err)) {
        sleepSync(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * transient SSH 에러인지 판별한다.
 * @param {Error} err
 * @returns {boolean}
 */
export function isTransientSshError(err) {
  const msg = String(err.stderr || err.message || "");
  return TRANSIENT_RE.test(msg);
}

/**
 * 동기 sleep (Atomics.wait 기반).
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
