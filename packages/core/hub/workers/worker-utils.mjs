// hub/workers/worker-utils.mjs — 워커 공통 유틸리티
// claude-worker, gemini-worker, pipe 등에서 공유하는 순수 유틸 함수 모음.

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 1000;

export function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

export function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function createWorkerError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, delayMs));
    timer.unref?.();
  });
}

export async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    shouldRetry = () => true,
  } = opts;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error, attempt)) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
        * (0.5 + Math.random() * 0.5);
      await sleep(delay);
    }
  }

  throw lastError;
}

export function appendTextFragments(value, parts) {
  if (value == null) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) parts.push(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) appendTextFragments(item, parts);
    return;
  }

  if (typeof value !== 'object') return;

  if (typeof value.text === 'string') appendTextFragments(value.text, parts);
  if (typeof value.response === 'string') appendTextFragments(value.response, parts);
  if (typeof value.result === 'string') appendTextFragments(value.result, parts);
  if (value.content != null) appendTextFragments(value.content, parts);
  if (value.message != null) appendTextFragments(value.message, parts);
}

export function extractText(value) {
  const parts = [];
  appendTextFragments(value, parts);
  return parts.join('\n').trim();
}

export function terminateChild(child, killGraceMs) {
  if (!child || child.exitCode !== null || child.killed) return;

  try { child.stdin.end(); } catch {}
  try { child.kill(); } catch {}

  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, killGraceMs);
  timer.unref?.();
}
