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

import { JsonRpcDispatchBase } from "./jsonrpc-core.mjs";

export { JsonRpcProtocolError } from "./jsonrpc-core.mjs";

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
export class JsonRpcStdioClient extends JsonRpcDispatchBase {
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

    super({ onError, closedMessage: CLOSED_MESSAGE });

    this._stdin = stdin;
    this._stdout = stdout;
    this._maxLineSize =
      Number.isFinite(maxLineSize) && maxLineSize > 0
        ? maxLineSize
        : DEFAULT_MAX_LINE_SIZE;

    /** @type {'running'|'closing'|'closed'} */
    this._state = "running";

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
    this._rl.on("line", (line) => this._handleInboundMessage(line));
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

  // --- internals ---------------------------------------------------------

  _encodeAndSend(frame) {
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

  _teardownTransport() {
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
}
