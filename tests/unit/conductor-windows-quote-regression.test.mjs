import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { createConductor } from "../../hub/team/conductor.mjs";

function makeTmpDir() {
  const dir = join(tmpdir(), `tfx-conductor-win-quote-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function waitFor(fn, timeoutMs = 3000, intervalMs = 25) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      try {
        const value = fn();
        if (value) {
          resolve(value);
          return;
        }
      } catch {
        /* condition not ready */
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`waitFor timeout (${timeoutMs}ms)`));
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function makeCapturingSpawn(calls) {
  return function mockSpawn(command, args = [], options = {}) {
    const call = {
      command,
      args: [...args],
      options: { ...options },
      exitCode: null,
      exitSignal: null,
    };
    calls.push(call);
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      call.exitCode = 0;
      call.exitSignal = null;
      child.emit("exit", 0, null);
    });
    return child;
  };
}

let logsDir;
let conductor;

beforeEach(() => {
  logsDir = makeTmpDir();
});

afterEach(async () => {
  try {
    await conductor?.shutdown("test_cleanup");
  } catch {
    /* ignore */
  }
  rmSync(logsDir, { recursive: true, force: true });
});

test("conductor launches quoted prompts through argv without shell quoting on Windows-sensitive paths", async () => {
  const spawnCalls = [];
  conductor = createConductor({
    logsDir,
    maxRestarts: 0,
    graceMs: 100,
    synapseFetch: null,
    probeOpts: {
      enableL2: false,
      writeStateFile: false,
      intervalMs: 999_999,
      l1ThresholdMs: 999_999,
      l3ThresholdMs: 999_999,
    },
    deps: {
      spawn: makeCapturingSpawn(spawnCalls),
      resolveCliExecutable: (name) =>
        name === "codex" ? "C:\\tools\\codex.cmd" : name,
    },
  });

  const prompt = 'fix the shard failure with "hello world" intact';
  const id = conductor.spawnSession({
    id: "windows-quote-regression",
    agent: "codex",
    prompt,
  });

  await waitFor(() => spawnCalls.length === 1);
  await waitFor(() => spawnCalls[0]?.exitCode !== null);

  assert.equal(id, "windows-quote-regression");

  // On Windows, .cmd files must go through `cmd /c <path>` wrapper (Node CVE-2024-27980).
  // On POSIX, the resolved path is used directly. Either way, shell:false is preserved.
  const isWin = process.platform === "win32";
  if (isWin) {
    assert.equal(spawnCalls[0].command, "cmd");
    assert.equal(spawnCalls[0].args[0], "/c");
    assert.equal(spawnCalls[0].args[1], "C:\\tools\\codex.cmd");
    assert.deepEqual(spawnCalls[0].args.slice(2, 7), [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--color",
      "never",
    ]);
  } else {
    assert.equal(spawnCalls[0].command, "C:\\tools\\codex.cmd");
    assert.deepEqual(spawnCalls[0].args.slice(0, 5), [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--color",
      "never",
    ]);
  }
  assert.equal(spawnCalls[0].options.shell, false);
  assert.notEqual(spawnCalls[0].exitCode, 255);
  assert.equal(spawnCalls[0].args.at(-1), prompt);
  assert.ok(
    !spawnCalls[0].args.some((arg) =>
      String(arg).includes('\\"hello world\\"'),
    ),
    `prompt should be passed as a raw argv item: ${JSON.stringify(spawnCalls[0].args)}`,
  );
});
