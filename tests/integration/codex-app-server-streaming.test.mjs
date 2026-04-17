// tests/integration/codex-app-server-streaming.test.mjs — PRD-4 end-to-end
//
// Strategy
//  - Scenarios (a) and (b) spawn the deterministic
//    `tests/fixtures/fake-codex-app-server.mjs` (PRD-2) via `process.execPath`
//    so the full CodexAppServerWorker stack runs — factory + JsonRpcStdioClient
//    + real child_process — without touching the real codex binary.
//  - Scenario (c) is gated by `TFX_RUN_REAL_CODEX_APP_SERVER=1`. When enabled
//    it runs the real `codex` binary and asserts PONG appears in the stream.
//  - Scenario (d) (AC-15) captures the spawned child's PID via `spawnFn`
//    wrapper and confirms `process.kill(pid, 0)` throws after `stop()` — i.e.
//    the child is truly dead (no PID zombie).
//
// Target ACs
//  - AC-2   end-to-end PONG via factory-created worker
//  - AC-10  publish contract smoke (envelope shape matches bridge.mjs
//           buildPublishBody)
//  - AC-15  PID zombie absence after execute + stop
//  - AC-16  (env-gated) real codex → actual unknown method detection
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createWorker } from "../../hub/workers/factory.mjs";
import { JsonRpcStdioClient } from "../../hub/workers/lib/jsonrpc-stdio.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const FAKE_SERVER = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "fake-codex-app-server.mjs",
);

const REAL_CODEX_ENABLED = process.env.TFX_RUN_REAL_CODEX_APP_SERVER === "1";

// NOTE: PRD-4 discovered a wildcard callback arg-order bug between
// JsonRpcStdioClient and CodexAppServerWorker catchAll. Fixed post-PRD-4 in
// hub/workers/codex-app-server-worker.mjs by flipping the catchAll signature
// to (params, method). Integration tests below now use the real client
// unshimmed.

/**
 * Wrap `spawn` so the test can observe the real child PID for AC-15.
 */
function makePidCapturingSpawn(state) {
  return (command, args, options) => {
    const child = spawn(command, args, options);
    state.child = child;
    state.pid = child.pid;
    return child;
  };
}

/**
 * Platform-aware "is this PID still alive?" check.
 *  - POSIX: `process.kill(pid, 0)` throws ESRCH when the pid is gone.
 *  - Windows: `process.kill(pid, 0)` works for our own descendants, so we use
 *    it directly. We retry a few times because SIGTERM → exit can take a tick.
 */
async function waitForPidDead(pid, { attempts = 20, intervalMs = 50 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    let alive;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      if (err && err.code === "ESRCH") {
        alive = false;
      } else if (err && err.code === "EPERM") {
        // Permission denied means the process exists but is not ours; treat as
        // alive for the purposes of this test.
        alive = true;
      } else {
        alive = false;
      }
    }
    if (!alive) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ── Scenario (a) — fake app-server + factory-created worker ──────────

describe("codex-app-server integration — fake app-server + factory", () => {
  it("1. AC-2 / AC-10 — execute('Say PONG') returns PONG and publishes ≥3 envelopes", {
    timeout: 15_000,
  }, async () => {
    const publishes = [];
    const worker = createWorker("codex", {
      transport: "app-server",
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_MODE: "ok", FAKE_DELTAS: "P,O,N,G" },
      bootstrapTimeoutMs: 5_000,
      // WildcardOrderAdapter compensates for the PRD-1/PRD-2 wildcard arg
      // order bug — see header note.
      publishCallback: (msg) => {
        publishes.push(msg);
      },
    });

    try {
      const result = await worker.execute("Say PONG", {
        sessionKey: "sess-int-a",
        timeoutMs: 8_000,
      });

      // AC-2 — end-to-end PONG via factory-created worker
      assert.equal(result.exitCode, 0, "turn must complete cleanly");
      assert.equal(result.output, "PONG");
      assert.equal(typeof result.threadId, "string");
      assert.ok(result.threadId.length > 0);

      // AC-10 — publish contract smoke (≥3 envelopes: thread/started,
      // turn/started, ≥1 item/agentMessage/delta, turn/completed).
      assert.ok(
        publishes.length >= 3,
        `expected ≥3 publishes, got ${publishes.length}`,
      );

      // Envelope shape must match bridge.mjs buildPublishBody
      // (from / to / topic / type / payload).
      for (const msg of publishes) {
        assert.equal(typeof msg.from, "string");
        assert.equal(msg.to, "topic:agent.progress");
        assert.equal(msg.topic, "agent.progress");
        assert.equal(msg.type, "event");
        assert.ok(msg.payload && typeof msg.payload === "object");
        assert.equal(msg.payload.type, "agent.progress");
        assert.equal(msg.payload.version, 1);
        assert.equal(msg.payload.sessionKey, "sess-int-a");
        assert.equal(typeof msg.payload.method, "string");
        assert.equal(typeof msg.payload.kind, "string");
        assert.equal(typeof msg.payload.timestamp, "number");
      }

      // Spot-check the three expected notification kinds are present.
      const methods = publishes.map((m) => m.payload.method);
      assert.ok(
        methods.includes("thread/started"),
        `thread/started missing; got ${JSON.stringify(methods)}`,
      );
      assert.ok(
        methods.some((m) => m === "item/agentMessage/delta"),
        `item/agentMessage/delta missing; got ${JSON.stringify(methods)}`,
      );
      assert.ok(
        methods.includes("turn/completed"),
        `turn/completed missing; got ${JSON.stringify(methods)}`,
      );

      // Timestamps must be strictly monotonic.
      let prev = -Infinity;
      for (const msg of publishes) {
        assert.ok(
          msg.payload.timestamp > prev,
          `timestamp must be monotonic: ${msg.payload.timestamp} > ${prev}`,
        );
        prev = msg.payload.timestamp;
      }
    } finally {
      await worker.stop().catch(() => {});
    }
  });
});

// ── Scenario (b) — fake app-server + real JsonRpcStdioClient full stack ──

describe("codex-app-server integration — full stack (no mocks)", () => {
  it("2. real JsonRpcStdioClient drives fake app-server end-to-end", {
    timeout: 15_000,
  }, async () => {
    const publishes = [];
    // Real JsonRpcStdioClient path via `WildcardOrderAdapter` — still a real
    // pipe, real child, real protocol parser. The adapter only patches the
    // wildcard arg order (see header note for the PRD-1/2 bug handoff).
    const worker = createWorker("codex-app-server", {
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_MODE: "ok", FAKE_DELTAS: "PONG" },
      bootstrapTimeoutMs: 5_000,
      publishCallback: (msg) => {
        publishes.push(msg);
      },
    });

    // Sanity — the factory gave us an app-server worker.
    assert.equal(worker.transport, "app-server");

    try {
      const result = await worker.execute("Say PONG", {
        sessionKey: "sess-int-b",
        timeoutMs: 8_000,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "PONG");
      assert.ok(publishes.length > 0);
    } finally {
      await worker.stop().catch(() => {});
    }
  });

  it("3. JsonRpcStdioClient reports isOpen semantics over a live fake stream", {
    timeout: 10_000,
  }, async () => {
    // Minimal direct-stream check: spawn the fake, wire a client, complete
    // initialize, then close. Asserts that the client's lifecycle is sane
    // when driven by an actual pipe (and not the unit-level EventEmitter).
    const child = spawn(process.execPath, [FAKE_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FAKE_MODE: "ok" },
    });
    try {
      const client = new JsonRpcStdioClient({
        stdin: child.stdout,
        stdout: child.stdin,
      });
      assert.equal(client.isOpen(), true);
      const init = await client.request(
        "initialize",
        {
          clientInfo: { name: "integration", version: "0" },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [],
          },
        },
        3_000,
      );
      assert.ok(init && typeof init === "object");
      client.close();
      assert.equal(client.isOpen(), false);
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  });
});

// ── Scenario (d) — AC-15 PID zombie absence ─────────────────────────

describe("codex-app-server integration — AC-15 PID zombie check", () => {
  it("4. child PID is dead after execute + stop", {
    timeout: 15_000,
  }, async () => {
    const pidState = {};
    const wrappedSpawn = makePidCapturingSpawn(pidState);

    const worker = createWorker("codex", {
      transport: "app-server",
      command: process.execPath,
      args: [FAKE_SERVER],
      env: { FAKE_MODE: "ok" },
      bootstrapTimeoutMs: 5_000,
      spawnFn: wrappedSpawn,
      publishCallback: () => {},
    });

    const result = await worker.execute("ping", {
      sessionKey: "sess-int-d",
      timeoutMs: 8_000,
    });
    assert.equal(result.exitCode, 0);

    assert.equal(typeof pidState.pid, "number");
    assert.ok(pidState.pid > 0, "child pid must have been captured");

    await worker.stop();

    const dead = await waitForPidDead(pidState.pid);
    assert.equal(
      dead,
      true,
      `child pid ${pidState.pid} must not leak after stop()`,
    );
  });
});

// ── Scenario (c) — env-gated real codex ──────────────────────────────

describe("codex-app-server integration — real codex (env-gated)", () => {
  it("5. AC-16 — real codex 0.119.0 streams PONG through factory worker", {
    timeout: 120_000,
    skip: !REAL_CODEX_ENABLED,
  }, async () => {
    const publishes = [];
    const worker = createWorker("codex-app-server", {
      bootstrapTimeoutMs: 15_000,
      publishCallback: (msg) => {
        publishes.push(msg);
      },
    });

    try {
      const result = await worker.execute(
        "Respond with exactly one word: PONG",
        { sessionKey: "sess-int-real", timeoutMs: 90_000 },
      );
      assert.equal(result.exitCode, 0);
      assert.match(result.output, /PONG/i);
      assert.ok(publishes.length > 0);
    } finally {
      await worker.stop().catch(() => {});
    }
  });
});
