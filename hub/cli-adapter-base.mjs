// hub/cli-adapter-base.mjs — codex/gemini 공통 CLI adapter 인터페이스
// Phase 2: codex-adapter.mjs에서 추출한 재사용 가능 유틸리티

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { killProcess, IS_WINDOWS } from './platform.mjs';

// ── Shell utilities ─────────────────────────────────────────────

export function normalizePathForShell(value) {
  return IS_WINDOWS ? String(value).replace(/\\/g, '/') : String(value);
}

export function shellQuote(value) {
  return JSON.stringify(String(value));
}

// ── Sleep ───────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ── Result factory ──────────────────────────────────────────────

export function createResult(ok, extra = {}) {
  return {
    ok,
    output: '',
    stderr: '',
    exitCode: null,
    duration: 0,
    retried: false,
    fellBack: false,
    failureMode: ok ? null : 'crash',
    ...extra,
  };
}

export function appendWarnings(stderr, warnings = []) {
  const text = warnings.map((item) => `[preflight] ${item}`).join('\n');
  return [stderr, text].filter(Boolean).join('\n');
}

// ── Circuit breaker factory ─────────────────────────────────────

export function createCircuitBreaker(opts = {}) {
  const state = {
    failures: [],
    maxFailures: opts.maxFailures ?? 3,
    windowMs: opts.windowMs ?? 10 * 60_000,
    openedAt: 0,
    trialInFlight: false,
  };

  function pruneFailures(now = Date.now()) {
    state.failures = state.failures.filter((stamp) => now - stamp < state.windowMs);
  }

  function reset() {
    state.failures = [];
    state.openedAt = 0;
    state.trialInFlight = false;
  }

  function recordFailure(isHalfOpen, now = Date.now()) {
    pruneFailures(now);
    state.failures = [...state.failures, now];
    state.trialInFlight = false;
    if (isHalfOpen || state.failures.length >= state.maxFailures) {
      state.openedAt = now;
    }
  }

  function getState(now = Date.now()) {
    pruneFailures(now);
    const withinWindow = state.openedAt && now - state.openedAt < state.windowMs;
    const current = withinWindow ? 'open' : (state.openedAt ? 'half-open' : 'closed');
    return {
      state: current,
      failures: [...state.failures],
      maxFailures: state.maxFailures,
      windowMs: state.windowMs,
      openedAt: state.openedAt || null,
      trialInFlight: state.trialInFlight,
    };
  }

  function canExecute() {
    const circuit = getState();
    if (circuit.state === 'open') return { allowed: false, halfOpen: false };
    if (circuit.state === 'half-open' && state.trialInFlight) return { allowed: false, halfOpen: true };
    const halfOpen = circuit.state === 'half-open';
    if (halfOpen) state.trialInFlight = true;
    return { allowed: true, halfOpen };
  }

  function clearTrial() {
    state.trialInFlight = false;
  }

  return { getState, recordFailure, reset, canExecute, clearTrial };
}

// ── Process termination ─────────────────────────────────────────

export async function terminateChild(pid, opts = {}) {
  if (!pid) return;
  const graceMs = opts.graceMs ?? 5000;
  killProcess(pid, { signal: 'SIGTERM', tree: true, timeout: graceMs });
  await sleep(graceMs);
  killProcess(pid, { signal: 'SIGKILL', tree: true, force: true, timeout: graceMs });
}

// ── Process execution with stall detection ──────────────────────

/**
 * Spawn a CLI process with timeout + stall detection.
 *
 * @param {string} command — shell command to run
 * @param {string} workdir — cwd for the child process
 * @param {number} timeout — max duration in ms
 * @param {object} [opts]
 * @param {string} [opts.resultFile] — file to read output from (if CLI writes there)
 * @param {function} [opts.inferStallMode] — (stdout, stderr) => string. Default: () => 'timeout'
 * @param {number} [opts.stallCheckIntervalMs] — stall check interval (default 10_000)
 * @param {number} [opts.stallThresholdMs] — stall threshold (default 30_000)
 * @returns {Promise<object>} createResult-shaped object
 */
export async function runProcess(command, workdir, timeout, opts = {}) {
  const startedAt = Date.now();
  const inferStallMode = opts.inferStallMode || (() => 'timeout');
  const stallCheckIntervalMs = opts.stallCheckIntervalMs ?? 10_000;
  const stallThresholdMs = opts.stallThresholdMs ?? 30_000;
  const resultFile = opts.resultFile || null;

  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let failureMode = null;
  let child;

  try {
    child = spawn(command, { cwd: workdir, shell: true, windowsHide: true });
  } catch (error) {
    return createResult(false, { stderr: String(error?.message || error), duration: Date.now() - startedAt });
  }

  let lastBytes = 0;
  let lastChange = Date.now();
  const touch = () => { lastChange = Date.now(); };
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); touch(); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); touch(); });
  child.on('error', (error) => { stderr += String(error?.message || error); failureMode ||= 'crash'; });

  const stopFor = async (mode) => {
    if (failureMode) return;
    failureMode = mode;
    await terminateChild(child.pid);
  };

  const timeoutTimer = setTimeout(() => { void stopFor('timeout'); }, timeout);
  const stallTimer = setInterval(() => {
    const size = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    if (size !== lastBytes) {
      lastBytes = size;
      return;
    }
    if (Date.now() - lastChange >= stallThresholdMs) void stopFor(inferStallMode(stdout, stderr));
  }, stallCheckIntervalMs);
  timeoutTimer.unref?.();
  stallTimer.unref?.();

  await new Promise((resolve) => child.on('close', (code) => { exitCode = code; resolve(); }));
  clearTimeout(timeoutTimer);
  clearInterval(stallTimer);

  const fileOutput = resultFile && existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '';
  const output = fileOutput || stdout;
  const ok = failureMode == null && exitCode === 0;
  return createResult(ok, {
    output,
    stderr,
    exitCode,
    duration: Date.now() - startedAt,
    failureMode: ok ? null : (failureMode || 'crash'),
  });
}
