// ============================================================================
// ANSI 색상 (OMC colors.js 스키마 일치)
// ============================================================================
export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const CLAUDE_ORANGE = "\x1b[38;2;232;112;64m"; // #E87040 (Claude 공식 오렌지)
export const CODEX_WHITE = "\x1b[97m"; // bright white (SGR 37은 Windows Terminal에서 연회색 매핑)
export const GEMINI_BLUE = "\x1b[38;5;39m";

export function green(t) { return `${GREEN}${t}${RESET}`; }
export function yellow(t) { return `${YELLOW}${t}${RESET}`; }
export function red(t) { return `${RED}${t}${RESET}`; }
export function cyan(t) { return `${CYAN}${t}${RESET}`; }
export function dim(t) { return `${DIM}${t}${RESET}`; }
export function bold(t) { return `${BOLD}${t}${RESET}`; }
export function claudeOrange(t) { return `${CLAUDE_ORANGE}${t}${RESET}`; }
export function codexWhite(t) { return `${CODEX_WHITE}${t}${RESET}`; }
export function geminiBlue(t) { return `${GEMINI_BLUE}${t}${RESET}`; }

export function colorByPercent(value, text) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  if (value >= 50) return cyan(text);
  return green(text);
}

export function colorCooldown(seconds, text) {
  if (seconds > 120) return red(text);
  if (seconds > 0) return yellow(text);
  return dim(text);
}

export function colorParallel(current, cap) {
  if (current >= cap) return green(`${current}/${cap}`);
  if (current > 1) return yellow(`${current}/${cap}`);
  return red(`${current}/${cap}`);
}

export const GAUGE_WIDTH = 5;
export const GAUGE_BLOCKS = ["░", "▒", "▓", "█"]; // 밝기 0~3

export function coloredBar(percent, width = GAUGE_WIDTH, baseColor = null) {
  const safePercent = Math.min(100, Math.max(0, percent));
  const perBlock = 100 / width;

  // 상태별 색상
  let barColor;
  if (safePercent >= 85) barColor = RED;
  else if (safePercent >= 70) barColor = YELLOW;
  else barColor = baseColor || GREEN;

  let bar = "";
  for (let i = 0; i < width; i++) {
    const blockStart = i * perBlock;
    const blockEnd = (i + 1) * perBlock;

    if (safePercent >= blockEnd) {
      bar += "█"; // 완전 채움
    } else if (safePercent > blockStart) {
      // 프론티어: 구간 내 진행률
      const progress = (safePercent - blockStart) / perBlock;
      if (progress >= 0.75) bar += "▓";
      else if (progress >= 0.33) bar += "▒";
      else bar += "░";
    } else {
      bar += "░"; // 미도달
    }
  }

  // 채워진 부분 = barColor, 빈 부분 = DIM
  const filledEnd = Math.ceil(safePercent / perBlock);
  const coloredPart = barColor + bar.slice(0, filledEnd) + RESET;
  const dimPart = filledEnd < width ? DIM + bar.slice(filledEnd) + RESET : "";

  return coloredPart + dimPart;
}

// 프로바이더별 색상 % (< 70%: 프로바이더 색, ≥ 70%: 경고색)
export function colorByProvider(value, text, providerColorFn) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  return providerColorFn(text);
}
