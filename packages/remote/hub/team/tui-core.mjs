// hub/team/tui-core.mjs — 대시보드 공통 유틸리티 (ISSUE-11)
// tui.mjs / tui-lite.mjs 간 중복 로직을 단일 모듈로 통합.

import { FG, MOCHA, wcswidth } from "./ansi.mjs";

// ── 상수 ──────────────────────────────────────────────────────────────────
export const FALLBACK_COLUMNS = 100;
export const FALLBACK_ROWS = 30;
export const VALID_TABS = Object.freeze(["log", "detail", "files"]);

// ── 버전 로드 ─────────────────────────────────────────────────────────────
let _cachedVersion = null;
export async function loadVersion(fallback = "7.x") {
  if (_cachedVersion) return _cachedVersion;
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    _cachedVersion = require("../../package.json").version;
  } catch {
    _cachedVersion = fallback;
  }
  return _cachedVersion;
}

// ── 수학 유틸 ─────────────────────────────────────────────────────────────
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ── 텍스트 정규화 ─────────────────────────────────────────────────────────
export function stripCodeBlocks(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/^\s*```.*$/gm, "")
    .replace(/^(?: {4}|\t).+$/gm, "")
    .replace(/^(?:PS\s+\S[^\n]*?>|>\s+|\$\s+)[^\n]*/gm, "")
    .trim();
}

export function sanitizeTextBlock(text, rawMode = false) {
  const normalized = rawMode
    ? String(text || "").replace(/\r/g, "")
    : stripCodeBlocks(text);
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "--- HANDOFF ---")
    .join("\n")
    .trim();
}

export function sanitizeOneLine(text, fallback = "") {
  return sanitizeTextBlock(text).replace(/\s+/g, " ").trim() || fallback;
}

export function sanitizeFiles(files) {
  if (!files) return [];
  const raw = Array.isArray(files) ? files : String(files).split(",");
  return raw.map((e) => sanitizeOneLine(e)).filter(Boolean);
}

export function sanitizeFindings(findings) {
  if (!findings) return [];
  const raw = Array.isArray(findings)
    ? findings
    : sanitizeTextBlock(findings).split("\n");
  return raw.map((e) => sanitizeOneLine(e)).filter(Boolean);
}

export function normalizeTokens(tokens) {
  if (tokens === null || tokens === undefined || tokens === "") return "";
  if (typeof tokens === "number" && Number.isFinite(tokens)) return tokens;
  const raw = sanitizeOneLine(tokens);
  if (!raw) return "";
  const match = raw.match(/(\d+(?:[.,]\d+)?\s*[kKmM]?)/);
  return match ? match[1].replace(/\s+/g, "").toLowerCase() : raw;
}

export function formatTokens(tokens) {
  if (tokens === null || tokens === undefined || tokens === "") return "n/a";
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return `${tokens}`;
  }
  return String(tokens);
}

// ── 워커 상태 ─────────────────────────────────────────────────────────────
export function runtimeStatus(worker) {
  return worker?.handoff?.status || worker?.status || "pending";
}

/**
 * 워커 상태 정규화 (tui.mjs / tui-lite.mjs 공통)
 * @param {object} existing - 기존 워커 상태
 * @param {object} state - 새 상태 패치
 * @param {object} [opts]
 * @param {boolean} [opts.trackChanges=false] - _prevStatus/_statusChangedAt 추적 (full TUI용)
 * @param {function} [opts.now=Date.now] - 시간 함수
 */
export function normalizeWorkerState(existing = {}, state = {}, opts = {}) {
  const { trackChanges = false, now = Date.now } = opts;

  const nextHandoff =
    state.handoff === undefined
      ? existing.handoff
      : {
          ...(existing.handoff || {}),
          ...(state.handoff || {}),
          verdict:
            state.handoff?.verdict !== undefined
              ? sanitizeOneLine(state.handoff.verdict)
              : existing.handoff?.verdict,
          confidence:
            state.handoff?.confidence !== undefined
              ? sanitizeOneLine(state.handoff.confidence)
              : existing.handoff?.confidence,
          status:
            state.handoff?.status !== undefined
              ? sanitizeOneLine(state.handoff.status)
              : existing.handoff?.status,
          files_changed:
            state.handoff?.files_changed !== undefined
              ? sanitizeFiles(state.handoff.files_changed)
              : existing.handoff?.files_changed,
        };

  const merged = {
    ...existing,
    ...state,
    cli:
      state.cli !== undefined
        ? sanitizeOneLine(state.cli, existing.cli || "codex")
        : existing.cli || "codex",
    role:
      state.role !== undefined ? sanitizeOneLine(state.role) : existing.role,
    status:
      state.status !== undefined
        ? sanitizeOneLine(state.status, existing.status || "pending")
        : existing.status || "pending",
    snapshot:
      state.snapshot !== undefined
        ? sanitizeTextBlock(state.snapshot)
        : existing.snapshot,
    summary:
      state.summary !== undefined
        ? sanitizeTextBlock(state.summary)
        : existing.summary,
    detail:
      state.detail !== undefined
        ? sanitizeTextBlock(state.detail)
        : existing.detail,
    findings:
      state.findings !== undefined
        ? sanitizeFindings(state.findings)
        : existing.findings,
    files_changed:
      state.files_changed !== undefined
        ? sanitizeFiles(state.files_changed)
        : existing.files_changed,
    confidence:
      state.confidence !== undefined
        ? sanitizeOneLine(state.confidence)
        : existing.confidence,
    tokens:
      state.tokens !== undefined
        ? normalizeTokens(state.tokens)
        : existing.tokens,
    progress:
      state.progress !== undefined
        ? clamp(Number(state.progress) || 0, 0, 1)
        : existing.progress,
    handoff: nextHandoff,
  };

  if (trackChanges) {
    const statusChanged =
      state.status !== undefined &&
      sanitizeOneLine(state.status) !== existing.status;
    merged._prevStatus = statusChanged ? existing.status : existing._prevStatus;
    merged._statusChangedAt = statusChanged
      ? now()
      : existing._statusChangedAt || 0;
  }

  return merged;
}

// ── 색상 헬퍼 ─────────────────────────────────────────────────────────────
export function cliColor(cli) {
  if (cli === "gemini") return FG.gemini;
  if (cli === "claude") return FG.claude;
  if (cli === "codex") return FG.codex;
  return FG.white;
}

export function statusColor(status) {
  if (status === "ok" || status === "completed") return MOCHA.ok;
  if (status === "partial") return MOCHA.partial;
  if (status === "failed") return MOCHA.fail;
  if (status === "running" || status === "in_progress") return MOCHA.executing;
  return FG.muted;
}

export function countStatuses(names, workers) {
  let ok = 0,
    partial = 0,
    failed = 0,
    running = 0;
  for (const name of names) {
    const st = workers.get(name);
    const s = runtimeStatus(st);
    if (s === "ok" || s === "completed") ok++;
    else if (s === "partial") partial++;
    else if (s === "failed") failed++;
    else if (s === "running" || s === "in_progress") running++;
  }
  return { ok, partial, failed, running };
}

// ── 뷰포트 해상도 ────────────────────────────────────────────────────────
export function resolveViewportColumns(opts = {}) {
  const { columns, stream } = opts;
  const v = Number.isFinite(columns)
    ? columns
    : Number.isFinite(stream?.columns)
      ? stream.columns
      : Number.isFinite(process.stdout?.columns)
        ? process.stdout.columns
        : FALLBACK_COLUMNS;
  return Math.max(48, v || FALLBACK_COLUMNS);
}

export function resolveViewportRows(opts = {}) {
  const { rows, stream } = opts;
  const v = Number.isFinite(rows)
    ? rows
    : Number.isFinite(stream?.rows)
      ? stream.rows
      : Number.isFinite(process.stdout?.rows)
        ? process.stdout.rows
        : FALLBACK_ROWS;
  return Math.max(10, v || FALLBACK_ROWS);
}

// ── 텍스트 래핑 ───────────────────────────────────────────────────────────
export function wrapLine(text, width) {
  const limit = Math.max(8, width);
  const source = String(text || "").trim();
  if (!source) return [""];
  const words = source.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (wcswidth(candidate) <= limit) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (wcswidth(word) <= limit) {
      current = word;
      continue;
    }
    let offset = 0;
    while (offset < word.length) {
      lines.push(word.slice(offset, offset + limit));
      offset += limit;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [source.slice(0, limit)];
}

export function wrapText(text, width, rawMode = false) {
  const input = sanitizeTextBlock(text, rawMode);
  if (!input) return [];
  return input
    .split("\n")
    .flatMap((line) => wrapLine(line, width))
    .filter(Boolean);
}
