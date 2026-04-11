// hub/workers/lib/jsonrpc-stdio.mjs
// Minimal line-delimited JSON-RPC 2.0 client over stdio.
// Replaces vscode-jsonrpc for the codex app-server transport.
//
// Contract (LOCKED for PRD-2):
//   new JsonRpcStdioClient({ stdin, stdout, onError, maxLineSize })
//   request(method, params, timeoutMs=60000) -> Promise<result>
//   notify(method, params) -> void
//   onNotification(method, cb) -> unsubscribe()      ('*' = catch-all)
//   close() -> void (idempotent)
//   isOpen() -> boolean
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
  constructor({
    stdin,
    stdout,
    onError,
    maxLineSize = DEFAULT_MAX_LINE_SIZE,
  }) {
    if (!stdin || typeof stdin.on !== "function") {
      throw new TypeError("JsonRpcStdioClient requires a readable stdin");
    }
    if (!stdout || typeof stdout.write !== "function") {
      throw new TypeError("JsonRpcStdioClient requires a writable stdout");
    }

    this._stdin = stdin;
    this._stdout = stdout;
    this._onError = typeof onError === "function" ? onError : null;
    this._maxLineSize = Number.isFinite(maxLineSize) && maxLineSize > 0
      ? maxLineSize
      : DEFAULT_MAX_LINE_SIZE;

    this._open = true;
    this._nextRequestId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    this._pendingRequests = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._notificationHandlers = new Map();

    // AC18: track bytes since last newline at the raw stream layer so an
    // oversized line is rejected *before* readline concatenates it internally.
    this._pendingLineSize = 0;
    this._oversized = false;

    this._onStdinData = (chunk) => this._trackRawBytes(chunk);
    this._stdin.on("data", this._onStdinData);

    this._rl = createInterface({ input: this._stdin, crlfDelay: Infinity });
    this._rl.on("line", (line) => this._handleLine(line));
    this._rl.on("close", () => {
      // stdin EOF: stop accepting new requests but keep pending rejected by close().
      if (this._open) {
        this.close();
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
    if (!this._open) {
      return Promise.reject(new Error(CLOSED_MESSAGE));
    }

    const id = this._nextRequestId++;
    const frame = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this._pendingRequests.get(id);
          if (!pending) return;
          this._pendingRequests.delete(id);
          reject(new Error(`JSON-RPC request timed out after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }

      this._pendingRequests.set(id, { resolve, reject, timer });

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
   * Silently drops if the client is closed.
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    if (!this._open) return;
    const frame = { jsonrpc: "2.0", method };
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
   */
  close() {
    if (!this._open) return;
    this._open = false;

    for (const [, pending] of this._pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(CLOSED_MESSAGE));
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

  /**
   * @returns {boolean} True if the client accepts new requests.
   */
  isOpen() {
    return this._open;
  }

  // --- internals ---------------------------------------------------------

  _writeFrame(frame) {
    const line = `${JSON.stringify(frame)}\n`;
    this._stdout.write(line);
  }

  _trackRawBytes(chunk) {
    if (this._oversized || !this._open) return;
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
        this.close();
        return;
      }
    }
  }

  _handleLine(line) {
    if (!this._open) return;
    if (line.length === 0) return;

    let frame;
    try {
      frame = JSON.parse(line);
    } catch (err) {
      this._emitError(
        new Error(`JSON-RPC parse error: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    if (!frame || typeof frame !== "object") {
      this._emitError(new Error("JSON-RPC protocol error: frame is not an object"));
      return;
    }

    // Response: has id + (result | error)
    if (Object.prototype.hasOwnProperty.call(frame, "id") && frame.id !== null &&
        (Object.prototype.hasOwnProperty.call(frame, "result") ||
         Object.prototype.hasOwnProperty.call(frame, "error"))) {
      this._dispatchResponse(frame);
      return;
    }

    // Notification: method + no id (or id === null for responses we treated above)
    if (typeof frame.method === "string" &&
        !Object.prototype.hasOwnProperty.call(frame, "id")) {
      this._dispatchNotification(frame);
      return;
    }

    // Unknown / malformed envelope — surface but keep loop alive.
    this._emitError(new Error("JSON-RPC protocol error: unrecognized frame shape"));
  }

  _dispatchResponse(frame) {
    const pending = this._pendingRequests.get(frame.id);
    if (!pending) {
      // Stray response — drop silently (notify() path, or late after timeout).
      return;
    }
    this._pendingRequests.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);

    if (Object.prototype.hasOwnProperty.call(frame, "error") && frame.error) {
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
