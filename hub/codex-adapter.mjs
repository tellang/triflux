import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPreflight } from './codex-preflight.mjs';
import { withRetry } from './workers/worker-utils.mjs';
import { killProcess, IS_WINDOWS } from './platform.mjs';
import { buildExecCommand } from './team/codex-compat.mjs';

const circuitBreaker = {
  failures: [],
  maxFailures: 3,
  windowMs: 10 * 60_000,
  openedAt: 0,
  trialInFlight: false,
};

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function pruneFailures(now = Date.now()) {
  circuitBreaker.failures = circuitBreaker.failures.filter((stamp) => now - stamp < circuitBreaker.windowMs);
}

function resetCircuit() {
  circuitBreaker.failures = [];
  circuitBreaker.openedAt = 0;
  circuitBreaker.trialInFlight = false;
}

function recordFailure(isHalfOpen, now = Date.now()) {
  pruneFailures(now);
  circuitBreaker.failures = [...circuitBreaker.failures, now];
  circuitBreaker.trialInFlight = false;
  if (isHalfOpen || circuitBreaker.failures.length >= circuitBreaker.maxFailures) {
    circuitBreaker.openedAt = now;
  }
}

export function getCircuitState(now = Date.now()) {
  pruneFailures(now);
  const withinWindow = circuitBreaker.openedAt && now - circuitBreaker.openedAt < circuitBreaker.windowMs;
  const state = withinWindow ? 'open' : (circuitBreaker.openedAt ? 'half-open' : 'closed');
  return {
    state,
    failures: [...circuitBreaker.failures],
    maxFailures: circuitBreaker.maxFailures,
    windowMs: circuitBreaker.windowMs,
    openedAt: circuitBreaker.openedAt || null,
    trialInFlight: circuitBreaker.trialInFlight,
  };
}

function normalizePathForShell(value) {
  return IS_WINDOWS ? String(value).replace(/\\/g, '/') : String(value);
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}

function createResult(ok, extra = {}) {
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

function appendWarnings(stderr, warnings = []) {
  const text = warnings.map((item) => `[preflight] ${item}`).join('\n');
  return [stderr, text].filter(Boolean).join('\n');
}

function inferStallMode(stdout, stderr) {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/(approval|approve|permission|sandbox|bypass)/u.test(text)) return 'approval_stall';
  if (/\bmcp\b|context7|playwright|tavily|exa|brave|sequential|server/u.test(text)) return 'mcp_stall';
  return 'timeout';
}

function commandWithOverrides(command, prompt, codexPath, overrides = []) {
  let next = codexPath ? command.replace(/^codex\b/u, shellQuote(codexPath)) : command;
  if (!overrides.length) return next;
  const promptArg = JSON.stringify(prompt);
  const flags = overrides.flatMap((value) => ['-c', shellQuote(value)]).join(' ');
  return next.endsWith(promptArg)
    ? `${next.slice(0, -promptArg.length)}${flags} ${promptArg}`
    : `${next} ${flags}`;
}

function buildOverrides(requested, excluded) {
  return [...new Set((requested || []).filter((name) => (excluded || []).includes(name)))]
    .map((name) => `mcp_servers.${name}.enabled=false`);
}

function buildAttempts(opts, preflight) {
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 300_000;
  const requested = Array.isArray(opts.mcpServers) ? [...opts.mcpServers] : [];
  const base = {
    timeout,
    profile: opts.profile,
    requested,
    excluded: [...(preflight.excludeMcpServers || [])],
    forceBypass: preflight.needsBypass,
  };
  if (opts.retryOnFail === false) return [base];
  return [
    base,
    { ...base, timeout: timeout * 2, excluded: requested, forceBypass: true },
  ];
}

function createLaunchScriptText(opts) {
  const parts = ['codex'];
  if (opts.profile) parts.push('--profile', shellQuote(opts.profile));
  parts.push(
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '$(cat "$PROMPT_FILE")',
  );
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `cd ${shellQuote(normalizePathForShell(opts.workdir))}`,
    `PROMPT_FILE=${shellQuote(normalizePathForShell(opts.promptFile))}`,
    `TFX_CODEX_TIMEOUT_MS=${shellQuote(String(opts.timeout ?? ''))}`,
    parts.join(' '),
    '',
  ].join('\n');
}

export function buildLaunchScript(opts = {}) {
  const dir = join(tmpdir(), 'triflux-codex-launch');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(opts.id || 'launch')}.sh`);
  writeFileSync(path, createLaunchScriptText(opts), 'utf8');
  return path;
}

async function terminateChild(pid) {
  if (!pid) return;
  killProcess(pid, { signal: 'SIGTERM', tree: true, timeout: 5000 });
  await sleep(5000);
  killProcess(pid, { signal: 'SIGKILL', tree: true, force: true, timeout: 5000 });
}

async function runAttempt(command, workdir, timeout, resultFile) {
  const startedAt = Date.now();
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
    if (Date.now() - lastChange >= 30_000) void stopFor(inferStallMode(stdout, stderr));
  }, 10_000);
  timeoutTimer.unref?.();
  stallTimer.unref?.();

  await new Promise((resolve) => child.on('close', (code) => { exitCode = code; resolve(); }));
  clearTimeout(timeoutTimer);
  clearInterval(stallTimer);

  const fileOutput = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '';
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

async function runCodex(prompt, workdir, preflight, attempt) {
  const dir = join(tmpdir(), 'triflux-codex-exec');
  mkdirSync(dir, { recursive: true });
  const resultFile = join(dir, `codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const command = commandWithOverrides(
    buildExecCommand(prompt, resultFile, {
      profile: attempt.profile,
      skipGitRepoCheck: true,
      sandboxBypass: attempt.forceBypass,
    }),
    prompt,
    preflight.codexPath,
    buildOverrides(attempt.requested, attempt.excluded),
  );
  return runAttempt(command, workdir, attempt.timeout, resultFile);
}

export async function execute(opts = {}) {
  const circuit = getCircuitState();
  if (circuit.state === 'open' || (circuit.state === 'half-open' && circuitBreaker.trialInFlight)) {
    return createResult(false, { fellBack: true, failureMode: 'circuit_open' });
  }

  const wasHalfOpen = circuit.state === 'half-open';
  circuitBreaker.trialInFlight = wasHalfOpen;

  const preflight = await runPreflight({ mcpServers: opts.mcpServers, subcommand: 'exec' });
  if (!preflight.ok) {
    circuitBreaker.trialInFlight = false;
    recordFailure(wasHalfOpen);
    return createResult(false, {
      stderr: appendWarnings('', preflight.warnings),
      fellBack: opts.fallbackToClaude !== false,
      failureMode: 'crash',
    });
  }

  const attempts = buildAttempts(opts, preflight);
  let attemptIndex = 0;
  let lastResult = createResult(false);

  try {
    lastResult = await withRetry(async () => {
      const result = await runCodex(opts.prompt || '', opts.workdir || process.cwd(), preflight, attempts[attemptIndex]);
      const current = { ...result, stderr: appendWarnings(result.stderr, preflight.warnings), retried: attemptIndex > 0 };
      const canRetry = !current.ok && attemptIndex < attempts.length - 1;
      attemptIndex += 1;
      if (!canRetry) return current;
      const error = new Error('retry');
      error.retryable = true;
      error.result = current;
      throw error;
    }, {
      maxAttempts: attempts.length,
      baseDelayMs: 250,
      maxDelayMs: 750,
      shouldRetry: (error) => error?.retryable === true,
    });
  } catch (error) {
    lastResult = error?.result || createResult(false, { stderr: String(error?.message || error) });
  }

  if (lastResult.ok) {
    resetCircuit();
    return lastResult;
  }

  recordFailure(wasHalfOpen);
  return {
    ...lastResult,
    retried: attempts.length > 1,
    fellBack: opts.fallbackToClaude !== false,
  };
}
