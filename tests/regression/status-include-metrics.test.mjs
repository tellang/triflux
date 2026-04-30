import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { startHub } from "../../hub/server.mjs";
import { releaseLock } from "../../hub/state.mjs";

const TEST_PORT = 27889 + Math.floor(Math.random() * 1000);
let hub;
let baseUrl;
let dbDir;
let testHome;
let previousToken;
let previousNodeEnv;
let previousTestHome;

const BASELINE_FIELDS = [
  "hub",
  "queues",
  "assigns",
  "sessions",
  "pid",
  "port",
  "auth_mode",
  "idle_timeout_ms",
  "last_request_at",
  "pipe_path",
  "pipe",
  "assign_callback_pipe_path",
  "assign_callback_pipe",
  "spawn_trace",
  "version",
];

describe("/status include_metrics opt-in", () => {
  before(async () => {
    previousToken = process.env.TFX_HUB_TOKEN;
    previousNodeEnv = process.env.NODE_ENV;
    previousTestHome = process.env.TRIFLUX_TEST_HOME;
    delete process.env.TFX_HUB_TOKEN;
    process.env.NODE_ENV = "test";
    dbDir = join(tmpdir(), `tfx-status-metrics-${randomUUID()}`);
    testHome = join(dbDir, "home");
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(testHome, { recursive: true });
    process.env.TRIFLUX_TEST_HOME = testHome;
    hub = await startHub({
      port: TEST_PORT,
      dbPath: join(dbDir, "hub.db"),
      host: "127.0.0.1",
      sessionId: `status-metrics-${TEST_PORT}`,
    });
    baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  });

  after(async () => {
    if (hub?.stop) {
      await Promise.race([hub.stop(), new Promise((r) => setTimeout(r, 5000))]);
    }
    releaseLock();
    rmSync(dbDir, { recursive: true, force: true });
    if (previousToken == null) {
      delete process.env.TFX_HUB_TOKEN;
    } else {
      process.env.TFX_HUB_TOKEN = previousToken;
    }
    if (previousNodeEnv == null) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    if (previousTestHome == null) {
      delete process.env.TRIFLUX_TEST_HOME;
    } else {
      process.env.TRIFLUX_TEST_HOME = previousTestHome;
    }
  });

  it("preserves the default /status response fields without metrics", async () => {
    const res = await fetch(`${baseUrl}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const field of BASELINE_FIELDS) {
      assert.ok(field in body, `missing default /status field: ${field}`);
    }
    assert.equal("metrics" in body, false);
  });

  it("keeps /status?include_metrics=0 lean", async () => {
    const res = await fetch(`${baseUrl}/status?include_metrics=0`);
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const field of BASELINE_FIELDS) {
      assert.ok(field in body, `missing include_metrics=0 field: ${field}`);
    }
    assert.equal("metrics" in body, false);
  });

  it("adds metrics only for /status?include_metrics=1", async () => {
    const res = await fetch(`${baseUrl}/status?include_metrics=1`);
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const field of BASELINE_FIELDS) {
      assert.ok(field in body, `missing include_metrics=1 field: ${field}`);
    }
    assert.ok(body.metrics);
    assert.ok(body.metrics.categories);
    assert.ok(body.metrics.workers);
  });

  it("records bridge worker spawn and explicit exit without changing responses", async () => {
    const agentId = `trace-worker-${randomUUID()}`;
    const registerRes = await fetch(`${baseUrl}/bridge/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agentId,
        cli: "codex",
        timeout_sec: 60,
        metadata: { command: "node hub/bridge.mjs" },
      }),
    });
    assert.equal(registerRes.status, 200);
    const registerBody = await registerRes.json();
    assert.equal(registerBody.ok, true);
    assert.equal("metrics" in registerBody, false);

    const deregisterRes = await fetch(`${baseUrl}/bridge/deregister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId }),
    });
    assert.equal(deregisterRes.status, 200);
    const deregisterBody = await deregisterRes.json();
    assert.equal(deregisterBody.ok, true);
    assert.equal("metrics" in deregisterBody, false);

    const metricsRes = await fetch(`${baseUrl}/status?include_metrics=1`);
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()).metrics;
    assert.ok(metrics.workers.spawned >= 1);
    assert.ok(metrics.workers.exited >= 1);
    assert.equal(typeof metrics.workers.p50, "number");
  });
});
