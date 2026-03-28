// hub/team/tui.mjs — Alternate-screen diff renderer (v11)
// virtual row buffer 기반. dirty-row만 갱신. isTTY 아닐 때 append-only fallback.
// Tier1(상단 고정) / Tier2(worker rail) / Tier3(focus pane) 3단 계층.

import {
  RESET,
  FG,
  BG,
  MOCHA,
  color,
  dim,
  bold,
  box,
  padRight,
  truncate,
  clip,
  stripAnsi,
  wcswidth,
  progressBar,
  statusBadge,
  STATUS_ICON,
  altScreenOn,
  altScreenOff,
  clearScreen,
  cursorHome,
  cursorHide,
  cursorShow,
  moveTo,
  clearLine,
  clearToEnd,
} from "./ansi.mjs";

// package.json에서 동적 로드 (실패 시 fallback)
let VERSION = "7.x";
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  VERSION = require("../../package.json").version;
} catch { /* fallback */ }

const FALLBACK_COLUMNS = 100;
const FALLBACK_ROWS = 30;
const MIN_CARD_WIDTH = 28;

// ✻ heartbeat — Claude Code 리버스 엔지니어링 기반 breathing animation
// 프레임: ["·","✢","✳","✶","✻","✽"] + 역재생 = 12프레임 왕복
// 타이밍: 2000ms/cycle, RGB truecolor 보간
const SPINNER_FRAMES_RAW = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...SPINNER_FRAMES_RAW, ...[...SPINNER_FRAMES_RAW].reverse()];
const SPINNER_CYCLE_MS = 2000;
const SPINNER_BASE_COLOR = { r: 203, g: 166, b: 247 }; // Catppuccin Mocha mauve
const SPINNER_SHIMMER = { r: 171, g: 43, b: 63 };      // Claude shimmer #ab2b3f
let spinnerStart = Date.now();
let spinnerTick = 0;

function lerpRgb(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function heartbeat(status, shimmerIntensity = 0) {
  if (status === "done" || status === "completed") return color("✓", MOCHA.ok);
  if (status === "failed" || status === "error") return color("✗", MOCHA.fail);
  if (status !== "running") return dim("○");
  const elapsed = Date.now() - spinnerStart;
  const idx = Math.floor((elapsed / SPINNER_CYCLE_MS) * SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
  const c = shimmerIntensity > 0
    ? lerpRgb(SPINNER_BASE_COLOR, SPINNER_SHIMMER, shimmerIntensity)
    : SPINNER_BASE_COLOR;
  return `\x1b[38;2;${c.r};${c.g};${c.b}m${SPINNER_FRAMES[idx]}${RESET}`;
}
const GRID_GAP = 2;
const DEFAULT_DETAIL_LINES = 10;
// Tier1 상단 고정 행 수
const TIER1_ROWS = 2;

const SUMMARY_KEYS = [
  "status", "lead_action", "verdict", "files_changed",
  "confidence", "risk", "detail", "error_stage", "retryable", "partial_output",
];

// ── 레이아웃 브레이크포인트 ──────────────────────────────────────────────
// 80-119: 28col rail, 120-159: 36col rail, 160+: 균등
function resolveRailWidth(totalCols, columnCount) {
  if (columnCount <= 1) return totalCols;
  if (totalCols >= 160) return Math.floor((totalCols - GRID_GAP * (columnCount - 1)) / columnCount);
  if (totalCols >= 120) return Math.min(36, Math.floor((totalCols - GRID_GAP * (columnCount - 1)) / columnCount));
  return Math.min(28, Math.floor((totalCols - GRID_GAP * (columnCount - 1)) / columnCount));
}

function autoColumnCount(totalCols, workerCount) {
  if (workerCount <= 1) return 1;
  if (totalCols >= 160) return Math.min(workerCount, 3);
  if (totalCols >= 120) return Math.min(workerCount, 2);
  return 1;
}

// ── 문자열 유틸 ──────────────────────────────────────────────────────────
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stripCodeBlocks(text) {
  return String(text || "")
    .replace(/\r/g, "")
    // fenced code blocks
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/^\s*```.*$/gm, "")
    // indented code blocks (4+ spaces or tab at line start)
    .replace(/^(?:    |\t).+$/gm, "")
    // shell prompts: PS C:\...>, >, $
    .replace(/^(?:PS\s+\S[^\n]*?>|>\s+|\$\s+)[^\n]*/gm, "")
    .trim();
}

function sanitizeTextBlock(text, rawMode = false) {
  const normalized = rawMode ? String(text || "").replace(/\r/g, "") : stripCodeBlocks(text);
  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "--- HANDOFF ---")
    .join("\n")
    .trim();
}

function sanitizeOneLine(text, fallback = "") {
  const normalized = sanitizeTextBlock(text).replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function sanitizeFiles(files) {
  if (!files) return [];
  const raw = Array.isArray(files) ? files : String(files).split(",");
  return raw.map((e) => sanitizeOneLine(e)).filter(Boolean);
}

function sanitizeFindings(findings) {
  if (!findings) return [];
  const raw = Array.isArray(findings)
    ? findings
    : sanitizeTextBlock(findings).split("\n");
  return raw.map((e) => sanitizeOneLine(e)).filter(Boolean);
}

function normalizeTokens(tokens) {
  if (tokens === null || tokens === undefined) return "";
  if (typeof tokens === "number" && Number.isFinite(tokens)) return tokens;
  const raw = sanitizeOneLine(tokens);
  if (!raw) return "";
  const match = raw.match(/(\d+(?:[.,]\d+)?\s*[kKmM]?)/);
  return match ? match[1].replace(/\s+/g, "").toLowerCase() : raw;
}

function formatTokens(tokens) {
  if (tokens === null || tokens === undefined || tokens === "") return "n/a";
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
    return `${tokens}`;
  }
  return String(tokens);
}

// ── 색상 헬퍼 ─────────────────────────────────────────────────────────────
function cliColor(cli) {
  if (cli === "gemini") return FG.gemini;
  if (cli === "claude") return FG.claude;
  if (cli === "codex") return FG.codex;
  return FG.white;
}

function runtimeStatus(st) {
  return st?.handoff?.status || st?.status || "pending";
}

function statusColor(status) {
  if (status === "ok" || status === "completed") return MOCHA.ok;
  if (status === "partial") return MOCHA.partial;
  if (status === "failed") return MOCHA.fail;
  if (status === "running" || status === "in_progress") return MOCHA.executing;
  return FG.muted;
}

// ── MOCHA RGB (gradual fade 보간용) ──
const MOCHA_RGB = {
  ok:        { r: 166, g: 227, b: 161 },
  partial:   { r: 250, g: 179, b: 135 },
  fail:      { r: 243, g: 139, b: 168 },
  executing: { r: 116, g: 199, b: 236 },
  muted:     { r: 147, g: 153, b: 178 },
  border:    { r: 69,  g: 71,  b: 90  },
};

function statusToRgb(status) {
  if (status === "ok" || status === "completed") return MOCHA_RGB.ok;
  if (status === "partial") return MOCHA_RGB.partial;
  if (status === "failed") return MOCHA_RGB.fail;
  if (status === "running" || status === "in_progress") return MOCHA_RGB.executing;
  return MOCHA_RGB.muted;
}

const FADE_DURATION_MS = 1500;

function fadeBorderColor(currentStatus, prevStatus, changedAt) {
  const elapsed = Date.now() - (changedAt || 0);
  if (elapsed >= FADE_DURATION_MS || !prevStatus) return MOCHA.border;
  const t = Math.min(1, elapsed / FADE_DURATION_MS);
  const from = statusToRgb(currentStatus);
  const to = MOCHA_RGB.border;
  const c = lerpRgb(from, to, t);
  return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
}

// ── 텍스트 래핑 ──────────────────────────────────────────────────────────
function wrapLine(text, width) {
  const limit = Math.max(8, width);
  const source = String(text || "").trim();
  if (!source) return [""];
  const words = source.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (wcswidth(candidate) <= limit) { current = candidate; continue; }
    if (current) { lines.push(current); current = ""; }
    if (wcswidth(word) <= limit) { current = word; continue; }
    let offset = 0;
    while (offset < word.length) {
      lines.push(word.slice(offset, offset + limit));
      offset += limit;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [source.slice(0, limit)];
}

function wrapText(text, width, maxLines = DEFAULT_DETAIL_LINES, rawMode = false) {
  if (maxLines <= 0) return [];
  const input = sanitizeTextBlock(text, rawMode);
  if (!input) return [];
  const wrapped = input.split("\n").flatMap((line) => wrapLine(line, width)).filter(Boolean);
  if (wrapped.length <= maxLines) return wrapped;
  return [...wrapped.slice(0, maxLines - 1), truncate(wrapped[wrapped.length - 1], width)];
}

// 스크롤 없이 전체 줄 반환 (focus pane용)
function wrapTextAll(text, width, rawMode = false) {
  const input = sanitizeTextBlock(text, rawMode);
  if (!input) return [];
  return input.split("\n").flatMap((line) => wrapLine(line, width)).filter(Boolean);
}

// ── virtual row buffer ────────────────────────────────────────────────────
class RowBuffer {
  constructor() {
    this._rows = [];
    this._prev = [];
  }

  set(rows) {
    this._rows = rows.map(String);
  }

  /** 변경된 row 인덱스 목록 반환 */
  diff() {
    const dirty = [];
    const len = Math.max(this._rows.length, this._prev.length);
    for (let i = 0; i < len; i++) {
      if (this._rows[i] !== this._prev[i]) dirty.push(i);
    }
    return dirty;
  }

  commit() {
    this._prev = [...this._rows];
  }

  get rows() { return this._rows; }
  get prevLen() { return this._prev.length; }
}

// ── 상태 집계 ─────────────────────────────────────────────────────────────
function countStatuses(names, workers) {
  let ok = 0, partial = 0, failed = 0, running = 0;
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

// ── Tier1: 상단 고정 2행 ─────────────────────────────────────────────────
function buildTier1(names, workers, pipeline, elapsed, width, version) {
  const { ok, partial, failed, running } = countStatuses(names, workers);
  const row1 = truncate(
    `${color("▲ triflux", FG.triflux)} v${version} ${dim("│")} phase ${color(pipeline.phase || "exec", FG.accent)} ${dim("│")} elapsed ${elapsed}s ${dim("│")} workers ${names.length}`,
    width,
  );
  const row2 = truncate(
    `${color(`✓ ${ok}`, MOCHA.ok)}  ${color(`◑ ${partial}`, MOCHA.partial)}  ${color(`✗ ${failed}`, MOCHA.fail)}  ${dim(`▶ ${running} running`)}  ${dim("Tab/j/k:nav • f:follow • r:raw • 1-9:jump")}`,
    width,
  );
  return [row1, row2];
}

// ── 카드 렌더러 (Tier2 worker rail) ─────────────────────────────────────
function detailText(st) {
  if (st.detail) return st.detail;
  const lines = [];
  for (const key of SUMMARY_KEYS) {
    const value = st.handoff?.[key];
    if (Array.isArray(value) && value.length > 0) lines.push(`${key}: ${value.join(", ")}`);
    else if (value) lines.push(`${key}: ${value}`);
  }
  if (st.snapshot) lines.unshift(st.snapshot);
  return lines.join("\n");
}

function detailHighlights(st) {
  if (Array.isArray(st.findings) && st.findings.length > 0) return st.findings;
  const verdict = sanitizeOneLine(st.handoff?.verdict);
  return sanitizeTextBlock(detailText(st))
    .split("\n")
    .map((line) => line.replace(/^verdict\s*:\s*/i, "").trim())
    .filter(Boolean)
    .filter((line) => line !== verdict)
    .filter((line) => !SUMMARY_KEYS.some((key) => line.toLowerCase().startsWith(`${key}:`)))
    .slice(0, 2);
}

function buildWorkerRail(name, st, opts = {}) {
  const {
    width,
    selected = false,
    focused = false,  // rail 포커스 여부
    rawMode = false,
    compact = false,
  } = opts;
  const innerWidth = Math.max(12, width - 4);
  const cli = st.cli || "codex";
  const role = sanitizeOneLine(st.role);
  const status = runtimeStatus(st);
  const sec = Number.isFinite(st._logSec) ? st._logSec : 0;

  // Tier2 행 1: 이름 + CLI + role
  const selMark = selected ? (focused ? color("▶", FG.accent) : color(">", FG.triflux)) : " ";
  const hb = heartbeat(status);
  const title = truncate(
    `${selMark} ${hb} ${color(name, FG.triflux)} ${dim("•")} ${color(cli, cliColor(cli))}${role ? ` ${dim(`(${role})`)}` : ""}`,
    innerWidth,
  );

  const borderColor = focused
    ? MOCHA.thinking
    : fadeBorderColor(status, st._prevStatus, st._statusChangedAt);

  if (compact) {
    // compact 2-line 카드
    const progress = Number.isFinite(st.progress) ? clamp(st.progress, 0, 1) : (status === "running" ? 0.3 : 1);
    const percent = Math.round(progress * 100);
    const compactLine1 = truncate(
      `${selMark} ${hb} ${color(name, FG.triflux)} ${dim("•")} ${color(cli, cliColor(cli))} ${statusBadge(status)} ${String(percent).padStart(3)}%`,
      innerWidth,
    );
    const verdict = sanitizeOneLine(st.handoff?.verdict || st.summary || st.snapshot, status);
    const compactLine2 = truncate(verdict, innerWidth);
    const framed = box([compactLine1, compactLine2], Math.max(MIN_CARD_WIDTH, width), borderColor);
    return [framed.top, ...framed.body, framed.bot];
  }

  // Tier2 행 2: 상태 배지 + elapsed + tokens + conf
  const confidence = sanitizeOneLine(st.handoff?.confidence || st.confidence, "n/a");
  const statusLine = truncate(
    `${statusBadge(status)} ${dim("•")} ${sec}s ${dim("•")} tok ${formatTokens(st.tokens)} ${dim("•")} conf ${confidence}`,
    innerWidth,
  );

  // Tier2 행 3: progress bar
  const progress = Number.isFinite(st.progress) ? clamp(st.progress, 0, 1) : (status === "running" ? 0.3 : 1);
  const percent = Math.round(progress * 100);
  const barWidth = clamp(Math.floor(innerWidth * 0.3), 8, 16);
  const progressLine = truncate(
    `${progressBar(percent, barWidth)} ${String(percent).padStart(3)}%`,
    innerWidth,
  );

  // Tier2 행 4-6: verdict / findings / files
  const verdict = sanitizeOneLine(st.handoff?.verdict || st.summary || st.snapshot, status);
  const findings = detailHighlights(st).join(" / ") || "no notable findings yet";
  const files = sanitizeFiles(st.handoff?.files_changed || st.files_changed).join(", ") || "none";

  const verdictClr = statusColor(status);
  const lines = [
    title,
    statusLine,
    progressLine,
    truncate(`${dim("verdict")} ${color(verdict, verdictClr)}`, innerWidth),
    truncate(`${dim("findings")} ${color(findings, MOCHA.partial)}`, innerWidth),
    truncate(`${dim("files")} ${color(files, FG.muted)}`, innerWidth),
  ];

  const framed = box(lines, Math.max(MIN_CARD_WIDTH, width), borderColor);
  return [framed.top, ...framed.body, framed.bot];
}

// ── Tier3: focus pane (우측 detail) ─────────────────────────────────────
function buildFocusPane(name, st, opts = {}) {
  const {
    width,
    height = 20,
    scrollOffset = 0,
    followTail = false,
    rawMode = false,
    focused = false,
  } = opts;
  const innerWidth = Math.max(12, width - 4);

  // verdict sticky 4행
  const verdict = sanitizeOneLine(st.handoff?.verdict || st.summary || st.snapshot, "—");
  const confidence = sanitizeOneLine(st.handoff?.confidence || st.confidence, "n/a");
  const files = sanitizeFiles(st.handoff?.files_changed || st.files_changed);
  const status = runtimeStatus(st);

  // Tab bar: 현재는 Log 활성 (향후 Tab 키로 전환 예정)
  const tabLog = color("[Log]", FG.accent);
  const tabDetail = dim("[Detail]");
  const tabFiles = dim(`[Files ${files.length}]`);
  const tabBar = truncate(`${tabLog} ${tabDetail} ${tabFiles}`, innerWidth);

  const stickyLines = [
    truncate(`${color(name, FG.triflux)} ${dim("•")} ${statusBadge(status)}`, innerWidth),
    tabBar,
    truncate(`${dim("verdict")}  ${color(verdict, statusColor(status))}`, innerWidth),
    truncate(`${dim("conf")}     ${confidence}`, innerWidth),
    dim("─").repeat(Math.max(4, innerWidth)),
  ];

  // 본문 스크롤 영역
  const bodyAvail = Math.max(0, height - stickyLines.length - 2); // top+bot border
  const allBodyLines = wrapTextAll(detailText(st), innerWidth, rawMode);

  let startIdx;
  if (followTail) {
    startIdx = Math.max(0, allBodyLines.length - bodyAvail);
  } else {
    startIdx = clamp(scrollOffset, 0, Math.max(0, allBodyLines.length - bodyAvail));
  }

  const bodySlice = allBodyLines.slice(startIdx, startIdx + bodyAvail);
  if (bodySlice.length === 0) bodySlice.push(dim("no detail available"));

  // scroll indicator
  const scrollInfo = allBodyLines.length > bodyAvail
    ? dim(`${startIdx + 1}-${Math.min(startIdx + bodyAvail, allBodyLines.length)}/${allBodyLines.length}`)
    : dim(`${allBodyLines.length} lines`);

  const contentLines = [
    ...stickyLines,
    ...bodySlice.map((l) => truncate(l, innerWidth)),
    truncate(scrollInfo, innerWidth),
  ];

  const borderColor = focused ? MOCHA.thinking : MOCHA.border;
  const framed = box(contentLines, Math.max(MIN_CARD_WIDTH, width), borderColor);
  return [framed.top, ...framed.body, framed.bot];
}

// ── summary bar (≥4 workers) ──────────────────────────────────────────────
function buildSummaryBar(names, workers, selectedWorker, pipeline, width, version) {
  const maxChipWidth = clamp(Math.floor((width - 6) / Math.min(names.length, 4)), 16, 26);
  const chips = names.map((name, idx) => {
    const st = workers.get(name);
    const status = runtimeStatus(st);
    const progress = Number.isFinite(st.progress) ? clamp(st.progress, 0, 1) : (status === "running" ? 0.3 : 1);
    const label = `${selectedWorker === name ? ">" : " "} ${idx + 1}.${name} ${status} ${Math.round(progress * 100)}%`;
    return padRight(truncate(label, maxChipWidth), maxChipWidth);
  });
  const chipsLine = truncate(chips.join(dim(" │ ")), width - 4);
  const keysLine = truncate(dim("Tab:focus • j/k:scroll • f:follow • r:raw • 1-9:jump"), width - 4);
  const framed = box([chipsLine, keysLine], width);
  return [framed.top, ...framed.body, framed.bot];
}

// ── joinColumns ───────────────────────────────────────────────────────────
function joinColumns(blocks, gap = GRID_GAP) {
  const maxHeight = Math.max(...blocks.map((b) => b.length));
  return Array.from({ length: maxHeight }, (_, rowIdx) =>
    blocks
      .map((block) => block[rowIdx] || " ".repeat(wcswidth(stripAnsi(block[0] || ""))))
      .join(" ".repeat(gap)),
  );
}

// ── normalizeWorkerState ──────────────────────────────────────────────────
function normalizeWorkerState(existing, state) {
  const nextHandoff = state.handoff === undefined
    ? existing.handoff
    : {
        ...(existing.handoff || {}),
        ...(state.handoff || {}),
        verdict: state.handoff?.verdict !== undefined
          ? sanitizeOneLine(state.handoff.verdict)
          : existing.handoff?.verdict,
        files_changed: state.handoff?.files_changed !== undefined
          ? sanitizeFiles(state.handoff.files_changed)
          : existing.handoff?.files_changed,
        confidence: state.handoff?.confidence !== undefined
          ? sanitizeOneLine(state.handoff.confidence)
          : existing.handoff?.confidence,
        status: state.handoff?.status !== undefined
          ? sanitizeOneLine(state.handoff.status)
          : existing.handoff?.status,
      };

  return {
    ...existing,
    ...state,
    cli: state.cli !== undefined ? sanitizeOneLine(state.cli, existing.cli || "codex") : (existing.cli || "codex"),
    role: state.role !== undefined ? sanitizeOneLine(state.role) : existing.role,
    status: state.status !== undefined ? sanitizeOneLine(state.status, existing.status || "pending") : (existing.status || "pending"),
    snapshot: state.snapshot !== undefined ? sanitizeTextBlock(state.snapshot) : existing.snapshot,
    summary: state.summary !== undefined ? sanitizeTextBlock(state.summary) : existing.summary,
    detail: state.detail !== undefined ? sanitizeTextBlock(state.detail) : existing.detail,
    findings: state.findings !== undefined ? sanitizeFindings(state.findings) : existing.findings,
    files_changed: state.files_changed !== undefined ? sanitizeFiles(state.files_changed) : existing.files_changed,
    confidence: state.confidence !== undefined ? sanitizeOneLine(state.confidence) : existing.confidence,
    tokens: state.tokens !== undefined ? normalizeTokens(state.tokens) : existing.tokens,
    progress: state.progress !== undefined ? clamp(Number(state.progress) || 0, 0, 1) : existing.progress,
    handoff: nextHandoff,
    _prevStatus: (state.status !== undefined && sanitizeOneLine(state.status) !== existing.status)
      ? existing.status : existing._prevStatus,
    _statusChangedAt: (state.status !== undefined && sanitizeOneLine(state.status) !== existing.status)
      ? Date.now() : (existing._statusChangedAt || 0),
  };
}

// ── createLogDashboard ────────────────────────────────────────────────────
/**
 * alternate-screen diff renderer (Tier1/2/3)
 * @param {object} [opts]
 * @param {NodeJS.WriteStream} [opts.stream=process.stdout]
 * @param {NodeJS.ReadStream} [opts.input=process.stdin]
 * @param {number} [opts.refreshMs=1000]
 * @param {number} [opts.columns] — 터미널 폭 override (테스트/뷰어용)
 * @param {string} [opts.layout] — "single"|"split-2col"|"split-3col"|"summary+detail"|"auto"
 * @returns {LogDashboardHandle}
 */
export function createLogDashboard(opts = {}) {
  const {
    stream = process.stdout,
    input = process.stdin,
    refreshMs = 1000,
    columns,
    layout: layoutHint = "auto",
    forceTTY = false,
  } = opts;

  const isTTY = forceTTY || !!stream?.isTTY;

  const workers = new Map();
  let pipeline = { phase: "exec", fix_attempt: 0 };
  let startedAt = Date.now();
  let timer = null;
  let closed = false;
  let frameCount = 0;
  let selectedWorker = null;
  // focus: "rail" | "detail"
  let focus = "rail";
  let detailScrollOffset = 0;
  let followTail = false;
  let rawMode = false;
  let inputAttached = false;
  let rawModeEnabled = false;

  // virtual row buffer (altScreen 전용)
  const rowBuf = new RowBuffer();

  // ── TTY 출력 헬퍼 ────────────────────────────────────────────────────
  function write(text) {
    if (!closed) stream.write(text);
  }

  function writeln(text) {
    if (!closed) stream.write(`${text}\n`);
  }

  function nowElapsedSec() {
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  }

  function getViewportColumns() {
    const v = Number.isFinite(columns)
      ? columns
      : (Number.isFinite(stream?.columns)
          ? stream.columns
          : (Number.isFinite(process.stdout?.columns) ? process.stdout.columns : FALLBACK_COLUMNS));
    return Math.max(48, v || FALLBACK_COLUMNS);
  }

  function getViewportRows() {
    const v = Number.isFinite(stream?.rows)
      ? stream.rows
      : (Number.isFinite(process.stdout?.rows) ? process.stdout.rows : FALLBACK_ROWS);
    return Math.max(10, v || FALLBACK_ROWS);
  }

  function visibleWorkerNames() {
    return [...workers.keys()].sort();
  }

  function ensureSelectedWorker(names) {
    if (names.length === 0) { selectedWorker = null; return; }
    if (!selectedWorker || !workers.has(selectedWorker)) selectedWorker = names[0];
  }

  function selectRelative(offset) {
    const names = visibleWorkerNames();
    if (names.length === 0) return;
    ensureSelectedWorker(names);
    const idx = Math.max(0, names.indexOf(selectedWorker));
    selectedWorker = names[(idx + offset + names.length) % names.length];
    detailScrollOffset = 0;
    render();
  }

  function scrollDetail(delta) {
    followTail = false;
    detailScrollOffset = Math.max(0, detailScrollOffset + delta);
    render();
  }

  // ── 키 입력 ──────────────────────────────────────────────────────────
  function handleInput(chunk) {
    const key = String(chunk);
    if (key === "\u0003") return; // Ctrl-C

    // Tab: rail ↔ detail 포커스 전환
    if (key === "\t") {
      focus = focus === "rail" ? "detail" : "rail";
      render();
      return;
    }

    // Shift+Arrow: 포커스 이동 + 워커 선택
    if (key === "\x1b[1;2A") { selectRelative(-1); return; } // Shift+Up → 워커 위
    if (key === "\x1b[1;2B") { selectRelative(1); return; }  // Shift+Down → 워커 아래
    if (key === "\x1b[1;2D") { focus = "rail"; render(); return; }   // Shift+Left → rail
    if (key === "\x1b[1;2C") { focus = "detail"; render(); return; } // Shift+Right → detail

    if (focus === "detail") {
      // detail 포커스: j/k/ArrowDown/Up = 스크롤
      if (key === "j" || key === "\u001b[B") { scrollDetail(1); return; }
      if (key === "k" || key === "\u001b[A") { scrollDetail(-1); return; }
    } else {
      // rail 포커스: j/k = 워커 선택
      if (key === "j" || key === "\u001b[B") { selectRelative(1); return; }
      if (key === "k" || key === "\u001b[A") { selectRelative(-1); return; }
    }

    // f: follow-tail 토글
    if (key === "f") { followTail = !followTail; if (followTail) detailScrollOffset = 0; render(); return; }
    // r: raw mode 토글
    if (key === "r") { rawMode = !rawMode; render(); return; }
    // 1-9: 워커 직접 선택
    if (/^[1-9]$/.test(key)) {
      const names = visibleWorkerNames();
      const target = names[Number.parseInt(key, 10) - 1];
      if (target) { selectedWorker = target; detailScrollOffset = 0; render(); }
      return;
    }
  }

  function attachInput() {
    if (inputAttached) return;
    if (!isTTY || (!forceTTY && !input?.isTTY) || typeof input?.on !== "function") return;
    inputAttached = true;
    if (typeof input.setRawMode === "function") { input.setRawMode(true); rawModeEnabled = true; }
    if (typeof input.resume === "function") input.resume();
    input.on("data", handleInput);
  }

  // ── altScreen 진입/퇴장 ───────────────────────────────────────────────
  function enterAltScreen() {
    if (!isTTY) return;
    write(altScreenOn + cursorHide + clearScreen + cursorHome);
  }

  function exitAltScreen() {
    if (!isTTY) return;
    write(cursorShow + altScreenOff);
  }

  // ── 프레임 빌드 ───────────────────────────────────────────────────────
  function buildRows() {
    const names = visibleWorkerNames();
    if (names.length === 0) return [];

    ensureSelectedWorker(names);
    attachInput();

    const totalCols = getViewportColumns();
    const totalRows = getViewportRows();
    const elapsed = nowElapsedSec();

    // Tier1: 상단 고정 2행
    const tier1 = buildTier1(names, workers, pipeline, elapsed, totalCols, VERSION);

    // 레이아웃 결정
    let effectiveLayout = layoutHint;
    if (effectiveLayout === "auto") {
      if (names.length >= 4) effectiveLayout = "summary+detail";
      else if (names.length === 3) effectiveLayout = "split-3col";
      else if (names.length === 2) effectiveLayout = "split-2col";
      else effectiveLayout = "single";
    }

    // summary+detail: summaryBar + focus pane
    if (effectiveLayout === "summary+detail") {
      const summaryBar = buildSummaryBar(names, workers, selectedWorker, pipeline, totalCols, VERSION);
      const selectedState = workers.get(selectedWorker);
      const focusPaneHeight = Math.max(8, totalRows - tier1.length - summaryBar.length);
      const focusPane = buildFocusPane(selectedWorker, selectedState, {
        width: totalCols,
        height: focusPaneHeight,
        scrollOffset: detailScrollOffset,
        followTail,
        rawMode,
        focused: focus === "detail",
      });
      return [...tier1, ...summaryBar, ...focusPane];
    }

    // 좌우 분할: Left Rail (30%) | Right Focus (70%)
    // 목업: Tier2 Left Rail + Tier3 Focus 나란히 렌더링
    const GAP = 1; // rail과 focus 사이 구분선
    const railWidth = Math.max(MIN_CARD_WIDTH, Math.floor(totalCols * 0.30));
    const focusWidth = totalCols - railWidth - GAP;
    const bodyHeight = Math.max(6, totalRows - tier1.length - 1); // -1 for status bar

    // compact 자동 적용: viewport 행이 20 미만이면 2-line 카드
    const useCompact = totalRows < 20;

    // Left Rail: 워커 카드 세로 스택
    const railLines = [];
    for (const name of names) {
      const card = buildWorkerRail(name, workers.get(name), {
        width: railWidth - 2, // box 테두리 감안
        selected: name === selectedWorker,
        focused: focus === "rail" && name === selectedWorker,
        rawMode,
        compact: useCompact,
      });
      railLines.push(...card);
    }
    // rail 높이를 bodyHeight에 맞춤 (부족하면 빈 줄, 넘치면 자름)
    while (railLines.length < bodyHeight) railLines.push(padRight("", railWidth));
    if (railLines.length > bodyHeight) railLines.length = bodyHeight;

    // Right Focus: 선택된 워커 상세
    let focusLines = [];
    if (selectedWorker && workers.has(selectedWorker)) {
      focusLines = buildFocusPane(selectedWorker, workers.get(selectedWorker), {
        width: focusWidth,
        height: bodyHeight,
        scrollOffset: detailScrollOffset,
        followTail,
        rawMode,
        focused: focus === "detail",
      });
    }
    while (focusLines.length < bodyHeight) focusLines.push(padRight("", focusWidth));
    if (focusLines.length > bodyHeight) focusLines.length = bodyHeight;

    // 좌우 합성: rail[i] + separator + focus[i]
    const separator = dim("│");
    const composedRows = [];
    for (let i = 0; i < bodyHeight; i++) {
      const left = clip(railLines[i] || "", railWidth);
      const right = focusLines[i] || "";
      composedRows.push(`${left}${separator}${right}`);
    }

    // 하단 상태바
    const statusBar = truncate(
      dim(`  세션 종료됨 — 아무 키나 누르면 닫힘`),
      totalCols,
    );

    return [...tier1, ...composedRows, statusBar];
  }

  // ── altScreen diff render ─────────────────────────────────────────────
  function renderAltScreen() {
    const newRows = buildRows();
    rowBuf.set(newRows);
    const dirty = rowBuf.diff();
    const prevLen = rowBuf.prevLen;

    if (dirty.length === 0 && newRows.length === prevLen) return;

    const toErase = prevLen > newRows.length
      ? Array.from({ length: prevLen - newRows.length }, (_, i) => newRows.length + i)
      : [];

    for (const i of dirty) {
      write(moveTo(i + 1, 1) + clearLine + (newRows[i] || ""));
    }
    for (const i of toErase) {
      write(moveTo(i + 1, 1) + clearLine);
    }

    rowBuf.commit();
  }

  // ── append-only render (non-TTY fallback) ────────────────────────────
  function renderAppendOnly() {
    const newRows = buildRows();
    if (newRows.length === 0) return;
    writeln(newRows.join("\n"));
  }

  // ── public render ─────────────────────────────────────────────────────
  function render() {
    if (closed) return;
    frameCount++;
    spinnerTick++;
    if (isTTY) {
      renderAltScreen();
    } else {
      renderAppendOnly();
    }
  }

  // altScreen 시작
  if (isTTY) {
    enterAltScreen();
  }

  if (refreshMs > 0) {
    timer = setInterval(render, refreshMs);
    if (timer.unref) timer.unref();
  }

  // ── 공개 API ─────────────────────────────────────────────────────────
  return {
    updateWorker(paneName, state) {
      const existing = workers.get(paneName) || { cli: "codex", status: "pending" };
      const merged = normalizeWorkerState(existing, state);
      const nextSig = JSON.stringify({
        cli: merged.cli, status: merged.status, role: merged.role,
        snapshot: merged.snapshot, summary: merged.summary, detail: merged.detail,
        findings: merged.findings, files_changed: merged.files_changed,
        confidence: merged.confidence, tokens: merged.tokens,
        progress: merged.progress, handoff: merged.handoff,
      });
      const sigChanged = nextSig !== existing._sig;
      const explicitElapsed = Number.isFinite(state.elapsed) ? Math.max(0, Math.round(state.elapsed)) : null;
      merged._sig = nextSig;
      merged._logSec = sigChanged
        ? (explicitElapsed ?? nowElapsedSec())
        : (Number.isFinite(existing._logSec) ? existing._logSec : (explicitElapsed ?? nowElapsedSec()));
      workers.set(paneName, merged);
      ensureSelectedWorker(visibleWorkerNames());
      // follow-tail: 새 데이터 → 자동 scroll 재계산
      if (followTail) detailScrollOffset = 0;
    },

    updatePipeline(state) {
      pipeline = { ...pipeline, ...state };
    },

    setStartTime(ms) {
      startedAt = ms;
    },

    selectWorker(name) {
      if (!workers.has(name)) return;
      selectedWorker = name;
    },

    toggleDetail(force) {
      // 하위 호환: toggleDetail = focus pane 표시 여부
      const next = typeof force === "boolean" ? force : focus !== "detail";
      focus = next ? "detail" : "rail";
    },

    render,

    getWorkers() {
      return new Map(workers);
    },

    getFrameCount() {
      return frameCount;
    },

    getPipelineState() {
      return { ...pipeline };
    },

    getSelectedWorker() {
      return selectedWorker;
    },

    isDetailExpanded() {
      return focus === "detail";
    },

    close() {
      if (closed) return;
      if (timer) clearInterval(timer);
      if (inputAttached && typeof input?.off === "function") input.off("data", handleInput);
      if (rawModeEnabled && typeof input?.setRawMode === "function") input.setRawMode(false);
      if (inputAttached && typeof input?.pause === "function") input.pause();
      exitAltScreen();
      closed = true;
    },
  };
}

// 하위 호환
export { createLogDashboard as createTui };
