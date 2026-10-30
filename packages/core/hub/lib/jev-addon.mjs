// hub/lib/jev-addon.mjs
// Opt-in Jev (System One) 판단 애드온.
// JEV_API_KEY / TYPESAFE_API_KEY 환경변수 또는 jev CLI(TFX_JEV=1)가 있을 때만 동작하고,
// 설정이 없거나 호출이 실패하면 항상 null을 반환해 기존 결정론적 로직을 그대로 유지한다.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { whichCommand } from "../platform.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_JEV_MODEL = "jev-latest";
export const DEFAULT_JEV_TIMEOUT_MS = 1500;
export const DEFAULT_JEV_CONFIDENCE_THRESHOLD = 0.7;
export const DEFAULT_JEV_STATS_PATH = join(
  homedir(),
  ".triflux",
  "logs",
  "jev-stats.jsonl",
);

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
    "execFileImpl" in obj ||
    "statsFile" in obj ||
    "includeScore" in obj
  ) {
    return false;
  }
  return (
    "TFX_JEV" in obj ||
    "JEV_API_KEY" in obj ||
    "TYPESAFE_API_KEY" in obj ||
    "TFX_JEV_CLI" in obj ||
    "TFX_JEV_STATS_FILE" in obj ||
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
    (typeof options.client === "function" ||
      typeof options.batchClient === "function")
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

export async function queryJevBatch(input = {}, options = {}) {
  if (!isJevEnabled(options)) return null;
  if (Array.isArray(input)) {
    const questions = {};
    const contexts = [];
    input.forEach((item, idx) => {
      const key = `q_${idx}`;
      questions[key] = item;
      if (item.context) contexts.push(item.context);
    });
    const objRes = await queryJevBatch(
      { state: contexts[0] || "", questions },
      options,
    );
    if (!objRes) return null;
    return input.map((_, idx) => objRes[`q_${idx}`] || null);
  }

  const { state = "", questions = {} } = input;
  const entries = Object.entries(questions || {});
  if (entries.length === 0) return null;

  try {
    const clientFn = options.batchClient || options.client;
    if (typeof clientFn === "function") {
      const custom = await clientFn({ state, questions }, options);
      const answers = custom?.answers || custom || {};
      const out = {};
      for (const [key, req] of entries) {
        out[key] = normalizeResponse(answers[key], req.kind);
      }
      return out;
    }

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

    const payloadQuestions = {};
    for (const [key, req] of entries) {
      payloadQuestions[key] = buildSystemOneQuestion(req);
    }

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        state: String(state || ""),
        questions: payloadQuestions,
      }),
      signal: AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : 1500),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const answers = data?.answers || {};
    const out = {};
    for (const [key, req] of entries) {
      out[key] = normalizeResponse(answers[key], req.kind);
    }
    return out;
  } catch {
    return null;
  }
}

export function recordJevStat(entry = {}, options = {}) {
  try {
    const env = resolveEnv(options);
    const flag = String(env.TFX_JEV_STATS ?? "")
      .trim()
      .toLowerCase();
    if (flag === "0" || flag === "false" || flag === "off") return;

    const explicitFile = options.statsFile || env.TFX_JEV_STATS_FILE || "";
    if (!explicitFile && typeof options.client === "function") return;

    const filePath = explicitFile || DEFAULT_JEV_STATS_PATH;
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(
      filePath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
      })}\n`,
      "utf8",
    );
  } catch {
    // 통계 기록 실패는 무시한다.
  }
}

export function summarizeJevStats(options = {}) {
  const env = resolveEnv(options);
  const filePath =
    options.statsFile || env.TFX_JEV_STATS_FILE || DEFAULT_JEV_STATS_PATH;
  const summary = {
    path: filePath,
    exists: false,
    total: 0,
    interventions: 0,
    fallbacks: 0,
    avgMs: 0,
    byHook: {},
  };
  if (!existsSync(filePath)) return summary;

  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    summary.exists = true;
    let totalMs = 0;
    let msCount = 0;
    for (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      summary.total += 1;
      const hook = String(row.hook || "unknown");
      if (!summary.byHook[hook]) {
        summary.byHook[hook] = { total: 0, interventions: 0, fallbacks: 0 };
      }
      summary.byHook[hook].total += 1;
      if (row.intervened) {
        summary.interventions += 1;
        summary.byHook[hook].interventions += 1;
      } else {
        summary.fallbacks += 1;
        summary.byHook[hook].fallbacks += 1;
      }
      if (
        typeof row.durationMs === "number" &&
        Number.isFinite(row.durationMs)
      ) {
        totalMs += row.durationMs;
        msCount += 1;
      }
    }
    summary.avgMs = msCount > 0 ? Math.round(totalMs / msCount) : 0;
  } catch {
    // 읽기 실패 시 빈 요약 반환
  }
  return summary;
}

export async function queryJev(request, options = {}) {
  if (!isJevEnabled(options)) return null;
  const startedAt = Date.now();
  try {
    let result = null;
    if (typeof options.client === "function") {
      const custom = await options.client(request, options);
      result = normalizeResponse(custom, request.kind);
    } else {
      const env = resolveEnv(options);
      if (resolveJevApiKey(env)) {
        result = await callJevHttp(request, options);
      } else if (resolveJevCliBin(env)) {
        result = await callJevCli(request, options);
      }
    }
    if (request.hook) {
      const threshold = minConfidence(options);
      const intervened = Boolean(result && result.confidence >= threshold);
      recordJevStat(
        {
          hook: request.hook,
          kind: request.kind,
          intervened,
          confidence: result?.confidence ?? null,
          outcome:
            result?.choice ??
            (typeof result?.value === "boolean" ? result.value : null) ??
            result?.score ??
            null,
          durationMs: Date.now() - startedAt,
        },
        options,
      );
    }
    return result;
  } catch {
    if (request.hook) {
      recordJevStat(
        {
          hook: request.hook,
          kind: request.kind,
          intervened: false,
          confidence: null,
          outcome: null,
          durationMs: Date.now() - startedAt,
        },
        options,
      );
    }
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
      hook: "same_failure_cause",
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
      hook: "handoff_quality",
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
      hook: "peer_convergence",
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
  {
    prompt = "",
    incomingMessage = "",
    threadSummary = "",
    currentOutput = "",
    allowDrop = false,
  } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const resolvedPrompt = prompt || incomingMessage;
  const resolvedSummary = threadSummary || currentOutput;
  const trimmed = clampText(resolvedPrompt, 1000);
  if (!trimmed) return null;

  const includeDrop =
    allowDrop === true || Boolean(incomingMessage || currentOutput);
  const allowed = includeDrop ? ["steer", "wait", "drop"] : ["steer", "wait"];
  const criteria = {
    steer:
      "Urgent course correction, constraint change, or abort instruction that must interrupt the active turn immediately.",
    wait: "Sequential follow-up task or next step that should wait in queue until the active turn finishes.",
    ...(includeDrop
      ? {
          drop: "Duplicate or redundant instruction already present in the active output that should be skipped.",
        }
      : {}),
  };
  const res = await queryJev(
    {
      hook: "busy_action",
      kind: "choice",
      options: allowed,
      criteria,
      query: includeDrop
        ? "The worker is currently busy executing a turn. Choose 'steer' if this message corrects course or aborts current work immediately, 'wait' if it is a sequential follow-up task, or 'drop' if it duplicates work already running."
        : "The worker is currently busy executing a turn. Choose 'steer' if this message corrects course, changes constraints, or aborts current work immediately; choose 'wait' if this message is a sequential follow-up task to run after the current turn finishes.",
      context: [
        resolvedSummary
          ? `Active thread:\n${clampText(resolvedSummary, 400)}`
          : "",
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
  {
    stdoutTail = "",
    stderrTail = "",
    rolloutTail = "",
    recentOutput = "",
    elapsedSec = 0,
  } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const resolvedStdoutTail = stdoutTail || recentOutput;
  const combined = [
    resolvedStdoutTail ? `stdout:\n${tailLines(resolvedStdoutTail, 20, 800)}` : "",
    stderrTail ? `stderr:\n${tailLines(stderrTail, 20, 800)}` : "",
    rolloutTail ? `rollout:\n${tailLines(rolloutTail, 20, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!combined) return null;

  const allowed = ["progressing", "waiting_input", "looping_error"];
  const res = await queryJev(
    {
      hook: "worker_health",
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
  return {
    status: res.choice,
    healthState: res.choice,
    confidence: res.confidence,
  };
}

/**
 * 실행 모드별 CLI 권한 플래그 매핑 헬퍼.
 * @param {"codex"|"antigravity"|"agy"|"claude"} cliType
 * @param {"read_only"|"workspace_auto"|"bypass"} executionMode
 */
export function executionFlagsForCli(
  cliType = "codex",
  executionMode = "bypass",
) {
  const normalizedCli = String(cliType || "codex")
    .trim()
    .toLowerCase();
  const mode = ["read_only", "workspace_auto", "bypass"].includes(executionMode)
    ? executionMode
    : "bypass";

  if (normalizedCli === "antigravity" || normalizedCli === "agy") {
    if (mode === "read_only" || mode === "workspace_auto") {
      return {
        cliType: "antigravity",
        executionMode: mode,
        args: ["--print", "--sandbox"],
        flagsString: "--print --sandbox",
      };
    }
    return {
      cliType: "antigravity",
      executionMode: "bypass",
      args: ["--print", "--dangerously-skip-permissions"],
      flagsString: "--print --dangerously-skip-permissions",
    };
  }

  if (normalizedCli === "claude") {
    if (mode === "read_only") {
      return {
        cliType: "claude",
        executionMode: "read_only",
        args: ["--permission-mode", "plan"],
        flagsString: "--permission-mode plan",
      };
    }
    if (mode === "workspace_auto") {
      return {
        cliType: "claude",
        executionMode: "workspace_auto",
        args: ["--permission-mode", "acceptEdits"],
        flagsString: "--permission-mode acceptEdits",
      };
    }
    return {
      cliType: "claude",
      executionMode: "bypass",
      args: [
        "--permission-mode",
        "bypassPermissions",
        "--allow-dangerously-skip-permissions",
      ],
      flagsString:
        "--permission-mode bypassPermissions --allow-dangerously-skip-permissions",
    };
  }

  if (mode === "read_only") {
    return {
      cliType: "codex",
      executionMode: "read_only",
      args: ["--sandbox", "read-only", "--skip-git-repo-check"],
      flagsString: "--sandbox read-only --skip-git-repo-check",
    };
  }
  if (mode === "workspace_auto") {
    return {
      cliType: "codex",
      executionMode: "workspace_auto",
      args: ["--sandbox", "workspace-write", "--skip-git-repo-check"],
      flagsString: "--sandbox workspace-write --skip-git-repo-check",
    };
  }
  return {
    cliType: "codex",
    executionMode: "bypass",
    args: ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
    flagsString:
      "--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
  };
}

const COMPLEXITY_ROUTE_MAP = Object.freeze({
  trivial: Object.freeze({
    codexProfile: "luna_low",
    agyProfile: "argon_low",
    claudeModel: "haiku",
    claudeEffort: "low",
    expectedDurationSec: 60,
  }),
  standard: Object.freeze({
    codexProfile: "sol_high",
    agyProfile: "argon",
    claudeModel: "sonnet",
    claudeEffort: "medium",
    expectedDurationSec: 300,
  }),
  deep: Object.freeze({
    codexProfile: "astra_xhigh",
    agyProfile: "argon_high",
    claudeModel: "opus",
    claudeEffort: "high",
    expectedDurationSec: 600,
  }),
  high_risk: Object.freeze({
    codexProfile: "astra_xhigh",
    agyProfile: "argon_high",
    claudeModel: "opus",
    claudeEffort: "high",
    expectedDurationSec: 900,
  }),
});

/**
 * 6. Pre-route 통합 판단: 프롬프트 복잡도(모델 및 effort), 실행 권한 모드(read_only / workspace_auto / bypass),
 * 필요한 MCP 프로필 및 서버 목록을 단일 queryJevBatch 호출로 판정한다.
 */
export async function judgeTaskRouting(
  {
    prompt = "",
    agentType = "executor",
    cliType = "codex",
    availableServers = [],
  } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const trimmedPrompt = clampText(prompt, 1400);
  if (!trimmedPrompt) return null;

  const complexityOptions = ["trivial", "standard", "deep", "high_risk"];
  const executionModes = ["read_only", "workspace_auto", "bypass"];
  const mcpProfiles = [
    "none",
    "executor",
    "implementer",
    "designer",
    "analyze",
    "explore",
    "reviewer",
    "writer",
    "default",
  ];
  const candidateServers = Array.isArray(availableServers)
    ? availableServers
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const contextBlock = [
    `agent_role: ${agentType || "executor"}`,
    `cli_type: ${cliType || "codex"}`,
    candidateServers.length > 0
      ? `available_mcp_servers: ${candidateServers.join(", ")}`
      : "",
    `task_prompt:\n${trimmedPrompt}`,
  ]
    .filter(Boolean)
    .join("\n");

  const questions = {
    complexity: {
      hook: "task_routing_complexity",
      kind: "choice",
      options: complexityOptions,
      criteria: {
        trivial:
          "Single-line lookup, formatting, typo fix, simple status check, or short question.",
        standard:
          "Routine feature implementation, unit test writing, bug fix, or single-module refactoring.",
        deep: "Multi-file architecture redesign, root-cause debugging across modules, or complex consensus synthesis.",
        high_risk:
          "Security-critical change, release/deployment automation, database migration, or destructive system operation.",
      },
      query:
        "Classify the complexity and reasoning depth required for this task.",
    },
    execution_mode: {
      hook: "task_routing_execution_mode",
      kind: "choice",
      options: executionModes,
      criteria: {
        read_only:
          "Only reading, searching, reviewing, or explaining code and docs without modifying files or running mutating commands.",
        workspace_auto:
          "Modifying files inside the repository and running local unit tests or build scripts without external network, git push, ssh, or system-wide state changes.",
        bypass:
          "Requires git push/gh CLI, ssh, external network requests, package installation, daemon/socket management, or writing outside the workspace.",
      },
      query:
        "Choose the minimum execution permission mode needed to complete this task safely.",
    },
    mcp_profile: {
      hook: "task_routing_mcp_profile",
      kind: "choice",
      options: mcpProfiles,
      criteria: {
        none: "Pure local code editing, local shell execution, or local unit test run that needs no external MCP servers.",
        executor:
          "Implementation task needing library docs lookup (context7) or browser verification.",
        analyze:
          "Deep analysis or research task needing web search, docs lookup, and structured reasoning.",
        explore:
          "Read-only codebase and documentation exploration needing fast docs/web lookup.",
        reviewer:
          "Code review task needing minimal reference documentation lookup.",
        designer: "UI/frontend design task needing browser/Playwright and docs.",
        writer: "Documentation writing task needing docs and reference search.",
        default: "General task with standard MCP tool access.",
      },
      query:
        "Choose the best MCP server profile for this task, or 'none' if external MCP tools are unnecessary.",
    },
  };

  for (const server of candidateServers) {
    const safeKey = `mcp_${server.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    questions[safeKey] = {
      hook: `task_routing_mcp_server_${server}`,
      kind: "noul",
      query: `Does this task specifically benefit from enabling the '${server}' MCP server?`,
    };
  }

  const results = await queryJevBatch(
    { state: contextBlock, questions },
    options,
  );
  if (!results || typeof results !== "object") return null;

  const threshold = minConfidence(options);
  const compRes = results.complexity;
  const modeRes = results.execution_mode;
  const mcpProfRes = results.mcp_profile;

  const complexity =
    compRes &&
    compRes.confidence >= threshold &&
    complexityOptions.includes(compRes.choice)
      ? compRes.choice
      : null;

  const executionMode =
    modeRes &&
    modeRes.confidence >= threshold &&
    executionModes.includes(modeRes.choice)
      ? modeRes.choice
      : null;

  const mcpProfile =
    mcpProfRes &&
    mcpProfRes.confidence >= threshold &&
    mcpProfiles.includes(mcpProfRes.choice)
      ? mcpProfRes.choice
      : null;

  const neededMcpServers = [];
  if (mcpProfile !== "none" && candidateServers.length > 0) {
    for (const server of candidateServers) {
      const safeKey = `mcp_${server.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      const srvRes = results[safeKey];
      if (srvRes && srvRes.confidence >= threshold && srvRes.value === true) {
        neededMcpServers.push(server);
      }
    }
  }

  if (
    !complexity &&
    !executionMode &&
    !mcpProfile &&
    neededMcpServers.length === 0
  ) {
    return null;
  }

  const routeSpec = complexity ? COMPLEXITY_ROUTE_MAP[complexity] || null : null;

  let codexProfile = routeSpec ? routeSpec.codexProfile : null;
  if (
    complexity === "standard" &&
    /deslop|cleanup|format|lint|rename|typo/i.test(trimmedPrompt)
  ) {
    codexProfile = "sol_med";
  }

  const execFlags = executionMode
    ? executionFlagsForCli(cliType, executionMode)
    : null;
  const confidences = [
    complexity ? compRes : null,
    executionMode ? modeRes : null,
    mcpProfile ? mcpProfRes : null,
  ]
    .filter((r) => r && Number.isFinite(r.confidence))
    .map((r) => r.confidence);
  const avgConfidence =
    confidences.length > 0
      ? Number(
          (
            confidences.reduce((sum, val) => sum + val, 0) / confidences.length
          ).toFixed(4),
        )
      : threshold;

  return {
    complexity,
    codexProfile,
    agyProfile: routeSpec ? routeSpec.agyProfile : null,
    claudeModel: routeSpec ? routeSpec.claudeModel : null,
    claudeEffort: routeSpec ? routeSpec.claudeEffort : null,
    expectedDurationSec: routeSpec ? routeSpec.expectedDurationSec : null,
    executionMode,
    executionFlags: execFlags ? execFlags.flagsString : null,
    executionArgs: execFlags ? execFlags.args : null,
    mcpProfile,
    neededMcpServers,
    confidence: avgConfidence,
  };
}

/**
 * 7. MCP 프로필 및 서버 동적 선별 (mcp-filter 연동용).
 */
export async function judgeMcpSelection(
  { taskText = "", agentType = "default", availableServers = [] } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const trimmedTask = clampText(taskText, 1200);
  if (!trimmedTask) return null;

  const routing = await judgeTaskRouting(
    {
      prompt: trimmedTask,
      agentType,
      cliType: "codex",
      availableServers,
    },
    options,
  );
  if (!routing) return null;

  return {
    mcpProfile: routing.mcpProfile,
    neededMcpServers: routing.neededMcpServers,
    neededServers: routing.neededMcpServers,
    confidence: routing.confidence,
  };
}

/**
 * 8. 다중 세션 중 프롬프트에 맞는 대상 세션 자동 선택 (--thread auto 모호성 해소).
 */
export async function judgeTargetSession(
  { prompt = "", candidates = [] } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const trimmedPrompt = clampText(prompt, 1000);
  if (!trimmedPrompt) return null;
  if (!Array.isArray(candidates) || candidates.length < 2) return null;

  const normalized = candidates
    .map((c, idx) => {
      if (typeof c === "string") {
        return { id: c, summary: `Session ${idx + 1}: ${c}` };
      }
      const id = String(c?.id || c?.threadId || c?.name || "").trim();
      if (!id) return null;
      const summary = [
        c.name ? `name=${c.name}` : "",
        c.cwd ? `cwd=${c.cwd}` : "",
        c.preview ? `preview=${clampText(c.preview, 220)}` : "",
        c.status ? `status=${c.status}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return { id, summary: summary || id };
    })
    .filter(Boolean);

  if (normalized.length < 2) return null;

  const allowedIds = normalized.map((c) => c.id);
  const candidateKeys = normalized.map((_, idx) => `candidate_${idx}`);
  const criteria = Object.fromEntries(
    normalized.map((c, idx) => [`candidate_${idx}`, `${c.id}: ${c.summary}`]),
  );

  const res = await queryJev(
    {
      hook: "target_session",
      kind: "choice",
      options: [...allowedIds, ...candidateKeys],
      criteria,
      query:
        "Multiple active worker sessions exist. Select the session ID whose working directory, topic, or recent preview best matches the incoming prompt.",
      context: [
        "Candidates:",
        ...normalized.map((c, idx) => `- candidate_${idx} (${c.id}): ${c.summary}`),
        "",
        `Prompt:\n${trimmedPrompt}`,
      ].join("\n"),
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  let selectedIdx = allowedIds.indexOf(res.choice);
  if (selectedIdx === -1) {
    selectedIdx = candidateKeys.indexOf(res.choice);
  }
  if (selectedIdx === -1) return null;
  return {
    sessionId: normalized[selectedIdx].id,
    selectedIndex: selectedIdx,
    selected: candidates[selectedIdx],
    confidence: res.confidence,
  };
}

/**
 * 9. 서브태스크별 최적 워커 CLI 및 역할 배정 (orchestrator 연동용).
 */
export async function judgeTaskAssignment(
  { subtasks = [], workers = ["codex", "claude", "antigravity"] } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  if (!Array.isArray(subtasks) || subtasks.length === 0) return null;
  if (!Array.isArray(workers) || workers.length === 0) return null;

  const normalizedWorkers = workers.map((w, idx) => {
    if (typeof w === "string") {
      return {
        index: idx,
        key: `worker_${idx}`,
        cli: w.trim() || "codex",
        label: w.trim() || `worker_${idx}`,
      };
    }
    const cli = String(w?.cli || w?.role || "codex").trim();
    return {
      index: idx,
      key: `worker_${idx}`,
      cli,
      label: w?.target ? `${cli} (${w.target})` : cli,
    };
  });

  const workerKeys = normalizedWorkers.map((w) => w.key);
  const cliNames = normalizedWorkers.map((w) => w.cli);
  const allowedChoices = [...new Set([...workerKeys, ...cliNames])];

  const defaultCriteria = {
    codex:
      "Backend implementation, refactoring, unit tests, CLI scripts, and multi-file code changes.",
    claude:
      "Deep architectural design, nuanced Korean documentation, complex reasoning, and interactive review.",
    antigravity:
      "Fast codebase exploration, frontend/UI prototyping, and lightweight verification.",
  };
  const criteria = Object.fromEntries(
    normalizedWorkers.map((w) => [
      w.key,
      `${w.label}: ${defaultCriteria[w.cli] || `Worker CLI option: ${w.cli}`}`,
    ]),
  );

  const questions = {};
  const stateParts = [];
  subtasks.forEach((task, idx) => {
    const text =
      typeof task === "string"
        ? task
        : String(task?.description || task?.title || task?.prompt || "");
    const clamped = clampText(text, 800);
    stateParts.push(`Subtask #${idx}: ${clamped}`);
    questions[`subtask_${idx}_worker`] = {
      hook: "task_assignment",
      kind: "choice",
      options: allowedChoices,
      criteria,
      query: `Select the best worker for subtask #${idx}.`,
    };
  });

  const results = await queryJevBatch(
    { state: stateParts.join("\n"), questions },
    options,
  );
  if (!results || typeof results !== "object") return null;

  const threshold = minConfidence(options);
  const assignments = subtasks.map((_, subtaskIdx) => {
    const res =
      results[`subtask_${subtaskIdx}_worker`] || results[`q_${subtaskIdx}`];
    let matchedWorkerIdx = subtaskIdx % normalizedWorkers.length;
    let valid = false;
    if (res && res.confidence >= threshold && res.choice) {
      const byKey = workerKeys.indexOf(res.choice);
      const byCli = cliNames.indexOf(res.choice);
      if (byKey !== -1) {
        matchedWorkerIdx = byKey;
        valid = true;
      } else if (byCli !== -1) {
        matchedWorkerIdx = byCli;
        valid = true;
      }
    }
    const targetWorker = normalizedWorkers[matchedWorkerIdx];
    const cliRes = results[`subtask_${subtaskIdx}_cli`];
    const recommendedCli =
      cliRes && cliRes.confidence >= threshold && cliRes.choice
        ? cliRes.choice
        : targetWorker.cli;
    return {
      index: subtaskIdx,
      subtaskIndex: subtaskIdx,
      workerIndex: matchedWorkerIdx,
      worker: targetWorker.cli,
      recommendedCli,
      confidence: res?.confidence ?? 0,
      fromJev: valid,
    };
  });

  if (!assignments.some((a) => a.fromJev)) return null;
  return {
    assignments,
    confidence: assignments[0]?.confidence ?? threshold,
  };
}

/**
 * 10. TUI 패인 프롬프트 제출 상태 판정 (pane.mjs 연동용).
 */
export async function judgeComposerState(
  { capturedText = "", promptPrefix = "" } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const tail = tailLines(capturedText, 25, 1200);
  if (!tail) return null;

  const allowed = ["submitted_running", "stuck_in_composer", "modal_blocking"];
  const res = await queryJev(
    {
      hook: "composer_state",
      kind: "choice",
      options: allowed,
      criteria: {
        submitted_running:
          "The prompt has been submitted and the agent is now thinking, running tools, or streaming output.",
        stuck_in_composer:
          "The prompt text is still sitting unsubmitted inside the input composer box waiting for Enter.",
        modal_blocking:
          "A modal dialog, trust prompt, or confirmation popup is blocking input submission.",
      },
      query:
        "Inspect the terminal pane capture after sending a prompt. Determine whether the prompt was submitted and is running, is still stuck unsubmitted in the input composer, or is blocked by a modal dialog.",
      context: [
        promptPrefix
          ? `Expected prompt prefix: ${clampText(promptPrefix, 200)}`
          : "",
        `Terminal pane tail:\n${tail}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  if (!allowed.includes(res.choice)) return null;
  return { state: res.choice, confidence: res.confidence };
}

/**
 * 11. 워커 개입/지시 주입 후 실제 반영 여부(Closed-loop Ack) 판정.
 */
export async function judgeInstructionAck(
  { instruction = "", recentOutput = "" } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const inst = clampText(instruction, 600);
  const out = tailLines(recentOutput, 30, 1400);
  if (!inst || !out) return null;

  const contextText = `Injected instruction:\n${inst}\n\nRecent worker output:\n${out}`;
  if (typeof options.batchClient === "function") {
    const batchRes = await queryJevBatch(
      {
        state: contextText,
        questions: {
          ack: {
            hook: "instruction_ack",
            kind: "noul",
            query:
              "Did the worker acknowledge, adopt, or act upon the injected instruction in its recent output?",
          },
          status: {
            hook: "instruction_ack_status",
            kind: "choice",
            options: [
              "acknowledged_executing",
              "acknowledged",
              "ignored",
              "blocked",
            ],
            query: "Classify the worker's response to the instruction.",
          },
        },
      },
      options,
    );
    if (!batchRes || !batchRes.ack) return null;
    if (batchRes.ack.confidence < minConfidence(options)) return null;
    return {
      acknowledged: Boolean(batchRes.ack.value),
      ackStatus:
        batchRes.status?.choice ||
        (batchRes.ack.value ? "acknowledged" : "ignored"),
      confidence: batchRes.ack.confidence,
    };
  }

  const res = await queryJev(
    {
      hook: "instruction_ack",
      kind: "noul",
      query:
        "Did the worker acknowledge, adopt, or act upon the injected instruction in its recent output?",
      context: contextText,
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  return {
    acknowledged: res.value,
    ackStatus: res.value ? "acknowledged" : "ignored",
    confidence: res.confidence,
  };
}

/**
 * 12. 팀 인박스 메시지 긴급도 분류 (nativeProxy / bridge team-send-message 연동용).
 */
export async function judgeInboxPriority(
  { text = "", summary = "", from = "" } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const body = clampText(text || summary, 1000);
  if (!body) return null;

  const allowed = [
    "urgent_blocker",
    "needs_decision",
    "progress_fyi",
    "done",
  ];
  const res = await queryJev(
    {
      hook: "inbox_priority",
      kind: "choice",
      options: allowed,
      includeScore: true,
      criteria: {
        urgent_blocker:
          "Worker is completely blocked by a fatal error, missing permission, or broken environment and needs immediate lead intervention.",
        needs_decision:
          "Worker encountered an architectural or product ambiguity and needs a decision from the lead.",
        progress_fyi:
          "Routine progress update or intermediate status report that requires no immediate action.",
        done: "Worker completed its assigned task and is reporting final deliverables.",
      },
      query:
        "Classify the urgency of this worker-to-lead inbox message so the lead can prioritize responses.",
      context: [
        from ? `from: ${from}` : "",
        summary ? `summary: ${clampText(summary, 200)}` : "",
        `message:\n${body}`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    options,
  );
  if (!res || res.confidence < minConfidence(options)) return null;
  if (!allowed.includes(res.choice)) return null;
  const priorityWeight = {
    urgent_blocker: 100,
    needs_decision: 75,
    done: 40,
    progress_fyi: 10,
  };
  return {
    priority: res.choice,
    urgencyScore:
      res.score ?? priorityWeight[res.choice] ?? Math.round(res.confidence * 100),
    confidence: res.confidence,
  };
}

/**
 * 13. 교차 리뷰 게이트 판정 (skip_review | cross_review | escalate_to_lead + 리뷰 루프 수렴 여부).
 */
export async function judgeReviewGate(
  {
    diffStat = "",
    handoffSummary = "",
    previousReviews = "",
    currentReview = "",
  } = {},
  options = {},
) {
  if (!isJevEnabled(options)) return null;
  const summary = clampText(handoffSummary || diffStat, 1200);
  if (!summary && !currentReview) return null;

  const allowedGates = ["skip_review", "cross_review", "escalate_to_lead"];
  const stateText = [
    diffStat ? `diff_stat:\n${clampText(diffStat, 600)}` : "",
    summary ? `handoff_summary:\n${summary}` : "",
    previousReviews
      ? `previous_reviews:\n${clampText(previousReviews, 800)}`
      : "",
    currentReview ? `current_review:\n${clampText(currentReview, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const questions = {
    gate: {
      hook: "review_gate",
      kind: "choice",
      options: allowedGates,
      criteria: {
        skip_review:
          "Trivial formatting, comment, or small isolated test change with passing tests that needs no separate cross-review.",
        cross_review:
          "Standard logic, feature, or refactoring change that benefits from automated peer cross-review.",
        escalate_to_lead:
          "High-risk architectural, security, or breaking API change that requires direct lead review.",
      },
      query:
        "Choose the appropriate review gate for this worker handoff and diff.",
    },
  };

  const hasReviewPair = Boolean(
    String(previousReviews || "").trim() && String(currentReview || "").trim(),
  );
  if (hasReviewPair) {
    questions.converged = {
      hook: "review_loop_converged",
      kind: "noul",
      query:
        "Has the review loop converged (either approved with no remaining blockers or repeating minor stylistic nitpicks)?",
    };
  }

  const results = await queryJevBatch({ state: stateText, questions }, options);
  if (!results || !results.gate) return null;

  const threshold = minConfidence(options);
  const gateRes = results.gate;
  if (gateRes.confidence < threshold || !allowedGates.includes(gateRes.choice)) {
    return null;
  }

  const loopRes = hasReviewPair ? results.converged : null;
  const converged =
    loopRes && loopRes.confidence >= threshold ? Boolean(loopRes.value) : false;

  return {
    gate: gateRes.choice,
    reviewGate: gateRes.choice,
    converged,
    confidence: gateRes.confidence,
  };
}
