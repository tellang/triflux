// hub/team/ansi.mjs — Zero-dependency ANSI escape 유틸리티
// TUI 대시보드 렌더링을 위한 최소 헬퍼.
//
// wcwidth 지원: emoji/CJK wide=2셀, combining mark=0셀, ANSI escape=0셀
// 외부 의존성 없이 Unicode 범위 기반으로 구현.

export const ESC = "\x1b";

// ── 화면 ──
export const altScreenOn = `${ESC}[?1049h`;
export const altScreenOff = `${ESC}[?1049l`;
export const clearScreen = `${ESC}[2J`;
export const cursorHome = `${ESC}[H`;
export const cursorHide = `${ESC}[?25l`;
export const cursorShow = `${ESC}[?25h`;

// ── 커서 이동 ──
export function moveTo(row, col) {
  return `${ESC}[${row};${col}H`;
}
export function moveUp(n = 1) {
  return `${ESC}[${n}A`;
}
export function moveDown(n = 1) {
  return `${ESC}[${n}B`;
}

// ── 줄 제어 ──
export const clearLine = `${ESC}[2K`;
export const clearToEnd = `${ESC}[K`;
export const eraseBelow = `${ESC}[J`;

// ── 색상 (triflux 디자인 시스템) ──
export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;

export const FG = {
  white: `${ESC}[97m`,
  black: `${ESC}[30m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
  // triflux 브랜드
  codex: `${ESC}[38;2;16;163;127m`, // #10a37f codex green
  gemini: `${ESC}[38;5;39m`, // blue
  claude: `${ESC}[38;2;232;112;64m`, // orange
  triflux: `${ESC}[38;5;214m`, // amber
  accent: `${ESC}[38;5;75m`, // light blue (Catppuccin blue)
  muted: `${ESC}[38;5;245m`, // gray
};

export const BG = {
  black: `${ESC}[40m`,
  red: `${ESC}[41m`,
  green: `${ESC}[42m`,
  yellow: `${ESC}[43m`,
  blue: `${ESC}[44m`,
  header: `${ESC}[48;5;236m`, // dark gray
};

// ── 색상 헬퍼 ──
export function color(text, fg, bg) {
  const prefix = (fg || "") + (bg || "");
  return prefix ? `${prefix}${text}${RESET}` : text;
}

export function bold(text) {
  return `${BOLD}${text}${RESET}`;
}
export function dim(text) {
  return `${DIM}${text}${RESET}`;
}

export function lerpRgb(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function rgbSeq(rgb, mode = 38) {
  return `${ESC}[${mode};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function brightenRgb(rgb, amount = 0.3) {
  return lerpRgb(rgb, { r: 255, g: 255, b: 255 }, amount);
}

function parseRgbSeq(seq) {
  const match =
    typeof seq === "string"
      ? seq.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/)
      : null;
  if (!match) return null;
  return {
    r: Number.parseInt(match[1], 10),
    g: Number.parseInt(match[2], 10),
    b: Number.parseInt(match[3], 10),
  };
}

function reapplyBackground(text, bgSeq) {
  if (!bgSeq) return text;
  return `${bgSeq}${String(text).replaceAll(RESET, `${RESET}${bgSeq}`)}${RESET}`;
}

// ── 박스 그리기 (유니코드 테두리) ──
const BOX = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  ml: "├",
  mr: "┤",
};

function borderHighlightCell(width, totalRows, highlightPos) {
  if (!Number.isFinite(highlightPos)) return null;
  const perimeter = 2 * (width - 2) + 2 * totalRows;
  if (perimeter <= 0) return null;
  let pos = Math.floor(highlightPos) % perimeter;
  if (pos < 0) pos += perimeter;

  if (pos < width - 2) return { row: 0, col: pos + 1 };
  pos -= width - 2;
  if (pos < totalRows) return { row: pos, col: width - 1 };
  pos -= totalRows;
  if (pos < width - 2) return { row: totalRows - 1, col: width - 2 - pos };
  pos -= width - 2;
  return { row: totalRows - 1 - pos, col: 0 };
}

function renderBorderChar(
  glyph,
  row,
  col,
  highlightCell,
  borderSeq,
  highlightSeq,
) {
  if (highlightCell && highlightCell.row === row && highlightCell.col === col) {
    return `${highlightSeq}${glyph}${RESET}`;
  }
  return borderSeq ? `${borderSeq}${glyph}${RESET}` : glyph;
}

export function box(lines, width, borderColor = "", options = {}) {
  const isFn = typeof borderColor === "function";
  const totalRows = lines.length + 2;
  const highlightCell = borderHighlightCell(
    width,
    totalRows,
    options.highlightPos,
  );

  // Fast path: static border, no highlight — batch border chars (~13x less output)
  if (!highlightCell && !isFn) {
    const bc = borderColor || "";
    const rst = bc ? RESET : "";
    const hLine = BOX.h.repeat(Math.max(0, width - 2));
    const top = `${bc}${BOX.tl}${hLine}${BOX.tr}${rst}`;
    const bot = `${bc}${BOX.bl}${hLine}${BOX.br}${rst}`;
    const mid = `${bc}${BOX.ml}${hLine}${BOX.mr}${rst}`;
    const body = lines.map((l, i) => {
      const content =
        options.titleFlashBg && i === 0
          ? reapplyBackground(padRight(l, width - 4), options.titleFlashBg)
          : padRight(l, width - 4);
      return `${bc}${BOX.v}${rst} ${content} ${bc}${BOX.v}${rst}`;
    });
    return { top, body, bot, mid };
  }

  // Slow path: per-character rendering for highlight animation
  const bc = isFn ? (row) => borderColor(row, totalRows) : () => borderColor;
  const rst = isFn || borderColor ? RESET : "";
  const highlightSeq =
    options.highlightColor ||
    (() => {
      const parsed = parseRgbSeq(
        typeof borderColor === "string" ? borderColor : "",
      );
      return parsed ? rgbSeq(brightenRgb(parsed, 0.45)) : `${BOLD}${FG.white}`;
    })();
  const topChars = [
    BOX.tl,
    ...Array.from({ length: width - 2 }, () => BOX.h),
    BOX.tr,
  ];
  const botChars = [
    BOX.bl,
    ...Array.from({ length: width - 2 }, () => BOX.h),
    BOX.br,
  ];
  const top = topChars
    .map((glyph, col) =>
      renderBorderChar(glyph, 0, col, highlightCell, bc(0), highlightSeq),
    )
    .join("");
  const bot = botChars
    .map((glyph, col) =>
      renderBorderChar(
        glyph,
        totalRows - 1,
        col,
        highlightCell,
        bc(totalRows - 1),
        highlightSeq,
      ),
    )
    .join("");
  const mid = `${bc(Math.floor(totalRows / 2))}${BOX.ml}${BOX.h.repeat(Math.max(0, width - 2))}${BOX.mr}${rst}`;
  const body = lines.map((l, i) => {
    const row = i + 1;
    const content =
      options.titleFlashBg && i === 0
        ? reapplyBackground(padRight(l, width - 4), options.titleFlashBg)
        : padRight(l, width - 4);
    return `${renderBorderChar(BOX.v, row, 0, highlightCell, bc(row), highlightSeq)} ${content} ${renderBorderChar(BOX.v, row, width - 1, highlightCell, bc(row), highlightSeq)}`;
  });
  return { top, body, bot, mid };
}

// ── wcwidth 구현 (외부 의존성 없음) ──
// Unicode 코드포인트의 터미널 표시 너비를 반환: 0(combining), 1(일반), 2(wide)
function charWidth(cp) {
  // combining / zero-width 범위
  if (
    cp === 0 ||
    cp === 0xad ||
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe20 && cp <= 0xfe2f) // Combining Half Marks
  )
    return 0;

  // Wide: CJK Unified Ideographs, Hangul, Fullwidth, emoji 주요 블록
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x2eff) || // CJK Radicals Supplement
    (cp >= 0x2f00 && cp <= 0x2fff) ||
    (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0x3190 && cp <= 0x319f) ||
    (cp >= 0x31c0 && cp <= 0x31ef) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa48f) ||
    (cp >= 0xa490 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) ||
    (cp >= 0x1f004 && cp <= 0x1f0cf) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Misc Symbols, Emoticons
    (cp >= 0x1f680 && cp <= 0x1f6ff) || // Transport & Map
    (cp >= 0x1f900 && cp <= 0x1faff) || // Supplemental Symbols
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
    return 2;

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

// ANSI-preserving slice: ANSI escape를 보존하면서 visible width만큼 자름
function ansiSlice(str, maxWidth) {
  let result = "";
  let visWidth = 0;
  let hasAnsi = false;
  let i = 0;

  while (i < str.length) {
    if (str.charCodeAt(i) === 0x1b) {
      const rest = str.slice(i);
      const m = rest.match(/^(\x1b(?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1b\\)))/);
      if (m) {
        result += m[1];
        hasAnsi = true;
        i += m[1].length;
        continue;
      }
    }

    const cp = str.codePointAt(i);
    const charLen = cp > 0xffff ? 2 : 1;
    const cw = charWidth(cp);

    if (visWidth + cw > maxWidth) break;

    result += str.slice(i, i + charLen);
    visWidth += cw;
    i += charLen;
  }

  return { result, visWidth, hasAnsi };
}

// wcwidth-aware truncate: wide char 경계에서 자름 (ANSI 보존)
export function truncate(str, maxLen) {
  if (wcswidth(str) <= maxLen) return str;

  const { result, hasAnsi } = ansiSlice(str, maxLen - 1);
  return hasAnsi ? result + RESET + "…" : result + "…";
}

// wcwidth-aware clip: 정확히 width 셀에 맞게 자르고 패딩 (ANSI 보존, wide char 경계 보정)
export function clip(str, width) {
  const vis = wcswidth(str);
  if (vis <= width) return str + " ".repeat(width - vis);

  const { result, visWidth, hasAnsi } = ansiSlice(str, width);
  const suffix = hasAnsi ? RESET : "";
  return result + suffix + " ".repeat(Math.max(0, width - visWidth));
}

// ── Catppuccin Mocha 색상 상수 ──
export const MOCHA = {
  ok: `${ESC}[38;5;114m`, // #a6e3a1 green
  partial: `${ESC}[38;5;216m`, // #fab387 peach
  fail: `${ESC}[38;5;210m`, // #f38ba8 red
  thinking: `${ESC}[38;5;183m`, // #cba6f7 mauve
  executing: `${ESC}[38;5;117m`, // #74c7ec sky
  border: `${ESC}[38;5;238m`, // #45475a surface1
  text: `${ESC}[38;2;205;214;244m`, // #cdd6f4 catppuccin text
  subtext: `${ESC}[38;2;166;173;200m`, // #a6adc8 subtext0
  overlay: `${ESC}[38;2;108;112;134m`, // #6c7086 overlay0
  blue: `${ESC}[38;2;137;180;250m`, // #89b4fa blue
  yellow: `${ESC}[38;2;249;226;175m`, // #f9e2af yellow
  red: `${ESC}[38;2;243;139;168m`, // #f38ba8 red (truecolor)
  surface0: `${ESC}[38;2;49;50;68m`, // #313244 surface0
};

const MOCHA_RGB = {
  ok: { r: 166, g: 227, b: 161 },
  partial: { r: 250, g: 179, b: 135 },
  fail: { r: 243, g: 139, b: 168 },
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
// progressBar(percent, width, time) — percent: 0~100, time 전달 시 shimmer sweep
export function progressBar(percent, width = 20, time) {
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const fillRgb =
    percent >= 100
      ? MOCHA_RGB.ok
      : percent >= 50
        ? MOCHA_RGB.partial
        : MOCHA_RGB.fail;
  const fillColor = rgbSeq(fillRgb);
  let fillText = "█".repeat(filled);

  if (filled > 0 && Number.isFinite(time)) {
    const shinePos = Math.min(
      filled - 1,
      Math.floor(((((time % 2000) + 2000) % 2000) / 2000) * filled),
    );
    const shineColor = rgbSeq(brightenRgb(fillRgb, 0.3));
    fillText = Array.from({ length: filled }, (_, idx) =>
      idx === shinePos ? `${shineColor}█${RESET}` : `${fillColor}█${RESET}`,
    ).join("");
  } else if (filled > 0) {
    fillText = `${fillColor}${fillText}${RESET}`;
  }

  const emptyText =
    empty > 0 ? `${MOCHA.border}${"░".repeat(empty)}${RESET}` : "";
  return `${fillText}${emptyText}`;
}

// ── 애니메이션 진행률 바 (shimmer sweep) ──
export function animatedProgressBar(percent, width = 20, tick = 0) {
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  if (filled === 0 || percent >= 100) return progressBar(percent, width);
  const baseClr = percent >= 50 ? MOCHA.partial : MOCHA.fail;
  const pos = tick % (filled + 3);
  let bar = "";
  for (let i = 0; i < filled; i++) {
    const d = Math.abs(i - pos);
    if (d === 0) bar += `${ESC}[97m█`;
    else if (d === 1) bar += `${baseClr}▓`;
    else bar += `${baseClr}█`;
  }
  return `${bar}${MOCHA.border}${"░".repeat(empty)}${RESET}`;
}

// ── 상태 아이콘 ──
export const STATUS_ICON = {
  running: `${MOCHA.partial}⏳${RESET}`,
  completed: `${MOCHA.ok}✓${RESET}`,
  failed: `${MOCHA.fail}✗${RESET}`,
  pending: `${FG.gray}⏸${RESET}`,
};

export const CLI_ICON = {
  codex: `${FG.codex}⚪${RESET}`,
  gemini: `${FG.gemini}🔵${RESET}`,
  claude: `${FG.claude}🟠${RESET}`,
};

// ── 로딩 도트 (braille spinner) ──
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function loadingDots(tick = 0, clr = MOCHA.thinking) {
  return `${clr}${BRAILLE_FRAMES[tick % BRAILLE_FRAMES.length]}${RESET}`;
}
