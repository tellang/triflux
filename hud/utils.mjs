// ============================================================================
// 유틸리티 함수
// ============================================================================
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  PERCENT_CELL_WIDTH, TIME_CELL_INNER_WIDTH, SV_CELL_WIDTH,
  FIVE_HOUR_MS, SEVEN_DAY_MS,
} from "./constants.mjs";
import { dim } from "./colors.mjs";

export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      process.stdin.destroy();
      resolve({});
    }, 200);
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      const raw = chunks.join("").trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    process.stdin.on("error", () => {
      clearTimeout(timeout);
      resolve({});
    });
    process.stdin.resume();
  });
}

export function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try { return JSON.parse(readFileSync(filePath, "utf-8")); } catch { return fallback; }
}

export function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 });
  } catch { /* 쓰기 실패 무시 */ }
}

// .omc/ → .claude/cache/ 마이그레이션: 새 경로 우선, 없으면 레거시 읽고 복사
export function readJsonMigrate(newPath, legacyPath, fallback) {
  const data = readJson(newPath, null);
  if (data != null) return data;
  const legacy = readJson(legacyPath, null);
  if (legacy != null) { writeJsonSafe(newPath, legacy); return legacy; }
  return fallback;
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

export function padAnsiRight(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return text + " ".repeat(width - len);
}

export function padAnsiLeft(text, width) {
  const len = stripAnsi(text).length;
  if (len >= width) return text;
  return " ".repeat(width - len) + text;
}

export function fitText(text, width) {
  const t = String(text || "");
  if (t.length <= width) return t;
  if (width <= 1) return "…";
  return `${t.slice(0, width - 1)}…`;
}

export function makeHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

export function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

export function formatPercentCell(value) {
  return `${clampPercent(value)}%`.padStart(PERCENT_CELL_WIDTH, " ");
}

export function formatPlaceholderPercentCell() {
  return "--%".padStart(PERCENT_CELL_WIDTH, " ");
}

export function normalizeTimeToken(value) {
  const text = String(value || "n/a");
  const hourMinute = text.match(/^(\d+)h(\d+)m$/);
  if (hourMinute) {
    return `${Number(hourMinute[1])}h${String(Number(hourMinute[2])).padStart(2, "0")}m`;
  }
  const dayHour = text.match(/^(\d+)d(\d+)h$/);
  if (dayHour) {
    return `${String(Number(dayHour[1])).padStart(2, "0")}d${String(Number(dayHour[2])).padStart(2, "0")}h`;
  }
  return text;
}

export function formatTimeCell(value) {
  const text = normalizeTimeToken(value);
  // 시간값(숫자 포함)은 0패딩, 비시간값(n/a 등)은 공백패딩
  const padChar = /\d/.test(text) ? "0" : " ";
  return `(${text.padStart(TIME_CELL_INNER_WIDTH, padChar)})`;
}

// 주간(d/h) 전용 — 최대 7d00h(5자)이므로 공백 불필요
export function formatTimeCellDH(value) {
  const text = normalizeTimeToken(value);
  return `(${text})`;
}

export function getCliArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function getContextPercent(stdin) {
  const nativePercent = stdin?.context_window?.used_percentage;
  if (typeof nativePercent === "number" && Number.isFinite(nativePercent)) return clampPercent(nativePercent);
  const usage = stdin?.context_window?.current_usage || {};
  const totalTokens = Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0);
  const capacity = Number(stdin?.context_window?.context_window_size || 0);
  if (!capacity || capacity <= 0) return 0;
  return clampPercent((totalTokens / capacity) * 100);
}

// 과거 리셋 시간 → 다음 주기로 순환하여 미래 시점 반환
export function advanceToNextCycle(epochMs, cycleMs) {
  const now = Date.now();
  if (epochMs >= now || !cycleMs) return epochMs;
  const elapsed = now - epochMs;
  return epochMs + Math.ceil(elapsed / cycleMs) * cycleMs;
}

export function formatResetRemaining(isoOrUnix, cycleMs = 0) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const targetMs = advanceToNextCycle(d.getTime(), cycleMs);
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${totalHours}h${String(minutes).padStart(2, "0")}m`;
}

export function isResetPast(isoOrUnix) {
  if (!isoOrUnix) return false;
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  return !isNaN(d.getTime()) && d.getTime() <= Date.now();
}

export function formatResetRemainingDayHour(isoOrUnix, cycleMs = 0) {
  if (!isoOrUnix) return "";
  const d = typeof isoOrUnix === "string" ? new Date(isoOrUnix) : new Date(isoOrUnix * 1000);
  if (isNaN(d.getTime())) return "";
  const targetMs = advanceToNextCycle(d.getTime(), cycleMs);
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  return `${String(days).padStart(2, "0")}d${String(hours).padStart(2, "0")}h`;
}

export function calcCooldownLeftSeconds(isoDatetime) {
  if (!isoDatetime) return 0;
  const cooldownMs = new Date(isoDatetime).getTime() - Date.now();
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return 0;
  return Math.ceil(cooldownMs / 1000);
}

export function getProviderAccountId(provider, accountsConfig, accountsState) {
  const providerState = accountsState?.providers?.[provider] || {};
  const selectedId = providerState.last_selected_id;
  if (selectedId) return selectedId;
  const providerConfig = accountsConfig?.providers?.[provider] || [];
  return providerConfig[0]?.id || `${provider}-main`;
}

// JWT base64 디코딩 공통 헬퍼
export function decodeJwtEmail(idToken) {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4) payload += "=";
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded.email || null;
  } catch { return null; }
}

// HTTPS POST (타임아웃 포함) — https 모듈은 호출자가 주입
export function createHttpsPost(https, timeoutMs) {
  return function httpsPost(url, body, accessToken) {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const data = JSON.stringify(body);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.write(data);
      req.end();
    });
  };
}

// sv 퍼센트 포맷 (1000+ → k 표기, 5자 고정폭)
export function formatSvPct(value) {
  if (value == null) return "--%".padStart(SV_CELL_WIDTH);
  if (value >= 10000) return `${Math.round(value / 1000)}k%`.padStart(SV_CELL_WIDTH);
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k%`.padStart(SV_CELL_WIDTH);
  return `${value}%`.padStart(SV_CELL_WIDTH);
}

export function formatSavings(dollars) {
  if (dollars >= 100) return `$${Math.round(dollars)}`;
  if (dollars >= 10) return `$${dollars.toFixed(1)}`;
  return `$${dollars.toFixed(2)}`;
}
