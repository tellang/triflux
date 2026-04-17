import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";

const TEST_LOG_DIR = join(tmpdir(), `spawn-trace-test-${Date.now()}`);
let importSequence = 0;

async function loadSpawnTraceModule() {
  importSequence += 1;
  return import(`../../hub/lib/spawn-trace.mjs?test=${importSequence}`);
}

function waitForClose(child) {
  return new Promise((resolve) => child.once("close", resolve));
}

describe("spawn-trace", () => {
  before(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true });
  });

  after(() => {
    try {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("exports child_process-compatible API surface", async () => {
    const mod = await loadSpawnTraceModule();
    assert.equal(typeof mod.spawn, "function");
    assert.equal(typeof mod.spawnWithBackoff, "function");
    assert.equal(typeof mod.execFile, "function");
    assert.equal(typeof mod.execFileSync, "function");
    assert.equal(typeof mod.exec, "function");
    assert.equal(typeof mod.execSync, "function");
    assert.equal(typeof mod.fork, "function");
    assert.equal(typeof mod.spawnSync, "function");
  });

  it("exports guard constants", async () => {
    const mod = await loadSpawnTraceModule();
    assert.equal(typeof mod.MAX_SPAWN_PER_SEC, "number");
    assert.equal(typeof mod.MAX_TOTAL_DESCENDANTS, "number");
    assert.equal(typeof mod.getMaxSpawnPerSec, "function");
    assert.equal(typeof mod.reload, "function");
  });

  it("reload re-evaluates TRIFLUX_MAX_SPAWN_RATE", async () => {
    const mod = await loadSpawnTraceModule();
    const original = process.env.TRIFLUX_MAX_SPAWN_RATE;

    try {
      process.env.TRIFLUX_MAX_SPAWN_RATE = "7";
      assert.equal(mod.reload(), 7);
      assert.equal(mod.getMaxSpawnPerSec(), 7);
      assert.equal(mod.MAX_SPAWN_PER_SEC, 7);
      assert.equal(mod.default.MAX_SPAWN_PER_SEC, 7);
    } finally {
      if (original == null) {
        delete process.env.TRIFLUX_MAX_SPAWN_RATE;
      } else {
        process.env.TRIFLUX_MAX_SPAWN_RATE = original;
      }
      mod.reload();
    }
  });

  it("spawn returns a ChildProcess-like object", async () => {
    const mod = await loadSpawnTraceModule();
    const child = mod.spawn("node", ["-e", "process.exit(0)"], {
      windowsHide: true,
    });
    assert.ok(child);
    assert.equal(typeof child.pid, "number");
    assert.equal(typeof child.kill, "function");

    await new Promise((resolve) => child.once("close", resolve));
  });

  it("execFileSync returns stdout buffer", async () => {
    const mod = await loadSpawnTraceModule();
    const result = mod.execFileSync(
      "node",
      ["-e", 'process.stdout.write("hello")'],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.trim(), "hello");
  });

  it("execFileSync throws on non-zero exit", async () => {
    const mod = await loadSpawnTraceModule();
    assert.throws(() => {
      mod.execFileSync("node", ["-e", "process.exit(1)"], {
        windowsHide: true,
      });
    });
  });

  it("execFile with callback receives stdout", async () => {
    const mod = await loadSpawnTraceModule();
    const result = await new Promise((resolve, reject) => {
      mod.execFile(
        "node",
        ["-e", 'process.stdout.write("world")'],
        { encoding: "utf8", windowsHide: true },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    assert.equal(result.trim(), "world");
  });

  it("strips trace-specific options before passing to child_process", async () => {
    const mod = await loadSpawnTraceModule();
    // reason and dedupe should not cause child_process to error
    const result = mod.execFileSync(
      "node",
      ["-e", 'process.stdout.write("ok")'],
      {
        encoding: "utf8",
        windowsHide: true,
        reason: "test:strip-options",
        dedupe: "test-key",
      },
    );
    assert.equal(result.trim(), "ok");
  });

  it("default export includes spawn/execFile/execFileSync", async () => {
    const mod = await loadSpawnTraceModule();
    assert.equal(typeof mod.default.spawn, "function");
    assert.equal(typeof mod.default.spawnWithBackoff, "function");
    assert.equal(typeof mod.default.execFile, "function");
    assert.equal(typeof mod.default.execFileSync, "function");
    assert.equal(typeof mod.default.MAX_SPAWN_PER_SEC, "number");
    assert.equal(typeof mod.default.getMaxSpawnPerSec, "function");
    assert.equal(typeof mod.default.reload, "function");
  });

  it("waits for RATE_WINDOW_MS and retries once after a rate limit error", async () => {
    const original = process.env.TRIFLUX_MAX_SPAWN_RATE;
    process.env.TRIFLUX_MAX_SPAWN_RATE = "1";

    try {
      const mod = await loadSpawnTraceModule();
      const blocker = mod.spawn(
        "node",
        ["-e", "setTimeout(() => process.exit(0), 1500)"],
        { windowsHide: true },
      );

      const startedAt = performance.now();
      const child = await mod.spawnWithBackoff(
        "node",
        ["-e", "process.exit(0)"],
        { windowsHide: true },
      );
      const elapsedMs = performance.now() - startedAt;

      assert.ok(elapsedMs >= 900, `expected retry delay, got ${elapsedMs}ms`);
      assert.equal(typeof child.pid, "number");

      await waitForClose(child);
      await waitForClose(blocker);
    } finally {
      if (original == null) {
        delete process.env.TRIFLUX_MAX_SPAWN_RATE;
      } else {
        process.env.TRIFLUX_MAX_SPAWN_RATE = original;
      }
    }
  });

  it("rethrows the original rate limit error when the retry also hits the limit", async () => {
    const originalEnv = process.env.TRIFLUX_MAX_SPAWN_RATE;
    const originalDateNow = Date.now;
    process.env.TRIFLUX_MAX_SPAWN_RATE = "1";
    Date.now = () => 1_000;

    try {
      const mod = await loadSpawnTraceModule();
      const blocker = mod.spawn(
        "node",
        ["-e", "setTimeout(() => process.exit(0), 1500)"],
        { windowsHide: true },
      );

      const startedAt = performance.now();
      await assert.rejects(
        () =>
          mod.spawnWithBackoff("node", ["-e", "process.exit(0)"], {
            windowsHide: true,
          }),
        (error) => {
          assert.equal(error?.reasonCode, "rate_limit");
          assert.equal(error?.maxPerSec, 1);
          return true;
        },
      );
      const elapsedMs = performance.now() - startedAt;
      assert.ok(elapsedMs >= 900, `expected retry delay, got ${elapsedMs}ms`);

      blocker.kill();
      await waitForClose(blocker);
    } finally {
      Date.now = originalDateNow;
      if (originalEnv == null) {
        delete process.env.TRIFLUX_MAX_SPAWN_RATE;
      } else {
        process.env.TRIFLUX_MAX_SPAWN_RATE = originalEnv;
      }
    }
  });

  it("throws non-rate-limit guard errors immediately", async () => {
    const mod = await loadSpawnTraceModule();
    const blocker = mod.spawn(
      "node",
      ["-e", "setTimeout(() => process.exit(0), 250)"],
      { dedupe: "same-key", windowsHide: true },
    );

    const startedAt = performance.now();
    await assert.rejects(
      () =>
        mod.spawnWithBackoff("node", ["-e", "process.exit(0)"], {
          dedupe: "same-key",
          windowsHide: true,
        }),
      (error) => {
        assert.equal(error?.reasonCode, "dedupe");
        return true;
      },
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(
      elapsedMs < 500,
      `expected immediate failure, got ${elapsedMs}ms`,
    );

    await waitForClose(blocker);
  });
});
