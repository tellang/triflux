import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
});
