// hub/lib/jev-addon.mjs
// Opt-in Jev (System One) 판단 애드온.
// JEV_API_KEY / TYPESAFE_API_KEY 환경변수 또는 jev CLI(TFX_JEV=1)가 있을 때만 동작하고,
// 설정이 없거나 호출이 실패하면 항상 null을 반환해 기존 결정론적 로직을 그대로 유지한다.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { whichCommand } from "../platform.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 1500;
export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.7;

let cachedCliBin;

function isExplicitlyDisabled(env = process.env) {
  const flag = String(env.TFX_JEV ?? "")
    .trim()
    .toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

function isExplicitlyEnabled(env = process.env) {
  const flag = String(env.TFX_JEV ?? "")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

export function resolveJevApiKey(env = process.env) {
  const key = env.JEV_API_KEY || env.TYPESAFE_API_KEY || "";
  return String(key).trim() || null;
}

export function resolveJevCliBin(env = process.env) {
  if (env.TFX_JEV_CLI) {
    return String(env.TFX_JEV_CLI).trim() || null;
  }
  if (!isExplicitlyEnabled(env)) return null;
  if (cachedCliBin !== undefined) return cachedCliBin;
  cachedCliBin =
    whichCommand("jev") || whichCommand("jev-cli") || whichCommand("jevctl");
  return cachedCliBin || null;
}

export function resetJevAddonCache() {
  cachedCliBin = undefined;
}

function isDirectEnvObject(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (
    "env" in obj ||
    "client" in obj ||
    "apiUrl" in obj ||
    "timeoutMs" in obj ||
    "minConfidence" in obj ||
    "fetchImpl" in obj ||
    "execFileImpl" in obj
  ) {
    return false;
  }
  return (
    "TFX_JEV" in obj ||
    "JEV_API_KEY" in obj ||
    "TYPESAFE_API_KEY" in obj ||
    "TFX_JEV_CLI" in obj ||
    "PATH" in obj
  );
}

function resolveEnv(options = {}) {
  if (!options || typeof options !== "object") return process.env;
  if (isDirectEnvObject(options)) return options;
  return options.env || process.env;
}

export function isJevEnabled(options = {}) {
  const env = resolveEnv(options);
  if (isExplicitlyDisabled(env)) return false;
  if (
    options &&
    typeof options === "object" &&
    !isDirectEnvObject(options) &&
    typeof options.client === "function"
  ) {
    return true;
  }
  if (resolveJevApiKey(env)) return true;
  if (resolveJevCliBin(env)) return true;
  return false;
}

function clampText(text, maxChars = 1600) {
  const str = String(text ?? "").trim();
  if (str.length <= maxChars) return str;
  return str.slice(-maxChars);
}

function tailLines(text, maxLines = 35, maxChars = 1800) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-maxLines)
    .join("\n");
  return clampText(lines, maxChars);
}

function isValidUnitNumber(val) {
  return (
    typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 1
  );
}

function normalizeResponse(rawInput, kind) {
  if (!rawInput || typeof rawInput !== "object") return null;

  const raw =
    rawInput.answers && typeof rawInput.answers === "object"
      ? (rawInput.answers.q ?? Object.values(rawInput.answers)[0] ?? rawInput)
      : rawInput;
  if (!raw || typeof raw !== "object") return null;

  // 공식 TypeSafe System One noul 응답: { noul: 0.98 } (0~1 사이 확률값 자체가 판정과 신뢰도를 겸함)
  if (
    kind === "noul" &&
    isValidUnitNumber(raw.noul) &&
    raw.answer === undefined &&
    raw.value === undefined
  ) {
    const p = raw.noul;
    return {
      value: p >= 0.5,
      confidence: p >= 0.5 ? p : 1 - p,
    };
  }

  let rawConf = raw.confidence ?? raw.probability ?? raw.prob;
  if (
    rawConf === undefined &&
    kind === "choice" &&
    typeof raw.choice === "string" &&
    raw.probabilities &&
    typeof raw.probabilities === "object"
  ) {
    rawConf = raw.probabilities[raw.choice];
  }

  if (!isValidUnitNumber(rawConf)) {
    return null;
  }
  const safeConfidence = rawConf;

  if (kind === "noul") {
    const val = raw.answer ?? raw.value ?? raw.result ?? raw.output ?? raw.yes;
    if (typeof val === "boolean") {
      return { value: val, confidence: safeConfidence };
    }
    if (typeof val === "string") {
      const lowered = val.trim().toLowerCase();
      if (lowered === "yes" || lowered === "true") {
        return { value: true, confidence: safeConfidence };
      }
      if (lowered === "no" || lowered === "false") {
        return { value: false, confidence: safeConfidence };
      }
    }
    return null;
  }

  if (kind === "choice") {
    const choice =
      raw.choice ?? raw.answer ?? raw.value ?? raw.result ?? raw.output;
    if (typeof choice === "string" && choice.trim()) {
      return { choice: choice.trim(), confidence: safeConfidence };
    }
    return null;
  }

  if (kind === "score") {
    const score = Number(
      raw.score ?? raw.value ?? raw.answer ?? raw.result ?? raw.output,
    );
    if (Number.isFinite(score)) {
      return { score, confidence: safeConfidence };
    }
    return null;
  }

  return null;
}

function buildSystemOneQuestion(request) {
  if (request.kind === "choice") {
    const criteria =
      request.criteria && typeof request.criteria === "object"
        ? request.criteria
        : Object.fromEntries(
            (request.options || []).map((opt) => [String(opt), String(opt)]),
          );
    return {
      type: "choice",
      instructions: request.query,
      criteria,
    };
  }
  if (request.kind === "score") {
    return {
      type: "score",
      instructions: request.query,
      ...(request.criteria ? { criteria: request.criteria } : {}),
    };
  }
  return {
    type: "noul",
    instructions: request.query,
    ...(request.criteria ? { criteria: request.criteria } : {}),
  };
}

async function callJevHttp(request, options = {}) {
  const env = resolveEnv(options);
  const apiKey = resolveJevApiKey(env);
  if (!apiKey) return null;

  const url = options.apiUrl || env.JEV_API_URL || DEFAULT_JEV_API_URL;
  const model = options.model || env.JEV_MODEL || DEFAULT_JEV_MODEL;
  const timeoutMs = Number(
    options.timeoutMs ?? env.TFX_JEV_TIMEOUT_MS ?? DEFAULT_JEV_TIMEOUT_MS,
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const payload = {
    model,
    state: request.context
      ? `${request.context}\n\nQuestion: ${request.query}`
      : String(request.query || ""),
    questions: {
      q: buildSystemOneQuestion(request),
    },
  };

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : 1500),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return normalizeResponse(data, request.kind);
}

async function callJevCli(request, options = {}) {
  const env = resolveEnv(options);
  const cliBin = resolveJevCliBin(env);
  if (!cliBin) return null;

  const timeoutMs = Number(
    options.timeoutMs ?? env.TFX_JEV_TIMEOUT_MS ?? DEFAULT_JEV_TIMEOUT_MS,
  );
  const args = [request.kind, request.query, "--json"];
  if (request.context) {
    args.push("--context", request.context);
  }
  if (Array.isArray(request.options) && request.options.length > 0) {
    args.push("--options", request.options.join(","));
  }
  const execImpl = options.execFileImpl || execFileAsync;
  const { stdout } = await execImpl(cliBin, args, {
    timeout: timeoutMs > 0 ? timeoutMs : 1500,
    maxBuffer: 256 * 1024,
    env: env === process.env ? process.env : { ...process.env, ...env },
  });
  const parsed = JSON.parse(String(stdout ?? "").trim());
  return normalizeResponse(parsed, request.kind);
}

export async function queryJev(request, options = {}) {
  if (!isJevEnabled(options)) return null;
  try {
    if (typeof options.client === "function") {
      const custom = await options.client(request, options);
      return normalizeResponse(custom, request.kind);
    }
    const env = resolveEnv(options);
    if (resolveJevApiKey(env)) {
      return await callJevHttp(request, options);
    }
    if (resolveJevCliBin(env)) {
      return await callJevCli(request, options);
    }
    return null;
  } catch {
    return null;
  }
}

function minConfidence(options = {}) {
  const env = resolveEnv(options);
  const threshold = Number(
    options.minConfidence ??
      env.TFX_JEV_MIN_CONFIDENCE ??
      DEFAULT_JEV_CONFIDENCE_THRESHOLD,
  );
  return Number.isFinite(threshold)
    ? threshold
    : DEFAULT_JEV_CONFIDENCE_THRESHOLD;
}

/**
 * 1. 재시도 상태 머신: 두 실패 메시지가 동일한 근본 원인인지 판정한다.
 */
export async function judgeSameFailureCause(
  previousReason,
  currentReason,
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const prev = clampText(previousReason, 800);
  const curr = clampText(currentReason, 800);
  if (!prev || !curr) return null;
  if (prev === curr) return { sameCause: true, confidence: 1 };

  const res = await queryJev(
    {
      kind: "noul",
      query:
        "Are both failure messages caused by the exact same underlying blocker or root error (ignoring timestamps, PIDs, ports, or line number shifts)?",
      context: `Previous failure:\n${prev}\n\nCurrent failure:\n${curr}`,
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  return { sameCause: res.value, confidence: res.confidence };
}

/**
 * 2. 워커 인계 파일(handoff) 보정 및 가짜 성공(exit 0) 필터링.
 */
export async function judgeHandoffQuality(
  {
    rawText = "",
    handoff = {},
    exitCode = 0,
    gitDiffFiles = [],
    role = "",
  } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const tail = tailLines(rawText, 40, 2000);
  if (!tail && !handoff?.verdict) return null;

  const allowed = ["accept", "needs_read", "retry"];
  const filesCount = Array.isArray(gitDiffFiles)
    ? gitDiffFiles.filter(Boolean).length
    : 0;
  const res = await queryJev(
    {
      kind: "choice",
      options: allowed,
      criteria: {
        accept:
          "The assigned code implementation and verification were completed cleanly with no skipped checks.",
        needs_read:
          "The output is an analysis report, or tests/verification were skipped or left ambiguous so the lead must read the details.",
        retry:
          "The worker exited without completing the implementation or hit an unresolved error that requires a retry.",
      },
      query:
        "Classify the required lead action for this worker output: 'accept' if the assigned task was completed cleanly, 'needs_read' if it is an analysis/report or ambiguous partial result that the lead must read, or 'retry' if the worker exited without completing the task or hit an unresolved error.",
      context: [
        `exit_code: ${exitCode}`,
        `role: ${role || handoff?.task || "worker"}`,
        `files_changed_count: ${filesCount}`,
        `declared_status: ${handoff?.status || "unknown"}`,
        `declared_action: ${handoff?.lead_action || "unknown"}`,
        `declared_verdict: ${handoff?.verdict || "none"}`,
        `output_tail:\n${tail}`,
      ].join("\n"),
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  if (!allowed.includes(res.choice)) return null;
  return { leadAction: res.choice, confidence: res.confidence };
}

/**
 * 3. 피어(peer) 토론 및 교차 리뷰 조기 종료 판정.
 */
export async function judgePeerConvergence(
  {
    seed = "",
    mode = "debate",
    previousResponse = "",
    currentResponse = "",
    hopIndex = 0,
    participantsCount = 2,
  } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  if (mode === "counting") return null;
  if (hopIndex < Math.max(2, participantsCount)) return null;

  const prev = clampText(previousResponse, 1200);
  const curr = clampText(currentResponse, 1200);
  if (!prev || !curr) return null;

  const res = await queryJev(
    {
      kind: "noul",
      query:
        "Have the participants reached substantive agreement on the core task or entered a repetitive nitpick loop where further rounds will not add new conclusions?",
      context: [
        seed ? `Task:\n${clampText(seed, 500)}` : "",
        `Previous turn:\n${prev}`,
        `Current turn:\n${curr}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  return { converged: res.value, confidence: res.confidence };
}

/**
 * 4. 작업 중인 워커에 대한 --if-busy auto (steer vs wait) 판단.
 */
export async function judgeBusyAction(
  { prompt = "", threadSummary = "" } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const trimmed = clampText(prompt, 1000);
  if (!trimmed) return null;

  const allowed = ["steer", "wait"];
  const res = await queryJev(
    {
      kind: "choice",
      options: allowed,
      criteria: {
        steer:
          "Urgent course correction, constraint change, or abort instruction that must interrupt the active turn immediately.",
        wait: "Sequential follow-up task or next step that should wait in queue until the active turn finishes.",
      },
      query:
        "The worker is currently busy executing a turn. Choose 'steer' if this message corrects course, changes constraints, or aborts current work immediately; choose 'wait' if this message is a sequential follow-up task to run after the current turn finishes.",
      context: [
        threadSummary ? `Active thread:\n${clampText(threadSummary, 400)}` : "",
        `Incoming message:\n${trimmed}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  if (!allowed.includes(res.choice)) return null;
  return { action: res.choice, confidence: res.confidence };
}

/**
 * 5. 하트비트 모니터: 로그 꼬리 기반 의미상 먹통(프롬프트 대기, 에러 무한 루프) 판정.
 */
export async function judgeWorkerHealth(
  { stdoutTail = "", stderrTail = "", rolloutTail = "", elapsedSec = 0 } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const combined = [
    stdoutTail ? `stdout:\n${tailLines(stdoutTail, 20, 800)}` : "",
    stderrTail ? `stderr:\n${tailLines(stderrTail, 20, 800)}` : "",
    rolloutTail ? `rollout:\n${tailLines(rolloutTail, 20, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!combined) return null;

  const allowed = ["progressing", "waiting_input", "looping_error"];
  const res = await queryJev(
    {
      kind: "choice",
      options: allowed,
      criteria: {
        progressing:
          "Normal work, compilation, testing, or file editing is actively progressing.",
        waiting_input:
          "Blocked waiting for an interactive user input, y/n confirmation, or terminal prompt.",
        looping_error:
          "Stuck repeating the same fatal error or retry loop without progress.",
      },
      query:
        "Inspect the worker's recent logs. Choose 'progressing' if normal work is happening, 'waiting_input' if blocked on an interactive y/n or confirmation prompt, or 'looping_error' if repeating the same fatal error in a loop.",
      context: `elapsed_sec: ${elapsedSec}\n\n${combined}`,
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  if (!allowed.includes(res.choice)) return null;
  return { status: res.choice, confidence: res.confidence };
}
