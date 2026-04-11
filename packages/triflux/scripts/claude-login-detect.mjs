#!/usr/bin/env node
/**
 * claude-login-detect.mjs — Claude 로그인(credentials 변경) 감지 + HUD 캐시 초기화
 *
 * ~/.claude/.credentials.json의 mtime을 추적하여 변경 시 HUD 관련 캐시를 삭제한다.
 * SessionStart 훅에서 import하여 사용.
 */

import { existsSync, statSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const STATE_PATH = join(homedir(), ".claude", "cache", "tfx-hub", "claude-login-mtime.json");
const HUD_CACHES = [
  join(homedir(), ".claude", "cache", "claude-usage-cache.json"),
  join(homedir(), ".claude", "cache", "codex-rate-limits-cache.json"),
  join(homedir(), ".claude", "cache", "gemini-quota-cache.json"),
];

function readLastMtime() {
  try {
    if (!existsSync(STATE_PATH)) return 0;
    return JSON.parse(readFileSync(STATE_PATH, "utf8")).mtime || 0;
  } catch {
    return 0;
  }
}

function writeLastMtime(mtime) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ mtime, updatedAt: Date.now() }));
  } catch { /* best-effort */ }
}

export function run() {
  if (!existsSync(CREDS_PATH)) return { changed: false };

  let currentMtime;
  try {
    currentMtime = statSync(CREDS_PATH).mtimeMs;
  } catch {
    return { changed: false };
  }

  const lastMtime = readLastMtime();
  if (currentMtime === lastMtime) return { changed: false };

  // credentials 변경 감지 → HUD 캐시 삭제
  let cleared = 0;
  for (const cachePath of HUD_CACHES) {
    try {
      if (existsSync(cachePath)) {
        unlinkSync(cachePath);
        cleared++;
      }
    } catch { /* ignore */ }
  }

  writeLastMtime(currentMtime);
  return { changed: true, cleared };
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop(),
  );

if (isDirectRun) {
  const result = run();
  if (result.changed) {
    console.error(`[claude-login-detect] credentials 변경 감지 — HUD 캐시 ${result.cleared}개 삭제`);
  }
}
