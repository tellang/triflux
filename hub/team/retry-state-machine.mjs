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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

const ESCALATION_CHAIN_CONFIG_PATH = ".triflux/config/escalation-chain.json";

// Escalation chain (2026-05-27 정책):
//   1. codex gpt-5.6-sol max — 최난도 단일 작업용 Codex escalation 단계
//   2. claude opus-4-8 — 최종 수단
const DEFAULT_ESCALATION_CHAIN = Object.freeze([
  Object.freeze({
    cli: "codex",
    model: "gpt-5.6-sol",
    profile: "gpt56_sol_max",
  }),
  Object.freeze({ cli: "claude", model: "opus-4-8" }),
]);

const STUCK_THRESHOLD = 3;

export function createRetryStateMachine(options = {}) {
  const mode = options.mode || MODES.BOUNDED;
  const cliChain = resolveEscalationChain(options);
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

  function serialize() {
    return {
      version: 1,
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

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    state.current = snapshot.current || STATES.PLANNING;
    state.iterations = Number(snapshot.iterations) || 0;
    state.maxIterations =
      snapshot.maxIterations !== undefined
        ? Number(snapshot.maxIterations)
        : state.maxIterations;
    state.stuckCounter = Number(snapshot.stuckCounter) || 0;
    state.lastFailureReason = snapshot.lastFailureReason || null;
    state.cliIndex = Number(snapshot.cliIndex) || 0;
    if (Array.isArray(snapshot.cliChain) && snapshot.cliChain.length > 0) {
      state.cliChain = normalizeEscalationChain(
        snapshot.cliChain,
        "snapshot.cliChain",
      );
    }
    if (snapshot.mode) state.mode = snapshot.mode;
    if (snapshot.sessionId !== undefined) state.sessionId = snapshot.sessionId;
    if (Array.isArray(snapshot.history))
      state.history = snapshot.history.slice();
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
    serialize,
    applySnapshot,
  };
}

function resolveEscalationChain(options) {
  if (Array.isArray(options.cliChain)) {
    return normalizeEscalationChain(options.cliChain, "options.cliChain");
  }

  const projectRoot = options.projectRoot || process.cwd();
  return (
    loadEscalationChainOverride(projectRoot) ||
    normalizeEscalationChain(
      DEFAULT_ESCALATION_CHAIN,
      "DEFAULT_ESCALATION_CHAIN",
    )
  );
}

export function loadEscalationChainOverride(projectRoot = process.cwd()) {
  const configPath = join(projectRoot, ESCALATION_CHAIN_CONFIG_PATH);
  if (!existsSync(configPath)) return null;

  const raw = readFileSync(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `escalation-chain override 파싱 실패: ${configPath} — 원인: ${err.message} — 수정: JSON 문법 확인 또는 파일 삭제로 DEFAULT_ESCALATION_CHAIN 사용`,
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath}: expected object`);
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`${configPath}: unsupported version ${parsed.version}`);
  }
  return normalizeEscalationChain(parsed.chain, configPath);
}

function normalizeEscalationChain(chain, source) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new Error(`${source}: chain must be a non-empty array`);
  }
  return chain.map((entry, index) =>
    normalizeEscalationChainEntry(entry, index, source),
  );
}

function normalizeEscalationChainEntry(entry, index, source) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${source}: chain[${index}] must be an object`);
  }
  if (typeof entry.cli !== "string" || entry.cli.trim() === "") {
    throw new Error(
      `${source}: chain[${index}].cli must be a non-empty string`,
    );
  }
  if (typeof entry.model !== "string" || entry.model.trim() === "") {
    throw new Error(
      `${source}: chain[${index}].model must be a non-empty string`,
    );
  }

  const normalized = {
    cli: entry.cli,
    model: entry.model,
  };
  if (typeof entry.profile === "string" && entry.profile.trim() !== "") {
    const profile = entry.profile.trim();
    normalized.profile =
      entry.cli === "codex" &&
      (profile === "ultra" || profile === "gpt56_sol_ultra")
        ? "gpt56_sol_max"
        : profile;
  }
  return normalized;
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

// Full-snapshot 기반 stateFile I/O — bridge retry-run 에서 multi-process state 복원용.
// transition event log (resumeFromStateFile) 와 별도 파일로 관리하는 것을 권장.
export function loadSnapshot(snapshotFile) {
  if (!existsSync(snapshotFile)) return null;
  const raw = readFileSync(snapshotFile, "utf8").trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported snapshot version: ${parsed.version} (expected 1)`,
    );
  }
  return parsed;
}

export function saveSnapshot(snapshotFile, snapshot) {
  const dir = dirname(snapshotFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotFile, JSON.stringify(snapshot), "utf8");
}

export { DEFAULT_ESCALATION_CHAIN, STUCK_THRESHOLD };
