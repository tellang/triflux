import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run as runHubEnsure } from "../../scripts/hub-ensure.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HUB_SERVER_URL = pathToFileURL(resolve(ROOT, "hub", "server.mjs")).href;

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function createTestContext() {
  const homeDir = mkdtempSync(join(tmpdir(), "hub-singleton-"));
  const cacheDir = join(homeDir, ".claude", "cache", "tfx-hub");
  mkdirSync(cacheDir, { recursive: true });
  const stateDir = cacheDir;
  const port = 29600 + Math.floor(Math.random() * 300);

  return {
    homeDir,
    stateDir,
    port,
    dbPath(prefix = "hub-singleton") {
      return join(cacheDir, `${prefix}-${randomUUID()}.db`);
    },
    cleanup() {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function createDelegatorWorker() {
  return {
    async start() {},
    async stop() {},
  };
}

function healthResponse(body) {
  return {
    ok: true,
    async json() {
      return body;
    },
  };
}

function makeEnsureExecFile({ commands = {}, listening = {} } = {}) {
  return (cmd, args) => {
    if (cmd === "ps") return commands[args[1]] || "";
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

describe("hub singleton", () => {
  it("동일 포트에서 startHub를 다시 호출하면 기존 허브를 재사용한다", async () => {
    const ctx = createTestContext();
    let firstHub = null;
    try {
      await withEnv(
        {
          HOME: ctx.homeDir,
          USERPROFILE: ctx.homeDir,
          TFX_HUB_PORT: String(ctx.port),
          TFX_HUB_STATE_DIR: ctx.stateDir,
        },
        async () => {
          const mod1 = await import(
            `${HUB_SERVER_URL}?singleton-first=${Date.now()}-${Math.random()}`
          );
          firstHub = await mod1.startHub({
            port: ctx.port,
            host: "127.0.0.1",
            dbPath: ctx.dbPath("first"),
            sessionId: `hub-singleton-first-${randomUUID()}`,
            createDelegatorWorker,
          });

          const mod2 = await import(
            `${HUB_SERVER_URL}?singleton-second=${Date.now()}-${Math.random()}`
          );
          const reusedHub = await mod2.startHub({
            port: ctx.port,
            host: "127.0.0.1",
            dbPath: ctx.dbPath("second"),
            sessionId: `hub-singleton-second-${randomUUID()}`,
            createDelegatorWorker,
          });

          assert.equal(reusedHub.reused, true);
          assert.equal(reusedHub.external, true);
          assert.equal(reusedHub.pid, firstHub.pid);
          assert.equal(reusedHub.port, firstHub.port);

          const beforeStop = await fetch(`http://127.0.0.1:${ctx.port}/health`);
          assert.equal(beforeStop.status, 200);

          const reusedStopResult = await reusedHub.stop();
          assert.equal(reusedStopResult, false);

          const afterReusedStop = await fetch(
            `http://127.0.0.1:${ctx.port}/health`,
          );
          assert.equal(afterReusedStop.status, 200);
        },
      );

      await withEnv(
        { HOME: ctx.homeDir, USERPROFILE: ctx.homeDir },
        async () => {
          await firstHub?.stop?.();
        },
      );

      let isStopped = false;
      try {
        await fetch(`http://127.0.0.1:${ctx.port}/health`);
      } catch {
        isStopped = true;
      }
      assert.equal(isStopped, true);
    } finally {
      try {
        await withEnv(
          { HOME: ctx.homeDir, USERPROFILE: ctx.homeDir },
          async () => {
            await firstHub?.stop?.();
          },
        );
      } catch {}
      ctx.cleanup();
    }
  });

  it("createServer alias와 TFX_HUB_PORT 오버라이드를 유지한다", async () => {
    const ctx = createTestContext();
    let hub = null;
    try {
      await withEnv(
        {
          HOME: ctx.homeDir,
          USERPROFILE: ctx.homeDir,
          TFX_HUB_PORT: String(ctx.port),
          TFX_HUB_STATE_DIR: ctx.stateDir,
        },
        async () => {
          const mod = await import(
            `${HUB_SERVER_URL}?singleton-alias=${Date.now()}-${Math.random()}`
          );
          assert.equal(mod.createServer, mod.startHub);

          hub = await mod.createServer({
            host: "127.0.0.1",
            dbPath: ctx.dbPath("alias"),
            sessionId: `hub-singleton-alias-${randomUUID()}`,
            createDelegatorWorker,
          });

          assert.equal(hub.port, ctx.port);
          assert.equal(hub.reused, false);
          assert.equal(hub.external, false);
        },
      );
    } finally {
      try {
        await withEnv(
          { HOME: ctx.homeDir, USERPROFILE: ctx.homeDir },
          async () => {
            await hub?.stop?.();
          },
        );
      } catch {}
      ctx.cleanup();
    }
  });

  it("hub-ensure는 stale pid file이 있어도 active default hub를 가리지 않는다", async () => {
    const ctx = createTestContext();
    let hub = null;
    try {
      await withEnv(
        {
          HOME: ctx.homeDir,
          USERPROFILE: ctx.homeDir,
          TFX_HUB_PORT: String(ctx.port),
          TFX_HUB_STATE_DIR: ctx.stateDir,
        },
        async () => {
          const mod = await import(
            `${HUB_SERVER_URL}?ensure-stale-pid=${Date.now()}-${Math.random()}`
          );
          hub = await mod.startHub({
            port: ctx.port,
            host: "127.0.0.1",
            dbPath: ctx.dbPath("stale-pid"),
            sessionId: `hub-singleton-stale-pid-${randomUUID()}`,
            createDelegatorWorker,
          });
          writeFileSync(
            join(ctx.stateDir, "hub.pid"),
            `${JSON.stringify({
              pid: 99999999,
              port: ctx.port + 1,
              host: "127.0.0.1",
              version: "old",
            })}\n`,
            "utf8",
          );

          const result = await runHubEnsure("", {
            pidFilePath: join(ctx.stateDir, "hub.pid"),
            killFn(pid, signal) {
              if (pid === 99999999 && signal === 0) {
                const error = new Error("dead");
                error.code = "ESRCH";
                throw error;
              }
              return process.kill(pid, signal);
            },
            execFile: makeEnsureExecFile({
              commands: { [hub.pid]: "node /repo/hub/server.mjs" },
              listening: { [hub.pid]: [ctx.port] },
            }),
            startHubDetached() {
              throw new Error("active hub should be reused");
            },
            syncHubConfigs: async () => {},
            snapshotUserState: () => {},
          });

          assert.equal(result.code, 0);
          assert.equal(result.stdout, "hub: ok");
          assert.match(result.stderr, /stale hub pid file/);
        },
      );
    } finally {
      try {
        await withEnv(
          { HOME: ctx.homeDir, USERPROFILE: ctx.homeDir },
          async () => {
            await hub?.stop?.();
          },
        );
      } catch {}
      ctx.cleanup();
    }
  });

  it("hub-ensure는 pid-file port mismatch hub를 retire한 뒤 기본 포트로 시작한다", async () => {
    const ctx = createTestContext();
    const pidFilePath = join(ctx.stateDir, "hub.pid");
    writeFileSync(
      pidFilePath,
      `${JSON.stringify({ pid: 2222, port: ctx.port + 5, host: "127.0.0.1" })}\n`,
      "utf8",
    );
    const alive = new Set([2222]);
    const kills = [];
    const started = [];

    try {
      await withEnv(
        {
          HOME: ctx.homeDir,
          USERPROFILE: ctx.homeDir,
          TFX_HUB_PORT: String(ctx.port),
        },
        async () => {
          const result = await runHubEnsure("", {
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
            execFile: makeEnsureExecFile({
              commands: { 2222: "node /repo/hub/server.mjs" },
              listening: { 2222: [ctx.port] },
            }),
            fetchImpl: async () => ({ ok: false, async json() {} }),
            startHubDetached(port) {
              started.push(port);
              return true;
            },
            waitForHubReady: async () => true,
            syncHubConfigs: async () => {},
            snapshotUserState: () => {},
          });

          assert.equal(result.code, 0);
          assert.deepEqual(kills, [[2222, "SIGTERM"]]);
          assert.deepEqual(started, [ctx.port]);
          assert.match(result.stderr, /not listening on port/);
        },
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("hub-ensure는 version mismatch retire 실패 시 cascade port를 명시 경고한다", async () => {
    const ctx = createTestContext();
    const pidFilePath = join(ctx.stateDir, "hub.pid");
    writeFileSync(
      pidFilePath,
      `${JSON.stringify({ pid: 86156, port: ctx.port + 9, host: "127.0.0.1" })}\n`,
      "utf8",
    );
    const kills = [];
    const started = [];

    try {
      await withEnv(
        {
          HOME: ctx.homeDir,
          USERPROFILE: ctx.homeDir,
          TFX_HUB_PORT: String(ctx.port),
        },
        async () => {
          const result = await runHubEnsure("", {
            expectedVersion: "10.21.0-new",
            pidFilePath,
            retireGraceMs: 0,
            killFn(pid, signal) {
              if (signal === 0) {
                if (pid === 86156) {
                  const error = new Error("dead");
                  error.code = "ESRCH";
                  throw error;
                }
                return;
              }
              kills.push([pid, signal]);
            },
            execFile: makeEnsureExecFile({
              commands: { 61463: "node /repo/hub/server.mjs" },
              listening: { 61463: [ctx.port] },
            }),
            fetchImpl: async (url) => {
              if (String(url).includes(`:${ctx.port}/health`)) {
                return healthResponse({ ok: true, version: "10.20.2-old" });
              }
              return { ok: false, async json() {} };
            },
            startHubDetached(port) {
              started.push(port);
              return true;
            },
            waitForHubReady: async (_host, port) => port === ctx.port + 1,
            syncHubConfigs: async () => {},
            snapshotUserState: () => {},
          });

          assert.equal(result.code, 0);
          assert.deepEqual(kills, [
            [61463, "SIGTERM"],
            [61463, "SIGKILL"],
          ]);
          assert.deepEqual(started, [ctx.port + 1]);
          assert.match(result.stderr, /falling back to cascade port/);
        },
      );
    } finally {
      ctx.cleanup();
    }
  });
});
