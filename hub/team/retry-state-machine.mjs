// hub/team/retry-state-machine.mjs
// Phase 3 Step A — true ralph / auto-escalate retry state machine.
// 설계 문서: .triflux/plans/phase3-lead-codex-ralph-escalate.md
//
// Modes:
//   bounded       — --retry 1 (기본): maxIterations 도달 시 BUDGET_EXCEEDED.
//   ralph         — --retry ralph: maxIterations=0 이면 unlimited. stuck detector 만 종료.
//   auto-escalate — --retry auto-escalate: BUDGET_EXCEEDED 시 다음 CLI 로 전이.
//
// 상태 전이:
//   PLANNING → EXECUTING → VERIFYING.success → DONE
//                       → VERIFYING.fail   → DIAGNOSING → EXECUTING …
//                       → stuckCounter≥3   → STUCK
//                       → iter≥max         → BUDGET_EXCEEDED (escalate 모드는 다음 CLI)

import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const STATES = Object.freeze({
  PLANNING: "PLANNING",
  EXECUTING: "EXECUTING",
  DIAGNOSING: "DIAGNOSING",
  STUCK: "STUCK",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  DONE: "DONE",
});

export const MODES = Object.freeze({
  BOUNDED: "bounded",
  RALPH: "ralph",
  ESCALATE: "auto-escalate",
});

const DEFAULT_ESCALATION_CHAIN = Object.freeze([
  Object.freeze({ cli: "codex", model: "gpt-5-mini" }),
  Object.freeze({ cli: "codex", model: "gpt-5" }),
  Object.freeze({ cli: "claude", model: "sonnet-4-6" }),
  Object.freeze({ cli: "claude", model: "opus-4-7" }),
]);

const STUCK_THRESHOLD = 3;

export function createRetryStateMachine(options = {}) {
  const mode = options.mode || MODES.BOUNDED;
  const cliChain = Array.isArray(options.cliChain)
    ? options.cliChain.slice()
    : DEFAULT_ESCALATION_CHAIN.slice();
  const maxIterationsInput =
    typeof options.maxIterations === "number" ? options.maxIterations : null;
  const maxIterations =
    maxIterationsInput !== null
      ? maxIterationsInput
      : mode === MODES.BOUNDED
        ? 3
        : 0;
  const stateFile = options.stateFile || null;
  const sessionId = options.sessionId || null;

  const emitter = new EventEmitter();
  const state = {
    current: STATES.PLANNING,
    iterations: 0,
    maxIterations,
    stuckCounter: 0,
    lastFailureReason: null,
    cliIndex: 0,
    cliChain,
    mode,
    sessionId,
    stateFile,
    history: [],
  };

  function transition(next, meta = {}) {
    const prev = state.current;
    state.current = next;
    const entry = {
      t: Date.now(),
      from: prev,
      to: next,
      iteration: state.iterations,
      cliIndex: state.cliIndex,
      ...meta,
    };
    state.history.push(entry);
    if (stateFile) persistTransition(stateFile, entry);
    emitter.emit("transition", entry);
    return entry;
  }

  function startIteration() {
    state.iterations += 1;
    return transition(STATES.EXECUTING, { iteration: state.iterations });
  }

  function reportVerifySuccess() {
    return transition(STATES.DONE);
  }

  function reportVerifyFail(failureReason) {
    const reason = String(failureReason || "unknown");
    if (reason === state.lastFailureReason) {
      state.stuckCounter += 1;
    } else {
      state.stuckCounter = 1;
      state.lastFailureReason = reason;
    }

    if (state.stuckCounter >= STUCK_THRESHOLD) {
      return transition(STATES.STUCK, {
        reason,
        stuckCounter: state.stuckCounter,
      });
    }

    if (state.maxIterations > 0 && state.iterations >= state.maxIterations) {
      if (state.mode === MODES.ESCALATE) {
        return escalate();
      }
      return transition(STATES.BUDGET_EXCEEDED, {
        reason,
        iterations: state.iterations,
      });
    }

    return transition(STATES.DIAGNOSING, { reason });
  }

  function escalate() {
    if (state.cliIndex + 1 >= state.cliChain.length) {
      return transition(STATES.BUDGET_EXCEEDED, {
        reason: "escalation-chain-exhausted",
        chain: state.cliChain,
      });
    }
    state.cliIndex += 1;
    state.iterations = 0;
    state.stuckCounter = 0;
    state.lastFailureReason = null;
    return transition(STATES.EXECUTING, {
      cli: state.cliChain[state.cliIndex],
      escalated: true,
    });
  }

  function getCurrent() {
    return {
      current: state.current,
      iterations: state.iterations,
      maxIterations: state.maxIterations,
      stuckCounter: state.stuckCounter,
      lastFailureReason: state.lastFailureReason,
      cliIndex: state.cliIndex,
      cliChain: state.cliChain.slice(),
      mode: state.mode,
      sessionId: state.sessionId,
      history: state.history.slice(),
    };
  }

  function on(event, listener) {
    emitter.on(event, listener);
    return () => emitter.off(event, listener);
  }

  return {
    STATES,
    MODES,
    getCurrent,
    startIteration,
    reportVerifySuccess,
    reportVerifyFail,
    escalate,
    on,
  };
}

function persistTransition(stateFile, entry) {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(stateFile, `${JSON.stringify(entry)}\n`, "utf8");
}

export function resumeFromStateFile(stateFile) {
  if (!existsSync(stateFile)) return null;
  const raw = readFileSync(stateFile, "utf8").trim();
  if (!raw) return null;
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

export { DEFAULT_ESCALATION_CHAIN, STUCK_THRESHOLD };
