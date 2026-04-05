// hub/team/remote-watcher.mjs — tfx-spawn-* 세션 완료/입력대기 watcher
//
// 요구사항:
// 1) listSpawnSessions()로 tfx-spawn-* 세션 목록 조회
// 2) 각 세션의 pane 마지막 50줄을 10초 간격으로 폴링
// 3) 완료 패턴(__TRIFLUX_DONE__ 또는 프롬프트 idle) 감지
// 4) 완료/실패/입력대기 이벤트 emit
// 5) immutable status snapshot 제공

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { detectInputWait, PROBE_LEVELS } from "./health-probe.mjs";
import { shellQuoteForHost, detectHostOs } from "../lib/ssh-command.mjs";

export const REMOTE_WATCHER_STATES = Object.freeze({
  WATCHING: "watching",
  INPUT_WAIT: "input_wait",
  COMPLETED: "completed",
  FAILED: "failed",
});

export const REMOTE_WATCHER_DEFAULTS = Object.freeze({
  captureLines: 50,
  execTimeoutMs: 10_000,
  intervalMs: 10_000,
  paneSuffix: ":0.0",
  sessionPrefix: "tfx-spawn-",
  sshConnectTimeoutSec: 5,
});

const COMPLETION_TOKEN_RE = /__TRIFLUX_DONE__(?::([^:\r\n]+))?(?::(-?\d+))?/gu;
const BARE_PROMPT_RE = /^\s*(?:\u276f|\u2795|>)\s*$/u;
const BARE_INPUT_WAIT_PATTERN = />\s*$/.source;
const PROMPT_IDLE_PATTERNS = Object.freeze([
  /^\s*PS [^\r\n>]*>\s*$/u,
  /^\s*[a-zA-Z]:\\[^>\r\n]*>\s*$/u,
  /^\s*[\w.-]+@[\w.-]+(?::[^\r\n]*)?[#$%]\s*$/u,
  BARE_PROMPT_RE,
]);

/** @deprecated shellQuoteForHost(value, os) 사용 권장 — OS-aware 쿼팅 */
function shellQuote(value, os) {
  if (os) return shellQuoteForHost(value, os);
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function freezeErrorRecord(error) {
  if (!error) return null;
  return Object.freeze({
    message: String(error.message || error),
    name: error.name || "Error",
  });
}

function freezeSessionRecord(record) {
  return Object.freeze({ ...record });
}

function freezeStatus(status) {
  const frozenSessions = Object.freeze(
    Object.fromEntries(
      Object.entries(status.sessions || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionName, record]) => [sessionName, freezeSessionRecord(record)]),
    ),
  );

  return Object.freeze({
    ...status,
    lastError: freezeErrorRecord(status.lastError),
    sessions: frozenSessions,
  });
}

function toErrorRecord(error) {
  return {
    message: String(error?.message || error),
    name: error?.name || "Error",
  };
}

function getNonEmptyLines(text) {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function detectPromptIdle(captured) {
  const lastLine = getNonEmptyLines(captured).at(-1) || "";
  if (!lastLine) {
    return { detected: false, line: "", pattern: null };
  }

  for (const pattern of PROMPT_IDLE_PATTERNS) {
    if (pattern.test(lastLine)) {
      return {
        detected: true,
        line: lastLine,
        pattern: pattern.source,
      };
    }
  }

  return { detected: false, line: lastLine, pattern: null };
}

function hasMeaningfulActivity(captured) {
  const lines = getNonEmptyLines(captured);
  if (lines.length === 0) return false;

  const promptIdle = detectPromptIdle(captured);
  if (!promptIdle.detected) return true;

  return lines.slice(0, -1).some((line) => line.trim().length > 0);
}

function detectCompletion(captured) {
  const matches = Array.from(String(captured || "").matchAll(COMPLETION_TOKEN_RE));
  const match = matches.at(-1);
  if (!match) {
    return {
      detected: false,
      exitCode: null,
      match: null,
      token: null,
    };
  }

  const parsedExitCode = match[2] == null ? null : Number.parseInt(match[2], 10);
  return {
    detected: true,
    exitCode: Number.isFinite(parsedExitCode) ? parsedExitCode : null,
    match: match[0],
    token: match[1] || null,
  };
}

function parseSessionNames(rawOutput, sessionPrefix) {
  return String(rawOutput || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(":")[0]?.trim())
    .filter((sessionName) => Boolean(sessionName) && sessionName.startsWith(sessionPrefix));
}

function buildExecOptions(config) {
  return {
    encoding: "utf8",
    timeout: config.execTimeoutMs,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function runPsmuxCommand(args, config) {
  const execFn = config.deps?.execFileSync || execFileSync;
  const execOptions = buildExecOptions(config);

  if (config.host) {
    const hostOs = detectHostOs(config.host);
    const sshArgs = [
      "-o",
      `ConnectTimeout=${config.sshConnectTimeoutSec}`,
      "-o",
      "BatchMode=yes",
      config.host,
      `psmux ${args.map((a) => shellQuoteForHost(a, hostOs)).join(" ")}`,
    ];
    return execFn("ssh", sshArgs, execOptions);
  }

  return execFn("psmux", args, execOptions);
}

function buildPaneTarget(sessionName, config) {
  return `${sessionName}${config.paneSuffix}`;
}

function captureSpawnSession(sessionName, config) {
  const paneTarget = buildPaneTarget(sessionName, config);
  const output = runPsmuxCommand(
    ["capture-pane", "-t", paneTarget, "-p", "-S", `-${config.captureLines}`],
    config,
  );
  return {
    paneTarget,
    captured: String(output || "").replace(/\r/g, "").trimEnd(),
  };
}

export function listSpawnSessions(opts = {}) {
  const config = Object.freeze({
    ...REMOTE_WATCHER_DEFAULTS,
    ...opts,
  });
  const rawOutput = runPsmuxCommand(["list-sessions"], config);
  return parseSessionNames(rawOutput, config.sessionPrefix);
}

function createSessionRecord(sessionName, config, now) {
  return {
    completionMatch: null,
    exitCode: null,
    hasActivity: false,
    host: config.host || null,
    inputWaitPattern: null,
    lastEventAt: null,
    lastOutput: "",
    lastPollAt: null,
    lastProbeLevel: PROBE_LEVELS.L1,
    lastSeenAt: now,
    paneTarget: buildPaneTarget(sessionName, config),
    promptIdlePattern: null,
    reason: "watching",
    sessionName,
    state: REMOTE_WATCHER_STATES.WATCHING,
  };
}

function isTerminalState(state) {
  return state === REMOTE_WATCHER_STATES.COMPLETED || state === REMOTE_WATCHER_STATES.FAILED;
}

export function createRemoteWatcher(opts = {}) {
  const config = Object.freeze({
    ...REMOTE_WATCHER_DEFAULTS,
    ...opts,
  });

  const emitter = new EventEmitter();
  const clearIntervalFn = config.deps?.clearInterval || clearInterval;
  const nowFn = config.deps?.now || Date.now;
  const setIntervalFn = config.deps?.setInterval || setInterval;

  let intervalHandle = null;
  let polling = false;
  let status = freezeStatus({
    host: config.host || null,
    intervalMs: config.intervalMs,
    lastError: null,
    lastPollAt: null,
    running: false,
    sessions: {},
  });

  function setStatus(nextStatus) {
    status = freezeStatus(nextStatus);
    return status;
  }

  function emitSessionEvent(eventName, nextRecord, now) {
    emitter.emit(eventName, Object.freeze({
      exitCode: nextRecord.exitCode,
      host: nextRecord.host,
      inputWaitPattern: nextRecord.inputWaitPattern,
      output: nextRecord.lastOutput,
      paneTarget: nextRecord.paneTarget,
      probeLevel: nextRecord.lastProbeLevel,
      promptIdlePattern: nextRecord.promptIdlePattern,
      reason: nextRecord.reason,
      sessionName: nextRecord.sessionName,
      state: nextRecord.state,
      ts: now,
    }));
  }

  function classifySession(previousRecord, captured, now) {
    const completion = detectCompletion(captured);
    const inputWait = detectInputWait(captured);
    const promptIdle = detectPromptIdle(captured);
    const hasActivity = previousRecord.hasActivity || hasMeaningfulActivity(captured);

    let nextState = REMOTE_WATCHER_STATES.WATCHING;
    let reason = "watching";
    let lastProbeLevel = PROBE_LEVELS.L1;
    let exitCode = null;
    let eventName = null;

    if (completion.detected) {
      exitCode = completion.exitCode;
      lastProbeLevel = PROBE_LEVELS.L3;
      if (completion.exitCode != null && completion.exitCode !== 0) {
        nextState = REMOTE_WATCHER_STATES.FAILED;
        reason = "completion_token_nonzero";
        eventName = "sessionFailed";
      } else {
        nextState = REMOTE_WATCHER_STATES.COMPLETED;
        reason = "completion_token";
        eventName = "sessionCompleted";
      }
    } else if (
      promptIdle.detected
      && hasActivity
      && (!inputWait.detected || inputWait.pattern === BARE_INPUT_WAIT_PATTERN)
    ) {
      nextState = REMOTE_WATCHER_STATES.COMPLETED;
      reason = "prompt_idle";
      lastProbeLevel = PROBE_LEVELS.L3;
      eventName = "sessionCompleted";
    } else if (inputWait.detected) {
      nextState = REMOTE_WATCHER_STATES.INPUT_WAIT;
      reason = "input_wait";
      lastProbeLevel = PROBE_LEVELS.L1;
      if (previousRecord.state !== REMOTE_WATCHER_STATES.INPUT_WAIT) {
        eventName = "sessionInputWait";
      }
    }

    const nextRecord = {
      ...previousRecord,
      completionMatch: completion.match,
      exitCode,
      hasActivity,
      inputWaitPattern: inputWait.detected ? inputWait.pattern : null,
      lastOutput: captured,
      lastPollAt: now,
      lastProbeLevel,
      lastSeenAt: now,
      promptIdlePattern: promptIdle.detected ? promptIdle.pattern : null,
      reason,
      state: nextState,
    };

    if (
      eventName
      && previousRecord.state === nextRecord.state
      && previousRecord.reason === nextRecord.reason
      && previousRecord.exitCode === nextRecord.exitCode
    ) {
      return { eventName: null, nextRecord };
    }

    if (eventName) {
      nextRecord.lastEventAt = now;
    }

    return { eventName, nextRecord };
  }

  function markMissingSession(previousRecord, now) {
    if (isTerminalState(previousRecord.state)) {
      return { eventName: null, nextRecord: previousRecord };
    }

    const nextRecord = {
      ...previousRecord,
      lastEventAt: now,
      lastPollAt: now,
      lastProbeLevel: PROBE_LEVELS.L0,
      reason: "session_missing",
      state: REMOTE_WATCHER_STATES.FAILED,
    };

    return { eventName: "sessionFailed", nextRecord };
  }

  function pollSessions() {
    if (polling) return;
    polling = true;

    const now = nowFn();
    const queuedEvents = [];
    const nextSessions = { ...status.sessions };

    try {
      const activeSessions = listSpawnSessions(config);
      const activeSet = new Set(activeSessions);

      for (const sessionName of activeSessions) {
        const previousRecord = nextSessions[sessionName]
          ? { ...nextSessions[sessionName] }
          : createSessionRecord(sessionName, config, now);

        try {
          const { paneTarget, captured } = captureSpawnSession(sessionName, config);
          const { eventName, nextRecord } = classifySession(
            { ...previousRecord, paneTarget },
            captured,
            now,
          );
          nextSessions[sessionName] = nextRecord;

          if (eventName) {
            queuedEvents.push({ eventName, record: nextRecord });
          }
        } catch (error) {
          const failedRecord = {
            ...previousRecord,
            lastEventAt: now,
            lastPollAt: now,
            lastProbeLevel: PROBE_LEVELS.L0,
            reason: "capture_failed",
            state: REMOTE_WATCHER_STATES.FAILED,
          };
          nextSessions[sessionName] = failedRecord;
          queuedEvents.push({ eventName: "sessionFailed", record: failedRecord });
          setStatus({
            ...status,
            lastError: toErrorRecord(error),
            lastPollAt: now,
            running: true,
            sessions: nextSessions,
          });
        }
      }

      for (const [sessionName, previousRecord] of Object.entries(status.sessions)) {
        if (activeSet.has(sessionName)) continue;
        const { eventName, nextRecord } = markMissingSession(previousRecord, now);
        nextSessions[sessionName] = nextRecord;
        if (eventName) {
          queuedEvents.push({ eventName, record: nextRecord });
        }
      }

      setStatus({
        ...status,
        lastError: null,
        lastPollAt: now,
        running: true,
        sessions: nextSessions,
      });

      for (const { eventName, record } of queuedEvents) {
        emitSessionEvent(eventName, record, now);
      }
    } catch (error) {
      setStatus({
        ...status,
        lastError: toErrorRecord(error),
        lastPollAt: now,
        running: true,
      });
    } finally {
      polling = false;
    }
  }

  function start() {
    if (intervalHandle) return;

    setStatus({
      ...status,
      lastError: null,
      running: true,
    });

    intervalHandle = setIntervalFn(() => {
      pollSessions();
    }, config.intervalMs);
    intervalHandle?.unref?.();

    pollSessions();
  }

  function stop() {
    if (intervalHandle) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }

    setStatus({
      ...status,
      running: false,
    });
  }

  return Object.freeze({
    getStatus: () => status,
    off: emitter.off.bind(emitter),
    on: emitter.on.bind(emitter),
    start,
    stop,
  });
}
