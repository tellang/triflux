import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_LOG_DIR = join(tmpdir(), `spawn-trace-test-${Date.now()}`);

describe("spawn-trace", () => {
  before(() => {
    mkdirSync(TEST_LOG_DIR, { recursive: true });
  });

  after(() => {
    try { rmSync(TEST_LOG_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("exports child_process-compatible API surface", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    assert.equal(typeof mod.spawn, "function");
    assert.equal(typeof mod.execFile, "function");
    assert.equal(typeof mod.execFileSync, "function");
    assert.equal(typeof mod.exec, "function");
    assert.equal(typeof mod.execSync, "function");
    assert.equal(typeof mod.fork, "function");
    assert.equal(typeof mod.spawnSync, "function");
  });

  it("exports guard constants", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    assert.equal(typeof mod.MAX_SPAWN_PER_SEC, "number");
    assert.equal(typeof mod.MAX_TOTAL_DESCENDANTS, "number");
  });

  it("spawn returns a ChildProcess-like object", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    const child = mod.spawn("node", ["-e", "process.exit(0)"], {
      windowsHide: true,
    });
    assert.ok(child);
    assert.equal(typeof child.pid, "number");
    assert.equal(typeof child.kill, "function");

    await new Promise((resolve) => child.once("close", resolve));
  });

  it("execFileSync returns stdout buffer", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    const result = mod.execFileSync("node", ["-e", 'process.stdout.write("hello")'], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.trim(), "hello");
  });

  it("execFileSync throws on non-zero exit", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    assert.throws(() => {
      mod.execFileSync("node", ["-e", "process.exit(1)"], {
        windowsHide: true,
      });
    });
  });

  it("execFile with callback receives stdout", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
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
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    // reason and dedupe should not cause child_process to error
    const result = mod.execFileSync("node", ["-e", 'process.stdout.write("ok")'], {
      encoding: "utf8",
      windowsHide: true,
      reason: "test:strip-options",
      dedupe: "test-key",
    });
    assert.equal(result.trim(), "ok");
  });

  it("default export includes spawn/execFile/execFileSync", async () => {
    const mod = await import("../../hub/lib/spawn-trace.mjs");
    assert.equal(typeof mod.default.spawn, "function");
    assert.equal(typeof mod.default.execFile, "function");
    assert.equal(typeof mod.default.execFileSync, "function");
    assert.equal(typeof mod.default.MAX_SPAWN_PER_SEC, "number");
  });
});
