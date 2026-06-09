import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanupOwnedTokenFile,
  cleanupOwnedPidFile,
  resolveHubIdleTimeoutMs,
  resolveHubPort,
  writeOwnedTokenFile,
} from "../../hub/server.mjs";

const LIVE_PEER = Object.freeze({
  alive: true,
  pid: 4242,
  port: 29102,
  host: "127.0.0.1",
  url: "http://127.0.0.1:29102/mcp",
  reason: "alive",
});

const DEAD_PEER = Object.freeze({
  alive: false,
  pid: 4242,
  port: 29102,
  reason: "dead",
});

const MISSING_PEER = Object.freeze({
  alive: false,
  reason: "missing",
});

const BASE_STATE = Object.freeze({
  pid: LIVE_PEER.pid,
  port: LIVE_PEER.port,
  host: LIVE_PEER.host,
  url: LIVE_PEER.url,
});

function createSilentLog(warnings) {
  return {
    warn(payload, event) {
      warnings.push({ payload, event });
    },
  };
}

describe("resolveHubPort()", () => {
  it("env only -> env value", () => {
    assert.equal(
      resolveHubPort(
        { TFX_HUB_PORT: "30001" },
        { detectPeer: () => LIVE_PEER },
      ),
      30001,
    );
  });

  it("env + alive PID -> env value", () => {
    assert.equal(
      resolveHubPort(
        { TFX_HUB_PORT: "30002" },
        { detectPeer: () => LIVE_PEER },
      ),
      30002,
    );
  });

  it("alive PID only -> 27888", () => {
    assert.equal(resolveHubPort({}, { detectPeer: () => LIVE_PEER }), 27888);
  });

  it("dead PID only -> 27888", () => {
    assert.equal(resolveHubPort({}, { detectPeer: () => DEAD_PEER }), 27888);
  });

  it("no PID + no env -> 27888", () => {
    assert.equal(resolveHubPort({}, { detectPeer: () => MISSING_PEER }), 27888);
  });

  it("preferLivePid:false + alive PID -> 27888", () => {
    assert.equal(
      resolveHubPort(
        {},
        {
          preferLivePid: false,
          detectPeer: () => LIVE_PEER,
        },
      ),
      27888,
    );
  });

  it("server boundary forces worktree env ports back to canonical 27888", () => {
    assert.equal(
      resolveHubPort(
        { TFX_HUB_PORT: "29009" },
        { cwd: "/repo/.worktrees/worker-a" },
      ),
      27888,
    );
  });

  it("server boundary preserves custom ports outside worktree contexts", () => {
    assert.equal(
      resolveHubPort({ TFX_HUB_PORT: "29009" }, { cwd: "/repo/main" }),
      29009,
    );
  });
});

describe("resolveHubIdleTimeoutMs()", () => {
  it("keeps canonical 27888 hub permanent by default", () => {
    assert.equal(resolveHubIdleTimeoutMs({ port: 27888, env: {} }), 0);
  });

  it("gives non-canonical hubs a 30 minute idle timeout by default", () => {
    assert.equal(resolveHubIdleTimeoutMs({ port: 29009, env: {} }), 30 * 60 * 1000);
  });

  it("preserves explicit TFX_HUB_IDLE_TIMEOUT_MS override", () => {
    assert.equal(
      resolveHubIdleTimeoutMs({
        port: 27888,
        env: { TFX_HUB_IDLE_TIMEOUT_MS: "5000" },
      }),
      5000,
    );
  });
});

describe("cleanupOwnedPidFile()", () => {
  it("unlinks the pid file only when it is owned by the current process", () => {
    const unlinked = [];
    const own = cleanupOwnedPidFile({
      pidFilePath: "/tmp/hub.pid",
      currentPid: 123,
      readFile: () => JSON.stringify({ pid: 123 }),
      unlink: (path) => unlinked.push(path),
    });

    const foreign = cleanupOwnedPidFile({
      pidFilePath: "/tmp/hub.pid",
      currentPid: 123,
      readFile: () => JSON.stringify({ pid: 456 }),
      unlink: (path) => unlinked.push(path),
    });

    assert.equal(own, true);
    assert.equal(foreign, false);
    assert.deepEqual(unlinked, ["/tmp/hub.pid"]);
  });
});

describe("cleanupOwnedTokenFile()", () => {
  it("unlinks the token only for the canonical hub that owns the token", () => {
    const unlinked = [];

    const canonicalOwn = cleanupOwnedTokenFile({
      tokenFilePath: "/tmp/.tfx-hub-token",
      token: "primary-token",
      port: 27888,
      readFile: () => "primary-token\n",
      unlink: (path) => unlinked.push(path),
    });

    const nonCanonicalOwn = cleanupOwnedTokenFile({
      tokenFilePath: "/tmp/.tfx-hub-token",
      token: "primary-token",
      port: 29009,
      readFile: () => "primary-token\n",
      unlink: (path) => unlinked.push(path),
    });

    const canonicalForeign = cleanupOwnedTokenFile({
      tokenFilePath: "/tmp/.tfx-hub-token",
      token: "worker-token",
      port: 27888,
      readFile: () => "primary-token\n",
      unlink: (path) => unlinked.push(path),
    });

    assert.equal(canonicalOwn, true);
    assert.equal(nonCanonicalOwn, false);
    assert.equal(canonicalForeign, false);
    assert.deepEqual(unlinked, ["/tmp/.tfx-hub-token"]);
  });
});

describe("writeOwnedTokenFile()", () => {
  it("writes the provided startup token without deleting ownership state", () => {
    const writes = [];

    const written = writeOwnedTokenFile({
      tokenFilePath: "/tmp/.tfx-hub-token",
      tokenDir: "/tmp",
      token: "worker-token",
      port: 29009,
      mkdir() {},
      writeFile: (...args) => writes.push(args),
    });

    const missingToken = writeOwnedTokenFile({
      tokenFilePath: "/tmp/.tfx-hub-token",
      tokenDir: "/tmp",
      token: "",
      port: 29009,
      mkdir() {},
      writeFile: (...args) => writes.push(args),
    });

    assert.equal(written, true);
    assert.equal(missingToken, false);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], "worker-token");
  });
});

describe("tryReuseExistingHub()", () => {
  it("portOpt 명시 + mismatch -> null", async () => {
    const serverModule = await import("../../hub/server.mjs");
    assert.equal(typeof serverModule.tryReuseExistingHub, "function");

    const reused = await serverModule.tryReuseExistingHub({
      port: 27888,
      portSpecified: true,
      readCurrentState: () => BASE_STATE,
      readInfo: () => BASE_STATE,
      detectPeer: () => LIVE_PEER,
      checkHealth: async () => true,
      killFn() {},
      log: createSilentLog([]),
    });

    assert.equal(reused, null);
  });

  it("portOpt 명시 + match alive -> reuse", async () => {
    const serverModule = await import("../../hub/server.mjs");
    assert.equal(typeof serverModule.tryReuseExistingHub, "function");

    const reused = await serverModule.tryReuseExistingHub({
      port: LIVE_PEER.port,
      portSpecified: true,
      readCurrentState: () => BASE_STATE,
      readInfo: () => BASE_STATE,
      detectPeer: () => LIVE_PEER,
      checkHealth: async () => true,
      killFn() {},
      log: createSilentLog([]),
    });

    assert.equal(reused?.reused, true);
    assert.equal(reused?.external, true);
    assert.equal(reused?.pid, LIVE_PEER.pid);
    assert.equal(reused?.port, LIVE_PEER.port);
    assert.equal(reused?.url, LIVE_PEER.url);
  });

  it("portOpt 미명시 + alive mismatch -> null", async () => {
    const serverModule = await import("../../hub/server.mjs");
    assert.equal(typeof serverModule.tryReuseExistingHub, "function");

    const warnings = [];
    const reused = await serverModule.tryReuseExistingHub({
      port: 27888,
      portSpecified: false,
      readCurrentState: () => BASE_STATE,
      readInfo: () => BASE_STATE,
      detectPeer: () => LIVE_PEER,
      checkHealth: async () => true,
      killFn() {},
      log: createSilentLog(warnings),
    });

    assert.equal(reused, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.event, "hub.port_mismatch_not_reusing_live_pid");
  });
});
