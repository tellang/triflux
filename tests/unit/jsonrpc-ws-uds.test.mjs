// tests/unit/jsonrpc-ws-uds.test.mjs
// JsonRpcWsUdsClient over a fake
// WebSocket-over-UDS server (no real codex, zero quota).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
