// tests/unit/jsonrpc-ws-uds.test.mjs
// JsonRpcWsUdsClient + createCodexAppServerUdsEndpoint over a fake
// WebSocket-over-UDS server (no real codex, zero quota).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createCodexAppServerUdsEndpoint } from "../../hub/team/uds-orchestrator.mjs";
import { JsonRpcWsUdsClient } from "../../hub/workers/lib/jsonrpc-ws-uds.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const FAKE_WS_SERVER = resolve(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "fake-codex-app-server-ws-uds.mjs",
);

async function waitForSocket(sockPath, deadlineMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      if ((await stat(sockPath)).isSocket()) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

let fakeServerSeq = 0;

async function startFakeServer(dir, env = {}) {
  // Unique socket path per call — tests in a suite share `dir`, and a reused
  // path races a not-yet-unlinked stale socket from a prior test (EADDRINUSE on
  // the new fake + stale-socket "ready" false positive => dead-socket timeout).
  const sockPath = join(dir, `fake-${++fakeServerSeq}.sock`);
  const child = spawn(process.execPath, [FAKE_WS_SERVER, sockPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const ok = await waitForSocket(sockPath);
  if (!ok) {
    try {
      child.kill("SIGKILL");
    } catch {}
    throw new Error("fake ws-uds server did not bind socket");
  }
  return { child, sockPath };
}

function killChild(child) {
  if (!child || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {}
}

describe("JsonRpcWsUdsClient over fake WebSocket-over-UDS", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "tfx-ws-uds-test-"));
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("connects, completes the initialize handshake, and runs a turn", async () => {
    const { child, sockPath } = await startFakeServer(dir, {
      FAKE_DELTAS: "P,O,N,G",
    });
    const client = new JsonRpcWsUdsClient({ socketPath: sockPath });
    try {
      await client.connect();
      assert.equal(client.isOpen(), true);

      const init = await client.request(
        "initialize",
        { clientInfo: { name: "test", version: "0" } },
        3000,
      );
      assert.equal(typeof init.codexHome, "string");
      assert.equal(init.platformFamily, "unix");

      client.notify("initialized", {});

      const threadStart = await client.request("thread/start", {}, 3000);
      const threadId = threadStart?.thread?.id;
      assert.equal(typeof threadId, "string");

      const parts = [];
      const completed = new Promise((res) => {
        client.onNotification("item/agentMessage/delta", (p) => {
          if (typeof p?.delta === "string") parts.push(p.delta);
        });
        client.onNotification("turn/completed", (p) => res(p?.turn?.status));
      });
      await client.request(
        "turn/start",
        { threadId, input: [{ type: "text", text: "Say PONG" }] },
        3000,
      );
      const status = await completed;
      assert.equal(status, "completed");
      assert.equal(parts.join(""), "PONG");
    } finally {
      client.close();
      assert.equal(client.isOpen(), false);
      killChild(child);
    }
  });

  it("reassembles fragmented server messages (text + continuation)", async () => {
    const { child, sockPath } = await startFakeServer(dir, {
      FAKE_FRAGMENT: "1",
      FAKE_DELTAS: "P,O,N,G",
    });
    const client = new JsonRpcWsUdsClient({ socketPath: sockPath });
    try {
      await client.connect();
      // initialize response is itself fragmented by the fake under FAKE_FRAGMENT.
      const init = await client.request(
        "initialize",
        { clientInfo: { name: "test", version: "0" } },
        3000,
      );
      assert.equal(typeof init.codexHome, "string");
      client.notify("initialized", {});
      const threadStart = await client.request("thread/start", {}, 3000);
      const threadId = threadStart?.thread?.id;
      assert.equal(typeof threadId, "string");
      const parts = [];
      const completed = new Promise((res) => {
        client.onNotification("item/agentMessage/delta", (p) => {
          if (typeof p?.delta === "string") parts.push(p.delta);
        });
        client.onNotification("turn/completed", (p) => res(p?.turn?.status));
      });
      await client.request(
        "turn/start",
        { threadId, input: [{ type: "text", text: "Say PONG" }] },
        3000,
      );
      assert.equal(await completed, "completed");
      assert.equal(parts.join(""), "PONG");
    } finally {
      client.close();
      killChild(child);
    }
  });

  it("rejects requests after close()", async () => {
    const { child, sockPath } = await startFakeServer(dir);
    const client = new JsonRpcWsUdsClient({ socketPath: sockPath });
    try {
      await client.connect();
      client.close();
      await assert.rejects(() => client.request("initialize", {}, 1000));
    } finally {
      killChild(child);
    }
  });
});

describe("createCodexAppServerUdsEndpoint (attach mode, fake server)", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "tfx-ws-uds-ep-test-"));
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("ask() returns the assembled agent text with done=true on completed turn", async () => {
    const { child, sockPath } = await startFakeServer(dir, {
      FAKE_DELTAS: "PO,NG",
    });
    try {
      const endpoint = createCodexAppServerUdsEndpoint({
        socketPath: sockPath,
        spawnServer: false,
        timeoutMs: 5000,
        bootstrapTimeoutMs: 3000,
      });
      assert.equal(endpoint.name, "codex-app-server-uds");
      const result = await endpoint.ask("Say PONG");
      assert.equal(result.endpoint, "codex-app-server-uds");
      assert.equal(result.text, "PONG");
      assert.equal(result.done, true);
      assert.equal(result.meta.status, "completed");
      assert.equal(result.meta.spawned, false);
    } finally {
      killChild(child);
    }
  });

  it("ask() reports done=false when the turn fails", async () => {
    const { child, sockPath } = await startFakeServer(dir, {
      FAKE_MODE: "execution-failed",
    });
    try {
      const endpoint = createCodexAppServerUdsEndpoint({
        socketPath: sockPath,
        spawnServer: false,
        timeoutMs: 5000,
        bootstrapTimeoutMs: 3000,
      });
      const result = await endpoint.ask("Say PONG");
      assert.equal(result.done, false);
      assert.equal(result.meta.status, "failed");
    } finally {
      killChild(child);
    }
  });

  it("ask() rejects an empty prompt", async () => {
    const endpoint = createCodexAppServerUdsEndpoint({
      socketPath: "/nonexistent.sock",
      spawnServer: false,
    });
    await assert.rejects(() => endpoint.ask("   "));
  });
});
