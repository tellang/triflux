// hub/team/ansi.mjs — Zero-dependency ANSI escape 유틸리티
// TUI 대시보드 렌더링을 위한 최소 헬퍼.
//
// wcwidth 지원: emoji/CJK wide=2셀, combining mark=0셀, ANSI escape=0셀
// 외부 의존성 없이 Unicode 범위 기반으로 구현.

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

export function box(lines, width, borderColor = "") {
  const bc = borderColor;
  const rst = bc ? RESET : "";
  const top = `${bc}${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}${rst}`;
  const bot = `${bc}${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}${rst}`;
  const mid = `${bc}${BOX.ml}${BOX.h.repeat(width - 2)}${BOX.mr}${rst}`;
  const body = lines.map((l) => `${bc}${BOX.v}${rst} ${padRight(l, width - 4)} ${bc}${BOX.v}${rst}`);
  return { top, body, bot, mid };
}

// ── wcwidth 구현 (외부 의존성 없음) ──
// Unicode 코드포인트의 터미널 표시 너비를 반환: 0(combining), 1(일반), 2(wide)
function charWidth(cp) {
  // combining / zero-width 범위
  if (
    cp === 0 || cp === 0xAD ||
    (cp >= 0x0300 && cp <= 0x036F) ||  // Combining Diacritical Marks
    (cp >= 0x0610 && cp <= 0x061A) ||
    (cp >= 0x064B && cp <= 0x065F) ||
    (cp >= 0x1AB0 && cp <= 0x1AFF) ||
    (cp >= 0x1DC0 && cp <= 0x1DFF) ||
    (cp >= 0x20D0 && cp <= 0x20FF) ||  // Combining Diacritical Marks for Symbols
    (cp >= 0xFE20 && cp <= 0xFE2F)     // Combining Half Marks
  ) return 0;

  // Wide: CJK Unified Ideographs, Hangul, Fullwidth, emoji 주요 블록
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x2EFF) ||  // CJK Radicals Supplement
    (cp >= 0x2F00 && cp <= 0x2FFF) ||
    (cp >= 0x3000 && cp <= 0x303F) ||  // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309F) ||  // Hiragana
    (cp >= 0x30A0 && cp <= 0x30FF) ||  // Katakana
    (cp >= 0x3100 && cp <= 0x312F) ||
    (cp >= 0x3130 && cp <= 0x318F) ||  // Hangul Compatibility Jamo
    (cp >= 0x3190 && cp <= 0x319F) ||
    (cp >= 0x31C0 && cp <= 0x31EF) ||
    (cp >= 0x3200 && cp <= 0x32FF) ||
    (cp >= 0x3300 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified Ideographs
    (cp >= 0xA000 && cp <= 0xA48F) ||
    (cp >= 0xA490 && cp <= 0xA4CF) ||
    (cp >= 0xA960 && cp <= 0xA97F) ||
    (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||  // CJK Compatibility Ideographs
    (cp >= 0xFE10 && cp <= 0xFE1F) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||  // Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1B000 && cp <= 0x1B0FF) ||
    (cp >= 0x1F004 && cp <= 0x1F0CF) ||
    (cp >= 0x1F200 && cp <= 0x1F2FF) ||
    (cp >= 0x1F300 && cp <= 0x1F64F) || // Misc Symbols, Emoticons
    (cp >= 0x1F680 && cp <= 0x1F6FF) || // Transport & Map
    (cp >= 0x1F900 && cp <= 0x1FAFF) || // Supplemental Symbols
    (cp >= 0x20000 && cp <= 0x2FFFD) ||
    (cp >= 0x30000 && cp <= 0x3FFFD)
  ) return 2;

  return 1;
}

// 문자열의 터미널 표시 너비 계산 (ANSI escape 제외, wcwidth 적용)
export function wcswidth(str) {
  const plain = stripAnsi(str);
  let width = 0;
  for (const char of plain) {
    width += charWidth(char.codePointAt(0));
  }
  return width;
}

// ── 텍스트 유틸 ──
export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(\x07|\x1b\\)/g, "");
}

// wcwidth-aware padRight: ANSI + wide char 보정 포함
export function padRight(str, len) {
  const w = wcswidth(str);
  const pad = Math.max(0, len - w);
  return str + " ".repeat(pad);
}

// wcwidth-aware truncate: wide char 경계에서 자름
export function truncate(str, maxLen) {
  const plain = stripAnsi(str);
  const w = wcswidth(plain);
  if (w <= maxLen) return str;

  let acc = 0;
  let i = 0;
  for (const char of plain) {
    const cw = charWidth(char.codePointAt(0));
    if (acc + cw > maxLen - 1) break;
    acc += cw;
    i += char.length;
  }
  return plain.slice(0, i) + "…";
}

// wcwidth-aware clip: 정확히 width 셀에 맞게 자르고 패딩 (wide char 경계 보정)
export function clip(str, width) {
  const plain = stripAnsi(str);
  let acc = 0;
  let i = 0;
  for (const char of plain) {
    const cw = charWidth(char.codePointAt(0));
    if (acc + cw > width) {
      // wide char이 경계를 넘으면 공백으로 채움
      const result = plain.slice(0, i) + " ".repeat(width - acc);
      return result;
    }
    acc += cw;
    i += char.length;
  }
  return plain + " ".repeat(width - acc);
}

// ── Catppuccin Mocha 색상 상수 ──
export const MOCHA = {
  ok:        `${ESC}[38;5;114m`,  // #a6e3a1 green
  partial:   `${ESC}[38;5;216m`,  // #fab387 peach
  fail:      `${ESC}[38;5;210m`,  // #f38ba8 red
  thinking:  `${ESC}[38;5;183m`,  // #cba6f7 mauve
  executing: `${ESC}[38;5;117m`,  // #74c7ec sky
  border:    `${ESC}[38;5;238m`,  // #45475a surface1
};

// ── badge 헬퍼 ──
// statusBadge(status) → ANSI 색상 문자열
export function statusBadge(status) {
  switch (status) {
    case "ok":
    case "completed":
    case "done":
      return `${MOCHA.ok}✓ ${status}${RESET}`;
    case "partial":
    case "in_progress":
    case "running":
      return `${MOCHA.partial}◑ ${status}${RESET}`;
    case "fail":
    case "failed":
    case "error":
      return `${MOCHA.fail}✗ ${status}${RESET}`;
    case "thinking":
      return `${MOCHA.thinking}⠿ ${status}${RESET}`;
    case "executing":
      return `${MOCHA.executing}▶ ${status}${RESET}`;
    default:
      return `${FG.muted}· ${status}${RESET}`;
  }
}

// ── 진행률 바 ──
// progressBar(percent, width) — percent: 0~100, ANSI colored bar string 반환
export function progressBar(percent, width = 20) {
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const fillColor = percent >= 100 ? MOCHA.ok : percent >= 50 ? MOCHA.partial : MOCHA.fail;
  return `${fillColor}${"█".repeat(filled)}${MOCHA.border}${"░".repeat(empty)}${RESET}`;
}

// ── 상태 아이콘 ──
export const STATUS_ICON = {
  running:   `${MOCHA.partial}⏳${RESET}`,
  completed: `${MOCHA.ok}✓${RESET}`,
  failed:    `${MOCHA.fail}✗${RESET}`,
  pending:   `${FG.gray}⏸${RESET}`,
};

export const CLI_ICON = {
  codex:  `${FG.codex}⚪${RESET}`,
  gemini: `${FG.gemini}🔵${RESET}`,
  claude: `${FG.claude}🟠${RESET}`,
};
