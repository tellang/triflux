import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  recordRequest,
  reset,
  snapshot,
} from "../../hub/lib/trace-recorder.mjs";
import { startHub } from "../../hub/server.mjs";
import { releaseLock } from "../../hub/state.mjs";

const TEST_PORT = 27989 + Math.floor(Math.random() * 1000);
let hub;
let baseUrl;
let dbDir;
let testHome;
let previousToken;
let previousNodeEnv;
let previousTestHome;
let previousStateDir;

function parseJsonResponse(text, contentType) {
  if (!text || !contentType.includes("application/json")) return null;
  return JSON.parse(text);
}

async function postMcp(body, headers = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    res,
    text,
    json: parseJsonResponse(text, res.headers.get("content-type") || ""),
  };
}

async function initialize(headers = {}) {
  const result = await postMcp(
    {
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "triflux-test", version: "1.0.0" },
      },
    },
    headers,
  );
  assert.equal(result.res.status, 200, result.text);
  const sessionId = result.res.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize response must include mcp-session-id");
  return sessionId;
}

async function notifyInitialized(sessionId) {
  const result = await postMcp(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    { "mcp-session-id": sessionId },
  );
  assert.ok([200, 202].includes(result.res.status), result.text);
}

describe("MCP lifecycle trace", () => {
  before(async () => {
    previousToken = process.env.TFX_HUB_TOKEN;
    previousNodeEnv = process.env.NODE_ENV;
    previousTestHome = process.env.TRIFLUX_TEST_HOME;
    previousStateDir = process.env.TFX_HUB_STATE_DIR;
    delete process.env.TFX_HUB_TOKEN;
    process.env.NODE_ENV = "test";
    reset();
    dbDir = join(tmpdir(), `tfx-mcp-trace-${randomUUID()}`);
    testHome = join(dbDir, "home");
    mkdirSync(dbDir, { recursive: true });
    mkdirSync(testHome, { recursive: true });
    process.env.TRIFLUX_TEST_HOME = testHome;
    process.env.TFX_HUB_STATE_DIR = join(
      testHome,
      ".claude",
      "cache",
      "tfx-hub",
    );
    hub = await startHub({
      port: TEST_PORT,
      dbPath: join(dbDir, "hub.db"),
      host: "127.0.0.1",
      sessionId: `mcp-trace-${TEST_PORT}`,
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
    if (previousStateDir == null) {
      delete process.env.TFX_HUB_STATE_DIR;
    } else {
      process.env.TFX_HUB_STATE_DIR = previousStateDir;
    }
  });

  it("binds X-TFX-Client from initialize to the transport session", async () => {
    const sessionId = await initialize({ "X-TFX-Client": "codex" });
    const session = hub
      .getMcpSessions()
      .find((entry) => entry.id === sessionId);

    assert.ok(session);
    assert.equal(session.client, "codex");
    assert.equal(typeof session.createdAt, "number");
  });

  it("uses unknown when initialize has no X-TFX-Client header", async () => {
    const sessionId = await initialize();
    const session = hub
      .getMcpSessions()
      .find((entry) => entry.id === sessionId);

    assert.ok(session);
    assert.equal(session.client, "unknown");
  });

  it("records tools/list and tools/call in separate per-client buckets", async () => {
    reset();
    const sessionId = await initialize({ "X-TFX-Client": "codex" });
    await notifyInitialized(sessionId);

    const listResult = await postMcp(
      { jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: {} },
      { "mcp-session-id": sessionId },
    );
    assert.equal(listResult.res.status, 200, listResult.text);

    const callResult = await postMcp(
      {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "tools/call",
        params: { name: "__missing_trace_test__", arguments: {} },
      },
      { "mcp-session-id": sessionId },
    );
    assert.equal(callResult.res.status, 200, callResult.text);

    const metricsRes = await fetch(`${baseUrl}/status?include_metrics=1`);
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()).metrics;
    assert.equal(metrics.categories.initialize.codex.count, 1);
    assert.equal(metrics.categories["tools.list"].codex.count, 1);
    assert.equal(
      metrics.categories["tools.call.__missing_trace_test__"].codex.count,
      1,
    );
  });

  it("ignores invalid durations without throwing", () => {
    reset();
    recordRequest("tools.list", -1, "codex", "handler");
    recordRequest("tools.list", Number.NaN, "codex", "handler");

    assert.deepEqual(snapshot().categories, {});
  });
});
