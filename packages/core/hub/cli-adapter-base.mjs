// hub/cli-adapter-base.mjs — codex/gemini 공통 CLI adapter 인터페이스
// Phase 2: codex-adapter.mjs에서 추출한 재사용 가능 유틸리티

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { killProcess, IS_WINDOWS } from './platform.mjs';

// ── Codex CLI compatibility ─────────────────────────────────────

let _cachedVersion = null;

/**
 * `codex --version` 실행 결과를 파싱하여 마이너 버전 숫자 반환.
 * 파싱 실패 시 0 반환 (구버전으로 간주).
 * @returns {number} 마이너 버전 (예: 0.117.0 → 117)
 */
export function getCodexVersion() {
  if (_cachedVersion !== null) return _cachedVersion;
  try {
    const out = execSync('codex --version', { encoding: 'utf8', timeout: 5000 }).trim();
    const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
    _cachedVersion = match ? Number.parseInt(match[2], 10) : 0;
  } catch {
    _cachedVersion = 0;
  }
  return _cachedVersion;
}

/**
 * 최소 마이너 버전 이상인지 확인.
 * @param {number} minMinor
 * @returns {boolean}
 */
export function gte(minMinor) {
  return getCodexVersion() >= minMinor;
}

/**
 * Codex CLI 기능별 분기 객체.
 * 117 = 0.117.0 (Rust 리라이트, exec 서브커맨드 도입)
 */
export const FEATURES = {
  /** exec 서브커맨드 사용 가능 여부 */
  get execSubcommand() { return gte(117); },
  /** --output-last-message 플래그 지원 여부 */
  get outputLastMessage() { return gte(117); },
  /** --color never 플래그 지원 여부 */
  get colorNever() { return gte(117); },
  /** 플러그인 시스템 지원 여부 (향후 확장용) */
  get pluginSystem() { return gte(120); },
};

// ── Shell utilities ─────────────────────────────────────────────

export function normalizePathForShell(value) {
  return IS_WINDOWS ? String(value).replace(/\\/g, '/') : String(value);
}

export function shellQuote(value) {
  return JSON.stringify(String(value));
}

export function escapePwshSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

export const CODEX_MCP_TRANSPORT_EXIT_CODE = 70;
export const CODEX_MCP_EXECUTION_EXIT_CODE = 1;

/**
 * long-form 플래그 기반 명령 빌더.
 * @param {string} prompt
 * @param {string|null} resultFile — null이면 --output-last-message 생략
 * @param {{ profile?: string, skipGitRepoCheck?: boolean, sandboxBypass?: boolean, cwd?: string, mcpServers?: string[] }} [opts]
 * @returns {string} 실행할 셸 커맨드
 */
export function buildExecCommand(prompt, resultFile = null, opts = {}) {
  const { profile, skipGitRepoCheck = true, sandboxBypass = true, cwd, mcpServers } = opts;

  const parts = ['codex'];
  if (profile) parts.push('--profile', profile);

  if (FEATURES.execSubcommand) {
    parts.push('exec');
    if (sandboxBypass) parts.push('--dangerously-bypass-approvals-and-sandbox');
    if (skipGitRepoCheck) parts.push('--skip-git-repo-check');
    if (resultFile && FEATURES.outputLastMessage) {
      parts.push('--output-last-message', resultFile);
    }
    if (FEATURES.colorNever) parts.push('--color', 'never');
    if (cwd) parts.push('--cwd', `'${escapePwshSingleQuoted(cwd)}'`);
    if (Array.isArray(mcpServers)) {
      for (const server of mcpServers) {
        parts.push('-c', `mcp_servers.${server}.enabled=true`);
      }
    }
  } else {
    parts.push('--dangerously-bypass-approvals-and-sandbox');
    if (skipGitRepoCheck) parts.push('--skip-git-repo-check');
  }

  parts.push(JSON.stringify(prompt));
  return parts.join(' ');
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
