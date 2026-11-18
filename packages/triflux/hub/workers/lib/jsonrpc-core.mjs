export class JsonRpcProtocolError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "JsonRpcProtocolError";
  }
}

export class JsonRpcTransportError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "JsonRpcTransportError";
  }
}

export class JsonRpcDispatchBase {
  constructor({ onError, closedMessage }) {
    this._onError = typeof onError === "function" ? onError : null;
    this._closedMessage = closedMessage;
    this._state = "closed";
    this._nextRequestId = 1;
    this._pendingRequests = new Map();
    this._notificationHandlers = new Map();
  }

  request(method, params, timeoutMs = 60000) {
    if (this._state !== "running") {
      return Promise.reject(new Error(this._closedMessage));
    }

    const id = this._nextRequestId++;
    // 송신 프레임은 OpenAI App Server JSONL 변형 규격에 맞춰 jsonrpc 헤더를 생략한다.
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
        this._encodeAndSend(frame);
      } catch (err) {
        this._pendingRequests.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (this._state !== "running") return;
    // 송신 프레임은 jsonrpc 헤더를 생략한다.
    const frame = { method };
    if (params !== undefined) frame.params = params;
    try {
      this._encodeAndSend(frame);
    } catch (err) {
      this._emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

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

  // reason === "closing" 이면 후속 EOF를 정상 종료로 취급하는 중간 상태로 전이한다.
  close(reason) {
    if (this._state === "closed") return;

    if (reason === "closing" && this._state === "running") {
      this._state = "closing";
      this._onEnterClosing();
      return;
    }
    this._closeWith("closed");
  }

  isOpen() {
    return this._state === "running";
  }

  getState() {
    return this._state;
  }

  _handleInboundMessage(line) {
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
      // P1 #3 fail-fast: malformed frame during running -> reject in-flight + close
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

    /*
     * FUTURE-EXTENSION: server->client requests (inbound frames with both
     * `id` and `method`) can dispatch from this shared routing point later,
     * for example via a `_dispatchServerRequest(frame)` branch, so backlog #1
     * only needs to touch the base. Do not implement that branch here.
     */

    // Notification: method + no id (or id === null for responses we treated above)
    if (typeof frame.method === "string" && !Object.hasOwn(frame, "id")) {
      this._dispatchNotification(frame);
      return;
    }

    // Unknown / malformed envelope - surface but keep loop alive during running.
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
      // Stray response - drop silently (notify() path, or late after timeout).
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

  _closeWith(target, rejectReason = null) {
    if (this._state === "closed") return;
    this._state = target;

    this._beforeRejectPending();

    const rejectErr =
      rejectReason instanceof Error
        ? rejectReason
        : new Error(this._closedMessage);

    for (const [, pending] of this._pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(rejectErr);
    }
    this._pendingRequests.clear();

    this._teardownTransport();
  }

  _emitError(err) {
    if (!this._onError) return;
    try {
      this._onError(err);
    } catch {
      // Never throw out of the dispatch loop.
    }
  }

  _encodeAndSend() {
    throw new Error("JsonRpcDispatchBase._encodeAndSend not implemented");
  }

  _onEnterClosing() {}

  _beforeRejectPending() {}

  _teardownTransport() {}
}
