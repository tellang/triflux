import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";

// --- helpers ---

const restorers = [];

function registerRestore(fn) {
  restorers.push(fn);
}

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()();
  }
});

function mockExecFileSyncThrows() {
  const tracker = mock.method(childProcess, "execFileSync", () => {
    throw new Error("psmux: command not found");
  });
  registerRestore(() => tracker.mock.restore());
}

function mockExecFileSyncOk() {
  const calls = [];
  const tracker = mock.method(childProcess, "execFileSync", (file, args) => {
    calls.push({ file, args: Array.isArray(args) ? [...args] : [] });
    return "psmux 3.3.1";
  });
  registerRestore(() => tracker.mock.restore());
  return { calls };
}

async function importFreshDemo(dryRun = true) {
  // Patch process.argv so parseArgs sees --dry-run when desired.
  // We cache-bust the module on each import so flags are re-evaluated.
  const originalArgv = process.argv;
  process.argv = dryRun
    ? ["node", "demo.mjs", "--dry-run"]
    : ["node", "demo.mjs"];

  const stamp = `${Date.now()}-${Math.random()}`;
  const mod = await import(
    new URL(`../../scripts/demo.mjs?t=${stamp}`, import.meta.url)
  );

  process.argv = originalArgv;
  return mod;
}

// --- tests ---

describe("checkPsmux", () => {
  it("returns false when psmux is not installed", async () => {
    mockExecFileSyncThrows();
    // Import in non-dry-run mode so checkPsmux actually tries to exec
    const { checkPsmux } = await importFreshDemo(false);
    const result = checkPsmux();
    assert.equal(result, false);
  });

  it("returns true when psmux is installed", async () => {
    mockExecFileSyncOk();
    const { checkPsmux } = await importFreshDemo(false);
    const result = checkPsmux();
    assert.equal(result, true);
  });
});

describe("simulateWorker dry-run output", () => {
  it("logs the correct psmux send-keys commands per message", async () => {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.join(" "));

    const { simulateWorker } = await importFreshDemo(true);

    simulateWorker(1, "gemini", [
      "[gemini] Reviewing UI components...",
      "[gemini] Done ✓",
    ]);

    console.log = originalLog;

    assert.equal(logged.length, 2);
    assert.match(logged[0], /dry-run/);
    assert.match(logged[0], /send-keys/);
    assert.match(logged[0], /0\.1/);
    assert.match(logged[0], /\[gemini\] Reviewing UI components\.\.\./);
    assert.match(logged[1], /\[gemini\] Done/);
  });
});

describe("full dry-run flow", () => {
  it("completes without throwing when psmux is unavailable", async () => {
    mockExecFileSyncThrows();

    // Capture console output to avoid noise in test output
    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(" "));

    let thrownError = null;
    try {
      // Import with --dry-run so the module skips real psmux calls
      const { checkPsmux, createDemoSession, simulateWorker, showSummary, cleanup } =
        await importFreshDemo(true);

      assert.equal(checkPsmux(), false);
      createDemoSession("triflux-demo");
      simulateWorker(0, "codex", ["[codex] Analyzing auth module...", "[codex] Done ✓"]);
      simulateWorker(1, "gemini", ["[gemini] Reviewing UI components...", "[gemini] Done ✓"]);
      simulateWorker(2, "claude", ["[claude] Security audit in progress...", "[claude] Done ✓"]);
      showSummary();
      cleanup("triflux-demo");
    } catch (err) {
      thrownError = err;
    } finally {
      console.log = originalLog;
    }

    assert.equal(thrownError, null, `Expected no error, got: ${thrownError?.message}`);

    // Verify dry-run output contains expected psmux commands
    const allOutput = captured.join("\n");
    assert.match(allOutput, /dry-run/);
    assert.match(allOutput, /new-session/);
    assert.match(allOutput, /kill-session/);
  });
});
