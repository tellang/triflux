// hub/workers/lib/jsonrpc-stdio.mjs
// Minimal line-delimited JSON-RPC 2.0 client over stdio.
// Replaces vscode-jsonrpc for the codex app-server transport.
//
// Wire format (Issue #95 P1 #1): OpenAI App Server JSONL variant omits the
// top-level `"jsonrpc": "2.0"` header on outbound frames. Inbound decode is
// lenient — frames with or without the header are accepted for forward compat.
//
// Contract:
//   new JsonRpcStdioClient({ stdin, stdout, onError, maxLineSize })
//   request(method, params, timeoutMs=60000) -> Promise<result>
//   notify(method, params) -> void
//   onNotification(method, cb) -> unsubscribe()      ('*' = catch-all)
//   close(reason) -> void (idempotent; optional reason marks closing state)
//   isOpen() -> boolean
//
// Lifecycle (Issue #95 P1 #3):
//   State machine: running | closing | closed
//   - `running` is the default. Parse/EOF/max-line errors reject in-flight
//     requests and transition to `closed`.
//   - `closing` is entered via `close("closing")` before a graceful shutdown;
//     EOF in `closing` is a normal termination and does NOT fail-fast.
//
// AC18: any single line whose raw-byte length would exceed maxLineSize is
// rejected at the stream layer (before readline emits it) to defend against
// OOM/DoS from an unresponsive or malicious peer.

import { createInterface } from "node:readline";

const DEFAULT_MAX_LINE_SIZE = 1024 * 1024; // 1 MiB
const CLOSED_MESSAGE = "JsonRpcStdioClient closed";

/**
 * Thrown (via onError) when an inbound line would exceed maxLineSize.
 */
export class MaxLineSizeExceededError extends Error {
  /**
   * @param {number} size Bytes observed so far in the offending line.
   * @param {number} max  Configured max.
   */
  constructor(size, max) {
    super(`JSON-RPC line exceeded max size: ${size} > ${max}`);
    this.name = "MaxLineSizeExceededError";
    this.size = size;
    this.max = max;
  }
}

/**
 * Thrown (and used to reject in-flight execute()) when the peer emits a
 * malformed frame or the transport layer hits a structural error.
 */
export class JsonRpcProtocolError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "JsonRpcProtocolError";
  }
}

/**
 * Thrown when the underlying stream closes unexpectedly (EOF outside `closing`).
 */
export class JsonRpcTransportError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "JsonRpcTransportError";
  }
}

/**
 * Line-delimited JSON-RPC 2.0 client over a pair of Node streams.
 */
export class JsonRpcStdioClient {
  /**
   * @param {object} options
   * @param {NodeJS.ReadableStream} options.stdin Server -> client bytes.
   * @param {NodeJS.WritableStream} options.stdout Client -> server bytes.
   * @param {(err: Error) => void} [options.onError] Protocol error sink.
   * @param {number} [options.maxLineSize] Max bytes per inbound line.
   */
  constructor({ stdin, stdout, onError, maxLineSize = DEFAULT_MAX_LINE_SIZE }) {
    if (!stdin || typeof stdin.on !== "function") {
      throw new TypeError("JsonRpcStdioClient requires a readable stdin");
    }
    if (!stdout || typeof stdout.write !== "function") {
      throw new TypeError("JsonRpcStdioClient requires a writable stdout");
    }

    this._stdin = stdin;
    this._stdout = stdout;
    this._onError = typeof onError === "function" ? onError : null;
    this._maxLineSize =
      Number.isFinite(maxLineSize) && maxLineSize > 0
        ? maxLineSize
        : DEFAULT_MAX_LINE_SIZE;

    /** @type {'running'|'closing'|'closed'} */
    this._state = "running";
    this._nextRequestId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any, method: string }>} */
    this._pendingRequests = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._notificationHandlers = new Map();

    // AC18: track bytes since last newline at the raw stream layer so an
    // oversized line is rejected *before* readline concatenates it internally.
    this._pendingLineSize = 0;
    this._oversized = false;

    this._onStdinData = (chunk) => this._trackRawBytes(chunk);
    this._stdin.on("data", this._onStdinData);

    // Without these handlers, an EPIPE/ERR_STREAM_DESTROYED on either pipe
    // would bubble up as an unhandled 'error' and take down the hub process.
    this._onStdinError = (err) => this._handleStreamError("stdin", err);
    this._onStdoutError = (err) => this._handleStreamError("stdout", err);
    if (typeof this._stdin.on === "function") {
      this._stdin.on("error", this._onStdinError);
    }
    if (typeof this._stdout.on === "function") {
      this._stdout.on("error", this._onStdoutError);
    }

    this._rl = createInterface({ input: this._stdin, crlfDelay: Infinity });
    this._rl.on("line", (line) => this._handleLine(line));
    // readline re-emits the input stream 'error' on itself; the raw stdin
    // handler above already converts it into a JsonRpcTransportError, so
    // suppress the re-emit to avoid an unhandled 'error' on the Interface.
    this._rl.on("error", () => {});
    this._rl.on("close", () => {
      // P1 #3 fail-fast: EOF during `running` is a transport error. Pending
      // requests are rejected with JsonRpcTransportError. EOF during `closing`
      // is a normal shutdown — pending requests are rejected with the generic
      // CLOSED_MESSAGE via close().
      if (this._state === "running") {
        const err = new JsonRpcTransportError(
          "JSON-RPC stream closed unexpectedly (EOF during running state)",
        );
        this._emitError(err);
        this._closeWith("closed", err);
      } else if (this._state !== "closed") {
        this._closeWith("closed");
      }
    });
  }

  /**
   * Issue a JSON-RPC request and resolve with the server's `result`.
   * Rejects on error response, timeout, malformed payload, or close().
   * @param {string} method
   * @param {unknown} params
   * @param {number} [timeoutMs=60000]
   * @returns {Promise<any>}
   */
  request(method, params, timeoutMs = 60000) {
    if (this._state !== "running") {
      return Promise.reject(new Error(CLOSED_MESSAGE));
    }

    const id = this._nextRequestId++;
    // P1 #1 wire framing: omit `jsonrpc: "2.0"` on outbound. Peer decode remains
    // lenient (OpenAI App Server JSONL variant spec).
    const frame = { id, method };
    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this._pendingRequests.get(id);
          if (!pending) return;
          this._pendingRequests.delete(id);
          reject(
            new Error(
              `JSON-RPC request timed out after ${timeoutMs}ms: ${method}`,
            ),
          );
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }

      this._pendingRequests.set(id, { resolve, reject, timer, method });

      try {
        this._writeFrame(frame);
      } catch (err) {
        this._pendingRequests.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected).
   * Silently drops if the client is not in `running`.
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    if (this._state !== "running") return;
    // P1 #1 wire framing: omit jsonrpc header (outbound).
    const frame = { method };
    if (params !== undefined) frame.params = params;
    try {
      this._writeFrame(frame);
    } catch (err) {
      this._emitError(err);
    }
  }

  /**
   * Subscribe to inbound notifications. Use `"*"` for a catch-all handler
   * which receives `(params, method)`. Targeted handlers receive `(params)`.
   * @param {string} method
   * @param {(params: any, method?: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onNotification(method, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onNotification requires a callback function");
    }
    let set = this._notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this._notificationHandlers.set(method, set);
    }
    set.add(callback);
    return () => {
      const handlers = this._notificationHandlers.get(method);
      if (!handlers) return;
      handlers.delete(callback);
      if (handlers.size === 0) this._notificationHandlers.delete(method);
    };
  }

  /**
   * Close the client: reject all pending requests, stop tracking input,
   * and release the readline interface. Idempotent.
   *
   * Optional `reason` = `"closing"` transitions to the intermediate `closing`
   * state *without* terminating the readline loop, so a graceful shutdown can
   * issue a final request (e.g. `thread/unsubscribe`) before EOF triggers
   * full closure. Any subsequent EOF in `closing` is treated as normal.
   *
   * @param {string} [reason]
   */
  close(reason) {
    if (this._state === "closed") return;

    if (reason === "closing" && this._state === "running") {
      this._state = "closing";
      return;
    }
    this._closeWith("closed");
  }

  /**
   * @returns {boolean} True if the client accepts new requests.
   */
  isOpen() {
    return this._state === "running";
  }

  /**
   * @returns {'running'|'closing'|'closed'}
   */
  getState() {
    return this._state;
  }

  // --- internals ---------------------------------------------------------

  _closeWith(target, rejectReason = null) {
    if (this._state === "closed") return;
    this._state = target;

    const rejectErr =
      rejectReason instanceof Error ? rejectReason : new Error(CLOSED_MESSAGE);

    for (const [, pending] of this._pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(rejectErr);
    }
    this._pendingRequests.clear();

    try {
      this._stdin.off?.("data", this._onStdinData);
    } catch {
      /* ignore */
    }
    try {
      this._rl.close();
    } catch {
      /* ignore */
    }
  }

  _writeFrame(frame) {
    if (this._state === "closed") return;
    const line = `${JSON.stringify(frame)}\n`;
    try {
      this._stdout.write(line, (err) => {
        if (err) this._handleStreamError("stdout-write", err);
      });
    } catch (err) {
      this._handleStreamError("stdout-write", err);
    }
  }

  /**
   * Convert a raw stream error into a JsonRpcTransportError, emit it to the
   * error sink, and close the client so pending requests are rejected.
   * Idempotent: repeated errors after close are swallowed.
   * @param {string} which identifier for the originating pipe/operation
   * @param {unknown} err raw error from the stream
   */
  _handleStreamError(which, err) {
    if (this._state === "closed") return;
    const base = err instanceof Error ? err : new Error(String(err));
    const wrapped = new JsonRpcTransportError(
      `JSON-RPC stream error on ${which}: ${base.message}`,
    );
    wrapped.cause = base;
    this._emitError(wrapped);
    this._closeWith("closed", wrapped);
  }

  _trackRawBytes(chunk) {
    if (this._oversized || this._state === "closed") return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a /* \n */) {
        this._pendingLineSize = 0;
        continue;
      }
      this._pendingLineSize += 1;
      if (this._pendingLineSize > this._maxLineSize) {
        this._oversized = true;
        const err = new MaxLineSizeExceededError(
          this._pendingLineSize,
          this._maxLineSize,
        );
        this._emitError(err);
        // P1 #3 fail-fast: oversized line → reject pending with the actual error
        this._closeWith("closed", err);
        return;
      }
    }
  }

  _handleLine(line) {
    if (this._state === "closed") return;
    if (line.length === 0) return;

    let frame;
    try {
      frame = JSON.parse(line);
    } catch (err) {
      const pErr = new JsonRpcProtocolError(
        `JSON-RPC parse error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      this._emitError(pErr);
      // P1 #3 fail-fast: malformed frame during running → reject in-flight + close
      if (this._state === "running") this._closeWith("closed", pErr);
      return;
    }

    if (!frame || typeof frame !== "object") {
      const pErr = new JsonRpcProtocolError(
        "JSON-RPC protocol error: frame is not an object",
      );
      this._emitError(pErr);
      if (this._state === "running") this._closeWith("closed", pErr);
      return;
    }

    // Response: has id + (result | error)
    if (
      Object.hasOwn(frame, "id") &&
      frame.id !== null &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))
    ) {
      this._dispatchResponse(frame);
      return;
    }

    // Notification: method + no id (or id === null for responses we treated above)
    if (typeof frame.method === "string" && !Object.hasOwn(frame, "id")) {
      this._dispatchNotification(frame);
      return;
    }

    // Unknown / malformed envelope — surface but keep loop alive during running.
    // Fail-fast only on structural errors (JSON parse, EOF, max-line).
    this._emitError(
      new JsonRpcProtocolError(
        "JSON-RPC protocol error: unrecognized frame shape",
      ),
    );
  }

  _dispatchResponse(frame) {
    const pending = this._pendingRequests.get(frame.id);
    if (!pending) {
      // Stray response — drop silently (notify() path, or late after timeout).
      return;
    }
    this._pendingRequests.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (Object.hasOwn(frame, "error") && frame.error) {
      const { code, message, data } = frame.error;
      const err = new Error(
        `JSON-RPC error${typeof code === "number" ? ` ${code}` : ""}: ${message || "unknown"}`,
      );
      if (code !== undefined) err.code = code;
      if (data !== undefined) err.data = data;
      pending.reject(err);
      return;
    }

    pending.resolve(frame.result);
  }

  _dispatchNotification(frame) {
    const method = frame.method;
    const params = frame.params;

    const targeted = this._notificationHandlers.get(method);
    if (targeted && targeted.size > 0) {
      for (const cb of targeted) {
        try {
          cb(params);
        } catch (err) {
          this._emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    const wildcard = this._notificationHandlers.get("*");
    if (wildcard && wildcard.size > 0) {
      for (const cb of wildcard) {
        try {
          cb(params, method);
        } catch (err) {
          this._emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }

  _emitError(err) {
    if (!this._onError) return;
    try {
      this._onError(err);
    } catch {
      // Never throw out of the dispatch loop.
    }
  }
}
