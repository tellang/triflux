// ============================================================================
// 유틸리티 함수
// ============================================================================

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PERCENT_CELL_WIDTH, TIME_CELL_INNER_WIDTH } from "./constants.mjs";

const STDIN_MAX_BYTES = 1024 * 1024;

// 입력이 JSON 으로 읽히는 순간 끝낸다. Claude Code 가 stdin 을 늦게 닫아도 기다리지 않는다.
export async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      process.stdin.removeAllListeners("data");
      process.stdin.destroy();
      resolve(value);
    };
    const tryParse = () => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    // 200ms 안에 다 못 받으면 받은 만큼으로 판정한다.
    const timeout = setTimeout(() => finish(tryParse() ?? {}), 200);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > STDIN_MAX_BYTES) return finish({});
      const parsed = tryParse();
      if (parsed) finish(parsed);
    });
    process.stdin.on("end", () => finish(tryParse() ?? {}));
    process.stdin.on("error", () => finish({}));
    process.stdin.resume();
  });
}

export function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

export function writeJsonSafe(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 });
  } catch {
    /* 쓰기 실패 무시 */
  }
}

// .omc/ → .claude/cache/ 마이그레이션: 새 경로 우선, 없으면 레거시 읽고 복사
// 갱신 프로세스를 겹쳐 띄우지 않는 락. 만료 시각을 적고, 남은 시간이 ttl 보다 길면(시계가 뒤로 감) 깨진 락으로 본다.
// 예전 { t } 락도 읽는다.
export function acquireSpawnLock(lockPath, ttlMs, now = Date.now()) {
  const lock = readJson(lockPath, null);
  const until = Number(lock?.until ?? Number(lock?.t) + ttlMs);
  const remaining = until - now;
  if (Number.isFinite(remaining) && remaining > 0 && remaining <= ttlMs)
    return false;
  writeJsonSafe(lockPath, { until: now + ttlMs });
  return true;
}

// Retry-After 헤더(초 또는 HTTP 날짜)를 ms 로 바꾼다. 없거나 지난 값이면 null.
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function readJsonMigrate(newPath, legacyPath, fallback) {
  const data = readJson(newPath, null);
  if (data != null) return data;
  const legacy = readJson(legacyPath, null);
  if (legacy != null) {
    writeJsonSafe(newPath, legacy);
    return legacy;
  }
  return fallback;
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function getVisibleLength(text) {
  return stripAnsi(text).length;
}

function padAnsi(text, width, align = "right") {
  const len = getVisibleLength(text);
  if (len >= width) return text;
  const padding = " ".repeat(width - len);
  return align === "left" ? padding + text : text + padding;
}

export function padAnsiRight(text, width) {
  return padAnsi(text, width, "right");
}

export function fitText(text, width) {
  const t = String(text || "");
  if (t.length <= width) return t;
  if (width <= 1) return "…";
  return `${t.slice(0, width - 1)}…`;
}

/**
 * ANSI 이스케이프 시퀀스를 보존하면서 visible width 기준으로 truncate.
 * maxWidth 초과 시 잘라내고 RESET(\x1b[0m)을 추가한다.
 */
export function truncateAnsi(text, maxWidth) {
  if (maxWidth <= 0) return "";
  const str = String(text);
  let visible = 0;
  let i = 0;
  while (i < str.length) {
    if (str.charCodeAt(i) === 0x1b && str[i + 1] === "[") {
      const mIdx = str.indexOf("m", i + 2);
      if (mIdx !== -1) {
        i = mIdx + 1;
        continue;
      }
    }
    visible++;
    if (visible > maxWidth) {
      return str.slice(0, i) + "\x1b[0m";
    }
    i++;
  }
  return str;
}

export function makeHash(text) {
  return createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex")
    .slice(0, 16);
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
  const text = String(value || "");
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

// 값이 없는 시간 칸은 단위 모양을 남겨 정상 값과 같은 폭으로 그린다.
function emptyTimeCell(unit) {
  return unit === "dh" ? "(--d--h)" : "(--h--m)";
}

export function formatTimeCell(value) {
  const text = normalizeTimeToken(value);
  if (!/\d/.test(text)) return emptyTimeCell("hm");
  return `(${text.padStart(TIME_CELL_INNER_WIDTH, "0")})`;
}

export function formatTimeCellDH(value) {
  const text = normalizeTimeToken(value);
  if (!/\d/.test(text)) return emptyTimeCell("dh");
  return `(${text.padStart(TIME_CELL_INNER_WIDTH, " ")})`;
}

export function getCliArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  return process.argv[idx + 1] || null;
}

export function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// 과거 리셋 시간 → 다음 주기로 순환하여 미래 시점 반환
// elapsed가 cycleMs의 정수배일 때 ceil은 target=now를 반환해 diff=0이 되므로
// floor+1로 항상 다음 사이클을 가리키도록 한다.
export function advanceToNextCycle(epochMs, cycleMs) {
  const now = Date.now();
  if (epochMs >= now || !cycleMs) return epochMs;
  const elapsed = now - epochMs;
  return epochMs + (Math.floor(elapsed / cycleMs) + 1) * cycleMs;
}

function parseResetDate(isoOrUnix) {
  if (!isoOrUnix) return null;
  const date =
    typeof isoOrUnix === "string"
      ? new Date(isoOrUnix)
      : new Date(isoOrUnix * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getResetTargetMs(isoOrUnix, cycleMs = 0) {
  const date = parseResetDate(isoOrUnix);
  if (!date) return null;
  return advanceToNextCycle(date.getTime(), cycleMs);
}

function getRemainingResetMs(isoOrUnix, cycleMs = 0) {
  const targetMs = getResetTargetMs(isoOrUnix, cycleMs);
  if (targetMs == null) return null;
  return targetMs - Date.now();
}

export function formatResetRemaining(isoOrUnix, cycleMs = 0) {
  const diffMs = getRemainingResetMs(isoOrUnix, cycleMs);
  if (diffMs == null || diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${totalHours}h${String(minutes).padStart(2, "0")}m`;
}

export function formatResetRemainingDayHour(isoOrUnix, cycleMs = 0) {
  const diffMs = getRemainingResetMs(isoOrUnix, cycleMs);
  if (diffMs == null || diffMs <= 0) return "";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  return `${String(days).padStart(2, "0")}d${String(hours).padStart(2, "0")}h`;
}

// JWT base64 디코딩 공통 헬퍼
export function decodeJwtEmail(idToken) {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  while (payload.length % 4) payload += "=";
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64").toString("utf-8"),
    );
    return decoded.email || null;
  } catch {
    return null;
  }
}

// HTTPS POST (타임아웃 포함) — https 모듈은 호출자가 주입
export function createHttpsPost(https, timeoutMs) {
  return function httpsPost(url, body, accessToken) {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const data = JSON.stringify(body);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            "Content-Length": Buffer.byteLength(data),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.write(data);
      req.end();
    });
  };
}
