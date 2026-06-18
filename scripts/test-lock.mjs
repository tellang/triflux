#!/usr/bin/env node

// scripts/test-lock.mjs — 테스트 러너 싱글톤 lockfile 가드
//
// npm test 동시 실행 방지. conductor 같은 child-spawn 테스트가
// 3중 실행되면 WT ConPTY 수백 개 → 16GB RAM 사고 발생.
//
// 사용: node scripts/test-lock.mjs [-- ...node --test args]

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const LOCK_DIR = join(dirname(SCRIPT_PATH), "..", ".test-lock");
const LOCK_FILE = join(LOCK_DIR, "pid.lock");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // release prepare 와 동일
const SHUTDOWN_GRACE_MS = 5 * 1000;
// --test-force-exit can beat already-queued async test failures: Node sets
// process.exitCode=1 a few microtask turns AFTER the runner calls
// process.exit(). A single-turn defer raced that and could force-exit 0 with
// real failures still pending (masking e.g. 4185-pass/3-fail as a green exit).
// Drain a BOUNDED number of turns until the runner's exitCode settles, and keep
// an independent failure signal for uncaught/rejection classes that may never
// set process.exitCode. Rejections are tracked per-promise and cleared on
// rejectionHandled so a late-attached .catch does not false-fail the run.
// Fails closed: a genuinely-unhandled rejection or uncaught error resolves
// toward non-zero.
const FORCE_EXIT_FAILURE_PROPAGATION_IMPORT = `data:text/javascript,${encodeURIComponent(`
const realExit = process.exit.bind(process);
let pendingCode = 0;
let uncaught = false;
let scheduled = false;
const pendingRejections = new Set();
process.on("uncaughtException", () => {
  uncaught = true;
});
process.on("unhandledRejection", (_reason, promise) => {
  pendingRejections.add(promise);
});
process.on("rejectionHandled", (promise) => {
  pendingRejections.delete(promise);
});

process.exit = (code) => {
  if (code !== undefined && code !== 0) pendingCode = code;
  if (scheduled) return;
  scheduled = true;
  let turns = 0;
  const settle = () => {
    const runnerCode = process.exitCode;
    const failed = uncaught || pendingRejections.size > 0;
    const resolved =
      runnerCode !== undefined && runnerCode !== 0
        ? runnerCode
        : failed
          ? 1
          : pendingCode;
    if (resolved || turns >= 50) {
      realExit(resolved ?? 0);
      return;
    }
    turns += 1;
    setImmediate(settle);
  };
  setImmediate(settle);
};
`)}`;

function toPosixPath(path) {
  return path.replace(/\\/g, "/");
}

function stripLeadingDotSlash(pattern) {
  return pattern.startsWith("./") ? pattern.slice(2) : pattern;
}

function globToRegExp(pattern) {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
  }
  source += "$";
  return new RegExp(source);
}

function staticGlobPrefix(pattern) {
  const firstGlob = pattern.indexOf("*");
  if (firstGlob === -1) return pattern;
  const slash = pattern.lastIndexOf("/", firstGlob);
  if (slash === -1) return ".";
  return pattern.slice(0, slash) || ".";
}

function walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function expandGlobArg(arg, cwd) {
  const normalizedPattern = stripLeadingDotSlash(toPosixPath(arg));
  const matchPattern = isAbsolute(arg)
    ? toPosixPath(resolve(arg))
    : normalizedPattern;
  const matcher = globToRegExp(matchPattern);
  const prefix = staticGlobPrefix(normalizedPattern);
  const root = isAbsolute(arg) ? resolve(prefix) : resolve(cwd, prefix);

  return walkFiles(root)
    .map((file) => {
      if (isAbsolute(arg)) return toPosixPath(resolve(file));
      return toPosixPath(relative(cwd, file));
    })
    .filter((file) => matcher.test(file))
    .sort((a, b) => a.localeCompare(b));
}

export function expandTestArgs(args, { cwd = process.cwd() } = {}) {
  return args.flatMap((arg) => {
    if (arg.startsWith("-") || !arg.includes("*")) return [arg];
    const expanded = expandGlobArg(arg, cwd);
    return expanded.length > 0 ? expanded : [arg];
  });
}

function parseTimeoutMs(value = process.env.TEST_LOCK_TIMEOUT_MS) {
  if (value === undefined || value === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.trunc(parsed);
}

function normalizeLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      parent_pid: Number(parsed.parent_pid),
      child_pid:
        parsed.child_pid === null || parsed.child_pid === undefined
          ? null
          : Number(parsed.child_pid),
      started_at: Number(parsed.started_at),
      timeout_ms: Number(parsed.timeout_ms) || DEFAULT_TIMEOUT_MS,
    };
  } catch {
    const [pidStr, tsStr] = raw.trim().split("\n");
    const parentPid = Number(pidStr);
    const startedAt = Number(tsStr);
    if (!Number.isFinite(parentPid)) return null;
    return {
      parent_pid: parentPid,
      child_pid: null,
      started_at: Number.isFinite(startedAt) ? startedAt : 0,
      timeout_ms: DEFAULT_TIMEOUT_MS,
    };
  }
}

function readLock() {
  try {
    const content = readFileSync(LOCK_FILE, "utf8").trim();
    if (!content) return null;
    return normalizeLock(content);
  } catch {
    return null;
  }
}

function writeLock(metadata) {
  writeFileSync(LOCK_FILE, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockAgeMs(lock) {
  if (!Number.isFinite(lock?.started_at)) return Number.POSITIVE_INFINITY;
  return Date.now() - lock.started_at;
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function acquireLock(timeoutMs) {
  const existing = readLock();
  if (existing) {
    const age = lockAgeMs(existing);
    const existingTimeoutMs = existing.timeout_ms || DEFAULT_TIMEOUT_MS;
    if (age >= 0 && age < existingTimeoutMs) {
      console.error(
        `\x1b[31m✗ 테스트 이미 실행 중 (parent PID ${existing.parent_pid}, child PID ${existing.child_pid ?? "unknown"}, age ${formatAge(age)})\x1b[0m`,
      );
      console.error(
        `  동시 실행은 WT 메모리 폭발을 유발합니다. 기다리거나 PID를 kill하세요.`,
      );
      console.error(`  강제 해제: rm ${LOCK_FILE}`);
      process.exit(1);
    }
    if (existing.child_pid && isPidAlive(existing.child_pid)) {
      console.error(
        `\x1b[31m✗ stale test lock has live child PID ${existing.child_pid} (age ${formatAge(age)}, timeout ${existingTimeoutMs}ms)\x1b[0m`,
      );
      console.error(`  lock 보존: ${LOCK_FILE}`);
      console.error(
        `  child 상태를 확인한 뒤 종료하거나, 안전하다고 판단될 때 lock을 수동 제거하세요.`,
      );
      process.exit(1);
    }
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock = {
    parent_pid: process.pid,
    child_pid: null,
    started_at: Date.now(),
    timeout_ms: timeoutMs,
  };
  writeLock(lock);
  return lock;
}

function releaseLock() {
  try {
    const lock = readLock();
    if (lock && lock.parent_pid === process.pid) unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function updateChildPid(lock, childPid) {
  if (!Number.isFinite(childPid)) return;
  const current = readLock();
  if (!current || current.parent_pid !== process.pid) return;
  writeLock({ ...lock, child_pid: childPid });
}

function signalToExitCode(signal) {
  if (!signal) return 1;
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  };
  return 128 + (signals[signal] ?? 1);
}

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function preserveForceExitFailures(args) {
  if (!args.includes("--test-force-exit")) return args;
  return ["--import", FORCE_EXIT_FAILURE_PROPAGATION_IMPORT, ...args];
}

function terminateChild(child, signal) {
  if (!childIsRunning(child)) return false;
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

export function main(argv = process.argv.slice(2)) {
  const timeoutMs = parseTimeoutMs();
  const lock = acquireLock(timeoutMs);
  const testHubPidDir = mkdtempSync(join(tmpdir(), "tfx-test-hub-pid-"));
  let child = null;
  let finished = false;
  let requestedExitCode = null;
  let timeoutTimer = null;
  let graceTimer = null;

  function clearTimers() {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    timeoutTimer = null;
    graceTimer = null;
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimers();
    releaseLock();
    try {
      rmSync(testHubPidDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
    process.exit(code);
  }

  function forceKillAfterGrace() {
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      terminateChild(child, "SIGKILL");
    }, SHUTDOWN_GRACE_MS);
    graceTimer.unref?.();
  }

  function requestShutdown(signal, exitCode = signalToExitCode(signal)) {
    if (finished) return;
    requestedExitCode = exitCode;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (childIsRunning(child)) {
      terminateChild(child, signal);
      forceKillAfterGrace();
      return;
    }
    finish(requestedExitCode);
  }

  process.once("exit", () => {
    if (!finished) terminateChild(child, "SIGTERM");
    releaseLock();
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => requestShutdown(signal));
  }

  // Install termination handlers before spawning/advertising child state. The
  // child can become ready before this wrapper reaches later setup lines on
  // fast Linux CI; without early handlers an external SIGTERM can terminate the
  // wrapper by signal instead of the controlled 128+signal exit path.
  // forward args after -- to node --test
  const args = preserveForceExitFailures(expandTestArgs(argv));
  // stdio split (issue #192 F1): when prepare.mjs spawns this lock with
  // ["ignore","pipe","pipe"], full inherit cascades the parent stdin=ignore
  // to grand-child node --test, breaking ConPTY assumptions on Windows and
  // surfacing as EXIT=1 (false-failed). Pipe stdin only — stdout/stderr stay
  // inherited so the grand-child still streams to whoever attached to us.
  child = spawn(process.execPath, args, {
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      TEST_LOCK_PID: String(process.pid),
      TFX_HUB_PID_DIR: process.env.TFX_HUB_PID_DIR || testHubPidDir,
      TFX_HUB_STATE_DIR: process.env.TFX_HUB_STATE_DIR || testHubPidDir,
    },
  });

  child.on("error", (error) => {
    console.error(`test-lock failed to spawn child: ${error.message}`);
    finish(1);
  });

  child.on("exit", (code, signal) => {
    if (requestedExitCode !== null) {
      finish(requestedExitCode);
      return;
    }
    finish(code ?? signalToExitCode(signal));
  });

  updateChildPid(lock, child.pid);
  // Close stdin immediately so node --test never blocks waiting for input.
  child.stdin?.end();

  timeoutTimer = setTimeout(() => {
    console.error(
      `\x1b[31m✗ test-lock child timed out after ${timeoutMs}ms (child PID ${child?.pid ?? "unknown"})\x1b[0m`,
    );
    requestShutdown("SIGTERM", 124);
  }, timeoutMs);
  timeoutTimer.unref?.();
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
