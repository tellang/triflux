import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const LOG_DIR = join(homedir(), ".triflux", "logs");
const DEDUPE_WINDOW_MS = 5_000;
const RATE_WINDOW_MS = 1_000;
const WINDOWS_TERMINAL_COMMANDS = new Set([
  "wt",
  "wt.exe",
  "windowsterminal.exe",
]);

export const MAX_WT_TABS = 8;
export const MAX_SPAWN_PER_SEC = resolvePositiveInteger(
  process.env.TRIFLUX_MAX_SPAWN_RATE,
  10,
);
export const MAX_TOTAL_DESCENDANTS = resolvePositiveInteger(
  process.env.TRIFLUX_MAX_DESCENDANTS,
  50,
);

let logDay = "";
let logStream = null;
let traceSequence = 0;

const recentSpawnTimes = [];
const dedupeEntries = new Map();
const activeChildren = new Map();
const activeWtChildren = new Set();

function resolvePositiveInteger(...values) {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function getLogPath(day = nowIso().slice(0, 10)) {
  return join(LOG_DIR, `spawn-trace-${day}.jsonl`);
}

function ensureLogStream() {
  const day = nowIso().slice(0, 10);
  if (logStream && logDay === day) {
    return logStream;
  }

  mkdirSync(LOG_DIR, { recursive: true });

  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
  }

  logDay = day;
  logStream = createWriteStream(getLogPath(day), { flags: "a" });
  logStream.on("error", () => {
    /* ignore logging failures */
  });
  return logStream;
}

function appendTrace(data, { sync = false } = {}) {
  const entry = {
    ts: nowIso(),
    session_id: process.env.TRIFLUX_SESSION_ID ?? null,
    parent_pid: process.pid,
    ...data,
  };

  try {
    ensureLogStream().write(`${JSON.stringify(entry)}\n`);
  } catch {
    if (!sync) {
      /* ignore logging failures */
    }
  }
}

function nextTraceId() {
  traceSequence += 1;
  return `spawn-trace-${Date.now()}-${traceSequence}`;
}

function trimRecentSpawnTimes(now) {
  while (
    recentSpawnTimes.length > 0 &&
    now - recentSpawnTimes[0] >= RATE_WINDOW_MS
  ) {
    recentSpawnTimes.shift();
  }
}

function trimDedupeEntries(now) {
  for (const [key, ts] of dedupeEntries.entries()) {
    if (now - ts >= DEDUPE_WINDOW_MS) {
      dedupeEntries.delete(key);
    }
  }
}

function stripTraceOptions(options) {
  if (!options || typeof options !== "object") {
    return undefined;
  }

  const { reason: _reason, dedupe: _dedupe, ...rest } = options;
  return rest;
}

function getReason(options) {
  if (!options || typeof options !== "object") {
    return null;
  }

  return options.reason ?? null;
}

function getDedupeKey(options) {
  if (!options || typeof options !== "object") {
    return null;
  }

  return typeof options.dedupe === "string" && options.dedupe.trim()
    ? options.dedupe.trim()
    : null;
}

function getCwd(options) {
  if (!options || typeof options !== "object") {
    return process.cwd();
  }

  return options.cwd || process.cwd();
}

function getCommandBasename(command) {
  return basename(String(command || "")).toLowerCase();
}

function isWindowsTerminalSpawn(command) {
  return WINDOWS_TERMINAL_COMMANDS.has(getCommandBasename(command));
}

function createPolicyError(reasonCode, message, meta = {}) {
  const error = new Error(message);
  error.code = "TRIFLUX_SPAWN_BLOCKED";
  error.reasonCode = reasonCode;
  Object.assign(error, meta);
  return error;
}

function logBlocked(traceId, command, args, options, error, extra = {}) {
  appendTrace({
    event: "blocked",
    trace_id: traceId,
    command,
    args,
    cwd: getCwd(options),
    reason: getReason(options),
    warning: error.message,
    warning_code: error.reasonCode || error.code || "unknown",
    ...extra,
  });
}

function enforceGuards(command, args, options) {
  const now = Date.now();
  trimRecentSpawnTimes(now);
  trimDedupeEntries(now);

  const dedupeKey = getDedupeKey(options);
  if (dedupeKey) {
    const lastSeenAt = dedupeEntries.get(dedupeKey);
    if (lastSeenAt != null && now - lastSeenAt < DEDUPE_WINDOW_MS) {
      return createPolicyError(
        "dedupe",
        `spawn-trace dedupe blocked for key "${dedupeKey}"`,
        { dedupeKey },
      );
    }
  }

  if (recentSpawnTimes.length >= MAX_SPAWN_PER_SEC) {
    return createPolicyError(
      "rate_limit",
      `spawn-trace rate limit exceeded (${MAX_SPAWN_PER_SEC}/sec)`,
      { maxPerSec: MAX_SPAWN_PER_SEC },
    );
  }

  if (activeChildren.size >= MAX_TOTAL_DESCENDANTS) {
    return createPolicyError(
      "max_descendants",
      `spawn-trace max descendants exceeded (${MAX_TOTAL_DESCENDANTS})`,
      { maxDescendants: MAX_TOTAL_DESCENDANTS },
    );
  }

  if (isWindowsTerminalSpawn(command) && activeWtChildren.size >= MAX_WT_TABS) {
    return createPolicyError(
      "wt_tab_cap",
      `spawn-trace Windows Terminal cap exceeded (${MAX_WT_TABS})`,
      { maxWtTabs: MAX_WT_TABS },
    );
  }

  recentSpawnTimes.push(now);
  if (dedupeKey) {
    dedupeEntries.set(dedupeKey, now);
  }

  return null;
}

function trackChild(child, meta) {
  if (!child || typeof child.once !== "function") {
    return child;
  }

  activeChildren.set(child, meta);
  if (meta.isWindowsTerminalSpawn) {
    activeWtChildren.add(child);
  }

  let finalized = false;
  const finalize = (event, payload = {}) => {
    if (finalized) {
      return;
    }

    finalized = true;
    activeChildren.delete(child);
    activeWtChildren.delete(child);

    appendTrace({
      event,
      trace_id: meta.traceId,
      command: meta.command,
      args: meta.args,
      cwd: meta.cwd,
      reason: meta.reason,
      child_pid: child.pid ?? null,
      duration_ms: Date.now() - meta.startedAt,
      ...payload,
    });
  };

  child.once("exit", (code, signal) => {
    finalize("exit", {
      exit_code: code,
      signal: signal ?? null,
    });
  });

  child.once("error", (error) => {
    finalize("error", {
      error: error.message,
    });
  });

  return child;
}

function createRejectedChild(command, args, error) {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  child.stdio = [null, null, null];
  child.spawnfile = String(command);
  child.spawnargs = [String(command), ...args.map((arg) => String(arg))];
  child.kill = () => false;
  child.killed = false;
  child.connected = false;
  child.exitCode = 1;
  child.signalCode = null;

  queueMicrotask(() => {
    child.emit("error", error);
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
  });

  return child;
}

function normalizeSpawnArgs(args, options) {
  if (Array.isArray(args)) {
    return {
      argsList: [...args],
      options,
    };
  }

  return {
    argsList: [],
    options: args,
  };
}

function normalizeExecFileArgs(args, options, callback) {
  let argsList = [];
  let normalizedOptions;
  let normalizedCallback;

  if (typeof args === "function") {
    normalizedCallback = args;
  } else if (Array.isArray(args)) {
    argsList = [...args];
    if (typeof options === "function") {
      normalizedCallback = options;
    } else {
      normalizedOptions = options;
      if (typeof callback === "function") {
        normalizedCallback = callback;
      }
    }
  } else {
    normalizedOptions = args;
    if (typeof options === "function") {
      normalizedCallback = options;
    }
  }

  return {
    argsList,
    options: normalizedOptions,
    callback: normalizedCallback,
  };
}

export function spawn(command, args, options) {
  const { argsList, options: normalizedOptions } = normalizeSpawnArgs(
    args,
    options,
  );
  const traceId = nextTraceId();
  const blockedError = enforceGuards(command, argsList, normalizedOptions);
  if (blockedError) {
    logBlocked(traceId, command, argsList, normalizedOptions, blockedError);
    throw blockedError;
  }

  const startedAt = Date.now();
  const child = childProcess.spawn(
    command,
    argsList,
    stripTraceOptions(normalizedOptions),
  );
  appendTrace({
    event: "spawn",
    trace_id: traceId,
    command,
    args: argsList,
    cwd: getCwd(normalizedOptions),
    reason: getReason(normalizedOptions),
    child_pid: child.pid ?? null,
  });

  return trackChild(child, {
    traceId,
    startedAt,
    command,
    args: argsList,
    cwd: getCwd(normalizedOptions),
    reason: getReason(normalizedOptions),
    isWindowsTerminalSpawn: isWindowsTerminalSpawn(command),
  });
}

export function execFile(file, args, options, callback) {
  const normalized = normalizeExecFileArgs(args, options, callback);
  const traceId = nextTraceId();
  const blockedError = enforceGuards(
    file,
    normalized.argsList,
    normalized.options,
  );
  if (blockedError) {
    logBlocked(traceId, file, normalized.argsList, normalized.options, blockedError);
    if (typeof normalized.callback === "function") {
      queueMicrotask(() => normalized.callback(blockedError, "", ""));
      return createRejectedChild(file, normalized.argsList, blockedError);
    }
    throw blockedError;
  }

  const startedAt = Date.now();
  const wrappedCallback =
    typeof normalized.callback === "function"
      ? (error, stdout, stderr) => normalized.callback(error, stdout, stderr)
      : undefined;

  const child = childProcess.execFile(
    file,
    normalized.argsList,
    stripTraceOptions(normalized.options),
    wrappedCallback,
  );

  appendTrace({
    event: "spawn",
    trace_id: traceId,
    command: file,
    args: normalized.argsList,
    cwd: getCwd(normalized.options),
    reason: getReason(normalized.options),
    child_pid: child.pid ?? null,
  });

  return trackChild(child, {
    traceId,
    startedAt,
    command: file,
    args: normalized.argsList,
    cwd: getCwd(normalized.options),
    reason: getReason(normalized.options),
    isWindowsTerminalSpawn: isWindowsTerminalSpawn(file),
  });
}

export function execFileSync(file, args, options) {
  const normalized = Array.isArray(args)
    ? { argsList: [...args], options }
    : { argsList: [], options: args };
  const traceId = nextTraceId();
  const blockedError = enforceGuards(
    file,
    normalized.argsList,
    normalized.options,
  );
  if (blockedError) {
    logBlocked(traceId, file, normalized.argsList, normalized.options, blockedError, {
      sync: true,
    });
    throw blockedError;
  }

  const startedAt = Date.now();
  appendTrace(
    {
      event: "spawn",
      trace_id: traceId,
      command: file,
      args: normalized.argsList,
      cwd: getCwd(normalized.options),
      reason: getReason(normalized.options),
      sync: true,
    },
    { sync: true },
  );

  try {
    const result = childProcess.execFileSync(
      file,
      normalized.argsList,
      stripTraceOptions(normalized.options),
    );
    appendTrace(
      {
        event: "exit",
        trace_id: traceId,
        command: file,
        args: normalized.argsList,
        cwd: getCwd(normalized.options),
        reason: getReason(normalized.options),
        exit_code: 0,
        duration_ms: Date.now() - startedAt,
        sync: true,
      },
      { sync: true },
    );
    return result;
  } catch (error) {
    appendTrace(
      {
        event: "exit",
        trace_id: traceId,
        command: file,
        args: normalized.argsList,
        cwd: getCwd(normalized.options),
        reason: getReason(normalized.options),
        exit_code: error?.status ?? null,
        signal: error?.signal ?? null,
        duration_ms: Date.now() - startedAt,
        error: error?.message,
        sync: true,
      },
      { sync: true },
    );
    throw error;
  }
}

export const ChildProcess = childProcess.ChildProcess;
export const _forkChild = childProcess._forkChild;
export const exec = childProcess.exec;
export const execSync = childProcess.execSync;
export const fork = childProcess.fork;
export const spawnSync = childProcess.spawnSync;

export default {
  ...childProcess,
  spawn,
  execFile,
  execFileSync,
  MAX_WT_TABS,
  MAX_SPAWN_PER_SEC,
  MAX_TOTAL_DESCENDANTS,
};
