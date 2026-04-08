import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { checkPsmux, createDemoSession, simulateWorker, showSummary, cleanup } from "../../scripts/demo.mjs";

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

// --- tests ---

describe("checkPsmux", () => {
  it("returns false when psmux is not installed", () => {
    mockExecFileSyncThrows();
    const result = checkPsmux();
    assert.equal(result, false);
  });

  it("returns true when psmux is installed", () => {
    mockExecFileSyncOk();
    const result = checkPsmux();
    assert.equal(result, true);
  });

  it("returns false when dryRun is requested", () => {
    const result = checkPsmux({ dryRun: true });
    assert.equal(result, false);
  });
});

describe("simulateWorker dry-run output", () => {
  it("logs the correct psmux send-keys commands and escapes single quotes", () => {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.join(" "));

    try {
      simulateWorker(1, "gemini", [
        "[gemini] Let's test quotes",
        "[gemini] Done ✓",
      ], { dryRun: true });
    } finally {
      console.log = originalLog;
    }

    assert.equal(logged.length, 2);
    assert.match(logged[0], /dry-run/);
    assert.match(logged[0], /send-keys/);
    assert.match(logged[0], /0\.1/);
    // Should contain escaped single quote: Let'\''s
    assert.match(logged[0], /Let'\\''s test quotes/);
    assert.match(logged[1], /\[gemini\] Done/);
  });
});

describe("full dry-run flow", () => {
  it("completes without throwing when psmux is unavailable using opts", () => {
    mockExecFileSyncThrows();

    const originalLog = console.log;
    const captured = [];
    console.log = (...args) => captured.push(args.join(" "));

    try {
      const opts = { dryRun: true };
      assert.equal(checkPsmux(opts), false);
      createDemoSession("triflux-demo", opts);
      simulateWorker(0, "codex", ["[codex] Analyzing auth module...", "[codex] Done ✓"], opts);
      simulateWorker(1, "gemini", ["[gemini] Reviewing UI components...", "[gemini] Done ✓"], opts);
      simulateWorker(2, "claude", ["[claude] Security audit in progress...", "[claude] Done ✓"], opts);
      showSummary();
      cleanup("triflux-demo", opts);
    } finally {
      console.log = originalLog;
    }

    const allOutput = captured.join("\n");
    assert.match(allOutput, /dry-run/);
    assert.match(allOutput, /new-session/);
    assert.match(allOutput, /kill-session/);
  });
});
