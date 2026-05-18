import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { inspectPidFileHub, run } from "../../scripts/hub-ensure.mjs";

const TEMP_DIRS = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-hub-ensure-drift-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function writePidFile(dir, payload) {
  const pidDir = join(dir, ".claude", "cache", "tfx-hub");
  mkdirSync(pidDir, { recursive: true });
  const pidFile = join(pidDir, "hub.pid");
  writeFileSync(pidFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return pidFile;
}

function response(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}

function makeExecFile({ commands = {}, listening = {} } = {}) {
  return (cmd, args) => {
    if (cmd === "ps") {
      const pid = args[1];
      return commands[pid] || "";
    }
    if (cmd === "lsof" && args.includes("-p")) {
      const pid = args[args.indexOf("-p") + 1];
      const ports = listening[pid] || [];
      return [
        "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
        ...ports.map(
          (port) =>
            `node ${pid} user 20u IPv4 0x0 0t0 TCP 127.0.0.1:${port} (LISTEN)`,
        ),
      ].join("\n");
    }
    if (cmd === "lsof" && args.some((arg) => arg.startsWith("-iTCP:"))) {
      const port = Number(
        args.find((arg) => arg.startsWith("-iTCP:")).replace("-iTCP:", ""),
      );
      for (const [pid, ports] of Object.entries(listening)) {
        if (ports.includes(port)) return `${pid}\n`;
      }
    }
    return "";
  };
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
  }
});

describe("hub-ensure version drift guard", () => {
  it("rejects a live pid-file PID that is not hub/server.mjs", async () => {
    const home = makeTempDir();
    const pidFilePath = writePidFile(home, {
      pid: 1234,
      port: 27888,
      host: "127.0.0.1",
    });

    const inspected = await inspectPidFileHub({
      expectedVersion: "10.21.0-test",
      pidFilePath,
      killFn(pid, signal) {
        assert.equal(pid, 1234);
        assert.equal(signal, 0);
      },
      execFile: makeExecFile({
        commands: { 1234: "node /tmp/not-hub/server.mjs" },
        listening: { 1234: [27888] },
      }),
      fetchImpl: async () => response({ ok: true, version: "10.21.0-test" }),
    });

    assert.equal(inspected.valid, false);
    assert.equal(inspected.reason, "not_hub_server");
    assert.equal(inspected.retirePid, null);
  });

  it("retires a hub pid-file PID when its LISTEN port differs from the pid file", async () => {
    const home = makeTempDir();
    const pidFilePath = writePidFile(home, {
      pid: 2222,
      port: 29196,
      host: "127.0.0.1",
    });
    const kills = [];
    const alive = new Set([2222]);

    const result = await run("", {
      expectedVersion: "10.21.0-test",
      pidFilePath,
      retireGraceMs: 0,
      killFn(pid, signal) {
        if (signal === 0) {
          if (!alive.has(pid)) {
            const error = new Error("dead");
            error.code = "ESRCH";
            throw error;
          }
          return;
        }
        kills.push([pid, signal]);
        alive.delete(pid);
      },
      execFile: makeExecFile({
        commands: { 2222: "node /repo/hub/server.mjs" },
        listening: { 2222: [27888] },
      }),
      fetchImpl: async () => ({ ok: false, async json() {} }),
      startHubDetached(port) {
        assert.equal(port, 27888);
        return true;
      },
      waitForHubReady: async () => true,
      syncHubConfigs: async () => {},
      snapshotUserState: () => {},
    });

    assert.equal(result.code, 0);
    assert.deepEqual(kills, [[2222, "SIGTERM"]]);
    assert.match(result.stderr, /not listening on port 29196/);
  });

  it("P3b: retires an old-version default-port hub before starting the expected version", async () => {
    const home = makeTempDir();
    const pidFilePath = writePidFile(home, {
      pid: 86156,
      port: 29196,
      host: "127.0.0.1",
    });
    const alive = new Set([61463]);
    const kills = [];
    const startedPorts = [];

    const result = await run("", {
      expectedVersion: "10.21.0-new",
      pidFilePath,
      retireGraceMs: 0,
      killFn(pid, signal) {
        if (signal === 0) {
          if (!alive.has(pid)) {
            const error = new Error("dead");
            error.code = "ESRCH";
            throw error;
          }
          return;
        }
        kills.push([pid, signal]);
        alive.delete(pid);
      },
      execFile: makeExecFile({
        commands: { 61463: "node /repo/hub/server.mjs" },
        listening: { 61463: [27888] },
      }),
      fetchImpl: async (url) => {
        if (String(url).includes(":27888/health")) {
          return response({ ok: true, version: "10.20.2-old" });
        }
        return { ok: false, async json() {} };
      },
      startHubDetached(port) {
        startedPorts.push(port);
        return true;
      },
      waitForHubReady: async (_host, port) => port === 27888,
      syncHubConfigs: async () => {},
      snapshotUserState: () => {},
    });

    assert.equal(result.code, 0);
    assert.deepEqual(kills, [[61463, "SIGTERM"]]);
    assert.deepEqual(startedPorts, [27888]);
    assert.match(result.stderr, /version mismatch/);
    assert.match(result.stderr, /retired port 27888 hub PID 61463/);
  });
});
