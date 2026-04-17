// hub/workers/codex-app-server-worker.mjs — Codex app-server JSON-RPC 2.0 worker
//
// Spawns `codex app-server --listen stdio://` and streams notifications as
// `agent.progress` publish events. Shares the `WorkerInterface` shape with
// `codex-mcp.mjs` for factory compatibility but uses a different transport.
//
// Phase 3 / PRD-2 — implements AC1..AC17 (except AC9 factory integration which
// lands in PRD-3 and AC11 regression which is purely "do not touch codex-mcp").

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import process from "node:process";

import {
  JsonRpcProtocolError,
  JsonRpcStdioClient,
  JsonRpcTransportError,
} from "./lib/jsonrpc-stdio.mjs";

// ── Exit codes ──────────────────────────────────────────────────
// Reuse codex-mcp convention so factory + retry logic can stay uniform.
export const CODEX_APP_SERVER_EXECUTION_EXIT_CODE = 1;
export const CODEX_APP_SERVER_TRANSPORT_EXIT_CODE = 70;
export const CODEX_APP_SERVER_TIMEOUT_EXIT_CODE = 124;

export const DEFAULT_CODEX_APP_SERVER_BOOTSTRAP_TIMEOUT_MS = 10_000;
export const DEFAULT_CODEX_APP_SERVER_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_UNKNOWN_METHOD_WARN_THRESHOLD = 5;
/**
 * How long stop() waits for `thread/unsubscribe` response before forcing
 * SIGTERM. Keep small — unsubscribe is a best-effort unload signal.
 */
export const UNSUBSCRIBE_DEADLINE_MS = 2_000;

// ── Error classes ───────────────────────────────────────────────

/**
 * Transport/bootstrap failures (spawn ENOENT, initialize timeout, stream close).
 */
export class CodexAppServerTransportError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, stderr?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "CodexAppServerTransportError";
    this.stderr = options.stderr || "";
  }
}

/**
 * Protocol-level failures (malformed JSON, max line exceeded, unresolved pending
 * requests on EOF).
 */
export class CodexAppServerProtocolError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "CodexAppServerProtocolError";
  }
}

// ── Protocol constants ──────────────────────────────────────────

/** 24 notification methods we forward as publish events. */
export const SUBSCRIBED_METHODS = Object.freeze(
  new Set([
    // thread lifecycle
    "thread/started",
    "thread/closed",
    "thread/tokenUsage/updated",
    "thread/compacted",
    // turn lifecycle
    "turn/started",
    "turn/completed",
    "turn/diff/updated",
    "turn/plan/updated",
    // item lifecycle
    "item/started",
    "item/completed",
    "item/autoApprovalReview/started",
    "item/autoApprovalReview/completed",
    // streaming deltas
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryPartAdded",
    "item/plan/delta",
    "item/mcpToolCall/progress",
    "command/exec/outputDelta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    // errors / model
    "error",
    "model/rerouted",
    "configWarning",
  ]),
);

/** 27 notification methods registered at initialize so codex never emits them. */
export const OPT_OUT_METHODS = Object.freeze([
  "skills/changed",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "account/login/completed",
  "app/list/updated",
  "fs/changed",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcriptUpdated",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "rawResponseItem/completed",
  "serverRequest/resolved",
  "hook/started",
  "hook/completed",
  "thread/archived",
  "thread/unarchived",
  "thread/name/updated",
  "deprecationNotice",
]);

/** Method → publish `kind` (13 distinct kinds). */
export const KIND_MAP = Object.freeze({
  "thread/started": "thread_status",
  "thread/closed": "thread_status",
  "thread/tokenUsage/updated": "thread_status",
  "thread/compacted": "thread_status",
  "turn/started": "turn_status",
  "turn/completed": "turn_status",
  "turn/diff/updated": "turn_status",
  "turn/plan/updated": "turn_status",
  "item/started": "item_status",
  "item/completed": "item_status",
  "item/autoApprovalReview/started": "approval_review",
  "item/autoApprovalReview/completed": "approval_review",
  "item/agentMessage/delta": "text_delta",
  "item/reasoning/summaryTextDelta": "thinking_delta",
  "item/reasoning/textDelta": "thinking_delta",
  "item/reasoning/summaryPartAdded": "thinking_delta",
  "item/plan/delta": "plan_delta",
  "item/mcpToolCall/progress": "tool_progress",
  "command/exec/outputDelta": "exec_delta",
  "item/commandExecution/outputDelta": "exec_delta",
  "item/commandExecution/terminalInteraction": "terminal_interaction",
  "item/fileChange/outputDelta": "file_delta",
  error: "error",
  "model/rerouted": "error",
  configWarning: "error",
});

export const DEFAULT_CODEX_APP_SERVER_ARGS = Object.freeze([
  "--skip-git-repo-check",
  "app-server",
  "--listen",
  "stdio://",
]);

// ── Helpers ─────────────────────────────────────────────────────

function cloneEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  );
}

/**
 * Strictly monotonic `Date.now()` — if two publishes collide in the same tick we
 * bump by 1 ms. Keeps AC12 simple without `performance.now` float math.
 */
function createMonotonicClock() {
  let last = 0;
  return () => {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}

/**
 * Walk a publish `data` payload and hash any string longer than 32 chars (AC17).
 * Short identifiers (ids, statuses) are kept readable.
 */
function redactDeep(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length <= 32) return value;
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function buildSpawnOptions({ cwd, env, command }) {
  return {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // Windows needs shell for PATHEXT/ENOENT resolution when command is not absolute
    shell: process.platform === "win32" && !isAbsolute(command),
    windowsHide: true,
  };
}

function buildInitializeParams(clientInfo) {
  return {
    clientInfo,
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [...OPT_OUT_METHODS],
    },
  };
}

function buildThreadStartParams(opts = {}) {
  const params = {
    sandbox: opts.sandbox || "read-only",
    approvalPolicy: opts.approvalPolicy || "never",
    ephemeral: true,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  };
  if (typeof opts.model === "string" && opts.model) params.model = opts.model;
  if (typeof opts.profile === "string" && opts.profile) {
    params.serviceName = opts.profile;
  }
  if (opts.config && typeof opts.config === "object") params.config = opts.config;
  if (typeof opts.cwd === "string" && opts.cwd) params.cwd = opts.cwd;
  if (typeof opts.baseInstructions === "string" && opts.baseInstructions) {
    params.baseInstructions = opts.baseInstructions;
  }
  if (
    typeof opts.developerInstructions === "string" &&
    opts.developerInstructions
  ) {
    params.developerInstructions = opts.developerInstructions;
  }
  return params;
}

function buildTurnStartParams(threadId, prompt) {
  return {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
  };
}

function buildWorkerError(code, message, attempts = 1) {
  return Object.freeze({
    code,
    retryable: code === "CODEX_APP_SERVER_TRANSPORT_ERROR",
    attempts,
    category:
      code === "INVALID_INPUT"
        ? "input"
        : code === "CODEX_APP_SERVER_TRANSPORT_ERROR"
          ? "transient"
          : "config",
    recovery:
      code === "INVALID_INPUT"
        ? "Provide a non-empty prompt before invoking the Codex app-server worker."
        : "Review the codex app-server stderr tail and retry.",
    message,
  });
}

function extractThreadIdFromStartResponse(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.threadId === "string") return result.threadId;
  if (result.thread && typeof result.thread.id === "string") {
    return result.thread.id;
  }
  return null;
}

function extractThreadIdFromStartedNotif(params) {
  if (!params || typeof params !== "object") return null;
  if (typeof params.threadId === "string") return params.threadId;
  if (params.thread && typeof params.thread.id === "string") {
    return params.thread.id;
  }
  return null;
}

// ── Worker class ────────────────────────────────────────────────

/**
 * Codex app-server worker.
 * @implements {import('./interface.mjs').IWorker}
 */
export class CodexAppServerWorker {
  type = "codex";
  transport = "app-server";

  /**
   * @param {object} [options]
   * @param {string} [options.command]
   * @param {string[]} [options.args]
   * @param {string} [options.cwd]
   * @param {Record<string, string>} [options.env]
   * @param {{ name: string, version: string }} [options.clientInfo]
   * @param {number} [options.bootstrapTimeoutMs]
   * @param {(msg: object) => void | Promise<void>} [options.publishCallback]
   * @param {string} [options.workerId]
   * @param {(command: string, args: string[], options: object) => import('node:child_process').ChildProcess} [options.spawnFn]
   * @param {boolean} [options.redactSensitive]
   * @param {number} [options.unknownMethodWarnThreshold]
   * @param {(method: string) => void} [options.onUnknownMethod]
   * @param {(label: string, payload: object) => void} [options.warn]
   */
  constructor(options = {}) {
    this.command = options.command || process.env.CODEX_BIN || "codex";
    this.args =
      Array.isArray(options.args) && options.args.length
        ? [...options.args]
        : [...DEFAULT_CODEX_APP_SERVER_ARGS];
    this.cwd = options.cwd || process.cwd();
    this.env = cloneEnv({ ...cloneEnv(process.env), ...cloneEnv(options.env) });
    this.clientInfo = options.clientInfo || {
      name: "triflux-codex-app-server",
      version: "1.0.0",
    };
    this.bootstrapTimeoutMs = Number.isFinite(options.bootstrapTimeoutMs)
      ? options.bootstrapTimeoutMs
      : DEFAULT_CODEX_APP_SERVER_BOOTSTRAP_TIMEOUT_MS;
    this.publishCallback =
      typeof options.publishCallback === "function"
        ? options.publishCallback
        : null;
    this.workerId = options.workerId || `codex-app-server-${randomUUID()}`;
    this._spawnFn = options.spawnFn || spawn;
    this._JsonRpcClientClass =
      typeof options.jsonRpcClientClass === "function"
        ? options.jsonRpcClientClass
        : JsonRpcStdioClient;
    this.redactSensitive =
      options.redactSensitive === true ||
      process.env.TFX_CODEX_REDACT === "1";
    this.unknownMethodWarnThreshold = Number.isFinite(
      options.unknownMethodWarnThreshold,
    )
      ? options.unknownMethodWarnThreshold
      : DEFAULT_UNKNOWN_METHOD_WARN_THRESHOLD;
    this._warn =
      typeof options.warn === "function"
        ? options.warn
        : (label, payload) => {
            // biome-ignore lint/suspicious/noConsole: defensive warn-once path
            console.warn(`[codex-app-server] ${label}`, payload);
          };
    this._onUnknownMethod =
      typeof options.onUnknownMethod === "function"
        ? options.onUnknownMethod
        : null;

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {JsonRpcStdioClient | null} */
    this.client = null;
    this.ready = false;
    /** Ring buffer of the last 16 KB of stderr for diagnostics. */
    this.serverStderr = "";
    /** @type {string | null} */
    this.activeThreadId = null;
    this._warnedUnknown = new Set();
    this._monotonicNow = createMonotonicClock();
    this._publishQueue = [];
    this._publishMaxQueue = 64;
    /** @type {Function | null} */
    this._rejectBootstrap = null;
    /**
     * Issue #95 P1 #2 — in-flight execute fail-fast registry.
     * Each execute() registers `(err) => void` here; child `exit`/`error`
     * and JsonRpcTransport/ProtocolError hook drain this to reject immediately
     * instead of waiting for timeoutMs.
     * @type {Set<(err: Error) => void>}
     */
    this._inflightRejectors = new Set();
    /** Unsubscribe for child exit/error listeners wired in start(). */
    this._detachChildLifecycle = null;
  }

  isReady() {
    return this.ready === true;
  }

  /**
   * Spawn the codex app-server child, wire JsonRpcStdioClient, and complete the
   * initialize/initialized handshake.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.ready) return;
    await this.stop().catch(() => {});

    let child;
    try {
      child = this._spawnFn(
        this.command,
        this.args,
        buildSpawnOptions({
          cwd: this.cwd,
          env: this.env,
          command: this.command,
        }),
      );
    } catch (error) {
      throw new CodexAppServerTransportError(
        `codex app-server spawn 실패: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (!child || !child.stdin || !child.stdout) {
      throw new CodexAppServerTransportError(
        "codex app-server 자식 프로세스의 stdio 핸들을 가져오지 못했습니다.",
      );
    }

    this.child = child;
    this.serverStderr = "";
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        this.serverStderr += String(chunk);
        if (this.serverStderr.length > 16_000) {
          this.serverStderr = this.serverStderr.slice(-16_000);
        }
      });
    }

    const spawnErrorPromise = new Promise((_, reject) => {
      const onError = (err) => {
        reject(
          new CodexAppServerTransportError(
            `codex app-server 프로세스 오류: ${err?.message || err}`,
            { cause: err, stderr: this.serverStderr },
          ),
        );
      };
      const onExit = (code, signal) => {
        if (this.ready) return;
        reject(
          new CodexAppServerTransportError(
            `codex app-server 프로세스가 조기 종료됨 (code=${code}, signal=${signal || ""})`,
            { stderr: this.serverStderr },
          ),
        );
      };
      child.once("error", onError);
      child.once("exit", onExit);
      this._rejectBootstrap = (err) => {
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        reject(err);
      };
    });

    const JsonRpcClientCtor = this._JsonRpcClientClass;
    this.client = new JsonRpcClientCtor({
      stdin: child.stdout,
      stdout: child.stdin,
      onError: (err) => {
        this._warn("jsonrpc error", { message: err?.message || String(err) });
        // P1 #2 / P1 #3 fail-fast: structural protocol/transport errors during
        // an active turn must reject in-flight execute() immediately instead of
        // silently hanging until timeoutMs. Parse noise without in-flight work
        // stays warn-only via _warn above.
        if (
          (err instanceof JsonRpcProtocolError ||
            err instanceof JsonRpcTransportError) &&
          this._inflightRejectors.size > 0
        ) {
          const transportErr = new CodexAppServerTransportError(
            `codex app-server transport error: ${err.message}`,
            { cause: err, stderr: this.serverStderr },
          );
          this._drainInflight(transportErr);
        }
      },
    });

    // Initialize handshake with timeout.
    const initPromise = this.client.request(
      "initialize",
      buildInitializeParams(this.clientInfo),
      this.bootstrapTimeoutMs,
    );

    try {
      await Promise.race([initPromise, spawnErrorPromise]);
    } catch (error) {
      await this.stop().catch(() => {});
      if (error instanceof CodexAppServerTransportError) throw error;
      throw new CodexAppServerTransportError(
        `codex app-server initialize 실패: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error, stderr: this.serverStderr },
      );
    }

    this._rejectBootstrap = null;
    try {
      this.client.notify("initialized", {});
    } catch (error) {
      await this.stop().catch(() => {});
      throw new CodexAppServerTransportError(
        `codex app-server initialized notification 실패: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error, stderr: this.serverStderr },
      );
    }

    // P1 #2: post-bootstrap lifecycle listeners. Once the handshake succeeds
    // (`ready=true`) the spawn-time `once("exit"/"error")` handlers are
    // consumed by `_rejectBootstrap` — we now install long-lived listeners so
    // that a mid-turn child crash rejects in-flight execute() immediately.
    const onPostBootstrapError = (err) => {
      const transportErr = new CodexAppServerTransportError(
        `codex app-server 프로세스 오류 (mid-turn): ${err?.message || err}`,
        { cause: err, stderr: this.serverStderr },
      );
      this._drainInflight(transportErr);
    };
    const onPostBootstrapExit = (code, signal) => {
      this.ready = false;
      if (this._inflightRejectors.size === 0) return;
      const transportErr = new CodexAppServerTransportError(
        `codex app-server 프로세스가 턴 중 종료됨 (code=${code}, signal=${signal || ""})`,
        { stderr: this.serverStderr },
      );
      this._drainInflight(transportErr);
    };
    child.on("error", onPostBootstrapError);
    child.on("exit", onPostBootstrapExit);
    this._detachChildLifecycle = () => {
      try {
        child.removeListener("error", onPostBootstrapError);
      } catch {}
      try {
        child.removeListener("exit", onPostBootstrapExit);
      } catch {}
    };

    this.ready = true;
  }

  /**
   * Fail-fast hook: reject every registered in-flight execute() with `err`.
   * Called on child exit/error, transport/protocol error, or stop().
   * @param {Error} err
   */
  _drainInflight(err) {
    if (this._inflightRejectors.size === 0) return;
    const rejectors = [...this._inflightRejectors];
    this._inflightRejectors.clear();
    for (const reject of rejectors) {
      try {
        reject(err);
      } catch {
        /* never throw out of fail-fast path */
      }
    }
  }

  /**
   * Run a single prompt through `thread/start` + `turn/start` and resolve when
   * the turn completes (or errors out).
   * @param {string} prompt
   * @param {import('./interface.mjs').WorkerExecuteOptions} [opts]
   * @returns {Promise<import('./interface.mjs').WorkerResult>}
   */
  async execute(prompt, opts = {}) {
    const sessionKey =
      typeof opts.sessionKey === "string" && opts.sessionKey
        ? opts.sessionKey
        : null;

    if (typeof prompt !== "string" || !prompt.trim()) {
      return {
        output: "prompt는 비어 있을 수 없습니다.",
        exitCode: CODEX_APP_SERVER_EXECUTION_EXIT_CODE,
        threadId: null,
        sessionKey,
        error: buildWorkerError(
          "INVALID_INPUT",
          "prompt는 비어 있을 수 없습니다.",
        ),
        raw: null,
      };
    }

    try {
      await this.start();
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        exitCode: CODEX_APP_SERVER_TRANSPORT_EXIT_CODE,
        threadId: null,
        sessionKey,
        error: buildWorkerError(
          "CODEX_APP_SERVER_TRANSPORT_ERROR",
          error instanceof Error ? error.message : String(error),
        ),
        raw: null,
      };
    }

    const client = this.client;
    if (!client) {
      return {
        output: "codex app-server client 미초기화",
        exitCode: CODEX_APP_SERVER_TRANSPORT_EXIT_CODE,
        threadId: null,
        sessionKey,
        error: buildWorkerError(
          "CODEX_APP_SERVER_TRANSPORT_ERROR",
          "client missing",
        ),
        raw: null,
      };
    }

    const outputParts = [];
    const unknownMethodsThisTurn = new Set();
    let threadId =
      typeof opts.threadId === "string" && opts.threadId ? opts.threadId : null;
    let protocolMismatchWarned = false;

    /** @type {((value: import('./interface.mjs').WorkerResult) => void) | null} */
    let resolveResult = null;
    const resultPromise = new Promise((resolve) => {
      resolveResult = resolve;
    });

    const finish = (result) => {
      if (!resolveResult) return;
      const f = resolveResult;
      resolveResult = null;
      f(result);
    };

    // P1 #2 fail-fast: register ourselves so transport/child lifecycle errors
    // can reject the in-flight turn immediately.
    const inflightReject = (err) => {
      finish({
        output: outputParts.join(""),
        exitCode: CODEX_APP_SERVER_TRANSPORT_EXIT_CODE,
        threadId,
        sessionKey,
        error: buildWorkerError(
          "CODEX_APP_SERVER_TRANSPORT_ERROR",
          err instanceof Error ? err.message : String(err),
        ),
        raw: null,
      });
    };
    this._inflightRejectors.add(inflightReject);

    const unsubscribers = [];
    const offAll = () => {
      while (unsubscribers.length) {
        const off = unsubscribers.pop();
        try {
          off?.();
        } catch {}
      }
    };

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    try {

    const pushPublish = (method, params) => {
      if (!this.publishCallback) return;
      const msg = this._buildPublishMessage(
        method,
        params,
        threadId,
        sessionKey,
      );
      // Fire-and-forget with 64-cap drop-oldest backpressure.
      if (this._publishQueue.length >= this._publishMaxQueue) {
        this._publishQueue.shift();
      }
      this._publishQueue.push(msg);
      try {
        const ret = this.publishCallback(msg);
        if (ret && typeof ret.then === "function") {
          ret.catch(() => {});
        }
      } catch {}
    };

    const handleNotification = (method, params) => {
      // AC5 defense: opt-out should already be filtered server-side.
      if (OPT_OUT_METHODS.includes(method)) return;

      if (!SUBSCRIBED_METHODS.has(method)) {
        // AC6 / AC14 / AC16 — unknown method handling
        unknownMethodsThisTurn.add(method);
        if (!this._warnedUnknown.has(method)) {
          this._warnedUnknown.add(method);
          this._warn("unknown notification method", { method });
          this._onUnknownMethod?.(method);
        }
        if (
          !protocolMismatchWarned &&
          unknownMethodsThisTurn.size > this.unknownMethodWarnThreshold
        ) {
          protocolMismatchWarned = true;
          this._warn("protocol_version_mismatch", {
            count: unknownMethodsThisTurn.size,
            threshold: this.unknownMethodWarnThreshold,
          });
        }
        return;
      }

      // Thread id can arrive on thread/started before thread/start resolves.
      if (method === "thread/started") {
        const tid = extractThreadIdFromStartedNotif(params);
        if (tid && !threadId) threadId = tid;
      }

      // Agent text accumulation (AC3)
      if (method === "item/agentMessage/delta") {
        const delta = typeof params?.delta === "string" ? params.delta : "";
        outputParts.push(delta);
      }

      pushPublish(method, params);

      if (method === "turn/completed") {
        const status = params?.turn?.status;
        if (status === "completed") {
          finish({
            output: outputParts.join(""),
            exitCode: 0,
            threadId,
            sessionKey,
            raw: { turn: params?.turn ?? null },
          });
        } else {
          const msg =
            params?.turn?.error?.message ||
            `turn ${status || "unknown"}`;
          finish({
            output: outputParts.join(""),
            exitCode: CODEX_APP_SERVER_EXECUTION_EXIT_CODE,
            threadId,
            sessionKey,
            error: buildWorkerError("CODEX_APP_SERVER_EXECUTION_ERROR", msg),
            raw: { turn: params?.turn ?? null },
          });
        }
        return;
      }

      if (method === "error") {
        const msg = params?.message || "codex app-server error";
        finish({
          output: outputParts.join(""),
          exitCode: CODEX_APP_SERVER_EXECUTION_EXIT_CODE,
          threadId,
          sessionKey,
          error: buildWorkerError("CODEX_APP_SERVER_EXECUTION_ERROR", msg),
          raw: { error: params ?? null },
        });
      }
    };

    // NOTE: JsonRpcStdioClient wildcard subscribers receive (params, method).
    // Match that contract here; targeted subscribers (cb(params)) are unchanged.
    const catchAll = (params, method) => handleNotification(method, params);
    unsubscribers.push(client.onNotification("*", catchAll));

    // Send thread/start (no prompt) then turn/start (prompt)
    let threadStartResponse;
    try {
      threadStartResponse = await client.request(
        "thread/start",
        buildThreadStartParams(opts),
        this.bootstrapTimeoutMs,
      );
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        exitCode: CODEX_APP_SERVER_TRANSPORT_EXIT_CODE,
        threadId,
        sessionKey,
        error: buildWorkerError(
          "CODEX_APP_SERVER_TRANSPORT_ERROR",
          error instanceof Error ? error.message : String(error),
        ),
        raw: null,
      };
    }
    const respThreadId = extractThreadIdFromStartResponse(threadStartResponse);
    if (respThreadId && !threadId) threadId = respThreadId;
    if (!threadId) {
      return {
        output: "thread id를 추출하지 못했습니다.",
        exitCode: CODEX_APP_SERVER_EXECUTION_EXIT_CODE,
        threadId: null,
        sessionKey,
        error: buildWorkerError(
          "CODEX_APP_SERVER_EXECUTION_ERROR",
          "thread id missing",
        ),
        raw: { threadStart: threadStartResponse },
      };
    }
    this.activeThreadId = threadId;

    try {
      await client.request(
        "turn/start",
        buildTurnStartParams(threadId, prompt),
        this.bootstrapTimeoutMs,
      );
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        exitCode: CODEX_APP_SERVER_TRANSPORT_EXIT_CODE,
        threadId,
        sessionKey,
        error: buildWorkerError(
          "CODEX_APP_SERVER_TRANSPORT_ERROR",
          error instanceof Error ? error.message : String(error),
        ),
        raw: null,
      };
    }

    // Timeout: SIGTERM + partial WorkerResult (AC8)
    const timeoutMs = Number.isFinite(opts.timeoutMs)
      ? opts.timeoutMs
      : DEFAULT_CODEX_APP_SERVER_EXECUTION_TIMEOUT_MS;
    // Capture current child so a stale timer (post-result) cannot SIGTERM a
    // later reused worker's child process.
    const capturedChild = this.child;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        this._warn("execution timeout", { timeoutMs });
        try {
          capturedChild?.kill?.("SIGTERM");
        } catch {}
        resolve({
          output: outputParts.join(""),
          exitCode: CODEX_APP_SERVER_TIMEOUT_EXIT_CODE,
          threadId,
          sessionKey,
          error: buildWorkerError(
            "CODEX_APP_SERVER_TIMEOUT",
            `codex app-server timeout (${timeoutMs}ms)`,
          ),
          raw: null,
        });
      }, timeoutMs);
      timer.unref?.();
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);
    return result;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      offAll();
      this._inflightRejectors.delete(inflightReject);
    }
  }

  /**
   * Graceful shutdown — best-effort thread/unsubscribe (request, with timeout),
   * close JSON-RPC client, SIGTERM the child then SIGKILL after 1 s.
   *
   * P1 #1 wire framing: `thread/unsubscribe` is sent as a **request** per the
   * OpenAI App Server API overview (was notification in the original PR #86).
   * P1 #2 lifecycle: we wait up to `UNSUBSCRIBE_DEADLINE_MS` for the response
   * before proceeding to SIGTERM so the server can flush unload work.
   * @returns {Promise<void>}
   */
  async stop() {
    this.ready = false;
    const child = this.child;
    const client = this.client;
    const activeThread = this.activeThreadId;
    this.child = null;
    this.client = null;
    this.activeThreadId = null;

    if (this._detachChildLifecycle) {
      try {
        this._detachChildLifecycle();
      } catch {}
      this._detachChildLifecycle = null;
    }
    // Reject any still-registered in-flight execute() with a generic transport
    // error so callers don't hang past stop().
    this._drainInflight(
      new CodexAppServerTransportError("codex app-server stop() 호출됨", {
        stderr: this.serverStderr,
      }),
    );

    if (this._rejectBootstrap) {
      try {
        this._rejectBootstrap(
          new CodexAppServerTransportError("codex app-server stop() 호출됨"),
        );
      } catch {}
      this._rejectBootstrap = null;
    }

    if (client) {
      if (activeThread) {
        try {
          if (client.isOpen()) {
            // Enter `closing` state so the EOF that follows `close()` doesn't
            // trip the fail-fast path. Send unsubscribe as a request and race
            // it against a hard deadline — some servers (and test fakes) may
            // never respond, and we must not hang stop().
            const unsubPromise = client
              .request(
                "thread/unsubscribe",
                { threadId: activeThread },
                UNSUBSCRIBE_DEADLINE_MS,
              )
              .catch(() => {
                /* best-effort; fall through to close + SIGTERM below */
              });
            client.close("closing");
            const deadline = new Promise((resolve) => {
              const t = setTimeout(resolve, UNSUBSCRIBE_DEADLINE_MS);
              t.unref?.();
            });
            await Promise.race([unsubPromise, deadline]);
          }
        } catch {}
      }
      try {
        client.close();
      } catch {}
    }

    if (child) {
      try {
        child.stdin?.end?.();
      } catch {}
      try {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      } catch {}
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        } catch {}
      }, 1_000);
      killTimer.unref?.();
    }
  }

  /**
   * Build the `agent.progress` publish envelope for a codex notification.
   * Compatible with `hub/bridge.mjs:buildPublishBody()` so the same object can
   * be handed to `requestJson('/bridge/publish', { body })` or a router shim.
   * @param {string} method
   * @param {unknown} params
   * @param {string | null} threadId
   * @param {string | null} sessionKey
   */
  _buildPublishMessage(method, params, threadId, sessionKey) {
    const kind = KIND_MAP[method] || "unknown";
    const data = this.redactSensitive ? redactDeep(params) : params;
    return {
      from: this.workerId,
      to: "topic:agent.progress",
      topic: "agent.progress",
      type: "event",
      payload: {
        type: "agent.progress",
        version: 1,
        agentId: this.workerId,
        sessionKey: sessionKey || "",
        threadId: threadId || "",
        kind,
        method,
        timestamp: this._monotonicNow(),
        data,
      },
    };
  }
}

export function createCodexAppServerWorker(options = {}) {
  return new CodexAppServerWorker(options);
}
