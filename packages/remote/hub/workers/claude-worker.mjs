// hub/workers/claude-worker.mjs — Claude stream-json subprocess 래퍼
// ADR-007: --input-format/--output-format stream-json 기반 세션 워커.

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

function findSessionId(event) {
  return event?.session_id
    || event?.sessionId
    || event?.message?.session_id
    || event?.message?.sessionId
    || null;
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

function isClaudeRetryable(error) {
  return error?.code === 'WORKER_EXIT'
    || error?.code === 'ETIMEDOUT'
    || error?.code === 'WORKER_STDIN_CLOSED';
}

function detectClaudeCategory(error) {
  const combined = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();

  if (/(unauthorized|forbidden|auth|login|token|credential|apikey|api key)/.test(combined)) {
    return 'auth';
  }
  if (/unknown option|invalid option|config|permission-mode|mcp-config/.test(combined)) {
    return 'config';
  }
  if (/stdin|prompt|input/.test(combined) && error?.code !== 'WORKER_STDIN_CLOSED') {
    return 'input';
  }

  return 'transient';
}

function buildClaudeErrorInfo(error, attempts) {
  const category = detectClaudeCategory(error);
  let recovery = 'Restart the Claude worker session and retry the turn.';

  if (category === 'auth') {
    recovery = 'Refresh the Claude authentication state and retry.';
  } else if (category === 'config') {
    recovery = 'Check the Claude CLI flags, MCP configuration, and permission settings.';
  } else if (category === 'input') {
    recovery = 'Check the Claude request payload before retrying.';
  }

  return Object.freeze({
    code: error?.code || 'CLAUDE_EXECUTION_ERROR',
    retryable: isClaudeRetryable(error),
    attempts,
    category,
    recovery,
  });
}

function buildClaudeArgs(worker, options) {
  const args = [...worker.commandArgs];

  args.push('--print');
  args.push('--input-format', 'stream-json');
  args.push('--output-format', 'stream-json');

  if (options.includePartialMessages) args.push('--include-partial-messages');
  if (options.replayUserMessages) args.push('--replay-user-messages');
  if (options.model) args.push('--model', options.model);
  if (options.allowDangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);

  for (const config of toStringList(options.mcpConfig)) {
    args.push('--mcp-config', config);
  }

  if (worker.resumeSessionId) {
    args.push('--resume', worker.resumeSessionId);
  }

  args.push(...toStringList(options.extraArgs));

  return args;
}

/**
 * Claude stream-json 세션 워커
 */
export class ClaudeWorker {
  type = 'claude';

  constructor(options = {}) {
    this.command = options.command || 'claude';
    this.commandArgs = toStringList(options.commandArgs || options.args);
    this.cwd = options.cwd || process.cwd();
    this.env = { ...process.env, ...(options.env || {}) };
    this.model = options.model || null;
    this.permissionMode = options.permissionMode || null;
    this.allowDangerouslySkipPermissions = options.allowDangerouslySkipPermissions !== false;
    this.includePartialMessages = options.includePartialMessages === true;
    this.replayUserMessages = options.replayUserMessages !== false;
    this.mcpConfig = toStringList(options.mcpConfig);
    this.extraArgs = toStringList(options.extraArgs);
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.killGraceMs = Number(options.killGraceMs) > 0 ? Number(options.killGraceMs) : DEFAULT_KILL_GRACE_MS;
    this.retryOptions = normalizeRetryOptions(options.retryOptions);
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    this.controlRequestHandler = typeof options.controlRequestHandler === 'function'
      ? options.controlRequestHandler
      : null;

    this.state = 'idle';
    this.child = null;
    this.stdoutReader = null;
    this.stderrReader = null;
    this.pendingTurn = null;
    this.history = [];
    this.events = [];
    this.stderrLines = [];
    this.sessionId = null;
    this.resumeSessionId = null;
    this.lastTurn = null;
    this._closePromise = null;
  }

  getStatus() {
    return {
      type: 'claude',
      state: this.state,
      pid: this.child?.pid || null,
      session_id: this.sessionId,
      history_length: this.history.length,
      last_turn_at_ms: this.lastTurn?.finishedAtMs || null,
    };
  }

  _writeFrame(frame) {
    if (!this.child?.stdin?.writable) {
      throw createWorkerError('Claude worker stdin is not writable', { code: 'WORKER_STDIN_CLOSED' });
    }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  _terminateChild(child) {
    terminateChild(child, this.killGraceMs);
  }

  async _handleControlRequest(event) {
    let responseFrame = null;

    if (this.controlRequestHandler) {
      responseFrame = await this.controlRequestHandler(event, { worker: this });
    } else {
      const requestId = event.request_id || event.requestId;
      if (!requestId) return;

      const successPayload = event.subtype === 'can_use_tool'
        ? { decision: 'allow', allowed: true }
        : { acknowledged: true, subtype: event.subtype || 'unknown' };

      responseFrame = {
        type: 'control_response',
        response: {
          request_id: requestId,
          subtype: 'success',
          response: successPayload,
        },
      };
    }

    if (responseFrame) {
      this._writeFrame(responseFrame);
    }
  }

  _finalizePendingTurn(turn, event) {
    if (!turn || turn.completed) return;

    turn.completed = true;
    clearTimeout(turn.timeout);
    this.pendingTurn = null;

    const response = [
      ...turn.assistantTexts,
      extractText(event),
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    if (response) {
      this.history.push({
        role: 'assistant',
        content: response,
        at_ms: Date.now(),
      });
    }

    const result = {
      type: 'claude',
      sessionId: this.sessionId,
      response,
      assistantEvents: turn.assistantEvents,
      resultEvent: event,
      stderr: this.stderrLines.join('\n').trim(),
      history: [...this.history],
      startedAtMs: turn.startedAtMs,
      finishedAtMs: Date.now(),
      durationMs: Date.now() - turn.startedAtMs,
    };

    this.lastTurn = result;
    turn.resolve(result);
  }

  _rejectPendingTurn(error) {
    if (!this.pendingTurn || this.pendingTurn.completed) return;
    const turn = this.pendingTurn;
    turn.completed = true;
    clearTimeout(turn.timeout);
    this.pendingTurn = null;
    turn.reject(error);
  }

  _handleStdoutLine(line) {
    if (!line) return;
    const event = safeJsonParse(line);
    if (!event) return;

    this.events.push(event);
    const sessionId = findSessionId(event);
    if (sessionId) {
      this.sessionId = sessionId;
      this.resumeSessionId = sessionId;
    }

    if (this.onEvent) {
      try { this.onEvent(event); } catch {}
    }

    if (event.type === 'control_request') {
      void this._handleControlRequest(event);
      return;
    }

    if (event.type === 'assistant' || event.type === 'streamlined_text') {
      const text = extractText(event);
      if (this.pendingTurn && text) {
        this.pendingTurn.assistantTexts.push(text);
        this.pendingTurn.assistantEvents.push(event);
      }
      return;
    }

    if (event.type === 'result' && this.pendingTurn) {
      this._finalizePendingTurn(this.pendingTurn, event);
    }
  }

  async start() {
    if (this.child && this.child.exitCode === null) {
      return this.getStatus();
    }

    const args = buildClaudeArgs(this, {
      model: this.model,
      permissionMode: this.permissionMode,
      allowDangerouslySkipPermissions: this.allowDangerouslySkipPermissions,
      includePartialMessages: this.includePartialMessages,
      replayUserMessages: this.replayUserMessages,
      mcpConfig: this.mcpConfig,
      extraArgs: this.extraArgs,
    });

    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child = child;
    this.state = 'ready';
    this.stderrLines = [];
    this.stdoutReader = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stderrReader = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on('line', (line) => this._handleStdoutLine(line));
    this.stderrReader.on('line', (line) => {
      if (!line) return;
      this.stderrLines.push(line);
    });

    this._closePromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        const closeError = code === 0
          ? null
          : createWorkerError(`Claude worker exited with code ${code}`, {
              code: 'WORKER_EXIT',
              exitCode: code,
              exitSignal: signal,
              stderr: this.stderrLines.join('\n').trim(),
            });

        this.child = null;
        this.state = 'idle';
        try { this.stdoutReader?.close(); } catch {}
        try { this.stderrReader?.close(); } catch {}
        this.stdoutReader = null;
        this.stderrReader = null;
        if (closeError) this._rejectPendingTurn(closeError);
        resolve({ code, signal });
      });
    });

    return this.getStatus();
  }

  async stop() {
    if (!this.child) {
      this.state = 'stopped';
      return this.getStatus();
    }

    const child = this.child;
    this._terminateChild(child);
    await Promise.race([
      this._closePromise,
      new Promise((resolve) => setTimeout(resolve, this.killGraceMs + 50)),
    ]);

    this.child = null;
    this.state = 'stopped';
    return this.getStatus();
  }

  async restart() {
    await this.stop();
    this.state = 'idle';
    return this.start();
  }

  async run(prompt, options = {}) {
    await this.start();

    if (this.pendingTurn) {
      throw createWorkerError('ClaudeWorker is already handling another turn', { code: 'WORKER_BUSY' });
    }

    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs;
    const userText = String(prompt ?? '');
    const startedAtMs = Date.now();

    this.history.push({
      role: 'user',
      content: userText,
      at_ms: startedAtMs,
    });

    const turnPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutError = createWorkerError(`Claude worker timed out after ${timeoutMs}ms`, {
          code: 'ETIMEDOUT',
          stderr: this.stderrLines.join('\n').trim(),
        });
        this._rejectPendingTurn(timeoutError);
        this._terminateChild(this.child);
      }, timeoutMs);
      timeout.unref?.();

      this.pendingTurn = {
        startedAtMs,
        assistantTexts: [],
        assistantEvents: [],
        timeout,
        resolve,
        reject,
        completed: false,
      };
    });

    this.state = 'running';
    this._writeFrame({
      type: 'user',
      message: {
        role: 'user',
        content: userText,
      },
    });

    try {
      return await turnPromise;
    } finally {
      if (this.child) {
        this.state = 'ready';
      }
    }
  }

  isReady() {
    return this.state === 'ready' || this.state === 'running';
  }

  async execute(prompt, options = {}) {
    let attempts = 0;

    try {
      const result = await withRetry(async () => {
        attempts += 1;
        if (attempts > 1) {
          await this.restart();
        }
        return this.run(prompt, options);
      }, {
        ...this.retryOptions,
        shouldRetry: (error) => isClaudeRetryable(error),
      });

      return {
        output: result.response,
        exitCode: 0,
        threadId: null,
        sessionKey: options.sessionKey || this.sessionId || null,
        raw: result,
      };
    } catch (error) {
      return {
        output: error.stderr || error.message || 'Claude worker failed',
        exitCode: error.code === 'ETIMEDOUT' ? 124 : 1,
        threadId: null,
        sessionKey: options.sessionKey || this.sessionId || null,
        error: buildClaudeErrorInfo(error, attempts || 1),
        raw: null,
      };
    }
  }
}
