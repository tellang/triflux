// hub/team/ansi.mjs — Zero-dependency ANSI escape 유틸리티
// TUI 대시보드 렌더링을 위한 최소 헬퍼.

export const ESC = "\x1b";

// ── 화면 ──
export const altScreenOn  = `${ESC}[?1049h`;
export const altScreenOff = `${ESC}[?1049l`;
export const clearScreen  = `${ESC}[2J`;
export const cursorHome   = `${ESC}[H`;
export const cursorHide   = `${ESC}[?25l`;
export const cursorShow   = `${ESC}[?25h`;

// ── 커서 이동 ──
export function moveTo(row, col) { return `${ESC}[${row};${col}H`; }
export function moveUp(n = 1)    { return `${ESC}[${n}A`; }
export function moveDown(n = 1)  { return `${ESC}[${n}B`; }

// ── 줄 제어 ──
export const clearLine    = `${ESC}[2K`;
export const clearToEnd   = `${ESC}[K`;

// ── 색상 (triflux 디자인 시스템) ──
export const RESET = `${ESC}[0m`;
export const BOLD  = `${ESC}[1m`;
export const DIM   = `${ESC}[2m`;

export const FG = {
  white:    `${ESC}[97m`,
  black:    `${ESC}[30m`,
  red:      `${ESC}[31m`,
  green:    `${ESC}[32m`,
  yellow:   `${ESC}[33m`,
  blue:     `${ESC}[34m`,
  magenta:  `${ESC}[35m`,
  cyan:     `${ESC}[36m`,
  gray:     `${ESC}[90m`,
  // triflux 브랜드
  codex:    `${ESC}[97m`,              // bright white
  gemini:   `${ESC}[38;5;39m`,         // blue
  claude:   `${ESC}[38;2;232;112;64m`, // orange
  triflux:  `${ESC}[38;5;214m`,        // amber
  accent:   `${ESC}[38;5;75m`,         // light blue (Catppuccin blue)
  muted:    `${ESC}[38;5;245m`,        // gray
};

export const BG = {
  black:   `${ESC}[40m`,
  red:     `${ESC}[41m`,
  green:   `${ESC}[42m`,
  yellow:  `${ESC}[43m`,
  blue:    `${ESC}[44m`,
  header:  `${ESC}[48;5;236m`,  // dark gray
};

// ── 색상 헬퍼 ──
export function color(text, fg, bg) {
  const prefix = (fg || "") + (bg || "");
  return prefix ? `${prefix}${text}${RESET}` : text;
}

export function bold(text)  { return `${BOLD}${text}${RESET}`; }
export function dim(text)   { return `${DIM}${text}${RESET}`; }

// ── 박스 그리기 (유니코드 테두리) ──
const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" };

export function box(lines, width) {
  const top = `${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`;
  const bot = `${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`;
  const mid = `${BOX.ml}${BOX.h.repeat(width - 2)}${BOX.mr}`;
  const body = lines.map((l) => `${BOX.v} ${padRight(l, width - 4)} ${BOX.v}`);
  return { top, body, bot, mid };
}

// ── 텍스트 유틸 ──
export function padRight(str, len) {
  // ANSI 코드 제외한 실제 표시 길이 기준 패딩
  const visible = stripAnsi(str);
  const pad = Math.max(0, len - visible.length);
  return str + " ".repeat(pad);
}

export function truncate(str, maxLen) {
  const visible = stripAnsi(str);
  if (visible.length <= maxLen) return str;
  return visible.slice(0, maxLen - 1) + "…";
}

export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)/g, "");
}

// ── 진행률 바 ──
export function progressBar(ratio, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = width - filled;
  return `${FG.accent}${"█".repeat(filled)}${FG.muted}${"░".repeat(empty)}${RESET}`;
}

// ── 상태 아이콘 ──
export const STATUS_ICON = {
  running:   `${FG.blue}⏳${RESET}`,
  completed: `${FG.green}✓${RESET}`,
  failed:    `${FG.red}✗${RESET}`,
  pending:   `${FG.gray}⏸${RESET}`,
};

export const CLI_ICON = {
  codex:  `${FG.codex}⚪${RESET}`,
  gemini: `${FG.gemini}🔵${RESET}`,
  claude: `${FG.claude}🟠${RESET}`,
};
