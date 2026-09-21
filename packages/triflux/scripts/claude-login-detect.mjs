#!/usr/bin/env node
/**
 * claude-login-detect.mjs — Claude 로그인(자격증명 변경) 감지 + HUD 캐시 초기화
 *
 * Claude Code 는 macOS 에서 로그인을 Keychain(`Claude Code-credentials`, CLAUDE_CONFIG_DIR 별 접미사)에
 * 두고, ~/.claude/.credentials.json 은 Keychain 을 못 쓸 때만 쓴다. 그래서 파일 mtime 만 보면 로그인이
 * 바뀌어도 감지하지 못한다. Keychain 항목의 로그인 지문과 후보 파일들의 mtime 을 함께 추적하고,
 * 어느 쪽이든 바뀌면 HUD 관련 캐시를 삭제한다. SessionStart 훅에서 import하여 사용.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getClaudeCredentialPaths } from "../hud/constants.mjs";
import {
  getKeychainServiceName,
  readClaudeKeychainEntry,
} from "../hud/providers/claude.mjs";

const STATE_PATH = join(
  homedir(),
  ".claude",
  "cache",
  "tfx-hub",
  "claude-login-mtime.json",
);
const HUD_CACHES = [
  join(homedir(), ".claude", "cache", "claude-usage-cache.json"),
  join(homedir(), ".claude", "cache", "codex-rate-limits-cache.json"),
  join(homedir(), ".claude", "cache", "gemini-quota-cache.json"),
];

// 로그인 지문: refreshToken 은 로그인 때 발급되고 8시간 주기 accessToken 갱신에는 바뀌지 않는다
// (2026-09 실측: 갱신 뒤에도 refreshTokenExpiresAt 유지). 그래서 "계정이 바뀌었는가"의 신호로 맞다.
// 항목 전체를 해시하면 갱신 때마다 캐시를 지워 usage API 를 불필요하게 다시 부른다.
// 토큰 원문은 상태 파일에 남기지 않는다.
export function computeLoginFingerprint(raw) {
  const oauth =
    raw && typeof raw === "object" ? raw.claudeAiOauth || raw : null;
  const identity =
    oauth?.refreshToken ||
    oauth?.accessToken ||
    (typeof raw === "string" ? raw : JSON.stringify(raw ?? null));
  return createHash("sha256").update(String(identity)).digest("hex");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function readLastState(statePath = STATE_PATH) {
  const empty = { fileMtimes: {}, keychainFingerprints: {} };
  try {
    if (!existsSync(statePath)) return empty;
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      fileMtimes: asRecord(data?.fileMtimes),
      keychainFingerprints: asRecord(data?.keychainFingerprints),
    };
  } catch {
    return empty;
  }
}

function writeLastState(state, statePath = STATE_PATH) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        fileMtimes: state.fileMtimes,
        keychainFingerprints: state.keychainFingerprints,
        updatedAt: Date.now(),
      }),
    );
  } catch {
    /* best-effort */
  }
}

export function run({
  env = process.env,
  platform = process.platform,
  execFileSyncFn = execFileSync,
  credsPath = null,
  credsPaths = credsPath ? [credsPath] : getClaudeCredentialPaths(env),
  statePath = STATE_PATH,
  hudCaches = HUD_CACHES,
} = {}) {
  // 파일 신호: 이 스코프에서 HUD 가 읽을 수 있는 후보 경로(스코프 경로 → 기본 경로) 전부를 경로별
  // mtime 으로 기억한다. 단일 mtime 이면 경로가 다른 세션이 번갈아 뜰 때마다 캐시를 되풀이 삭제한다.
  const currentMtimes = {};
  for (const filePath of credsPaths) {
    if (!existsSync(filePath)) continue;
    try {
      currentMtimes[filePath] = statSync(filePath).mtimeMs;
    } catch {
      /* skip unreadable candidate */
    }
  }

  const entry =
    platform === "darwin"
      ? readClaudeKeychainEntry({ execFileSyncFn, env })
      : null;
  const serviceName = entry?.serviceName ?? getKeychainServiceName(env);
  const currentFingerprint = entry ? computeLoginFingerprint(entry.raw) : null;

  const hasFile = Object.keys(currentMtimes).length > 0;
  if (!hasFile && !currentFingerprint) return { changed: false };

  const lastState = readLastState(statePath);
  const fileChanged = Object.entries(currentMtimes).some(
    ([filePath, mtime]) => mtime !== lastState.fileMtimes[filePath],
  );
  // 지문은 Keychain 서비스명(= CLAUDE_CONFIG_DIR 스코프)별로 기억한다. 격리 세션과 기본 세션이
  // 번갈아 뜰 때 서로의 지문을 덮어쓰며 캐시를 반복 삭제하지 않기 위해서다.
  const keychainChanged =
    !!currentFingerprint &&
    currentFingerprint !== lastState.keychainFingerprints[serviceName];

  if (!fileChanged && !keychainChanged) return { changed: false };

  // credentials 변경 감지 → HUD 캐시 삭제
  let cleared = 0;
  for (const cachePath of hudCaches) {
    try {
      if (existsSync(cachePath)) {
        unlinkSync(cachePath);
        cleared++;
      }
    } catch {
      /* 개별 실패 무시 */
    }
  }

  writeLastState(
    {
      fileMtimes: { ...lastState.fileMtimes, ...currentMtimes },
      keychainFingerprints: currentFingerprint
        ? {
            ...lastState.keychainFingerprints,
            [serviceName]: currentFingerprint,
          }
        : lastState.keychainFingerprints,
    },
    statePath,
  );

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
    console.error(
      `[claude-login-detect] credentials 변경 감지: HUD 캐시 ${result.cleared}개 삭제`,
    );
  }
}
