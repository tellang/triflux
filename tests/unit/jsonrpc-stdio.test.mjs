// tests/unit/jsonrpc-stdio.test.mjs — PRD-1 JSON-RPC stdio mini impl
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  JsonRpcStdioClient,
  MaxLineSizeExceededError,
} from "../../hub/workers/lib/jsonrpc-stdio.mjs";

/**
 * Build a client wired to PassThrough streams so tests can push JSON-RPC
 * frames from the "server" side and observe frames written by the client.
 */
function makePair({ maxLineSize, onError } = {}) {
  const stdin = new PassThrough(); // server -> client
  const stdout = new PassThrough(); // client -> server
  const errors = [];
  const client = new JsonRpcStdioClient({
    stdin,
    stdout,
    maxLineSize,
    onError: (err) => {
      errors.push(err);
      if (typeof onError === "function") onError(err);
    },
  });

  /**
   * Parse every frame the client writes into stdout (line-delimited JSON).
   */
  const sentFrames = [];
  let sentBuffer = "";
  stdout.on("data", (chunk) => {
    sentBuffer += String(chunk);
    let idx = sentBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = sentBuffer.slice(0, idx);
      sentBuffer = sentBuffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          sentFrames.push(JSON.parse(line));
        } catch {
          sentFrames.push({ __raw: line });
        }
      }
      idx = sentBuffer.indexOf("\n");
    }
  });

  return { client, stdin, stdout, errors, sentFrames };
}

function pushLine(stream, obj) {
  stream.write(`${JSON.stringify(obj)}\n`);
}

describe("JsonRpcStdioClient", () => {
  it("1. request → response id matching resolves with result", async () => {
    const { client, stdin, sentFrames } = makePair();

    const pending = client.request("ping", { hello: "world" });
    // Wait one microtask so the request frame is written
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sentFrames.length, 1);
    const frame = sentFrames[0];
    // Issue #95 P1 #1: outbound frames omit `jsonrpc` header (OpenAI App Server
    // JSONL variant). Inbound decode remains lenient.
    assert.equal("jsonrpc" in frame, false);
    assert.equal(frame.method, "ping");
    assert.deepEqual(frame.params, { hello: "world" });
    assert.equal(typeof frame.id, "number");

    pushLine(stdin, { jsonrpc: "2.0", id: frame.id, result: { ok: true } });

    const result = await pending;
    assert.deepEqual(result, { ok: true });

    client.close();
  });

  it("2. multiple concurrent requests with out-of-order responses", async () => {
    const { client, stdin, sentFrames } = makePair();

    const a = client.request("one", { n: 1 });
    const b = client.request("two", { n: 2 });
    const c = client.request("three", { n: 3 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sentFrames.length, 3);
    const idA = sentFrames[0].id;
    const idB = sentFrames[1].id;
    const idC = sentFrames[2].id;
    assert.notEqual(idA, idB);
    assert.notEqual(idB, idC);

    // Respond out of order: C, A, B
    pushLine(stdin, { jsonrpc: "2.0", id: idC, result: "third" });
    pushLine(stdin, { jsonrpc: "2.0", id: idA, result: "first" });
    pushLine(stdin, { jsonrpc: "2.0", id: idB, result: "second" });

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.equal(ra, "first");
    assert.equal(rb, "second");
    assert.equal(rc, "third");

    client.close();
  });

  it("3. notification fanout via onNotification(method, cb)", async () => {
    const { client, stdin } = makePair();

    const received = [];
    const unsubscribe = client.onNotification("progress", (params) => {
      received.push(params);
    });
    assert.equal(typeof unsubscribe, "function");

    pushLine(stdin, { jsonrpc: "2.0", method: "progress", params: { pct: 25 } });
    pushLine(stdin, { jsonrpc: "2.0", method: "progress", params: { pct: 50 } });
    pushLine(stdin, { jsonrpc: "2.0", method: "other", params: { pct: 999 } });

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(received, [{ pct: 25 }, { pct: 50 }]);

    unsubscribe();
    pushLine(stdin, { jsonrpc: "2.0", method: "progress", params: { pct: 75 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 2);

    client.close();
  });

  it("4. catch-all via onNotification('*', cb) sees every notification", async () => {
    const { client, stdin } = makePair();

    const received = [];
    client.onNotification("*", (params, method) => {
      received.push({ method, params });
    });

    pushLine(stdin, { jsonrpc: "2.0", method: "alpha", params: { a: 1 } });
    pushLine(stdin, { jsonrpc: "2.0", method: "beta", params: { b: 2 } });
    pushLine(stdin, { jsonrpc: "2.0", method: "gamma" });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(received.length, 3);
    assert.equal(received[0].method, "alpha");
    assert.deepEqual(received[0].params, { a: 1 });
    assert.equal(received[1].method, "beta");
    assert.deepEqual(received[1].params, { b: 2 });
    assert.equal(received[2].method, "gamma");

    client.close();
  });

  it("5. malformed JSON line (no in-flight) → onError + close (fail-fast)", async () => {
    // Issue #95 P1 #3: parse error during `running` now fails fast — the
    // original contract ("keep loop alive") silently hung callers when the
    // peer emitted garbage. New behavior: surface the error and close.
    // (See P1#3 test above for the in-flight rejection path.)
    const { client, stdin, errors } = makePair();

    stdin.write("this-is-not-json\n");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.ok(/json|parse/i.test(errors[0].message));
    // Client closes on structural parse failure.
    assert.equal(client.isOpen(), false);
  });

  it("6. close() rejects all pending requests with CLOSED error", async () => {
    const { client } = makePair();

    const a = client.request("one", {});
    const b = client.request("two", {});

    client.close();

    await assert.rejects(a, /closed/i);
    await assert.rejects(b, /closed/i);

    assert.equal(client.isOpen(), false);

    // Idempotent close
    client.close();
    assert.equal(client.isOpen(), false);
  });

  it("7. partial line buffering (chunk without newline, then newline)", async () => {
    const { client, stdin } = makePair();

    const pending = client.request("ping", {});
    await new Promise((resolve) => setImmediate(resolve));

    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "pong" });
    const mid = Math.floor(payload.length / 2);
    stdin.write(payload.slice(0, mid));
    await new Promise((resolve) => setImmediate(resolve));
    // Still pending — no newline yet
    stdin.write(payload.slice(mid));
    await new Promise((resolve) => setImmediate(resolve));
    // Still pending — still no newline
    stdin.write("\n");

    assert.equal(await pending, "pong");
    client.close();
  });

  it("8. AC18: line > maxLineSize emits MaxLineSizeExceededError + close + pending rejected", async () => {
    const maxLineSize = 1024;
    const { client, stdin, errors } = makePair({ maxLineSize });

    const pending = client.request("ping", {});
    // Attach a swallowing rejection handler up front so the synchronous
    // reject triggered by close() cannot become an unhandled rejection
    // before the assertion awaits it.
    const pendingResult = pending.then(
      (value) => ({ kind: "resolved", value }),
      (err) => ({ kind: "rejected", err }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    // Write a chunk larger than the cap WITHOUT any newline — must be detected at the raw stream layer.
    const big = Buffer.alloc(maxLineSize + 16, 0x41); // 'A' * (max+16)
    stdin.write(big);
    await new Promise((resolve) => setImmediate(resolve));

    const oversize = errors.find((e) => e instanceof MaxLineSizeExceededError);
    assert.ok(oversize, "expected MaxLineSizeExceededError");
    assert.equal(oversize.max, maxLineSize);
    assert.ok(oversize.size >= maxLineSize + 1);
    assert.equal(client.isOpen(), false);

    const outcome = await pendingResult;
    assert.equal(outcome.kind, "rejected");
    // P1 #3 fail-fast: oversized line rejects pending with the concrete
    // MaxLineSizeExceededError (not the generic CLOSED_MESSAGE) so callers
    // can distinguish transport faults from clean shutdown.
    assert.match(outcome.err.message, /max.*size|exceed/i);
  });

  it("9. per-request timeout → reject + pending entry cleaned", async () => {
    const { client } = makePair();

    const started = Date.now();
    const pending = client.request("ping", {}, 20);
    await assert.rejects(pending, /timeout|timed out/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 15, `expected >=15ms, got ${elapsed}`);

    // No leaked pending — a second close() should not throw even if it tries
    // to reject non-existent entries.
    client.close();
    assert.equal(client.isOpen(), false);
  });

  it("10. notify() does not register pending; no response handling", async () => {
    const { client, stdin, sentFrames } = makePair();

    client.notify("event", { hello: "world" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sentFrames.length, 1);
    const frame = sentFrames[0];
    // Issue #95 P1 #1: outbound notification omits `jsonrpc` header.
    assert.equal("jsonrpc" in frame, false);
    assert.equal(frame.method, "event");
    assert.deepEqual(frame.params, { hello: "world" });
    assert.equal("id" in frame, false);

    // Server sending a stray response with any id must not throw or leak.
    // Inbound with `jsonrpc` header is still accepted (lenient decode).
    pushLine(stdin, { jsonrpc: "2.0", id: 999, result: "ignored" });
    await new Promise((resolve) => setImmediate(resolve));

    // close() should resolve synchronously with no pending rejections
    client.close();
    assert.equal(client.isOpen(), false);
  });

  // ─── Issue #95 regression tests ─────────────────────────────────
  it("P1#1 inbound frames without `jsonrpc` header are accepted (lenient)", async () => {
    const { client, stdin, sentFrames } = makePair();
    const pending = client.request("ping");
    await new Promise((resolve) => setImmediate(resolve));
    const frame = sentFrames[0];
    // Inbound response with NO jsonrpc header
    pushLine(stdin, { id: frame.id, result: { lenient: true } });
    const result = await pending;
    assert.deepEqual(result, { lenient: true });
    client.close();
  });

  it("P1#3 EOF during `running` rejects pending + surfaces TransportError", async () => {
    const errors = [];
    const { client, stdin } = makePair({
      onError: (err) => errors.push(err),
    });
    const pending = client.request("ping", null, 999_999);
    await new Promise((resolve) => setImmediate(resolve));
    // Simulate peer EOF without sending a response
    stdin.emit("end");
    stdin.emit("close");
    await assert.rejects(pending, /closed/i);
    assert.ok(
      errors.some((e) => e.name === "JsonRpcTransportError"),
      `expected JsonRpcTransportError, got: ${errors.map((e) => e.name).join(",")}`,
    );
    assert.equal(client.isOpen(), false);
  });

  it("P1#3 EOF during `closing` does NOT produce TransportError", async () => {
    const errors = [];
    const { client, stdin } = makePair({
      onError: (err) => errors.push(err),
    });
    // Mark client closing BEFORE EOF
    client.close("closing");
    assert.equal(client.getState(), "closing");
    stdin.emit("end");
    stdin.emit("close");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      errors.filter((e) => e.name === "JsonRpcTransportError").length,
      0,
      "no TransportError expected during closing",
    );
    assert.equal(client.isOpen(), false);
    assert.equal(client.getState(), "closed");
  });

  it("P1#3 parse error during `running` fails-fast on pending request", async () => {
    const errors = [];
    const { client, stdin } = makePair({
      onError: (err) => errors.push(err),
    });
    const pending = client.request("ping", null, 999_999);
    await new Promise((resolve) => setImmediate(resolve));
    // Malformed JSON line
    stdin.push("this is not json\n");
    await assert.rejects(pending, /closed|parse/i);
    assert.ok(
      errors.some((e) => e.name === "JsonRpcProtocolError"),
      `expected JsonRpcProtocolError, got: ${errors.map((e) => e.name).join(",")}`,
    );
  });
});
