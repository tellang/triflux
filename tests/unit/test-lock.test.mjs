import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_SCRIPT = resolve(REPO_ROOT, "scripts", "test-lock.mjs");

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killPid(pid, signal = "SIGKILL") {
  if (!pid || !pidAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

function readLock(lockFile) {
  try {
    return JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "triflux-test-lock-supervisor-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(SOURCE_SCRIPT, join(root, "scripts", "test-lock.mjs"));
  return {
    root,
    lockFile: join(root, ".test-lock", "pid.lock"),
    script: join("scripts", "test-lock.mjs"),
  };
}

function cleanupHarness(harness) {
  const lock = readLock(harness.lockFile);
  if (lock?.child_pid !== process.pid) killPid(lock?.child_pid);
  rmSync(harness.root, { recursive: true, force: true });
}

function writeScript(harness, name, source) {
  const path = join(harness.root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return name;
}

function writeHoldingScript(harness, name) {
  return writeScript(
    harness,
    name,
    `
import { writeFileSync } from "node:fs";

writeFileSync(process.env.CHILD_PID_FILE, String(process.pid));

process.on("SIGTERM", () => {
  writeFileSync(process.env.CHILD_SIGNAL_FILE, "SIGTERM");
  process.exit(0);
});

setInterval(() => {}, 1000);
`,
  );
}

function spawnWrapper(harness, args, env = {}) {
  return spawn(process.execPath, [harness.script, ...args], {
    cwd: harness.root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child, timeoutMs = 7000) {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killPid(child.pid);
      reject(
        new Error(`process ${child.pid} did not exit within ${timeoutMs}ms`),
      );
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitUntilDead(pid) {
  await waitFor(() => !pidAlive(pid), `pid ${pid} to exit`);
}

function writeLock(harness, metadata) {
  mkdirSync(dirname(harness.lockFile), { recursive: true });
  writeFileSync(
    harness.lockFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
}

function readPidFile(path) {
  try {
    return Number(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function findDeadPid() {
  for (let pid = 999_999; pid > 900_000; pid -= 1) {
    if (!pidAlive(pid)) return pid;
  }
  throw new Error("could not find an unused pid for stale lock test");
}

test("parent SIGTERM forwards to child and waits for child exit", async () => {
  const harness = createHarness();
  const childPidFile = join(harness.root, "child.pid");
  const childSignalFile = join(harness.root, "child.signal");
  let wrapper;
  try {
    const holdScript = writeHoldingScript(harness, "hold.mjs");
    wrapper = spawnWrapper(harness, [holdScript], {
      CHILD_PID_FILE: childPidFile,
      CHILD_SIGNAL_FILE: childSignalFile,
    });

    const lockChildPid = await waitFor(
      () => readLock(harness.lockFile)?.child_pid,
      "lock child pid",
    );
    const childPid = await waitFor(
      () => readPidFile(childPidFile),
      "child pid file",
    );
    assert.equal(lockChildPid, childPid);

    process.kill(wrapper.pid, "SIGTERM");
    const result = await waitForExit(wrapper);

    assert.equal(result.code, 143);
    assert.equal(readFileSync(childSignalFile, "utf8"), "SIGTERM");
    await waitUntilDead(childPid);
  } finally {
    killPid(readPidFile(childPidFile));
    killPid(wrapper?.pid);
    cleanupHarness(harness);
  }
});

test("child timeout exits non-zero and does not leave child alive", async () => {
  const harness = createHarness();
  const childPidFile = join(harness.root, "child.pid");
  const childSignalFile = join(harness.root, "child.signal");
  let wrapper;
  try {
    const holdScript = writeHoldingScript(harness, "hold-timeout.mjs");
    wrapper = spawnWrapper(harness, [holdScript], {
      CHILD_PID_FILE: childPidFile,
      CHILD_SIGNAL_FILE: childSignalFile,
      TEST_LOCK_TIMEOUT_MS: "200",
    });

    const childPid = await waitFor(
      () => readLock(harness.lockFile)?.child_pid,
      "lock child pid",
    );
    const result = await waitForExit(wrapper);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /timed out/i);
    assert.ok(!existsSync(harness.lockFile));
    await waitUntilDead(childPid);
  } finally {
    killPid(readPidFile(childPidFile));
    killPid(wrapper?.pid);
    cleanupHarness(harness);
  }
});

test("stale lock with live child PID exits non-zero and preserves lock", async () => {
  const harness = createHarness();
  try {
    const metadata = {
      parent_pid: 1,
      child_pid: process.pid,
      started_at: Date.now() - 10_000,
      timeout_ms: 1,
    };
    writeLock(harness, metadata);
    const okScript = writeScript(harness, "ok.mjs", "console.log('ok');\n");

    const wrapper = spawnWrapper(harness, [okScript]);
    const result = await waitForExit(wrapper);

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`child PID ${process.pid}`));
    assert.match(result.stderr, /age/i);
    assert.deepEqual(readLock(harness.lockFile), metadata);
  } finally {
    cleanupHarness(harness);
  }
});

test("stale lock with dead child PID is cleaned up and command proceeds", async () => {
  const harness = createHarness();
  try {
    writeLock(harness, {
      parent_pid: 1,
      child_pid: findDeadPid(),
      started_at: Date.now() - 10_000,
      timeout_ms: 1,
    });
    const okScript = writeScript(
      harness,
      "ok.mjs",
      "console.log('ok-child');\n",
    );

    const wrapper = spawnWrapper(harness, [okScript]);
    const result = await waitForExit(wrapper);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /ok-child/);
    assert.ok(!existsSync(harness.lockFile));
  } finally {
    cleanupHarness(harness);
  }
});

test("normal child exit preserves wrapper success behavior and releases lock", async () => {
  const harness = createHarness();
  try {
    const okScript = writeScript(
      harness,
      "ok.mjs",
      "console.log('normal-ok');\n",
    );

    const wrapper = spawnWrapper(harness, [okScript]);
    const result = await waitForExit(wrapper);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /normal-ok/);
    assert.ok(!existsSync(harness.lockFile));
  } finally {
    cleanupHarness(harness);
  }
});
