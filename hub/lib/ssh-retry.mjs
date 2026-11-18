import { execFileSync } from "node:child_process";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 1000;

const TRANSIENT_RE =
  /connection (reset|refused|timed out)|broken pipe|network is unreachable|ssh_exchange_identification|kex_exchange_identification/i;

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

export function isTransientSshError(err) {
  const msg = String(err.stderr || err.message || "");
  return TRANSIENT_RE.test(msg);
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
