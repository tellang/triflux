import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".triflux", "logs");
const DEDUPE_WINDOW_MS = 5_000;
const RATE_WINDOW_MS = 1_000;
const DEFAULT_MAX_SPAWN_PER_SEC = 100;
const MAX_PLAIN_TRACE_VALUE = 64;
// multi-worker headless dispatch 가 1 초 안에 ~25-30+ psmux/tmux 명령을 호출한다.
// 2-worker dispatchBatch 가 default 30 limit 을 초과해 `rate_limit` throw 로 mac
// 호환성 회귀 (smoke test 발견, 2026-05-15). 100 으로 상향 — 폭주 안전망은
// 여전히 (default 100/sec) 유지, env override 로 보수 설정 가능.
export let MAX_SPAWN_PER_SEC = resolvePositiveInteger(
  process.env.TRIFLUX_MAX_SPAWN_RATE,
  DEFAULT_MAX_SPAWN_PER_SEC,
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

  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  restrictMode(LOG_DIR, 0o700);

  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
  }

  logDay = day;
  logStream = createWriteStream(getLogPath(day), { flags: "a", mode: 0o600 });
  restrictMode(getLogPath(day), 0o600);
  logStream.on("error", () => {
    /* ignore logging failures */
  });
  return logStream;
}

// 예전 버전이 0644 로 만든 로그도 좁힌다. Windows 는 chmod 가 의미 없어 실패를 무시한다.
function restrictMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    /* ignore */
  }
}

function redacted(value) {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `<redacted len=${value.length} sha256=${digest}>`;
}

// 프롬프트가 로그에 남지 않게, 공백이 있거나 긴 값은 길이와 해시만 남긴다.
export function redactTraceValue(value) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_PLAIN_TRACE_VALUE && !/\s/u.test(value)) return value;
  return redacted(value);
}

const PROMPT_FLAGS = new Set(["--print", "--prompt", "--message", "--seed"]);
const SEND_KEYS_VALUE_FLAGS = new Set(["-t", "-N", "-c"]);
const NAMED_KEY =
  /^(Enter|Escape|Tab|BSpace|Space|Up|Down|Left|Right|[CM]-.)$/u;

// 짧은 토큰도 키 입력과 프롬프트 자리에 오면 항상 가린다. 길이만 보면 짧은 비밀이 샌다.
function redactArgs(args) {
  const sendKeysAt = args.indexOf("send-keys");
  let keysFrom = -1;
  if (sendKeysAt >= 0) {
    let i = sendKeysAt + 1;
    while (i < args.length && /^-./u.test(String(args[i]))) {
      i += SEND_KEYS_VALUE_FLAGS.has(args[i]) ? 2 : 1;
    }
    keysFrom = i;
  }
  return args.map((arg, index) => {
    if (typeof arg !== "string") return arg;
    const promptFlag = arg.split("=")[0];
    if (PROMPT_FLAGS.has(promptFlag) && arg.includes("=")) {
      return `${promptFlag}=${redacted(arg.slice(promptFlag.length + 1))}`;
    }
    const afterPromptFlag = PROMPT_FLAGS.has(args[index - 1]);
    const isKey = keysFrom >= 0 && index >= keysFrom && !NAMED_KEY.test(arg);
    return afterPromptFlag || isKey ? redacted(arg) : redactTraceValue(arg);
  });
}

export function redactTraceEntry(entry) {
  return {
    ...entry,
    command: redactTraceValue(entry.command),
    args: Array.isArray(entry.args) ? redactArgs(entry.args) : entry.args,
    // execFileSync 오류 메시지에는 명령과 인자 전체가 들어간다.
    ...(typeof entry.error === "string"
      ? { error: redactTraceValue(entry.error) }
      : {}),
  };
}

function appendTrace(data, { sync = false } = {}) {
  const entry = redactTraceEntry({
    ts: nowIso(),
    session_id: process.env.TRIFLUX_SESSION_ID ?? null,
    parent_pid: process.pid,
    ...data,
  });

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

function createPolicyError(reasonCode, message, meta = {}) {
  const error = new Error(message);
  error.code = "TRIFLUX_SPAWN_BLOCKED";
  error.reasonCode = reasonCode;
  Object.assign(error, meta);
  return error;
}

export function getMaxSpawnPerSec() {
  return MAX_SPAWN_PER_SEC;
}

export function reload() {
  MAX_SPAWN_PER_SEC = resolvePositiveInteger(
    process.env.TRIFLUX_MAX_SPAWN_RATE,
    DEFAULT_MAX_SPAWN_PER_SEC,
  );
  return getMaxSpawnPerSec();
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
  const maxSpawnPerSec = getMaxSpawnPerSec();

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

  if (recentSpawnTimes.length >= maxSpawnPerSec) {
    return createPolicyError(
      "rate_limit",
      `spawn-trace rate limit exceeded (${maxSpawnPerSec}/sec)`,
      { maxPerSec: maxSpawnPerSec },
    );
  }

  if (activeChildren.size >= MAX_TOTAL_DESCENDANTS) {
    return createPolicyError(
      "max_descendants",
      `spawn-trace max descendants exceeded (${MAX_TOTAL_DESCENDANTS})`,
      { maxDescendants: MAX_TOTAL_DESCENDANTS },
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

  let finalized = false;
  const finalize = (event, payload = {}) => {
    if (finalized) {
      return;
    }

    finalized = true;
    activeChildren.delete(child);

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
      error_code: error.code ?? null,
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  });
}

export async function spawnWithBackoff(command, args, options, maxRetries = 1) {
  const retryLimit =
    Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 1;
  let originalRateLimitError = null;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      return spawn(command, args, options);
    } catch (error) {
      if (error?.reasonCode !== "rate_limit") {
        throw error;
      }

      originalRateLimitError ??= error;

      if (attempt >= retryLimit) {
        throw originalRateLimitError;
      }

      await wait(RATE_WINDOW_MS);
    }
  }

  throw originalRateLimitError;
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
    logBlocked(
      traceId,
      file,
      normalized.argsList,
      normalized.options,
      blockedError,
    );
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
    logBlocked(
      traceId,
      file,
      normalized.argsList,
      normalized.options,
      blockedError,
      {
        sync: true,
      },
    );
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
        error_code: error?.code ?? null,
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
  spawnWithBackoff,
  execFile,
  execFileSync,
  get MAX_SPAWN_PER_SEC() {
    return MAX_SPAWN_PER_SEC;
  },
  MAX_TOTAL_DESCENDANTS,
  getMaxSpawnPerSec,
  reload,
};
