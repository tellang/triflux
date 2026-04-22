import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CONTEXT_MONITOR_CACHE_PATH,
  CONTEXT_MONITOR_LEGACY_PATH,
  CONTEXT_MONITOR_LOG_DIR,
} from "./constants.mjs";
import { clampPercent, formatTokenCount, readJsonMigrate } from "./utils.mjs";

const DEFAULT_CONTEXT_LIMIT = 200_000;
const MILLION_CONTEXT_LIMIT = 1_000_000;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_TOP_KEYS = 20;

// stdin 이 context_window_size 를 제공하지 않을 때 모델 ID 로 한도를 추정한다.
// Anthropic 공식 문서(2026-04 기준): Opus 4.7 / Opus 4.6 / Sonnet 4.6 = 1M,
// Sonnet 4.5 / Haiku 4.5 = 200K. 그 외 모델은 [1m] suffix 로 opt-in 가능.
const MODEL_HINT_1M_PREFIXES = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
];

function normalizeModelId(modelId) {
  if (!modelId) return "";
  return String(modelId).toLowerCase();
}

function resolveModelLimit(modelId) {
  const id = normalizeModelId(modelId);
  if (!id) return DEFAULT_CONTEXT_LIMIT;
  if (id.includes("[1m]")) return MILLION_CONTEXT_LIMIT;
  for (const prefix of MODEL_HINT_1M_PREFIXES) {
    if (id.startsWith(prefix)) return MILLION_CONTEXT_LIMIT;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

export function shouldSuppressInfoOnlyContextStatus(modelId) {
  const id = normalizeModelId(modelId);
  if (!id) return false;
  return id.startsWith("claude-opus-4-7") || id.includes("[1m]");
}

const WARNING_LEVELS = Object.freeze({
  ok: { min: 0, message: "" },
  info: { min: 60, message: "컨텍스트 절반 이상 사용" },
  warn: { min: 80, message: "압축 권장" },
  critical: { min: 90, message: "에이전트 분할 또는 세션 교체 권장" },
});

// Unlike clampPercent (rounds), this preserves decimals for precise threshold comparison.
function clampThresholdPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function safeWriteJson(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // noop
  }
}

function normalizeText(input) {
  if (typeof input === "string") return input;
  if (input == null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function safeJsonParse(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toTokenEstimate(bytesOrText) {
  if (typeof bytesOrText === "number" && Number.isFinite(bytesOrText)) {
    if (bytesOrText <= 0) return 0;
    return Math.max(1, Math.ceil(bytesOrText / 4));
  }
  const text = normalizeText(bytesOrText);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= 0) return 0;
  return Math.max(1, Math.ceil(bytes / 4));
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
  const cacheCreation = Number(
    usage.cache_creation_input_tokens ??
      usage.cacheCreationInputTokens ??
      usage.cache_creation_tokens ??
      0,
  );
  const cacheRead = Number(
    usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cache_read_tokens ??
      0,
  );
  const totalCandidate = Number(
    usage.total_tokens ?? usage.totalTokens ?? Number.NaN,
  );
  const total =
    Number.isFinite(totalCandidate) && totalCandidate > 0
      ? totalCandidate
      : input + output + cacheCreation + cacheRead;
  if (!Number.isFinite(total) || total <= 0) return null;
  return {
    input: Math.max(0, Math.round(input)),
    output: Math.max(0, Math.round(output)),
    cacheCreation: Math.max(0, Math.round(cacheCreation)),
    cacheRead: Math.max(0, Math.round(cacheRead)),
    total: Math.max(0, Math.round(total)),
  };
}

function extractUsage(payload) {
  if (!payload || typeof payload !== "object") return null;

  const queue = [payload];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const directUsage = normalizeUsage(current.usage);
    if (directUsage) return directUsage;

    if (Array.isArray(current.content)) {
      for (const item of current.content) queue.push(item);
    }

    for (const key of ["result", "payload", "response", "message", "data"]) {
      if (current[key] && typeof current[key] === "object") {
        queue.push(current[key]);
      }
    }
  }
  return null;
}

function bumpCounter(target, key, tokens) {
  if (!key) return;
  const prev = target[key] || 0;
  target[key] = prev + tokens;
}

function pushTopKeys(inputMap, maxKeys = MAX_TOP_KEYS) {
  const entries = Object.entries(inputMap || {});
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, maxKeys));
}

function extractFileKeys(args) {
  if (!args || typeof args !== "object") return [];
  const out = [];
  const add = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    out.push(value.trim());
  };
  add(args.path);
  add(args.file);
  add(args.filename);
  add(args.relative_path);
  add(args.requestFilePath);
  add(args.responseFilePath);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) add(p);
  }
  return Array.from(new Set(out)).slice(0, 5);
}

function detectSkillHints(payloadText) {
  if (!payloadText) return [];
  const matches = payloadText.match(/\$[a-z0-9_-]+/gi) || [];
  return Array.from(new Set(matches.map((m) => m.replace(/^\$/, "")))).slice(
    0,
    5,
  );
}

export function estimateTokens(input) {
  return toTokenEstimate(input);
}

export function parseUsageFromPayload(payload) {
  return extractUsage(payload);
}

export function classifyContextThreshold(percent) {
  const p = clampThresholdPercent(percent);
  if (p >= WARNING_LEVELS.critical.min)
    return { level: "critical", message: WARNING_LEVELS.critical.message };
  if (p >= WARNING_LEVELS.warn.min)
    return { level: "warn", message: WARNING_LEVELS.warn.message };
  if (p >= WARNING_LEVELS.info.min)
    return { level: "info", message: WARNING_LEVELS.info.message };
  return { level: "ok", message: "" };
}

export function formatContextUsage(usedTokens, limitTokens, percent = null) {
  const used = Math.max(0, Math.round(Number(usedTokens) || 0));
  const limit = Math.max(
    1,
    Math.round(Number(limitTokens) || DEFAULT_CONTEXT_LIMIT),
  );
  const pct =
    percent == null
      ? clampPercent((used / limit) * 100)
      : clampPercent(percent);
  return `${formatTokenCount(used)}/${formatTokenCount(limit)} (${pct}%)`;
}

export function readContextMonitorSnapshot() {
  return readJsonMigrate(
    CONTEXT_MONITOR_CACHE_PATH,
    CONTEXT_MONITOR_LEGACY_PATH,
    null,
  );
}

function getStdinContextUsage(stdin) {
  const limitTokens = Number(stdin?.context_window?.context_window_size || 0);
  const nativePercent = Number(stdin?.context_window?.used_percentage);
  const usage = stdin?.context_window?.current_usage || {};
  const explicitUsed = Number(usage.total_tokens || 0);
  const calculatedUsed =
    Number(usage.input_tokens || 0) +
    Number(usage.cache_creation_input_tokens || 0) +
    Number(usage.cache_read_input_tokens || 0);
  const usedTokens = explicitUsed > 0 ? explicitUsed : calculatedUsed;

  if (limitTokens > 0 && usedTokens > 0) {
    return {
      usedTokens: Math.round(usedTokens),
      limitTokens: Math.round(limitTokens),
      percent: clampPercent((usedTokens / limitTokens) * 100),
      source: "stdin.tokens",
    };
  }

  if (limitTokens > 0 && Number.isFinite(nativePercent)) {
    const percent = clampPercent(nativePercent);
    return {
      usedTokens: Math.round((limitTokens * percent) / 100),
      limitTokens: Math.round(limitTokens),
      percent,
      source: "stdin.percent",
    };
  }
  return null;
}

export function deriveContextLimit(stdin) {
  const explicit = Number(stdin?.context_window?.context_window_size || 0);
  const modelHint = resolveModelLimit(stdin?.model?.id ?? stdin?.model);
  return Math.max(explicit, modelHint);
}

export function buildContextUsageView(stdin, snapshot = null) {
  const stdinUsage = getStdinContextUsage(stdin);
  const monitor = snapshot || readContextMonitorSnapshot();
  const modelId = stdin?.model?.id ?? stdin?.model;
  const modelHintLimit = resolveModelLimit(modelId);
  const monitorLimit = Number(monitor?.limitTokens || 0);
  const stdinLimit = stdinUsage?.limitTokens;
  const limitTokens =
    stdinLimit != null && stdinLimit > 0
      ? Math.max(1, stdinLimit)
      : modelId
        ? Math.max(1, monitorLimit, modelHintLimit)
        : Math.max(1, monitorLimit || modelHintLimit);

  const usedTokens = stdinUsage?.usedTokens ?? Number(monitor?.usedTokens || 0);
  const percent =
    limitTokens > 0 ? clampPercent((usedTokens / limitTokens) * 100) : 0;

  const warning = classifyContextThreshold(percent);
  const showInfoOnlyStatus = !(
    warning.level === "info" && shouldSuppressInfoOnlyContextStatus(modelId)
  );
  return {
    usedTokens,
    limitTokens,
    percent,
    display: formatContextUsage(usedTokens, limitTokens, percent),
    warningLevel: warning.level,
    warningMessage: showInfoOnlyStatus ? warning.message : "",
    warningTag: !showInfoOnlyStatus
      ? ""
      : warning.level === "warn"
        ? "⚠ 압축 권장"
        : warning.level === "critical"
          ? "‼ 분할 권장"
          : warning.level === "info"
            ? "ℹ 절반 이상 사용"
            : "",
    source: stdinUsage?.source || (monitor ? "monitor" : "none"),
  };
}

export function createContextMonitor(options = {}) {
  const limitTokens = Number(options.limitTokens || DEFAULT_CONTEXT_LIMIT);
  const cachePath = options.cachePath || CONTEXT_MONITOR_CACHE_PATH;
  const logsDir = options.logsDir || CONTEXT_MONITOR_LOG_DIR;
  const sessionId = options.sessionId || randomUUID().slice(0, 8);
  const registerExitHooks = options.registerExitHooks !== false;

  const state = {
    sessionId,
    startedAt: new Date().toISOString(),
    updatedAt: null,
    limitTokens,
    usedTokens: 0,
    requestTokens: 0,
    responseTokens: 0,
    exactUsageTokens: 0,
    totalUpdates: 0,
    maxPercent: 0,
    warningLevel: "ok",
    warningMessage: "",
    bySkill: {},
    byFile: {},
    byTool: {},
  };

  const writeSnapshot = () => {
    const percent = clampPercent((state.usedTokens / state.limitTokens) * 100);
    const warning = classifyContextThreshold(percent);
    state.maxPercent = Math.max(state.maxPercent, percent);
    state.warningLevel = warning.level;
    state.warningMessage = warning.message;
    state.updatedAt = new Date().toISOString();
    safeWriteJson(cachePath, {
      ...state,
      display: formatContextUsage(state.usedTokens, state.limitTokens, percent),
      percent,
      bySkill: pushTopKeys(state.bySkill),
      byFile: pushTopKeys(state.byFile),
      byTool: pushTopKeys(state.byTool),
    });
    return { percent, warning };
  };

  const writeReport = (reason = "shutdown") => {
    const percent = clampPercent((state.usedTokens / state.limitTokens) * 100);
    const warning = classifyContextThreshold(percent);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = join(
      logsDir,
      `context-usage-${state.sessionId}-${ts}.json`,
    );
    safeWriteJson(reportPath, {
      sessionId: state.sessionId,
      reason,
      startedAt: state.startedAt,
      endedAt: new Date().toISOString(),
      summary: {
        usedTokens: state.usedTokens,
        limitTokens: state.limitTokens,
        percent,
        warningLevel: warning.level,
        warningMessage: warning.message,
        requestTokens: state.requestTokens,
        responseTokens: state.responseTokens,
        exactUsageTokens: state.exactUsageTokens,
        updates: state.totalUpdates,
      },
      breakdown: {
        skills: pushTopKeys(state.bySkill),
        files: pushTopKeys(state.byFile),
        tools: pushTopKeys(state.byTool),
      },
    });
    return reportPath;
  };

  const record = ({
    requestBody = null,
    requestBytes = 0,
    responseBody = null,
    responseBytes = 0,
    toolName = "",
  } = {}) => {
    const started = process.hrtime.bigint();
    const reqObj =
      typeof requestBody === "object"
        ? requestBody
        : safeJsonParse(String(requestBody || ""));
    const resObj =
      typeof responseBody === "object"
        ? responseBody
        : safeJsonParse(String(responseBody || ""));

    const usage = parseUsageFromPayload(resObj);
    const requestTokens =
      requestBytes > 0
        ? toTokenEstimate(requestBytes)
        : toTokenEstimate(requestBody);
    const responseTokens =
      usage?.total ??
      (responseBytes > 0
        ? toTokenEstimate(responseBytes)
        : toTokenEstimate(responseBody));
    const totalTokens = Math.max(0, requestTokens + responseTokens);

    const method = reqObj?.method || reqObj?.params?.name || "";
    const name = toolName || reqObj?.params?.name || reqObj?.tool || "";
    const args =
      reqObj?.params?.arguments || reqObj?.arguments || reqObj?.params || {};
    const payloadText = normalizeText(requestBody).slice(0, MAX_CAPTURE_BYTES);
    const skills = detectSkillHints(payloadText);
    const files = extractFileKeys(args);

    if (name) bumpCounter(state.byTool, String(name), totalTokens);
    if (method?.includes("tool")) {
      bumpCounter(state.byTool, String(method), totalTokens);
    }
    for (const file of files) bumpCounter(state.byFile, file, totalTokens);
    for (const skill of skills) bumpCounter(state.bySkill, skill, totalTokens);

    state.requestTokens += requestTokens;
    state.responseTokens += responseTokens;
    state.exactUsageTokens += usage?.total || 0;
    state.usedTokens += totalTokens;
    state.totalUpdates += 1;

    const { percent, warning } = writeSnapshot();
    const overheadMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    return {
      requestTokens,
      responseTokens,
      totalTokens,
      usedTokens: state.usedTokens,
      limitTokens: state.limitTokens,
      percent,
      warningLevel: warning.level,
      warningMessage: warning.message,
      display: formatContextUsage(state.usedTokens, state.limitTokens, percent),
      overheadMs: Math.round(overheadMs * 1000) / 1000,
    };
  };

  let reportWritten = false;
  const flush = (reason = "shutdown") => {
    if (reportWritten) return null;
    reportWritten = true;
    return writeReport(reason);
  };

  if (registerExitHooks) {
    const flushOnExit = () => {
      try {
        flush("process.exit");
      } catch {}
    };
    process.once("exit", flushOnExit);
    process.once("SIGINT", flushOnExit);
    process.once("SIGTERM", flushOnExit);
  }

  return {
    record,
    flush,
    snapshot: () => ({
      ...state,
      bySkill: pushTopKeys(state.bySkill),
      byFile: pushTopKeys(state.byFile),
      byTool: pushTopKeys(state.byTool),
    }),
  };
}
