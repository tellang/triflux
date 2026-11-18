export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const CLAUDE_ORANGE = "\x1b[38;2;232;112;64m";
// SGR 37은 Windows Terminal에서 연회색으로 매핑되어 bright white를 쓴다.
export const CODEX_WHITE = "\x1b[97m";
export const GEMINI_BLUE = "\x1b[38;5;39m";

export function green(t) {
  return `${GREEN}${t}${RESET}`;
}
export function yellow(t) {
  return `${YELLOW}${t}${RESET}`;
}
export function red(t) {
  return `${RED}${t}${RESET}`;
}
export function cyan(t) {
  return `${CYAN}${t}${RESET}`;
}
export function dim(t) {
  return `${DIM}${t}${RESET}`;
}
export function bold(t) {
  return `${BOLD}${t}${RESET}`;
}
export function claudeOrange(t) {
  return `${CLAUDE_ORANGE}${t}${RESET}`;
}
export function codexWhite(t) {
  return `${CODEX_WHITE}${t}${RESET}`;
}
export function geminiBlue(t) {
  return `${GEMINI_BLUE}${t}${RESET}`;
}

export function colorByPercent(value, text) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  if (value >= 50) return cyan(text);
  return green(text);
}

export const GAUGE_WIDTH = 5;

export function coloredBar(percent, width = GAUGE_WIDTH, baseColor = null) {
  const safePercent = Math.min(100, Math.max(0, percent));
  const perBlock = 100 / width;

  let barColor;
  if (safePercent >= 85) barColor = RED;
  else if (safePercent >= 70) barColor = YELLOW;
  else barColor = baseColor || GREEN;

  let bar = "";
  for (let i = 0; i < width; i++) {
    const blockStart = i * perBlock;
    const blockEnd = (i + 1) * perBlock;

    if (safePercent >= blockEnd) {
      bar += "█";
    } else if (safePercent > blockStart) {
      const progress = (safePercent - blockStart) / perBlock;
      if (progress >= 0.75) bar += "▓";
      else if (progress >= 0.33) bar += "▒";
      else bar += "░";
    } else {
      bar += "░";
    }
  }

  const filledEnd = Math.ceil(safePercent / perBlock);
  const coloredPart = barColor + bar.slice(0, filledEnd) + RESET;
  const dimPart = filledEnd < width ? DIM + bar.slice(filledEnd) + RESET : "";

  return coloredPart + dimPart;
}

export function colorByProvider(value, text, providerColorFn) {
  if (value >= 85) return red(text);
  if (value >= 70) return yellow(text);
  return providerColorFn(text);
}
