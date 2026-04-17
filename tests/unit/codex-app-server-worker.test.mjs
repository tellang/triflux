// tests/unit/codex-app-server-worker.test.mjs — PRD-2 unit coverage
//
// Strategy
//  - We do NOT import the real JsonRpcStdioClient. PRD-1 and PRD-2 ship in
//    parallel so tests must not depend on PRD-1's runtime behaviour.
//  - The worker accepts `jsonRpcClientClass` as a constructor option for DI.
//    Each test injects a fake that records sends, resolves requests, and
//    dispatches notifications.
//  - `spawnFn` is injected too so we never touch `child_process`.
//
// Target ACs: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC12, AC13, AC14, AC15,
// AC16, AC17 — 14 of the 18 total. Remaining (AC9 factory, AC10 publish shape
// integration, AC11 regression, AC18 DoS) land in PRD-3/PRD-4.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  CODEX_APP_SERVER_EXECUTION_EXIT_CODE,
  CODEX_APP_SERVER_TIMEOUT_EXIT_CODE,
  CODEX_APP_SERVER_TRANSPORT_EXIT_CODE,
  CodexAppServerTransportError,
  CodexAppServerWorker,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  KIND_MAP,
  OPT_OUT_METHODS,
  SUBSCRIBED_METHODS,
} from "../../hub/workers/codex-app-server-worker.mjs";

// ── FakeJsonRpcClient family ───────────────────────────────────

/**
 * Base fake JSON-RPC client. Subclasses override `request()` to shape the
 * test-specific response timing.
 */
class FakeClientBase {
  constructor({ stdin, stdout, onError, maxLineSize } = {}) {
    FakeClientBase.last = this;
    this.stdin = stdin;
    this.stdout = stdout;
    this.onError = onError;
    this.maxLineSize = maxLineSize;
    this.open = true;
    /** @type {Array<{ method: string, params: any, notify?: boolean }>} */
    this.sent = [];
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
    /** @type {Array<{ method: string, resolve: Function, reject: Function }>} */
    this.pending = [];
  }

  /** Push a notification to all registered handlers. */
  emitNotification(method, params) {
    const specific = this.handlers.get(method) || [];
    const catchAll = this.handlers.get("*") || [];
    for (const cb of specific) cb(params, method);
    for (const cb of catchAll) cb(params, method);
  }

  notify(method, params) {
    if (!this.open) return;
    this.sent.push({ method, params, notify: true });
  }

  onNotification(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
    return () => {
      const arr = this.handlers.get(method);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  close() {
    this.open = false;
  }

  isOpen() {
    return this.open === true;
  }

  request(method, params) {
    this.sent.push({ method, params });
    return new Promise((resolve, reject) => {
      this.pending.push({ method, resolve, reject });
    });
  }
}

/** The happy-path default: initialize + thread/start + turn/start all resolve. */
class PrimedFake extends FakeClientBase {
  request(method, params, timeoutMs) {
    this.sent.push({ method, params });
    if (method === "initialize") {
      return Promise.resolve({
        userAgent: "fake/0",
        codexHome: "/tmp/codex",
        platformFamily: "unix",
        platformOs: "linux",
      });
    }
    if (method === "thread/start") {
      return Promise.resolve({
        thread: { id: "thread-1" },
        model: "m",
        modelProvider: "p",
        serviceTier: null,
        cwd: "/",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { mode: "read-only" },
        reasoningEffort: null,
      });
    }
    if (method === "turn/start") {
      return Promise.resolve({ turnId: "turn-1" });
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ method, resolve, reject });
    });
  }
}

/** Initialize hangs forever, triggers bootstrap timeout. */
class TimeoutInitFake extends FakeClientBase {
  request(method, params, timeoutMs) {
    this.sent.push({ method, params });
    if (method === "initialize") {
      return new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error(`initialize timeout ${timeoutMs}ms`)),
          Math.min(timeoutMs ?? 100, 50),
        );
        t.unref?.();
      });
    }
    return new Promise(() => {});
  }
}

/** thread/start stays pending until test resolves `_threadStartResolve`. */
class RacingFake extends FakeClientBase {
  request(method, params) {
    this.sent.push({ method, params });
    if (method === "initialize") {
      return Promise.resolve({
        userAgent: "f",
        codexHome: "/",
        platformFamily: "u",
        platformOs: "l",
      });
    }
    if (method === "thread/start") {
      return new Promise((resolve) => {
        this._threadStartResolve = resolve;
      });
    }
    if (method === "turn/start") {
      return Promise.resolve({});
    }
    return new Promise(() => {});
  }
}

// ── Fake child process ─────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new EventEmitter();
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
    /** @type {Array<string>} */
    this.signals = [];
  }

  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
}

function makeSpawn({ failSpawn = false, childRef = {} } = {}) {
  return (command, args, options) => {
    if (failSpawn) {
      const err = new Error("spawn ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    const child = new FakeChild();
    childRef.command = command;
    childRef.args = args;
    childRef.options = options;
    childRef.child = child;
    return child;
  };
}

// ── Harness ────────────────────────────────────────────────────

function makeWorker({ clientClass = PrimedFake, ...overrides } = {}) {
  const childRef = {};
  const publishes = [];
  const warns = [];
  const worker = new CodexAppServerWorker({
    command: "fake-codex",
    spawnFn: makeSpawn({ childRef }),
    jsonRpcClientClass: clientClass,
    publishCallback: (msg) => publishes.push(msg),
    warn: (label, payload) => warns.push({ label, payload }),
    bootstrapTimeoutMs: 500,
    ...overrides,
  });
  return { worker, childRef, publishes, warns };
}

async function tick(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

function emitAgentDeltas(client, deltas) {
  for (const d of deltas) {
    client.emitNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: d,
    });
  }
}

function emitTurnCompleted(client, status = "completed") {
  client.emitNotification("turn/completed", {
    threadId: "thread-1",
    turn: {
      id: "turn-1",
      items: [],
      status,
      error:
        status === "failed"
          ? { code: "boom", message: "turn failed explicitly" }
          : null,
      startedAt: 0,
      completedAt: 0,
      durationMs: 100,
    },
  });
}

// ── Tests ──────────────────────────────────────────────────────

describe("CodexAppServerWorker — constants", () => {
  it("SUBSCRIBED_METHODS covers the 25 expected methods", () => {
    // Note: spec said "~24" (architect approximation). Actual count is 25
    // because item/commandExecution/terminalInteraction is its own entry.
    assert.equal(SUBSCRIBED_METHODS.size, 25);
    assert.ok(SUBSCRIBED_METHODS.has("item/agentMessage/delta"));
    assert.ok(SUBSCRIBED_METHODS.has("turn/completed"));
    assert.ok(SUBSCRIBED_METHODS.has("error"));
  });

  it("OPT_OUT_METHODS has 27 entries", () => {
    assert.equal(OPT_OUT_METHODS.length, 27);
  });

  it("KIND_MAP exposes 12 distinct publish kinds across 25 methods", () => {
    assert.equal(Object.keys(KIND_MAP).length, 25);
    const kinds = new Set(Object.values(KIND_MAP));
    assert.equal(kinds.size, 12);
    // Spot-check known mappings
    assert.equal(KIND_MAP["item/agentMessage/delta"], "text_delta");
    assert.equal(KIND_MAP["turn/completed"], "turn_status");
    assert.equal(KIND_MAP["error"], "error");
    assert.equal(KIND_MAP["item/fileChange/outputDelta"], "file_delta");
  });
});

describe("CodexAppServerWorker — AC-1 start handshake", () => {
  it("1. start() spawns codex with default args and completes initialize+initialized", async () => {
    const { worker, childRef } = makeWorker();
    await worker.start();
    assert.equal(worker.isReady(), true);
    assert.deepEqual(childRef.args, [...DEFAULT_CODEX_APP_SERVER_ARGS]);
    const sent = FakeClientBase.last.sent;
    const init = sent.find((s) => s.method === "initialize");
    assert.ok(init, "initialize sent");
    const optOut = init.params.capabilities.optOutNotificationMethods;
    assert.equal(optOut.length, 27);
    for (const m of OPT_OUT_METHODS) assert.ok(optOut.includes(m));
    const initialized = sent.find(
      (s) => s.method === "initialized" && s.notify,
    );
    assert.ok(initialized, "initialized notification emitted");
    assert.equal(init.params.capabilities.experimentalApi, true);
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-1 initialize timeout", () => {
  it("2. initialize timeout resolves to TransportError and ready=false", async () => {
    const { worker } = makeWorker({
      clientClass: TimeoutInitFake,
      bootstrapTimeoutMs: 30,
    });
    await assert.rejects(
      () => worker.start(),
      (err) => err instanceof CodexAppServerTransportError,
    );
    assert.equal(worker.isReady(), false);
  });
});

describe("CodexAppServerWorker — AC-7 spawn ENOENT", () => {
  it("3. spawn ENOENT throws CodexAppServerTransportError", async () => {
    const worker = new CodexAppServerWorker({
      command: "missing",
      jsonRpcClientClass: PrimedFake,
      spawnFn: () => {
        const err = new Error("spawn ENOENT missing");
        err.code = "ENOENT";
        throw err;
      },
    });
    await assert.rejects(
      () => worker.start(),
      (err) => err instanceof CodexAppServerTransportError,
    );
    assert.equal(worker.isReady(), false);
  });
});

describe("CodexAppServerWorker — AC-2 / AC-3 happy path", () => {
  it("4. execute('Say PONG') returns concatenated deltas with exit 0", async () => {
    const { worker } = makeWorker();
    const execPromise = worker.execute("Say PONG");
    await tick();
    const client = FakeClientBase.last;
    const threadStart = client.sent.find((s) => s.method === "thread/start");
    assert.ok(threadStart, "thread/start sent");
    assert.equal(threadStart.params.prompt, undefined);
    const turnStart = client.sent.find((s) => s.method === "turn/start");
    assert.ok(turnStart, "turn/start sent");
    assert.deepEqual(turnStart.params.input, [
      { type: "text", text: "Say PONG", text_elements: [] },
    ]);
    emitAgentDeltas(client, ["P", "O", "N", "G"]);
    emitTurnCompleted(client, "completed");
    const result = await execPromise;
    assert.equal(result.output, "PONG");
    assert.equal(result.exitCode, 0);
    assert.equal(result.threadId, "thread-1");
    await worker.stop();
  });

  it("5. multiple deltas concatenate exactly with no trim/newline", async () => {
    const { worker } = makeWorker();
    const execPromise = worker.execute("anything");
    await tick();
    const client = FakeClientBase.last;
    emitAgentDeltas(client, [" hello ", "\nworld ", "!"]);
    emitTurnCompleted(client, "completed");
    const result = await execPromise;
    assert.equal(result.output, " hello \nworld !");
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-4 turn statuses", () => {
  it("6. turn.status=completed -> exitCode 0", async () => {
    const { worker } = makeWorker();
    const p = worker.execute("x");
    await tick();
    emitAgentDeltas(FakeClientBase.last, ["ok"]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    const r = await p;
    assert.equal(r.exitCode, 0);
    assert.equal(r.output, "ok");
    await worker.stop();
  });

  it("7. turn.status=failed -> execution exit code", async () => {
    const { worker } = makeWorker();
    const p = worker.execute("x");
    await tick();
    emitAgentDeltas(FakeClientBase.last, ["partial"]);
    emitTurnCompleted(FakeClientBase.last, "failed");
    const r = await p;
    assert.equal(r.exitCode, CODEX_APP_SERVER_EXECUTION_EXIT_CODE);
    assert.equal(r.output, "partial");
    assert.ok(r.error);
    await worker.stop();
  });

  it("8. turn.status=interrupted -> execution exit code", async () => {
    const { worker } = makeWorker();
    const p = worker.execute("x");
    await tick();
    emitTurnCompleted(FakeClientBase.last, "interrupted");
    const r = await p;
    assert.equal(r.exitCode, CODEX_APP_SERVER_EXECUTION_EXIT_CODE);
    await worker.stop();
  });

  it("9. error notification yields execution error WorkerResult", async () => {
    const { worker } = makeWorker();
    const p = worker.execute("x");
    await tick();
    FakeClientBase.last.emitNotification("error", {
      threadId: "thread-1",
      message: "synthetic",
    });
    const r = await p;
    assert.equal(r.exitCode, CODEX_APP_SERVER_EXECUTION_EXIT_CODE);
    assert.match(r.error.message, /synthetic/);
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-5 opt-out defense", () => {
  it("10. opt-out method injected mid-stream is dropped", async () => {
    const { worker, publishes } = makeWorker();
    const p = worker.execute("x");
    await tick();
    FakeClientBase.last.emitNotification("fs/changed", { path: "/tmp/x" });
    emitAgentDeltas(FakeClientBase.last, ["data"]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    const fsPublish = publishes.find(
      (m) => m.payload.method === "fs/changed",
    );
    assert.equal(fsPublish, undefined);
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-6 unknown method", () => {
  it("11. unknown method warns-once and is skipped", async () => {
    const { worker, warns, publishes } = makeWorker();
    const p = worker.execute("x");
    await tick();
    FakeClientBase.last.emitNotification("codex/future/thing", { any: 1 });
    FakeClientBase.last.emitNotification("codex/future/thing", { any: 2 });
    emitAgentDeltas(FakeClientBase.last, ["ok"]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    const futurePublished = publishes.find(
      (m) => m.payload.method === "codex/future/thing",
    );
    assert.equal(futurePublished, undefined);
    const futureWarns = warns.filter(
      (w) =>
        w.label === "unknown notification method" &&
        w.payload.method === "codex/future/thing",
    );
    assert.equal(futureWarns.length, 1, "warn only once");
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-8 timeout", () => {
  it("12. timeout produces partial WorkerResult with SIGTERM", async () => {
    const { worker, childRef } = makeWorker();
    const p = worker.execute("x", { timeoutMs: 30 });
    await tick();
    emitAgentDeltas(FakeClientBase.last, ["partial-"]);
    const r = await p;
    assert.equal(r.exitCode, CODEX_APP_SERVER_TIMEOUT_EXIT_CODE);
    assert.equal(r.output, "partial-");
    assert.ok(
      childRef.child.signals.includes("SIGTERM"),
      "child received SIGTERM",
    );
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-12 publish invariants", () => {
  it("13. publish messages carry monotonic timestamps + non-empty fields", async () => {
    const { worker, publishes } = makeWorker({ workerId: "wk-123" });
    const p = worker.execute("x", { sessionKey: "sess-1" });
    await tick();
    FakeClientBase.last.emitNotification("thread/started", {
      thread: { id: "thread-1" },
    });
    emitAgentDeltas(FakeClientBase.last, ["a", "b", "c"]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    assert.ok(publishes.length > 0);
    let prev = -Infinity;
    for (const m of publishes) {
      assert.ok(
        m.payload.timestamp > prev,
        `monotonic ${m.payload.timestamp} > ${prev}`,
      );
      prev = m.payload.timestamp;
      assert.equal(m.payload.agentId, "wk-123");
      assert.equal(m.payload.sessionKey, "sess-1");
      assert.equal(m.payload.threadId, "thread-1");
    }
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-13 defaults", () => {
  it("14. default sandbox 'read-only' and args start with --skip-git-repo-check", async () => {
    const { worker, childRef } = makeWorker();
    const p = worker.execute("x");
    await tick();
    const ts = FakeClientBase.last.sent.find(
      (s) => s.method === "thread/start",
    );
    assert.equal(ts.params.sandbox, "read-only");
    assert.equal(ts.params.ephemeral, true);
    assert.equal(ts.params.experimentalRawEvents, false);
    assert.equal(ts.params.persistExtendedHistory, false);
    assert.equal(childRef.args[0], "--skip-git-repo-check");
    assert.equal(childRef.args[1], "app-server");
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-14 forward compat", () => {
  it("15. future codex method is ignored + execution still succeeds", async () => {
    const { worker } = makeWorker();
    const p = worker.execute("x");
    await tick();
    FakeClientBase.last.emitNotification("codex/brandnew/method", { a: 1 });
    emitAgentDeltas(FakeClientBase.last, ["text"]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    const r = await p;
    assert.equal(r.exitCode, 0);
    assert.equal(r.output, "text");
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-15 stop", () => {
  it("16. stop() kills child and resets ready", async () => {
    const { worker, childRef } = makeWorker();
    await worker.start();
    assert.equal(worker.isReady(), true);
    await worker.stop();
    assert.equal(worker.isReady(), false);
    assert.ok(childRef.child.signals.includes("SIGTERM"));
  });
});

describe("CodexAppServerWorker — AC-16 protocol mismatch", () => {
  it("17. >threshold unknown methods emits protocol_version_mismatch warn", async () => {
    const { worker, warns } = makeWorker({ unknownMethodWarnThreshold: 3 });
    const p = worker.execute("x");
    await tick();
    for (let i = 0; i < 6; i += 1) {
      FakeClientBase.last.emitNotification(`codex/new/${i}`, { i });
    }
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    const mismatch = warns.find((w) => w.label === "protocol_version_mismatch");
    assert.ok(mismatch, "protocol_version_mismatch warn was emitted");
    assert.ok(mismatch.payload.count >= 4);
    assert.equal(mismatch.payload.threshold, 3);
    await worker.stop();
  });
});

describe("CodexAppServerWorker — AC-17 redaction", () => {
  it("18. redactSensitive=false preserves plaintext in publish", async () => {
    const { worker, publishes } = makeWorker({ redactSensitive: false });
    const p = worker.execute("x");
    await tick();
    emitAgentDeltas(FakeClientBase.last, [
      "this is a very long plaintext delta that should not be hashed",
    ]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    const textPublish = publishes.find(
      (m) => m.payload.method === "item/agentMessage/delta",
    );
    assert.ok(textPublish);
    assert.match(textPublish.payload.data.delta, /plaintext/);
    await worker.stop();
  });

  it("19. redactSensitive=true replaces long strings with sha256 hash", async () => {
    const { worker, publishes } = makeWorker({ redactSensitive: true });
    const p = worker.execute("x");
    await tick();
    emitAgentDeltas(FakeClientBase.last, [
      "this is a very long plaintext delta to redact because it exceeds 32 chars",
    ]);
    emitTurnCompleted(FakeClientBase.last, "completed");
    await p;
    const textPublish = publishes.find(
      (m) => m.payload.method === "item/agentMessage/delta",
    );
    assert.ok(textPublish);
    assert.match(textPublish.payload.data.delta, /^sha256:[0-9a-f]{64}$/);
    await worker.stop();
  });
});

describe("CodexAppServerWorker — thread id race", () => {
  it("20. thread/started notification before thread/start response still extracts threadId", async () => {
    const { worker } = makeWorker({ clientClass: RacingFake });
    const p = worker.execute("x");
    await tick();
    const racing = FakeClientBase.last;
    // Fire notification BEFORE resolving the pending thread/start response
    racing.emitNotification("thread/started", {
      thread: { id: "thread-early" },
    });
    racing._threadStartResolve({
      thread: { id: "thread-early" },
      model: "m",
      modelProvider: "p",
      serviceTier: null,
      cwd: "/",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { mode: "read-only" },
      reasoningEffort: null,
    });
    await tick();
    emitAgentDeltas(racing, ["ok"]);
    emitTurnCompleted(racing, "completed");
    const r = await p;
    assert.equal(r.threadId, "thread-early");
    assert.equal(r.output, "ok");
    await worker.stop();
  });
});

describe("CodexAppServerWorker — inflightRejectors & stale timer", () => {
  it("inflightRejectors set is drained after thread/start failures (no leak)", async () => {
    class RejectingThreadStart extends FakeClientBase {
      request(method, params, timeoutMs) {
        this.sent.push({ method, params });
        if (method === "initialize") {
          return Promise.resolve({
            userAgent: "f",
            codexHome: "/",
            platformFamily: "u",
            platformOs: "l",
          });
        }
        if (method === "thread/start") {
          return Promise.reject(new Error("thread/start boom"));
        }
        return new Promise(() => {});
      }
    }
    const { worker } = makeWorker({ clientClass: RejectingThreadStart });
    await worker.start();
    for (let i = 0; i < 5; i += 1) {
      const r = await worker.execute(`p${i}`);
      assert.equal(r.exitCode, CODEX_APP_SERVER_TRANSPORT_EXIT_CODE);
      assert.equal(r.error.code, "CODEX_APP_SERVER_TRANSPORT_ERROR");
    }
    assert.equal(
      worker._inflightRejectors.size,
      0,
      "failed execute() must not leave stale rejectors behind",
    );
    await worker.stop();
  });

  it("stale timeout timer does not SIGTERM the child after prior execute completed", async () => {
    const { worker, childRef } = makeWorker({ clientClass: PrimedFake });
    await worker.start();
    const client = FakeClientBase.last;

    // A: short timeoutMs; completes well before the timer fires
    const a = worker.execute("A", { timeoutMs: 40 });
    await tick();
    emitTurnCompleted(client, "completed");
    const resultA = await a;
    assert.equal(resultA.exitCode, 0);

    // Wait past A's original timeout: stale timer (pre-fix) would fire here
    await new Promise((r) => setTimeout(r, 80));

    // B: long timeoutMs, uses the same child
    const b = worker.execute("B", { timeoutMs: 10_000 });
    await tick();
    emitTurnCompleted(client, "completed");
    const resultB = await b;
    assert.equal(resultB.exitCode, 0);

    assert.deepEqual(
      childRef.child.signals,
      [],
      "no SIGTERM should be issued after A completes normally",
    );
    await worker.stop();
  });
});
