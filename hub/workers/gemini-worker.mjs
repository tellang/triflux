// hub/workers/gemini-worker.mjs — Gemini headless subprocess 래퍼
// ADR-006: --output-format stream-json 기반 단발 실행 워커.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { extractText, terminateChild, withRetry } from './worker-utils.mjs';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 1000;

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function findLastEvent(events, predicate) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index];
  }
  return null;
}

function buildGeminiArgs(options) {
  const args = [];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.approvalMode) {
    args.push('--approval-mode', options.approvalMode);
  } else if (options.yolo !== false) {
    args.push('--yolo');
  }

  const allowedMcpServers = toStringList(options.allowedMcpServerNames);
  if (allowedMcpServers.length) {
    args.push('--allowed-mcp-server-names', ...allowedMcpServers);
  }

  const extraArgs = toStringList(options.extraArgs);
  if (extraArgs.length) args.push(...extraArgs);

  args.push('--prompt', options.promptArgument ?? '');
  args.push('--output-format', 'stream-json');

  return args;
}

function createWorkerError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function normalizeRetryOptions(retryOptions) {
  if (!retryOptions || typeof retryOptions !== 'object') {
    return Object.freeze({});
  }
  return Object.freeze({ ...retryOptions });
}

function isGeminiRetryable(error) {
  return error?.code === 'WORKER_EXIT'
    && error?.result?.exitCode !== 0
    && error?.result?.exitCode !== 2;
}

function detectGeminiCategory(error) {
  const combined = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();

  if (/(unauthorized|forbidden|auth|login|token|credential|apikey|api key)/.test(combined)) {
    return 'auth';
  }
  if (error?.result?.exitCode === 2 || /expected stream-json|unknown option|invalid option|config/.test(combined)) {
    return 'config';
  }
  if (error?.code === 'WORKER_EVENT_ERROR') {
    return 'input';
  }

  return 'transient';
}

function buildGeminiErrorInfo(error, attempts) {
  const category = detectGeminiCategory(error);
  const retryable = isGeminiRetryable(error);
  let recovery = 'Retry the Gemini worker after correcting the reported issue.';

  if (category === 'auth') {
    recovery = 'Refresh the Gemini authentication state and retry.';
  } else if (category === 'config') {
    recovery = 'Check the Gemini CLI flags and worker configuration.';
  } else if (category === 'input') {
    recovery = 'Check the Gemini request payload and streamed event format.';
  }

  return Object.freeze({
    code: error?.code || 'GEMINI_EXECUTION_ERROR',
    retryable,
    attempts,
    category,
    recovery,
  });
}

/**
 * Gemini stream-json 래퍼
 */
export class GeminiWorker {
  type = 'gemini';

  constructor(options = {}) {
    this.command = options.command || 'gemini';
    this.commandArgs = toStringList(options.commandArgs || options.args);
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...(options.env || {}) };
    this.model = options.model || null;
    this.approvalMode = options.approvalMode || null;
    this.yolo = options.yolo !== false;
    this.allowedMcpServerNames = toStringList(options.allowedMcpServerNames);
    this.extraArgs = toStringList(options.extraArgs);
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.killGraceMs = Number(options.killGraceMs) > 0 ? Number(options.killGraceMs) : DEFAULT_KILL_GRACE_MS;
    this.retryOptions = normalizeRetryOptions(options.retryOptions);
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

    this.state = 'idle';
    this.child = null;
    this.lastRun = null;
  }

  getStatus() {
    return {
      type: 'gemini',
      state: this.state,
      pid: this.child?.pid || null,
      last_run_at_ms: this.lastRun?.finishedAtMs || null,
      last_exit_code: this.lastRun?.exitCode ?? null,
    };
  }

  async start() {
    if (this.state === 'stopped') {
      this.state = 'idle';
    }
    return this.getStatus();
  }

  async stop() {
    if (!this.child) {
      this.state = 'stopped';
      return this.getStatus();
    }
    const child = this.child;
    terminateChild(child, this.killGraceMs);
    await new Promise((resolve) => {
      child.once('close', resolve);
      setTimeout(resolve, this.killGraceMs + 50).unref?.();
    });
    this.child = null;
    this.state = 'stopped';
    return this.getStatus();
  }

  async restart() {
    await this.stop();
    this.state = 'idle';
    return this.getStatus();
  }

  async run(prompt, options = {}) {
    if (this.child) {
      throw createWorkerError('GeminiWorker is already running', { code: 'WORKER_BUSY' });
    }

    await this.start();

    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs;
    const startedAtMs = Date.now();
    const args = [
      ...this.commandArgs,
      ...buildGeminiArgs({
        model: options.model || this.model,
        approvalMode: options.approvalMode || this.approvalMode,
        yolo: options.yolo ?? this.yolo,
        allowedMcpServerNames: options.allowedMcpServerNames || this.allowedMcpServerNames,
        extraArgs: options.extraArgs || this.extraArgs,
        promptArgument: options.promptArgument ?? '',
      }),
    ];

    const child = spawn(this.command, args, {
      cwd: options.cwd || this.cwd,
      env: { ...this.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    this.child = child;
    this.state = 'running';

    const events = [];
    const stdoutLines = [];
    const stderrLines = [];
    let lastErrorEvent = null;
    let timedOut = false;
    let exitCode = null;
    let exitSignal = null;

    const stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    const stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });

    stdoutReader.on('line', (line) => {
      if (!line) return;
      const event = safeJsonParse(line);
      if (!event) {
        stdoutLines.push(line);
        return;
      }

      events.push(event);
      if (event.type === 'error') lastErrorEvent = event;
      if (this.onEvent) {
        try { this.onEvent(event); } catch {}
      }
    });

    stderrReader.on('line', (line) => {
      if (!line) return;
      stderrLines.push(line);
    });

    const closePromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child, this.killGraceMs);
    }, timeoutMs);
    timeout.unref?.();

    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt ?? ''));

    try {
      await closePromise;
    } finally {
      clearTimeout(timeout);
      stdoutReader.close();
      stderrReader.close();
      if (this.child === child) {
        this.child = null;
      }
      this.state = 'idle';
    }

    const resultEvent = findLastEvent(events, (event) => event?.type === 'result');
    const response = [
      extractText(resultEvent),
      ...events
        .filter((event) => event?.type === 'message' || event?.type === 'assistant')
        .map((event) => extractText(event))
        .filter(Boolean),
      ...stdoutLines,
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    const result = {
      type: 'gemini',
      command: this.command,
      args,
      response,
      events,
      resultEvent,
      usage: resultEvent?.usage || null,
      stdout: stdoutLines.join('\n').trim(),
      stderr: stderrLines.join('\n').trim(),
      exitCode,
      exitSignal,
      timedOut,
      startedAtMs,
      finishedAtMs: Date.now(),
    };

    this.lastRun = result;

    if (timedOut) {
      throw createWorkerError(`Gemini worker timed out after ${timeoutMs}ms`, {
        code: 'ETIMEDOUT',
        result,
        stderr: result.stderr,
      });
    }

    if (exitCode !== 0) {
      throw createWorkerError(`Gemini worker exited with code ${exitCode}`, {
        code: 'WORKER_EXIT',
        result,
        stderr: result.stderr,
      });
    }

    if (lastErrorEvent) {
      throw createWorkerError('Gemini worker emitted an error event', {
        code: 'WORKER_EVENT_ERROR',
        result,
        stderr: result.stderr,
      });
    }

    return result;
  }

  isReady() {
    return this.state !== 'stopped';
  }

  async execute(prompt, options = {}) {
    let attempts = 0;

    try {
      const result = await withRetry(async () => {
        attempts += 1;
        return this.run(prompt, options);
      }, {
        ...this.retryOptions,
        shouldRetry: (error) => isGeminiRetryable(error),
      });

      return {
        output: result.response,
        exitCode: 0,
        sessionKey: options.sessionKey || null,
        raw: result,
      };
    } catch (error) {
      return {
        output: error.stderr || error.message || 'Gemini worker failed',
        exitCode: error.code === 'ETIMEDOUT' ? 124 : 1,
        sessionKey: options.sessionKey || null,
        error: buildGeminiErrorInfo(error, attempts || 1),
        raw: error.result || null,
      };
    }
  }
}
