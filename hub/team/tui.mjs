// hub/team/tui.mjs — Alternate-screen diff renderer (v11)
// virtual row buffer 기반. dirty-row만 갱신. isTTY 아닐 때 append-only fallback.
// Tier1(상단 고정) / Tier2(worker rail) / Tier3(focus pane) 3단 계층.

import { getEnvironment } from "../lib/env-detect.mjs";
import {
  altScreenOff,
  altScreenOn,
  bold,
  box,
  clearLine,
  clearScreen,
  clip,
  color,
  cursorHide,
  cursorHome,
  cursorShow,
  dim,
  FG,
  MOCHA,
  moveTo,
  padRight,
  progressBar,
  RESET,
  statusBadge,
  stripAnsi,
  truncate,
  wcswidth,
} from "./ansi.mjs";
import { resolveAttachCommand } from "./session.mjs";
import {
  clamp,
  cliColor,
  normalizeWorkerState as coreNormalizeWorkerState,
  countStatuses,
  FALLBACK_COLUMNS,
  FALLBACK_ROWS,
  formatTokens,
  loadVersion,
  runtimeStatus,
  sanitizeFiles,
  sanitizeFindings,
  sanitizeOneLine,
  sanitizeTextBlock,
  statusColor,
  stripCodeBlocks,
  wrapLine,
  wrapText as wrapTextAll,
} from "./tui-core.mjs";
import {
  createMetricsCollector,
  createSynapseEventStream,
  renderMetricsTier1,
} from "./tui-synapse.mjs";
import {
  createPanelResizer,
  createSearchState,
  createTokenTracker,
  createVimMotion,
} from "./tui-widgets.mjs";
import { createWtManager } from "./wt-manager.mjs";

const VERSION = await loadVersion();

// FALLBACK_COLUMNS, FALLBACK_ROWS → tui-core.mjs에서 import
const MIN_CARD_WIDTH = 28;
const ATTACH_SESSION_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/u;
const DEFAULT_ATTACH_TAB_TTL_MS = 30_000;
const DEFAULT_ATTACH_LIMITS = Object.freeze({ local: 8, remote: 4 });

function sanitizeAttachTitle(value, fallback) {
  const text = String(value || "")
    .replace(/[\r\n]+/gu, " ")
    .trim();
  return text || fallback;
}

function assertAttachSessionName(value) {
  const sessionName = String(value || "").trim();
  if (!ATTACH_SESSION_NAME_PATTERN.test(sessionName)) {
    throw new Error(`invalid attach session name: ${sessionName || "<empty>"}`);
  }
  return sessionName;
}

export function createTransientTabLimiter(opts = {}) {
  const now = opts.now || Date.now;
  const ttlMs = Number.isFinite(opts.ttlMs)
    ? Math.max(1, Math.trunc(opts.ttlMs))
    : DEFAULT_ATTACH_TAB_TTL_MS;
  const limits = {
    local: Number.isFinite(opts.limits?.local)
      ? Math.max(1, Math.trunc(opts.limits.local))
      : DEFAULT_ATTACH_LIMITS.local,
    remote: Number.isFinite(opts.limits?.remote)
      ? Math.max(1, Math.trunc(opts.limits.remote))
      : DEFAULT_ATTACH_LIMITS.remote,
  };
  const buckets = {
    local: [],
    remote: [],
  };
  let nextId = 0;

  function normalizeKind(kind) {
    return kind === "remote" ? "remote" : "local";
  }

  function prune(kind) {
    const normalized = normalizeKind(kind);
    const nowAt = now();
    buckets[normalized] = buckets[normalized].filter(
      (entry) => entry.expiresAt > nowAt,
    );
    return buckets[normalized];
  }

  function acquire(kind) {
    const normalized = normalizeKind(kind);
    const active = prune(normalized);
    const limit = limits[normalized];
    if (active.length >= limit) {
      const retryAfterMs =
        active.length > 0 ? Math.max(0, active[0].expiresAt - now()) : ttlMs;
      return Object.freeze({
        ok: false,
        kind: normalized,
        limit,
        active: active.length,
        retryAfterMs,
      });
    }

    const entry = Object.freeze({
      id: ++nextId,
      expiresAt: now() + ttlMs,
    });
    buckets[normalized] = [...active, entry];

    return Object.freeze({
      ok: true,
      kind: normalized,
      limit,
      release() {
        buckets[normalized] = buckets[normalized].filter(
          (candidate) => candidate.id !== entry.id,
        );
      },
    });
  }

  function snapshot() {
    return Object.freeze({
      local: prune("local").length,
      remote: prune("remote").length,
      ttlMs,
      limits: Object.freeze({ ...limits }),
    });
  }

  return Object.freeze({
    acquire,
    snapshot,
  });
}

export function buildDashboardAttachRequest(worker, opts = {}) {
  const resolveAttach = opts.resolveAttachCommand || resolveAttachCommand;
  const sessionName = assertAttachSessionName(
    worker?.sessionName || worker?.paneName,
  );

  if (worker?.remote && worker?.sshUser) {
    const host = String(worker.host || "unknown");
    const ip = String(worker._sshIp || host);
    const title = sanitizeAttachTitle(
      `${host}:${worker.role || sessionName}`,
      `${host}:${sessionName}`,
    );
    const command = `ssh ${worker.sshUser}@${ip} -t "psmux attach-session -t ${sessionName}"`;
    return Object.freeze({
      kind: "remote",
      sessionName,
      title,
      command,
    });
  }

  const attachSpec = resolveAttach(sessionName);
  const title = sanitizeAttachTitle(worker?.role || sessionName, sessionName);
  const commandParts = [attachSpec.command, ...attachSpec.args];
  return Object.freeze({
    kind: "local",
    sessionName,
    title,
    command: commandParts.join(" "),
  });
}

// ✻ heartbeat — Claude Code 리버스 엔지니어링 기반 breathing animation
// 프레임: ["·","✢","✳","✶","✻","✽"] + 역재생 = 12프레임 왕복
// 타이밍: 2000ms/cycle, RGB truecolor 보간
const SPINNER_FRAMES_RAW = ["·", "✢", "✳", "✶", "✻", "✽"];
const SPINNER_FRAMES = [
  ...SPINNER_FRAMES_RAW,
  ...[...SPINNER_FRAMES_RAW].reverse(),
];
const SPINNER_CYCLE_MS = 2000;
const SPINNER_BASE_COLOR = { r: 203, g: 166, b: 247 }; // Catppuccin Mocha mauve
const SPINNER_SHIMMER = { r: 171, g: 43, b: 63 }; // Claude shimmer #ab2b3f
const spinnerStart = Date.now();
let spinnerTick = 0;

function lerpRgb(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function rgbSeq(rgb, mode = 38) {
  return `\x1b[${mode};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function pseudoRandomFrame(step, seed) {
  return Math.abs(Math.imul(step + seed, 2654435761)) % SPINNER_FRAMES.length;
}

function heartbeat(
  status,
  shimmerIntensity = 0,
  statusChangedAt = 0,
  time = Date.now(),
) {
  const transitionElapsed = statusChangedAt
    ? Math.max(0, time - statusChangedAt)
    : Number.POSITIVE_INFINITY;
  if (transitionElapsed < 500) {
    const step = Math.floor(transitionElapsed / 50);
    const idx = pseudoRandomFrame(step, statusChangedAt % 997);
    const targetColor =
      status === "failed" || status === "error"
        ? MOCHA.fail
        : status === "done" || status === "completed"
          ? MOCHA.ok
          : shimmerIntensity > 0
            ? rgbSeq(
                lerpRgb(SPINNER_BASE_COLOR, SPINNER_SHIMMER, shimmerIntensity),
              )
            : MOCHA.executing;
    return `${targetColor}${SPINNER_FRAMES[idx]}${RESET}`;
  }

  if (status === "done" || status === "completed") return color("✓", MOCHA.ok);
  if (status === "failed" || status === "error") return color("✗", MOCHA.fail);
  if (status !== "running") return dim("○");
  const elapsed = time - spinnerStart;
  const idx =
    Math.floor((elapsed / SPINNER_CYCLE_MS) * SPINNER_FRAMES.length) %
    SPINNER_FRAMES.length;
  const c =
    shimmerIntensity > 0
      ? lerpRgb(SPINNER_BASE_COLOR, SPINNER_SHIMMER, shimmerIntensity)
      : SPINNER_BASE_COLOR;
  return `${rgbSeq(c)}${SPINNER_FRAMES[idx]}${RESET}`;
}

function currentShimmer(time = Date.now()) {
  const elapsed = time - spinnerStart;
  const quantized = Math.floor(elapsed / 80) * 80;
  const t = (quantized % SPINNER_CYCLE_MS) / SPINNER_CYCLE_MS;
  return 0.5 * (1 + Math.sin(t * Math.PI * 2));
}

// ── activity wave — Tier1 헤더용 미니 파형 ──
const WAVE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
function activityWave(tick, count = 4) {
  let wave = "";
  for (let i = 0; i < count; i++) {
    const phase = tick * 0.3 + i * 1.5;
    const idx = Math.floor(
      (Math.sin(phase) * 0.5 + 0.5) * (WAVE_CHARS.length - 1),
    );
    wave += WAVE_CHARS[idx];
  }
  return `${MOCHA.executing}${wave}${RESET}`;
}

const GRID_GAP = 2;
const DEFAULT_DETAIL_LINES = 10;
// Tier1 상단 고정 행 수
const _TIER1_ROWS = 2;

const SUMMARY_KEYS = [
  "status",
  "lead_action",
  "verdict",
  "files_changed",
  "confidence",
  "risk",
  "detail",
  "error_stage",
  "retryable",
  "partial_output",
];

// ── 레이아웃 브레이크포인트 ──────────────────────────────────────────────
// 80-119: 28col rail, 120-159: 36col rail, 160+: 균등
function _resolveRailWidth(totalCols, columnCount) {
  if (columnCount <= 1) return totalCols;
  if (totalCols >= 160)
    return Math.floor((totalCols - GRID_GAP * (columnCount - 1)) / columnCount);
  if (totalCols >= 120)
    return Math.min(
      36,
      Math.floor((totalCols - GRID_GAP * (columnCount - 1)) / columnCount),
    );
  return Math.min(
    28,
    Math.floor((totalCols - GRID_GAP * (columnCount - 1)) / columnCount),
  );
}

function _autoColumnCount(totalCols, workerCount) {
  if (workerCount <= 1) return 1;
  if (totalCols >= 160) return Math.min(workerCount, 3);
  if (totalCols >= 120) return Math.min(workerCount, 2);
  return 1;
}

// 텍스트/상태/색상 유틸은 tui-core.mjs에서 import (위 참조)

// ── MOCHA RGB (gradual fade 보간용) ──
const MOCHA_RGB = {
  ok: { r: 166, g: 227, b: 161 },
  partial: { r: 250, g: 179, b: 135 },
  fail: { r: 243, g: 139, b: 168 },
  executing: { r: 116, g: 199, b: 236 },
  muted: { r: 147, g: 153, b: 178 },
  border: { r: 69, g: 71, b: 90 },
  blue: { r: 137, g: 180, b: 250 },
  sky: { r: 116, g: 199, b: 236 },
  yellow: { r: 249, g: 226, b: 175 },
  peach: { r: 250, g: 179, b: 135 },
  maroon: { r: 235, g: 160, b: 172 },
  surface0: { r: 49, g: 50, b: 68 },
  thinking: { r: 203, g: 166, b: 247 },
};

function statusToRgb(status) {
  if (status === "ok" || status === "completed") return MOCHA_RGB.ok;
  if (status === "partial") return MOCHA_RGB.partial;
  if (status === "failed") return MOCHA_RGB.fail;
  if (status === "running" || status === "in_progress")
    return MOCHA_RGB.executing;
  return MOCHA_RGB.muted;
}

const FADE_DURATION_MS = 1500;
const FLASH_PHASE_MS = 250;
const CARD_GLOW_MS = 3000;

// Effect 1: Pulse border — running 워커 보더가 heartbeat 동기 breathing
function pulseBorderColor(statusRgb, time = Date.now()) {
  const intensity = 0.3 + 0.7 * currentShimmer(time);
  const c = lerpRgb(MOCHA_RGB.border, statusRgb, intensity);
  return rgbSeq(c);
}

// Effect 2: Gradient border — focus pane 보더 상단→하단 그라데이션
function gradientBorderFn(topRgb, bottomRgb) {
  return (row, totalRows) => {
    const t = totalRows <= 1 ? 0 : row / (totalRows - 1);
    const c = lerpRgb(topRgb, bottomRgb, t);
    return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
  };
}

// Effect 3: Flash-fade border — 상태 변경 시 백색 플래시 → 페이드아웃
function _flashFadeBorderColor(currentStatus, prevStatus, changedAt) {
  const elapsed = Date.now() - (changedAt || 0);
  if (elapsed >= FADE_DURATION_MS || !prevStatus) return null;
  const statusRgb = statusToRgb(currentStatus);
  if (elapsed < FLASH_PHASE_MS) {
    const t = elapsed / FLASH_PHASE_MS;
    const bright = { r: 255, g: 255, b: 255 };
    const c = lerpRgb(bright, statusRgb, t);
    return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
  }
  const t = (elapsed - FLASH_PHASE_MS) / (FADE_DURATION_MS - FLASH_PHASE_MS);
  const c = lerpRgb(statusRgb, MOCHA_RGB.border, t);
  return `\x1b[38;2;${c.r};${c.g};${c.b}m`;
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function borderHighlightPosition(width, bodyLines, time = Date.now()) {
  const totalRows = bodyLines + 2;
  const perimeter = 2 * (width - 2) + 2 * totalRows;
  if (perimeter <= 0) return undefined;
  return Math.floor(time / 120) % perimeter;
}

function titleFlash(status, changeElapsed) {
  const isCompleted =
    status === "completed" || status === "done" || status === "ok";
  const isFailed =
    status === "failed" || status === "error" || status === "fail";
  if ((!isCompleted && !isFailed) || changeElapsed > 800) return null;
  const flashRgb = isCompleted ? MOCHA_RGB.ok : MOCHA_RGB.fail;
  const bgRgb =
    changeElapsed <= 300
      ? flashRgb
      : lerpRgb(
          flashRgb,
          MOCHA_RGB.surface0,
          clamp((changeElapsed - 300) / 500, 0, 1),
        );
  return rgbSeq(bgRgb, 48);
}

function dedupeRole(role, name, cli) {
  if (!role) return "";
  let r = role;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  r = r.replace(new RegExp(esc(cli), "gi"), "").trim();
  r = r.replace(new RegExp(esc(name), "gi"), "").trim();
  // CLI indicator emojis 제거
  r = r.replace(/[⚪⚫🔴🟠🟡🟢🔵🟣🟤⭕🔘]/gu, "").trim();
  // 빈 괄호 제거 + 중첩 괄호 정리
  r = r.replace(/\(\s*\)/g, "").trim();
  r = r.replace(/^\(([^()]+)\)$/, "$1").trim();
  r = r.replace(/^\s*[•·-]\s*/, "").trim();
  return r;
}

// wrapLine, wrapTextAll → tui-core.mjs에서 import

function _wrapText(
  text,
  width,
  maxLines = DEFAULT_DETAIL_LINES,
  rawMode = false,
) {
  if (maxLines <= 0) return [];
  const input = sanitizeTextBlock(text, rawMode);
  if (!input) return [];
  const wrapped = input
    .split("\n")
    .flatMap((line) => wrapLine(line, width))
    .filter(Boolean);
  if (wrapped.length <= maxLines) return wrapped;
  return [
    ...wrapped.slice(0, maxLines - 1),
    truncate(wrapped[wrapped.length - 1], width),
  ];
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

  get rows() {
    return this._rows;
  }
  get prevLen() {
    return this._prev.length;
  }
}

// countStatuses → tui-core.mjs에서 import

// ── Tier1: 상단 고정 1행 ─────────────────────────────────────────────────
function phaseColor(phase, time = Date.now()) {
  const shimmer = currentShimmer(time);
  if (phase === "exec" || phase === "executing")
    return rgbSeq(lerpRgb(MOCHA_RGB.blue, MOCHA_RGB.sky, shimmer));
  if (phase === "verify" || phase === "verifying")
    return rgbSeq(lerpRgb(MOCHA_RGB.yellow, MOCHA_RGB.peach, shimmer));
  if (phase === "fix" || phase === "fixing")
    return rgbSeq(lerpRgb(MOCHA_RGB.fail, MOCHA_RGB.maroon, shimmer));
  return FG.accent;
}

function buildTier1(
  names,
  workers,
  pipeline,
  elapsed,
  width,
  version,
  time = Date.now(),
) {
  const { ok, partial, failed, running } = countStatuses(names, workers);
  const phase = pipeline.phase || "exec";
  const row1 = truncate(
    `${color("▲", FG.triflux)} v${version} ${dim("│")} ${color(phase, phaseColor(phase, time))} ${dim("│")} ${elapsed}s ${dim("│")} ` +
      `${color(`✓${ok}`, MOCHA.ok)} ${color(`◑${partial}`, MOCHA.partial)} ${color(`✗${failed}`, MOCHA.fail)} ${dim(`▶${running}`)}${running > 0 ? ` ${activityWave(spinnerTick)}` : ""}`,
    width,
  );
  const keysHint = color(
    "Tab:focus • j/k:nav • gg/G:jump • /:search • n/N:next • H/L:resize • f:follow • l:tab",
    MOCHA.subtext,
  );
  const hintWidth = wcswidth(stripAnsi(keysHint));
  const row2 =
    hintWidth >= width
      ? truncate(keysHint, width)
      : padRight(`${" ".repeat(width - hintWidth)}${keysHint}`, width);
  return [row1, row2];
}

// ── 카드 렌더러 (Tier2 worker rail) ─────────────────────────────────────
function detailText(st) {
  if (st.detail) return st.detail;
  const lines = [];
  for (const key of SUMMARY_KEYS) {
    const value = st.handoff?.[key];
    if (Array.isArray(value) && value.length > 0)
      lines.push(`${key}: ${value.join(", ")}`);
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
    .filter(
      (line) =>
        !SUMMARY_KEYS.some((key) => line.toLowerCase().startsWith(`${key}:`)),
    )
    .slice(0, 2);
}

function buildWorkerRail(name, st, opts = {}) {
  const {
    width,
    selected = false,
    focused = false, // rail 포커스 여부
    previousSelected = false,
    _rawMode = false,
    compact = false,
    time = Date.now(),
  } = opts;
  const innerWidth = Math.max(12, width - 4);
  const cli = st.cli || "codex";
  const role = sanitizeOneLine(st.role);
  const status = runtimeStatus(st);
  const sec = Number.isFinite(st._logSec) ? st._logSec : 0;
  const changeElapsed = st._statusChangedAt
    ? Math.max(0, time - st._statusChangedAt)
    : Number.POSITIVE_INFINITY;

  // Tier2 행 1: 이름 + CLI + role
  const selMark = selected
    ? focused
      ? color("▶", MOCHA.blue)
      : color(">", FG.triflux)
    : previousSelected
      ? dim("~")
      : " ";
  const hb = heartbeat(
    status,
    status === "running" ? currentShimmer(time) : 0,
    st._statusChangedAt,
    time,
  );
  // host 배지 (원격 워커용)
  const hostBadge =
    st.host && st.host !== "local"
      ? color(`[${st.host}]`, MOCHA.mauve) + " "
      : "";
  const displayRole = dedupeRole(role, name, cli);
  const title = truncate(
    `${selMark} ${hb} ${hostBadge}${color(name, FG.triflux)} ${color("•", MOCHA.overlay)} ${color(cli, cliColor(cli))}${displayRole ? ` ${color(`(${displayRole})`, MOCHA.overlay)}` : ""}`,
    innerWidth,
  );

  const cardWidth = Math.max(MIN_CARD_WIDTH, width);
  const borderHighlight = focused
    ? borderHighlightPosition(cardWidth, compact ? 2 : 6, time)
    : undefined;
  const titleFlashBg = titleFlash(status, changeElapsed);

  // status-specific border: focused→mauve, selected→bright, non-selected→glow decay
  const statusBorderColor = (() => {
    if (focused) return MOCHA.thinking;
    if (selected && (status === "running" || status === "in_progress")) {
      return pulseBorderColor(statusToRgb(status), time);
    }
    if (selected) return statusColor(status);
    const from = statusToRgb(status);
    const decayBase = st._statusChangedAt
      ? clamp(changeElapsed / CARD_GLOW_MS, 0, 1)
      : 1;
    const decayT = easeOutCubic(decayBase);
    return rgbSeq(lerpRgb(from, MOCHA_RGB.border, 0.5 + 0.5 * decayT));
  })();

  if (compact) {
    // compact 2-line 카드
    const progress = Number.isFinite(st.progress)
      ? clamp(st.progress, 0, 1)
      : status === "running"
        ? 0.3
        : 1;
    const percent = Math.round(progress * 100);
    const compactLine1 = truncate(
      `${selMark} ${hb} ${hostBadge}${color(name, FG.triflux)} ${dim("•")} ${color(cli, cliColor(cli))} ${statusBadge(status)} ${String(percent).padStart(3)}%`,
      innerWidth,
    );
    const verdict = sanitizeOneLine(
      st.handoff?.verdict || st.summary || st.snapshot,
      status,
    );
    const compactLine2 = truncate(color(verdict, MOCHA.text), innerWidth);
    const framed = box(
      [compactLine1, compactLine2],
      cardWidth,
      statusBorderColor,
      {
        highlightPos: borderHighlight,
        titleFlashBg,
      },
    );
    return [framed.top, ...framed.body, framed.bot];
  }

  // Tier2 행 2: 상태 배지 + elapsed + tokens + conf
  const confidence = sanitizeOneLine(
    st.handoff?.confidence || st.confidence,
    "n/a",
  );
  const statusLine = truncate(
    `${statusBadge(status)} ${color("•", MOCHA.overlay)} ${color(`${sec}s`, MOCHA.subtext)} ${color("•", MOCHA.overlay)} ${color(`tok ${formatTokens(st.tokens)}`, MOCHA.subtext)} ${color("•", MOCHA.overlay)} ${color(`conf ${confidence}`, MOCHA.subtext)}`,
    innerWidth,
  );

  // Tier2 행 3: progress bar
  const progress = Number.isFinite(st.progress)
    ? clamp(st.progress, 0, 1)
    : status === "running"
      ? 0.3
      : 1;
  const percent = Math.round(progress * 100);
  const barWidth = clamp(Math.floor(innerWidth * 0.3), 8, 16);
  const bar = progressBar(percent, barWidth, time);
  const progressLine = truncate(
    `${bar} ${color(`${String(percent).padStart(3)}%`, MOCHA.text)}`,
    innerWidth,
  );

  // Tier2 행 4-6: verdict / findings / files
  const verdict = sanitizeOneLine(
    st.handoff?.verdict || st.summary || st.snapshot,
    status,
  );
  const findings =
    detailHighlights(st).join(" / ") || "no notable findings yet";
  const files =
    sanitizeFiles(st.handoff?.files_changed || st.files_changed).join(", ") ||
    "none";

  const verdictClr = statusColor(status);
  const lines = [
    title,
    statusLine,
    progressLine,
    truncate(
      `${color("verdict", MOCHA.overlay)} ${color(verdict, verdictClr)}`,
      innerWidth,
    ),
    truncate(
      `${color("findings", MOCHA.overlay)} ${color(findings, MOCHA.subtext)}`,
      innerWidth,
    ),
    truncate(
      `${color("files", MOCHA.overlay)} ${color(files, MOCHA.subtext)}`,
      innerWidth,
    ),
  ];

  const framed = box(lines, cardWidth, statusBorderColor, {
    highlightPos: borderHighlight,
    titleFlashBg,
  });
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
    time = Date.now(),
  } = opts;
  const innerWidth = Math.max(12, width - 4);

  // verdict sticky 4행
  const verdict = sanitizeOneLine(
    st.handoff?.verdict || st.summary || st.snapshot,
    "—",
  );
  const confidence = sanitizeOneLine(
    st.handoff?.confidence || st.confidence,
    "n/a",
  );
  const files = sanitizeFiles(st.handoff?.files_changed || st.files_changed);
  const status = runtimeStatus(st);

  // Tab bar: 활성 탭은 MOCHA.blue + bold, 비활성은 MOCHA.overlay
  const activeTab = opts.activeTab || "log";
  const tabLog =
    activeTab === "log"
      ? `${MOCHA.blue}${bold("[Log]")}`
      : color("[Log]", MOCHA.overlay);
  const tabDetail =
    activeTab === "detail"
      ? `${MOCHA.blue}${bold("[Detail]")}`
      : color("[Detail]", MOCHA.overlay);
  const tabFiles =
    activeTab === "files"
      ? `${MOCHA.blue}${bold(`[Files ${files.length}]`)}`
      : color(`[Files ${files.length}]`, MOCHA.overlay);
  const tabBar = truncate(`${tabLog} ${tabDetail} ${tabFiles}`, innerWidth);

  const stickyLines = [
    truncate(
      `${color(name, FG.triflux)} ${color("•", MOCHA.overlay)} ${statusBadge(status)}`,
      innerWidth,
    ),
    tabBar,
    truncate(
      `${color("verdict", MOCHA.overlay)}  ${color(verdict, statusColor(status))}`,
      innerWidth,
    ),
    truncate(
      `${color("conf", MOCHA.overlay)}     ${color(confidence, MOCHA.text)}`,
      innerWidth,
    ),
    color("─", MOCHA.surface0).repeat(Math.max(4, innerWidth)),
  ];

  // 본문 스크롤 영역
  const bodyAvail = Math.max(0, height - stickyLines.length - 3); // top+bot border + scrollInfo

  let allBodyLines;
  if (activeTab === "detail") {
    const summaryLines = [];
    for (const key of SUMMARY_KEYS) {
      const value = st.handoff?.[key];
      if (Array.isArray(value) && value.length > 0)
        summaryLines.push(`${key}: ${value.join(", ")}`);
      else if (value) summaryLines.push(`${key}: ${value}`);
    }
    allBodyLines =
      summaryLines.length > 0
        ? summaryLines.flatMap((l) => wrapLine(l, innerWidth))
        : [dim("no structured data")];
  } else if (activeTab === "files") {
    const filesList = sanitizeFiles(
      st.handoff?.files_changed || st.files_changed,
    );
    allBodyLines =
      filesList.length > 0
        ? filesList.map((f, i) => `${i + 1}. ${f}`)
        : [dim("no files changed")];
  } else {
    allBodyLines = wrapTextAll(detailText(st), innerWidth, rawMode);
  }

  let startIdx;
  if (followTail) {
    startIdx = Math.max(0, allBodyLines.length - bodyAvail);
  } else {
    startIdx = clamp(
      scrollOffset,
      0,
      Math.max(0, allBodyLines.length - bodyAvail),
    );
  }

  const bodySlice = allBodyLines.slice(startIdx, startIdx + bodyAvail);
  if (bodySlice.length === 0) bodySlice.push(dim("no detail available"));

  // scroll indicator — MOCHA.overlay for position
  const scrollInfo =
    allBodyLines.length > bodyAvail
      ? color(
          `${startIdx + 1}-${Math.min(startIdx + bodyAvail, allBodyLines.length)}/${allBodyLines.length}`,
          MOCHA.overlay,
        )
      : color(`${allBodyLines.length} lines`, MOCHA.overlay);

  const contentLines = [
    ...stickyLines,
    ...bodySlice.map((l) => truncate(l, innerWidth)),
    truncate(scrollInfo, innerWidth),
  ];

  // Effect 2: focused pane gets gradient border (blue→border), unfocused gets dim
  const borderColor = focused
    ? gradientBorderFn(MOCHA_RGB.blue, MOCHA_RGB.border)
    : MOCHA.border;
  const paneWidth = Math.max(MIN_CARD_WIDTH, width);
  const framed = box(contentLines, paneWidth, borderColor, {
    highlightPos: focused
      ? borderHighlightPosition(paneWidth, contentLines.length, time)
      : undefined,
  });
  return [framed.top, ...framed.body, framed.bot];
}

// ── summary bar (≥4 workers) ──────────────────────────────────────────────
function buildSummaryBar(
  names,
  workers,
  selectedWorker,
  pipeline,
  width,
  version,
) {
  const maxChipWidth = clamp(
    Math.floor((width - 6) / Math.min(names.length, 4)),
    16,
    26,
  );
  const chips = names.map((name, idx) => {
    const st = workers.get(name);
    const status = runtimeStatus(st);
    const progress = Number.isFinite(st.progress)
      ? clamp(st.progress, 0, 1)
      : status === "running"
        ? 0.3
        : 1;
    const label = `${selectedWorker === name ? ">" : " "} ${idx + 1}.${name} ${status} ${Math.round(progress * 100)}%`;
    return padRight(truncate(label, maxChipWidth), maxChipWidth);
  });
  const chipsLine = truncate(
    chips.join(color(" │ ", MOCHA.overlay)),
    width - 4,
  );
  const keysLine = truncate(
    color(
      "Tab:focus • j/k:nav • gg/G:jump • /:search • n/N:next • H/L:resize • f:follow • l:tab",
      MOCHA.subtext,
    ),
    width - 4,
  );
  const framed = box([chipsLine, keysLine], width);
  return [framed.top, ...framed.body, framed.bot];
}

// ── help overlay ──────────────────────────────────────────────────────────
function buildHelpOverlay(width, height) {
  const innerWidth = Math.min(50, width - 6);
  const helpLines = [
    color("  Keyboard Shortcuts", FG.triflux),
    "",
    `  ${color("Tab", MOCHA.blue)}        rail ↔ detail 포커스 전환`,
    `  ${color("j/↓", MOCHA.blue)}        다음 워커 / 스크롤 아래`,
    `  ${color("k/↑", MOCHA.blue)}        이전 워커 / 스크롤 위`,
    `  ${color("1-9", MOCHA.blue)}        워커 직접 선택`,
    `  ${color("n", MOCHA.blue)}          최근 상태 변경 워커 선택`,
    `  ${color("f", MOCHA.blue)}          follow-tail 토글`,
    `  ${color("r", MOCHA.blue)}          raw mode 토글`,
    `  ${color("l", MOCHA.blue)}          탭 전환 (Log/Detail/Files)`,
    `  ${color("g", MOCHA.blue)}          focus pane 상단 점프`,
    `  ${color("G", MOCHA.blue)}          focus pane 하단 점프`,
    `  ${color("PgUp", MOCHA.blue)}       페이지 위 스크롤`,
    `  ${color("PgDn", MOCHA.blue)}       페이지 아래 스크롤`,
    `  ${color("Shift+↑↓", MOCHA.blue)}   워커 선택 + 포커스 이동`,
    `  ${color("Shift+←→", MOCHA.blue)}   rail ↔ detail 포커스`,
    `  ${color("h/?", MOCHA.blue)}        이 도움말 토글`,
    `  ${color("q", MOCHA.blue)}          대시보드 종료`,
    "",
    dim("  아무 키나 눌러 닫기"),
  ];
  const framed = box(helpLines, innerWidth + 4, MOCHA.blue);
  const framedRows = [framed.top, ...framed.body, framed.bot];
  const topPad = Math.max(0, Math.floor((height - framedRows.length) / 2));
  const leftPad = " ".repeat(
    Math.max(0, Math.floor((width - innerWidth - 4) / 2)),
  );
  const result = [];
  for (let i = 0; i < height; i++) {
    const fi = i - topPad;
    if (fi >= 0 && fi < framedRows.length) {
      result.push(`${leftPad}${framedRows[fi]}`);
    } else {
      result.push("");
    }
  }
  return result;
}

// ── joinColumns ───────────────────────────────────────────────────────────
function _joinColumns(blocks, gap = GRID_GAP) {
  const maxHeight = Math.max(...blocks.map((b) => b.length));
  return Array.from({ length: maxHeight }, (_, rowIdx) =>
    blocks
      .map(
        (block) =>
          block[rowIdx] || " ".repeat(wcswidth(stripAnsi(block[0] || ""))),
      )
      .join(" ".repeat(gap)),
  );
}

// ── normalizeWorkerState ──────────────────────────────────────────────────
function normalizeWorkerState(existing, state) {
  return coreNormalizeWorkerState(
    existing || { cli: "codex", status: "pending" },
    state,
    {
      trackChanges: true,
    },
  );
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
  const deps = opts.deps || {};
  const {
    stream = process.stdout,
    input = process.stdin,
    refreshMs = 1000,
    columns,
    layout: layoutHint = "auto",
    forceTTY = false,
  } = opts;

  const isTTY = forceTTY || !!stream?.isTTY;
  const now = deps.now || Date.now;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const openTab =
    deps.openTab ||
    ((request) => {
      const wtm = createWtManager();
      return wtm.createTab({ title: request.title, command: request.command });
    });
  const attachLimiter =
    deps.attachLimiter ||
    createTransientTabLimiter({
      now,
      ttlMs: deps.attachTabTtlMs,
      limits: deps.attachLimits,
    });

  const workers = new Map();
  let pipeline = { phase: "exec", fix_attempt: 0 };
  let startedAt = now();
  let timer = null;
  let closed = false;
  let frameCount = 0;
  let selectedWorker = null;
  let previousSelectedWorker = null;
  // focus: "rail" | "detail"
  let focus = "rail";
  let detailScrollOffset = 0;
  let followTail = false;
  let rawMode = false;
  let focusTab = "log"; // "log" | "detail" | "files"
  let helpOverlay = false;
  let inputAttached = false;
  let rawModeEnabled = false;

  // UX 위젯 (ISSUE-14)
  const tokenTracker = createTokenTracker();
  const searchState = createSearchState();
  const vimMotion = createVimMotion();
  const panelResizer = createPanelResizer({
    initialRatio: focus === "detail" ? 0.2 : 0.3,
  });

  // Synapse 실시간 관제 (Phase 3)
  const synapseMetrics = deps.synapseMetrics || createMetricsCollector();
  const synapseStream =
    deps.synapseStream ||
    createSynapseEventStream({
      onEvent(event) {
        synapseMetrics.ingest(event);
      },
      fetchImpl: deps.synapseFetch,
    });
  // Synapse 자동 시작 (옵트인: deps.enableSynapse)
  if (deps.enableSynapse) synapseStream.start();

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
    return Math.max(0, Math.round((now() - startedAt) / 1000));
  }

  function getViewportColumns() {
    const v = Number.isFinite(columns)
      ? columns
      : Number.isFinite(stream?.columns)
        ? stream.columns
        : Number.isFinite(process.stdout?.columns)
          ? process.stdout.columns
          : FALLBACK_COLUMNS;
    return Math.max(48, v || FALLBACK_COLUMNS);
  }

  function getViewportRows() {
    const v = Number.isFinite(stream?.rows)
      ? stream.rows
      : Number.isFinite(process.stdout?.rows)
        ? process.stdout.rows
        : FALLBACK_ROWS;
    return Math.max(10, v || FALLBACK_ROWS);
  }

  function visibleWorkerNames() {
    return [...workers.keys()].sort();
  }

  function ensureSelectedWorker(names) {
    if (names.length === 0) {
      selectedWorker = null;
      return;
    }
    if (!selectedWorker || !workers.has(selectedWorker))
      selectedWorker = names[0];
  }

  function setSelectedWorker(nextWorker, { preserveTrail = true } = {}) {
    if (!nextWorker || nextWorker === selectedWorker) return;
    if (preserveTrail && selectedWorker && workers.has(selectedWorker)) {
      previousSelectedWorker = selectedWorker;
    }
    selectedWorker = nextWorker;
    detailScrollOffset = 0;
  }

  function selectRelative(offset) {
    const names = visibleWorkerNames();
    if (names.length === 0) return;
    ensureSelectedWorker(names);
    const idx = Math.max(0, names.indexOf(selectedWorker));
    setSelectedWorker(names[(idx + offset + names.length) % names.length]);
    render();
  }

  function selectMostRecentChangedWorker() {
    const names = visibleWorkerNames();
    if (names.length === 0) return;
    ensureSelectedWorker(names);
    const target = names.reduce((best, name) => {
      const changedAt = workers.get(name)?._statusChangedAt || 0;
      const bestChangedAt = workers.get(best)?._statusChangedAt || 0;
      return changedAt > bestChangedAt ? name : best;
    }, names[0]);
    setSelectedWorker(target);
    render();
  }

  function scrollDetail(delta) {
    followTail = false;
    detailScrollOffset = Math.max(0, detailScrollOffset + delta);
    render();
  }

  // ── doClose (내부 함수) ─────────────────────────────────────────────
  function doClose() {
    if (closed) return;
    if (timer) clearInterval(timer);
    synapseStream.stop();
    if (inputAttached && typeof input?.off === "function")
      input.off("data", handleInput);
    if (rawModeEnabled && typeof input?.setRawMode === "function")
      input.setRawMode(false);
    if (inputAttached && typeof input?.pause === "function") input.pause();
    exitAltScreen();
    closed = true;
  }

  // ── 키 입력 ──────────────────────────────────────────────────────────
  function handleInput(chunk) {
    const key = String(chunk);
    if (key === "\u0003") {
      doClose();
      return;
    }

    // 검색 모드 활성 중: 키를 검색 상태에 위임
    if (searchState.active) {
      if (searchState.handleKey(key)) {
        render();
        return;
      }
    }

    // Help overlay: 아무 키나 누르면 닫기
    if (helpOverlay) {
      helpOverlay = false;
      render();
      return;
    }

    // Enter: 선택된 워커 세션에 attach (k9s 패턴)
    if (key === "\r" || key === "\n") {
      if (!selectedWorker) return;
      const w = workers.get(selectedWorker);
      if (!w) return;
      const sessionTarget = w.sessionName || w.paneName;
      if (!sessionTarget) {
        showFlash("세션 정보 없음 — 아직 준비 중");
        return;
      }
      attachToSession(w);
      return;
    }

    // Tab: rail ↔ detail 포커스 전환
    if (key === "\t") {
      focus = focus === "rail" ? "detail" : "rail";
      render();
      return;
    }

    // Shift+Arrow: 포커스 이동 + 워커 선택
    if (key === "\x1b[1;2A") {
      selectRelative(-1);
      return;
    } // Shift+Up → 워커 위
    if (key === "\x1b[1;2B") {
      selectRelative(1);
      return;
    } // Shift+Down → 워커 아래
    if (key === "\x1b[1;2D") {
      focus = "rail";
      render();
      return;
    } // Shift+Left → rail
    if (key === "\x1b[1;2C") {
      focus = "detail";
      render();
      return;
    } // Shift+Right → detail

    if (focus === "detail") {
      // detail 포커스: j/k/ArrowDown/Up = 스크롤
      if (key === "j" || key === "\u001b[B") {
        scrollDetail(1);
        return;
      }
      if (key === "k" || key === "\u001b[A") {
        scrollDetail(-1);
        return;
      }
    } else {
      // rail 포커스: j/k = 워커 선택
      if (key === "j" || key === "\u001b[B") {
        selectRelative(1);
        return;
      }
      if (key === "k" || key === "\u001b[A") {
        selectRelative(-1);
        return;
      }
    }

    // vim 모션: gg(첫 워커/상단), G(마지막 워커/하단)
    const motion = vimMotion.handleKey(key);
    if (motion === "gg") {
      if (focus === "detail") {
        followTail = false;
        detailScrollOffset = 0;
      } else {
        const names = visibleWorkerNames();
        if (names.length > 0) setSelectedWorker(names[0]);
      }
      render();
      return;
    }
    if (motion === "G") {
      if (focus === "detail") {
        followTail = true;
        detailScrollOffset = 0;
      } else {
        const names = visibleWorkerNames();
        if (names.length > 0) setSelectedWorker(names[names.length - 1]);
      }
      render();
      return;
    }
    // 단일 g는 vimMotion 대기 → return하지 않음 (이전 동작 유지)
    if (key === "g") return;

    // PgUp/PgDn: 페이지 단위 스크롤
    const pageSize = Math.max(1, Math.floor(getViewportRows() / 2));
    if (key === "\x1b[5~") {
      scrollDetail(-pageSize);
      return;
    } // PgUp
    if (key === "\x1b[6~") {
      scrollDetail(pageSize);
      return;
    } // PgDn
    // f: follow-tail 토글
    if (key === "f") {
      followTail = !followTail;
      if (followTail) detailScrollOffset = 0;
      render();
      return;
    }
    // r: raw mode 토글
    if (key === "r") {
      rawMode = !rawMode;
      render();
      return;
    }
    // l: 탭 전환 (Log → Detail → Files)
    if (key === "l") {
      const tabs = ["log", "detail", "files"];
      focusTab = tabs[(tabs.indexOf(focusTab) + 1) % tabs.length];
      detailScrollOffset = 0;
      render();
      return;
    }
    // /: 검색 모드 활성화 (vim 패턴)
    if (key === "/") {
      searchState.activate();
      render();
      return;
    }
    // n: 검색 결과 다음 / 최근 변경 워커
    if (key === "n") {
      if (searchState.query) {
        const names = visibleWorkerNames();
        const idx = names.indexOf(selectedWorker);
        const match = searchState.findMatch(names, idx, 1);
        if (match >= 0) {
          setSelectedWorker(names[match]);
          render();
        } else {
          showFlash(`검색 결과 없음: ${searchState.query}`);
        }
      } else {
        selectMostRecentChangedWorker();
      }
      return;
    }
    // N: 검색 결과 이전
    if (key === "N") {
      if (searchState.query) {
        const names = visibleWorkerNames();
        const idx = names.indexOf(selectedWorker);
        const match = searchState.findMatch(names, idx, -1);
        if (match >= 0) {
          setSelectedWorker(names[match]);
          render();
        }
      }
      return;
    }
    // H: rail 축소 (패널 리사이즈)
    if (key === "H") {
      panelResizer.shrinkRail();
      render();
      return;
    }
    // L: rail 확대 (패널 리사이즈)
    if (key === "L") {
      panelResizer.expandRail();
      render();
      return;
    }
    // h/?: 도움말 오버레이 토글
    if (key === "h" || key === "?") {
      helpOverlay = true;
      render();
      return;
    }
    // q: 대시보드 종료
    if (key === "q") {
      doClose();
      return;
    }
    // 1-9: 워커 직접 선택
    if (/^[1-9]$/.test(key)) {
      const names = visibleWorkerNames();
      const target = names[Number.parseInt(key, 10) - 1];
      if (target) {
        setSelectedWorker(target);
        render();
      }
      return;
    }
  }

  // ── Enter→attach (k9s 패턴) ───────────────────────────────────────────
  async function attachToSession(worker) {
    let request;
    try {
      request = buildDashboardAttachRequest(worker);
    } catch (error) {
      showFlash(`[attach] ${error.message}`);
      return false;
    }

    const lease = attachLimiter.acquire(request.kind);
    if (!lease.ok) {
      const seconds = Math.max(1, Math.ceil(lease.retryAfterMs / 1000));
      const label = lease.kind === "remote" ? "원격" : "로컬";
      showFlash(
        `[attach] ${label} 탭 제한(${lease.limit}/30초) — ${seconds}초 후 다시 시도`,
      );
      return false;
    }

    try {
      await openTab(request);
    } catch (error) {
      lease.release?.();
      const reason = error?.reasonCode || error?.message || "unknown";
      showFlash(`[attach] 탭 열기 실패: ${reason}`);
      return false;
    }

    if (rawModeEnabled && typeof input?.setRawMode === "function") {
      input.setRawMode(false);
      rawModeEnabled = false;
    }
    if (typeof input?.pause === "function") input.pause();
    exitAltScreen();

    setTimeoutFn(() => {
      enterAltScreen();
      if (typeof input?.setRawMode === "function") {
        input.setRawMode(true);
        rawModeEnabled = true;
      }
      if (typeof input?.resume === "function") input.resume();
      render();
    }, 200);
    return true;
  }

  // ── flash 메시지 (완료/실패 알림용) ────────────────────────────────────
  let flashMessage = "";
  let flashTimer = null;
  function showFlash(msg, durationMs = 5000) {
    flashMessage = msg;
    if (flashTimer) clearTimeoutFn(flashTimer);
    flashTimer = setTimeoutFn(() => {
      flashMessage = "";
      render();
    }, durationMs);
    render();
  }

  function attachInput() {
    if (inputAttached) return;
    if (
      !isTTY ||
      (!forceTTY && !input?.isTTY) ||
      typeof input?.on !== "function"
    )
      return;
    inputAttached = true;
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
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

    // Help overlay: 전체 화면 오버레이
    if (helpOverlay) {
      return buildHelpOverlay(totalCols, totalRows);
    }

    const elapsed = nowElapsedSec();
    const renderTime = Date.now();

    // Tier1: 상단 고정 2행
    const tier1 = buildTier1(
      names,
      workers,
      pipeline,
      elapsed,
      totalCols,
      VERSION,
      renderTime,
    );
    // flash 메시지 (완료/실패 알림)
    if (flashMessage) {
      tier1.push(
        truncate(` ${color("▸", MOCHA.green)} ${flashMessage}`, totalCols),
      );
    }
    // Synapse 실시간 메트릭 (활성 시)
    if (synapseStream.isRunning) {
      const metricsSnap = synapseMetrics.snapshot();
      tier1.push(
        truncate(renderMetricsTier1(metricsSnap, totalCols), totalCols),
      );
    }
    // 검색 프롬프트 (/ 모드)
    const searchPrompt = searchState.renderPrompt(totalCols);
    if (searchPrompt) {
      tier1.push(truncate(searchPrompt, totalCols));
    }

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
      const summaryBar = buildSummaryBar(
        names,
        workers,
        selectedWorker,
        pipeline,
        totalCols,
        VERSION,
      );
      const selectedState = workers.get(selectedWorker);
      const focusPaneHeight = Math.max(
        8,
        totalRows - tier1.length - summaryBar.length,
      );
      const focusPane = buildFocusPane(selectedWorker, selectedState, {
        width: totalCols,
        height: focusPaneHeight,
        scrollOffset: detailScrollOffset,
        followTail,
        rawMode,
        focused: focus === "detail",
        activeTab: focusTab,
        time: renderTime,
      });
      return [...tier1, ...summaryBar, ...focusPane];
    }

    // 좌우 분할: Left Rail | Right Focus (H/L로 비율 조정 가능)
    const GAP = 1; // rail과 focus 사이 구분선
    const railWidth = Math.max(
      MIN_CARD_WIDTH,
      Math.floor(totalCols * panelResizer.ratio),
    );
    const focusWidth = totalCols - railWidth - GAP;
    const bodyHeight = Math.max(6, totalRows - tier1.length - 1); // -1 for status bar

    // 반응형 compact: 워커 카드가 가용 높이 초과 시 자동 전환
    const normalCardHeight = 8; // box top/bot + 6 content lines
    const useCompact = names.length * normalCardHeight > bodyHeight;

    // Left Rail: 워커 카드 세로 스택
    const railLines = [];
    for (const name of names) {
      const card = buildWorkerRail(name, workers.get(name), {
        width: railWidth,
        selected: name === selectedWorker,
        previousSelected: name === previousSelectedWorker,
        focused: focus === "rail" && name === selectedWorker,
        rawMode,
        compact: useCompact,
        time: renderTime,
      });
      railLines.push(...card);
    }
    // rail 높이를 bodyHeight에 맞춤 (부족하면 빈 줄, 넘치면 자름)
    while (railLines.length < bodyHeight)
      railLines.push(padRight("", railWidth));
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
        activeTab: focusTab,
        time: renderTime,
      });
    }
    while (focusLines.length < bodyHeight)
      focusLines.push(padRight("", focusWidth));
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
    const allDone = names.every((n) => {
      const s = runtimeStatus(workers.get(n));
      return s === "ok" || s === "completed" || s === "failed";
    });
    const statusText = allDone
      ? "  Enter: attach • q: 종료"
      : "  Enter: attach • Tab: 포커스 • j/k: 이동 • h: 도움말";
    const statusBar = truncate(color(statusText, MOCHA.subtext), totalCols);

    return [...tier1, ...composedRows, statusBar];
  }

  // ── altScreen diff render (batched single write → 깜빡임 방지) ───────
  function renderAltScreen() {
    const newRows = buildRows();
    rowBuf.set(newRows);
    const dirty = rowBuf.diff();
    const prevLen = rowBuf.prevLen;

    if (dirty.length === 0 && newRows.length === prevLen) return;

    let buf = "";
    for (const i of dirty) {
      buf += moveTo(i + 1, 1) + clearLine + (newRows[i] || "");
    }
    if (prevLen > newRows.length) {
      for (let i = newRows.length; i < prevLen; i++) {
        buf += moveTo(i + 1, 1) + clearLine;
      }
    }
    if (buf) write(buf);

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
    try {
      if (isTTY) {
        renderAltScreen();
      } else {
        renderAppendOnly();
      }
    } finally {
      previousSelectedWorker = null;
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
      const existing = workers.get(paneName) || {
        cli: "codex",
        status: "pending",
      };
      const merged = normalizeWorkerState(existing, state);
      const nextSig = JSON.stringify({
        cli: merged.cli,
        status: merged.status,
        role: merged.role,
        snapshot: merged.snapshot,
        summary: merged.summary,
        detail: merged.detail,
        findings: merged.findings,
        files_changed: merged.files_changed,
        confidence: merged.confidence,
        tokens: merged.tokens,
        progress: merged.progress,
        handoff: merged.handoff,
      });
      const sigChanged = nextSig !== existing._sig;
      const explicitElapsed = Number.isFinite(state.elapsed)
        ? Math.max(0, Math.round(state.elapsed))
        : null;
      merged._sig = nextSig;
      merged._logSec = sigChanged
        ? (explicitElapsed ?? nowElapsedSec())
        : Number.isFinite(existing._logSec)
          ? existing._logSec
          : (explicitElapsed ?? nowElapsedSec());
      workers.set(paneName, merged);
      // 토큰 히스토리 추적 (스파크라인용)
      if (merged.tokens !== undefined)
        tokenTracker.record(paneName, merged.tokens);
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
      setSelectedWorker(name);
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

    getFocusTab() {
      return focusTab;
    },

    setFocusTab(tab) {
      const valid = ["log", "detail", "files"];
      if (valid.includes(tab)) {
        focusTab = tab;
        detailScrollOffset = 0;
      }
    },

    getLayout() {
      return layoutHint;
    },

    toggleHelp(force) {
      helpOverlay = typeof force === "boolean" ? force : !helpOverlay;
    },

    isHelpVisible() {
      return helpOverlay;
    },

    showFlash,

    attachWorker(name) {
      const w = workers.get(name);
      if (!w) return false;
      return attachToSession(w);
    },

    // Synapse 관제 API
    startSynapse() {
      synapseStream.start();
    },
    stopSynapse() {
      synapseStream.stop();
    },
    getSynapseMetrics() {
      return synapseMetrics.snapshot();
    },

    close() {
      doClose();
    },
  };
}

// ── Conductor Tier: 세션 테이블 렌더러 ─────────────────────────────────
//
// renderConductorTier(snapshot, cols)
//   snapshot: conductor.getSnapshot() 반환 배열
//   cols:     터미널 폭 (기본 100)
//
// 레이아웃:
//   ┌─ CONDUCTOR ──────────────────────────────────────────┐
//   │ ID       Agent   Host   Health       Last Out  Restarts Why │
//   │ abc123   codex   local  ■ OK         2s ago    0           │
//   └──────────────────────────────────────────────────────┘
//
// Health 색상: healthy=green, stalled=yellow, input_wait=cyan,
//              failed=red, dead/init/starting=dim

const CONDUCTOR_STATE_LABEL = {
  init: { label: "INIT", seq: MOCHA.subtext },
  starting: { label: "START", seq: MOCHA.executing },
  healthy: { label: "OK", seq: MOCHA.ok },
  stalled: { label: "STALL", seq: MOCHA.yellow },
  input_wait: { label: "INPUT_WAIT", seq: FG.cyan },
  failed: { label: "FAIL", seq: MOCHA.fail },
  restarting: { label: "RESTART", seq: MOCHA.partial },
  dead: { label: "DEAD", seq: FG.gray },
  completed: { label: "DONE", seq: MOCHA.ok },
};

function conductorHealthCell(state) {
  const entry = CONDUCTOR_STATE_LABEL[state] || {
    label: state.toUpperCase(),
    seq: FG.gray,
  };
  return `${entry.seq}■ ${entry.label}${RESET}`;
}

function conductorRelTime(ms) {
  if (!ms) return "—";
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 0) return "—";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

/**
 * Conductor 세션 테이블을 문자열 배열(행 목록)로 렌더링.
 *
 * @param {object[]} snapshot — conductor.getSnapshot() 결과
 * @param {number}   [cols=100] — 터미널 폭
 * @returns {string[]} 렌더링된 행 목록 (altScreen rowBuf.set()에 바로 삽입 가능)
 */
export function renderConductorTier(snapshot, cols = 100) {
  const width = Math.max(48, cols);
  const inner = width - 4; // border: '│ ' + content + ' │'

  // ── 열 너비 계산 ────────────────────────────────────────
  // ID(8) Agent(7) Host(6) Health(dyn) LastOut(dyn) Restarts(8) Why(rest)
  const COL_ID = 8;
  const COL_AGENT = 7;
  const COL_HOST = 6;
  const COL_RESTARTS = 4;
  const COL_HEALTH = 12; // '■ INPUT_WAIT' = 12 chars
  const COL_LASTOUT = 9; // '999m ago' = 8 + space
  // Why gets the remainder
  const fixedCols =
    COL_ID + COL_AGENT + COL_HOST + COL_HEALTH + COL_LASTOUT + COL_RESTARTS + 6; // 6 spaces between cols
  const COL_WHY = Math.max(4, inner - fixedCols);

  function cell(text, width_) {
    return clip(String(text ?? ""), width_);
  }

  function buildRow(id, agent, host, healthCell, lastOut, restarts, why) {
    const idC = cell(id, COL_ID);
    const agentC = cell(agent, COL_AGENT);
    const hostC = cell(host, COL_HOST);
    const restartsC = cell(String(restarts ?? 0), COL_RESTARTS);
    const lastOutC = clip(lastOut, COL_LASTOUT);
    const whyC = cell(why, COL_WHY);
    // healthCell already has ANSI codes; pad its visible width manually
    const healthVis = wcswidth(stripAnsi(healthCell));
    const healthPad = Math.max(0, COL_HEALTH - healthVis);
    const healthC = healthCell + " ".repeat(healthPad);

    return `${idC} ${agentC} ${hostC} ${healthC} ${lastOutC} ${restartsC} ${whyC}`;
  }

  const boxWidth = inner;

  // ── 타이틀 행 ───────────────────────────────────────────
  const titleText = ` CONDUCTOR `;
  const titleColored = bold(color(titleText, FG.accent));
  // Border top with title embedded: ┌─ CONDUCTOR ──...─┐
  const dashLen = Math.max(0, boxWidth - titleText.length);
  const dashLeft = 1;
  const dashRight = Math.max(0, dashLen - dashLeft);
  const borderSeq = MOCHA.border;
  const topBorder = `${borderSeq}┌${"─".repeat(dashLeft)}${RESET}${titleColored}${borderSeq}${"─".repeat(dashRight)}┐${RESET}`;

  // ── ヘッダー行 ───────────────────────────────────────────
  const headerRow = buildRow(
    "ID",
    "Agent",
    "Host",
    clip("Health", COL_HEALTH),
    "Last Out",
    "Rst",
    "Why",
  );
  const headerLine = `${borderSeq}│${RESET} ${dim(headerRow)} ${borderSeq}│${RESET}`;

  // ── データ行 ────────────────────────────────────────────
  const dataLines = [];
  if (!snapshot || snapshot.length === 0) {
    const emptyMsg = color("(no sessions)", FG.muted);
    const _emptyPad = clip(
      stripAnsi(emptyMsg) === "(no sessions)" ? emptyMsg : emptyMsg,
      inner,
    );
    dataLines.push(
      `${borderSeq}│${RESET} ${padRight(emptyMsg, inner - 2)} ${borderSeq}│${RESET}`,
    );
  } else {
    for (const s of snapshot) {
      const id = String(s.id ?? "").slice(0, COL_ID);
      const agent = String(s.agent ?? "unknown").slice(0, COL_AGENT);
      const host = "local";
      const state = s.state ?? "init";
      const healthCell = conductorHealthCell(state);
      const lastOut = conductorRelTime(s.health?.lastProbeAt ?? null);
      const restarts = s.restarts ?? 0;
      // derive "why" from last state transition context
      const why = s.health?.inputWaitPattern
        ? String(s.health.inputWaitPattern).slice(0, COL_WHY)
        : "";

      const rowText = buildRow(
        id,
        agent,
        host,
        healthCell,
        lastOut,
        restarts,
        why,
      );
      dataLines.push(`${borderSeq}│${RESET} ${rowText} ${borderSeq}│${RESET}`);
    }
  }

  // ── Bottom border ─────────────────────────────────────
  const botBorder = `${borderSeq}└${"─".repeat(boxWidth)}┘${RESET}`;

  return [topBorder, headerLine, ...dataLines, botBorder];
}

// 하위 호환
export { createLogDashboard as createTui };
