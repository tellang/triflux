import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

function tempDbPath() {
  const dir = join(tmpdir(), `tfx-hub-idle-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getUnusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.close(resolve);
  });

  assert.ok(port > 0, "ephemeral test port must be assigned");
  return port;
}

function createStubDelegatorWorker() {
  return {
    async start() {},
    async stop() {},
    async delegate() {
      return { ok: true, status: "completed", transport: "stub-delegator" };
    },
    async getJobStatus(jobId) {
      return {
        ok: true,
        job_id: jobId,
        status: "completed",
        transport: "stub-delegator",
      };
    },
    async reply({ job_id }) {
      return {
        ok: true,
        job_id,
        status: "completed",
        transport: "stub-delegator",
      };
    },
  };
}

describe("startHub() idle auto-shutdown", () => {
  it("stops the hub after the configured idle timeout elapses without requests", async () => {
    const previousIdleTimeout = process.env.TFX_HUB_IDLE_TIMEOUT_MS;
    const previousIdleSweep = process.env.TFX_HUB_IDLE_SWEEP_MS;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousHomeDrive = process.env.HOMEDRIVE;
    const previousHomePath = process.env.HOMEPATH;
    const previousTfxTest = process.env.TFX_TEST;
    const fakeHome = join(tmpdir(), `tfx-hub-home-${randomUUID()}`);

    mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.HOMEDRIVE = fakeHome.slice(0, 2);
    process.env.HOMEPATH = fakeHome.slice(2).replace(/\\/g, "/");
    process.env.TFX_HUB_IDLE_TIMEOUT_MS = "300";
    process.env.TFX_HUB_IDLE_SWEEP_MS = "50";
    process.env.TFX_TEST = "1";

    const { startHub } = await import(
      `../../hub/server.mjs?test=${randomUUID()}`
    );

    const port = await getUnusedPort();
    const statusUrl = `http://127.0.0.1:${port}/status`;
    let hub;

    try {
      hub = await startHub({
        port,
        dbPath: tempDbPath(),
        host: "127.0.0.1",
        sessionId: `idle-${port}`,
        createDelegatorWorker: createStubDelegatorWorker,
      });

      const closePromise = once(hub.httpServer, "close");

      let response = await fetch(statusUrl);
      assert.equal(response.status, 200);

      await wait(150);
      response = await fetch(statusUrl);
      assert.equal(response.status, 200);

      await Promise.race([
        closePromise,
        wait(1200).then(() => {
          throw new Error(
            "Hub did not auto-shutdown after the idle timeout elapsed",
          );
        }),
      ]);

      await wait(50);
      await assert.rejects(fetch(statusUrl), /fetch failed|ECONNREFUSED/i);
    } finally {
      if (hub?.stop) {
        await hub.stop().catch(() => {});
      }

      if (previousIdleTimeout === undefined) {
        delete process.env.TFX_HUB_IDLE_TIMEOUT_MS;
      } else {
        process.env.TFX_HUB_IDLE_TIMEOUT_MS = previousIdleTimeout;
      }

      if (previousIdleSweep === undefined) {
        delete process.env.TFX_HUB_IDLE_SWEEP_MS;
      } else {
        process.env.TFX_HUB_IDLE_SWEEP_MS = previousIdleSweep;
      }

      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }

      if (previousHomeDrive === undefined) {
        delete process.env.HOMEDRIVE;
      } else {
        process.env.HOMEDRIVE = previousHomeDrive;
      }

      if (previousHomePath === undefined) {
        delete process.env.HOMEPATH;
      } else {
        process.env.HOMEPATH = previousHomePath;
      }

      if (previousTfxTest === undefined) {
        delete process.env.TFX_TEST;
      } else {
        process.env.TFX_TEST = previousTfxTest;
      }
    }
  });
});
