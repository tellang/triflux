// hub/workers/gemini-worker.mjs — Gemini headless subprocess 래퍼
// ADR-006: --output-format stream-json 기반 단발 실행 워커.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import readline from 'node:readline';
import { IS_WINDOWS } from '../platform.mjs';
import { toStringList, safeJsonParse, createWorkerError, DEFAULT_TIMEOUT_MS, DEFAULT_KILL_GRACE_MS } from './worker-utils.mjs';

function appendTextFragments(value, parts) {
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
  if (typeof value === 'object') {
    if (typeof value.text === 'string') appendTextFragments(value.text, parts);
    if (typeof value.response === 'string') appendTextFragments(value.response, parts);
    if (typeof value.result === 'string') appendTextFragments(value.result, parts);
    if (typeof value.content === 'string' || Array.isArray(value.content) || value.content) {
      appendTextFragments(value.content, parts);
    }
    if (value.message) appendTextFragments(value.message, parts);
  }
}

function extractText(event) {
  const parts = [];
  appendTextFragments(event, parts);
  return parts.join('\n').trim();
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

function resolveSpawnCommand(command, env = process.env) {
  const raw = String(command ?? '').trim();
  if (!raw || !IS_WINDOWS) return raw;

  const pathExts = (env.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const extensions = extname(raw)
    ? ['']
    : [...new Set(['.cmd', '.exe', '.bat', ...pathExts, ''])];

  const tryResolve = (base) => {
    for (const ext of extensions) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };

  if (raw.includes('\\') || raw.includes('/')) {
    return tryResolve(raw.replaceAll('/', '\\')) || raw;
  }

  const pathEntries = String(env.PATH || process.env.PATH || '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const resolved = tryResolve(join(entry, raw));
    if (resolved) return resolved;
  }

  return raw;
}

function quoteWindowsCmdArg(value) {
  const raw = String(value ?? '');
  if (raw.length === 0) return '""';

  const escaped = raw
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1');

  return /[\s"&()<>^|]/.test(raw)
    ? `"${escaped}"`
    : escaped;
}

function quotePosixShellArg(value) {
  const raw = String(value ?? '');
  return `'${raw.replaceAll("'", `'\"'\"'`)}'`;
}

function toBashPath(value) {
  return String(value ?? '')
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

function buildSpawnSpec(command, args, env = process.env) {
  const resolvedCommand = resolveSpawnCommand(command, env);

  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(resolvedCommand)) {
    const commandLine = [resolvedCommand, ...args]
      .map((part) => quoteWindowsCmdArg(part))
      .join(' ');

    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
      resolvedCommand,
    };
  }

  if (IS_WINDOWS && !extname(resolvedCommand) && existsSync(resolvedCommand)) {
    const bashCommand = env.TFX_BASH_BIN || env.BASH || 'bash';
    const commandLine = [toBashPath(resolvedCommand), ...args]
      .map((part) => quotePosixShellArg(part))
      .join(' ');

    return {
      command: bashCommand,
      args: ['-lc', commandLine],
      resolvedCommand,
    };
  }

  return {
    command: resolvedCommand,
    args,
    resolvedCommand,
  };
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
    this._terminateChild(child);
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

  _terminateChild(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}

    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, this.killGraceMs);
    timer.unref?.();
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
    const env = { ...this.env, ...(options.env || {}) };
    const spawnSpec = buildSpawnSpec(this.command, args, env);

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd || this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
      this._terminateChild(child);
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
        .filter((event) => (
          event?.type === 'assistant'
          || (event?.type === 'message' && event?.role === 'assistant')
        ))
        .map((event) => extractText(event))
        .filter(Boolean),
      ...stdoutLines.filter((line) => line.trim() !== '""'),
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    const result = {
      type: 'gemini',
      command: spawnSpec.resolvedCommand,
      args: spawnSpec.args,
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
    try {
      const result = await this.run(prompt, options);
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
        raw: error.result || null,
      };
    }
  }
}
