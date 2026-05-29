// hub/workers/lib/jsonrpc-ws-uds.mjs
// JSON-RPC 2.0 client over WebSocket-over-Unix-Domain-Socket.
//
// codex `app-server --listen unix://PATH` does NOT speak newline-delimited JSON
// on the socket — it speaks WebSocket (RFC 6455) after a standard HTTP/1.1
// Upgrade handshake, one JSON-RPC message per text frame. Confirmed live against
// codex-cli 0.135.0 (see experiments/native-bridge-feasibility/
// codex-app-server-uds-probe.mjs). This is the UDS sibling of the stdio
// `JsonRpcStdioClient`: same public surface (request/notify/onNotification/
// close/isOpen), different framing.
//
// Wire framing notes:
//   - client -> server frames MUST be masked (RFC 6455 §5.3).
//   - server -> client frames are unmasked.
//   - one JSON-RPC object per text frame; fragmented frames are reassembled.
//   - outbound JSON-RPC omits the `"jsonrpc":"2.0"` header (OpenAI App Server
//     JSONL variant), matching JsonRpcStdioClient.
//
// Zero new dependencies — minimal hand-rolled WS client (no `ws` package).

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

import {
  JsonRpcProtocolError,
  JsonRpcTransportError,
} from "./jsonrpc-stdio.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MiB
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// After a graceful close("closing") we wait this long for the peer's close/EOF
// before force-destroying the socket so a silent peer cannot pin it open.
const CLOSING_DEADLINE_MS = 2_000;
const MAX_CONTROL_PAYLOAD = 125; // RFC 6455 §5.5: control frames <=125 bytes
const CLOSED_MESSAGE = "JsonRpcWsUdsClient closed";

// RFC 6455 opcodes
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * Encode a single client->server WebSocket frame (always masked).
 * @param {number} opcode
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeClientFrame(opcode, payload) {
  const len = payload.length;
  const mask = randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * JSON-RPC 2.0 client over WebSocket-over-UDS.
 */
export class JsonRpcWsUdsClient {
  /**
   * @param {object} options
   * @param {string} options.socketPath Absolute path to the AF_UNIX socket.
   * @param {(err: Error) => void} [options.onError]
   * @param {number} [options.maxFrameSize] Max bytes per inbound frame payload.
   * @param {number} [options.connectTimeoutMs]
   */
  constructor({
    socketPath,
    onError,
    maxFrameSize = DEFAULT_MAX_FRAME_SIZE,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  } = {}) {
    if (typeof socketPath !== "string" || !socketPath) {
      throw new TypeError("JsonRpcWsUdsClient requires a socketPath string");
    }
    this._socketPath = socketPath;
    this._onError = typeof onError === "function" ? onError : null;
    this._maxFrameSize =
      Number.isFinite(maxFrameSize) && maxFrameSize > 0
        ? maxFrameSize
        : DEFAULT_MAX_FRAME_SIZE;
    this._connectTimeoutMs = Number.isFinite(connectTimeoutMs)
      ? connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT_MS;

    /** @type {'idle'|'running'|'closing'|'closed'} */
    this._state = "idle";
    this._socket = null;
    this._nextRequestId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any, method: string }>} */
    this._pendingRequests = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._notificationHandlers = new Map();

    // RX framing state
    this._rxBuf = Buffer.alloc(0);
    /** @type {Buffer[]} accumulated payloads of a fragmented message */
    this._fragmentChunks = [];
    /** @type {number|null} opcode of the in-progress fragmented message */
    this._fragmentOpcode = null;
    this._fragmentSize = 0;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._closingTimer = null;
  }

  /**
   * Open the socket and complete the WebSocket HTTP Upgrade handshake.
   * Resolves once the connection is in the `running` state.
   * @returns {Promise<void>}
   */
  connect() {
    if (this._state !== "idle") {
      return Promise.reject(
        new Error(
          `JsonRpcWsUdsClient.connect() invalid in state ${this._state}`,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      let handshakeBuf = Buffer.alloc(0);
      let settled = false;

      const socket = net.connect(this._socketPath);
      this._socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {}
        this._state = "closed";
        reject(
          new JsonRpcTransportError(
            `WebSocket-over-UDS connect timed out after ${this._connectTimeoutMs}ms: ${this._socketPath}`,
          ),
        );
      }, this._connectTimeoutMs);

      const onConnectError = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._state = "closed";
        reject(
          new JsonRpcTransportError(
            `WebSocket-over-UDS connect error: ${err?.message || err}`,
            { cause: err },
          ),
        );
      };

      socket.once("error", onConnectError);
      socket.on("connect", () => {
        const req =
          "GET / HTTP/1.1\r\n" +
          "Host: localhost\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n";
        socket.write(req);
      });

      const onHandshakeData = (chunk) => {
        if (settled) return;
        handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
        const sep = handshakeBuf.indexOf("\r\n\r\n");
        if (sep < 0) {
          if (handshakeBuf.length > 64 * 1024) {
            settled = true;
            clearTimeout(timer);
            socket.removeListener("error", onConnectError);
            socket.removeListener("data", onHandshakeData);
            try {
              socket.destroy();
            } catch {}
            this._state = "closed";
            reject(
              new JsonRpcProtocolError(
                "WebSocket handshake response headers exceeded 64 KiB",
              ),
            );
          }
          return;
        }
        const rawHeaders = handshakeBuf.subarray(0, sep).toString("utf8");
        const leftover = handshakeBuf.subarray(sep + 4);

        const lines = rawHeaders.split("\r\n");
        const ok101 = /^HTTP\/1\.\d 101/.test(lines[0] || "");
        const headerMap = new Map();
        for (let i = 1; i < lines.length; i++) {
          const idx = lines[i].indexOf(":");
          if (idx < 0) continue;
          headerMap.set(
            lines[i].slice(0, idx).trim().toLowerCase(),
            lines[i].slice(idx + 1).trim(),
          );
        }
        const acceptOk =
          headerMap.get("sec-websocket-accept") === expectedAccept;

        if (!ok101 || !acceptOk) {
          settled = true;
          clearTimeout(timer);
          socket.removeListener("error", onConnectError);
          socket.removeListener("data", onHandshakeData);
          try {
            socket.destroy();
          } catch {}
          this._state = "closed";
          reject(
            new JsonRpcProtocolError(
              `WebSocket upgrade rejected (status101=${ok101}, acceptValid=${acceptOk})`,
            ),
          );
          return;
        }

        // Handshake complete — switch to running and wire frame handling.
        settled = true;
        clearTimeout(timer);
        socket.removeListener("error", onConnectError);
        socket.removeListener("data", onHandshakeData);
        this._state = "running";

        socket.on("data", (buf) => this._onSocketData(buf));
        socket.on("error", (err) => this._handleStreamError("socket", err));
        socket.on("close", () => {
          if (this._state === "running") {
            const err = new JsonRpcTransportError(
              "WebSocket-over-UDS closed unexpectedly (EOF during running)",
            );
            this._emitError(err);
            this._closeWith("closed", err);
          } else if (this._state !== "closed") {
            this._closeWith("closed");
          }
        });

        if (leftover.length > 0) {
          this._rxBuf = Buffer.concat([this._rxBuf, leftover]);
          this._drainFrames();
        }
        resolve();
      };

      socket.on("data", onHandshakeData);
    });
  }

  /**
   * Issue a JSON-RPC request and resolve with the server's `result`.
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
      }
      this._pendingRequests.set(id, { resolve, reject, timer, method });
      try {
        this._sendText(JSON.stringify(frame));
      } catch (err) {
        this._pendingRequests.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response).
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    if (this._state !== "running") return;
    const frame = { method };
    if (params !== undefined) frame.params = params;
    try {
      this._sendText(JSON.stringify(frame));
    } catch (err) {
      this._emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Subscribe to inbound notifications. `"*"` = catch-all receiving
   * `(params, method)`; targeted handlers receive `(params)`.
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
   * Close the client. `reason === "closing"` transitions to an intermediate
   * graceful state where a subsequent EOF is treated as normal. Idempotent.
   * @param {string} [reason]
   */
  close(reason) {
    if (this._state === "closed") return;
    if (reason === "closing" && this._state === "running") {
      this._state = "closing";
      // best-effort WS close frame
      try {
        this._socket?.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0)));
      } catch {}
      // Arm a deadline so a peer that never replies with close/EOF cannot pin
      // the socket + pending requests open forever.
      this._closingTimer = setTimeout(() => {
        if (this._state === "closing") this._closeWith("closed");
      }, CLOSING_DEADLINE_MS);
      if (typeof this._closingTimer.unref === "function") {
        this._closingTimer.unref();
      }
      return;
    }
    this._closeWith("closed");
  }

  /** @returns {boolean} */
  isOpen() {
    return this._state === "running";
  }

  /** @returns {'idle'|'running'|'closing'|'closed'} */
  getState() {
    return this._state;
  }

  // --- internals ---------------------------------------------------------

  _sendText(text) {
    if (this._state === "closed") throw new Error(CLOSED_MESSAGE);
    const frame = encodeClientFrame(OP_TEXT, Buffer.from(text, "utf8"));
    this._socket.write(frame, (err) => {
      if (err) this._handleStreamError("socket-write", err);
    });
  }

  _onSocketData(chunk) {
    if (this._state === "closed") return;
    this._rxBuf = Buffer.concat([this._rxBuf, chunk]);
    this._drainFrames();
  }

  /**
   * Parse as many complete WebSocket frames as are buffered. Control frames
   * (ping/pong/close) are handled inline; text/continuation frames are
   * reassembled into a full JSON-RPC message before dispatch.
   */
  _drainFrames() {
    while (this._rxBuf.length >= 2) {
      const b0 = this._rxBuf[0];
      const b1 = this._rxBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let cursor = 2;

      if (len === 126) {
        if (this._rxBuf.length < cursor + 2) return;
        len = this._rxBuf.readUInt16BE(cursor);
        cursor += 2;
      } else if (len === 127) {
        if (this._rxBuf.length < cursor + 8) return;
        const big = this._rxBuf.readBigUInt64BE(cursor);
        if (big > BigInt(this._maxFrameSize)) {
          const err = new JsonRpcProtocolError(
            `WebSocket frame payload ${big} exceeds max ${this._maxFrameSize}`,
          );
          this._emitError(err);
          this._closeWith("closed", err);
          return;
        }
        len = Number(big);
        cursor += 8;
      }

      if (len > this._maxFrameSize) {
        const err = new JsonRpcProtocolError(
          `WebSocket frame payload ${len} exceeds max ${this._maxFrameSize}`,
        );
        this._emitError(err);
        this._closeWith("closed", err);
        return;
      }

      // RFC 6455 §5.1: server -> client frames MUST NOT be masked.
      if (masked) {
        this._protocolClose("WebSocket server frame is masked (RFC 6455 §5.1)");
        return;
      }
      if (this._rxBuf.length < cursor + len) return; // wait for full payload

      // Detach from rxBuf before we slice it off.
      const payload = Buffer.from(this._rxBuf.subarray(cursor, cursor + len));
      this._rxBuf = this._rxBuf.subarray(cursor + len);

      this._handleFrame(fin, opcode, payload);
      if (this._state === "closed") return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    // Control frames (>=0x8): must be FIN and <=125 bytes (RFC 6455 §5.5).
    if (opcode >= 0x8) {
      if (!fin || payload.length > MAX_CONTROL_PAYLOAD) {
        this._protocolClose(
          `Invalid control frame (opcode 0x${opcode.toString(16)}, fin=${fin}, len=${payload.length})`,
        );
        return;
      }
      if (opcode === OP_PING) {
        try {
          this._socket?.write(encodeClientFrame(OP_PONG, payload));
        } catch {}
        return;
      }
      if (opcode === OP_PONG) return;
      if (opcode === OP_CLOSE) {
        if (this._state === "running") {
          const err = new JsonRpcTransportError(
            "WebSocket server sent close frame",
          );
          this._emitError(err);
          this._closeWith("closed", err);
        } else {
          this._closeWith("closed");
        }
        return;
      }
      this._protocolClose(`Unknown control opcode 0x${opcode.toString(16)}`);
      return;
    }

    // Data frames: text / binary (message start) or continuation.
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this._fragmentOpcode !== null) {
        this._protocolClose(
          "New data frame received while a fragmented message is active",
        );
        return;
      }
      if (opcode === OP_BINARY) {
        this._protocolClose(
          "Binary frames are not supported (expected text JSON-RPC)",
        );
        return;
      }
      if (fin) {
        this._handleMessage(payload.toString("utf8"));
        return;
      }
      this._fragmentOpcode = opcode;
      this._fragmentChunks = [payload];
      this._fragmentSize = payload.length;
      return;
    }

    if (opcode === OP_CONTINUATION) {
      if (this._fragmentOpcode === null) {
        this._protocolClose(
          "Continuation frame with no active fragmented message",
        );
        return;
      }
      this._fragmentSize += payload.length;
      if (this._fragmentSize > this._maxFrameSize) {
        this._protocolClose(
          `Fragmented message ${this._fragmentSize} exceeds max ${this._maxFrameSize}`,
        );
        return;
      }
      this._fragmentChunks.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this._fragmentChunks);
      this._fragmentChunks = [];
      this._fragmentOpcode = null;
      this._fragmentSize = 0;
      this._handleMessage(full.toString("utf8"));
      return;
    }

    this._protocolClose(`Unknown WebSocket opcode 0x${opcode.toString(16)}`);
  }

  _protocolClose(message) {
    const err = new JsonRpcProtocolError(message);
    this._emitError(err);
    this._closeWith("closed", err);
  }

  _handleMessage(line) {
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

    if (
      Object.hasOwn(frame, "id") &&
      frame.id !== null &&
      (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))
    ) {
      this._dispatchResponse(frame);
      return;
    }

    if (typeof frame.method === "string" && !Object.hasOwn(frame, "id")) {
      this._dispatchNotification(frame);
      return;
    }

    this._emitError(
      new JsonRpcProtocolError(
        "JSON-RPC protocol error: unrecognized frame shape",
      ),
    );
  }

  _dispatchResponse(frame) {
    const pending = this._pendingRequests.get(frame.id);
    if (!pending) return;
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
    const { method, params } = frame;
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

  _handleStreamError(which, err) {
    if (this._state === "closed") return;
    const base = err instanceof Error ? err : new Error(String(err));
    const wrapped = new JsonRpcTransportError(
      `WebSocket-over-UDS stream error on ${which}: ${base.message}`,
      { cause: base },
    );
    this._emitError(wrapped);
    this._closeWith("closed", wrapped);
  }

  _closeWith(target, rejectReason = null) {
    if (this._state === "closed") return;
    this._state = target;
    if (this._closingTimer) {
      clearTimeout(this._closingTimer);
      this._closingTimer = null;
    }
    const rejectErr =
      rejectReason instanceof Error ? rejectReason : new Error(CLOSED_MESSAGE);
    for (const [, pending] of this._pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(rejectErr);
    }
    this._pendingRequests.clear();
    try {
      this._socket?.destroy();
    } catch {}
  }

  _emitError(err) {
    if (!this._onError) return;
    try {
      this._onError(err);
    } catch {
      /* never throw out of the dispatch loop */
    }
  }
}

export default JsonRpcWsUdsClient;
