// hub/team/shared.mjs — 팀 모듈 공유 유틸리티
// cli.mjs, dashboard.mjs 등에서 중복되던 상수/함수를 통합

// ── ANSI 색상 상수 ──
export const AMBER = "\x1b[38;5;214m";
export const GREEN = "\x1b[38;5;82m";
export const RED = "\x1b[38;5;196m";
export const GRAY = "\x1b[38;5;245m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";
export const WHITE = "\x1b[97m";
export const YELLOW = "\x1b[33m";
