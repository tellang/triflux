import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  ANTIGRAVITY_OAUTH_PATHS,
  ANTIGRAVITY_QUOTA_CACHE_PATH,
  ANTIGRAVITY_QUOTA_STALE_MS,
  ANTIGRAVITY_REFRESH_FLAG,
  ANTIGRAVITY_REFRESH_LOCK_PATH,
  ANTIGRAVITY_SETTINGS_PATH,
  SPAWN_LOCK_TTL_MS,
} from "../constants.mjs";
import { decodeJwtEmail, readJson, writeJsonSafe } from "../utils.mjs";

function getCredentialEmail(credential) {
  return (
    decodeJwtEmail(credential?.id_token) ||
    credential?.email ||
    credential?.account?.email ||
    credential?.user?.email ||
    credential?.profile?.email ||
    null
  );
}

// GCP 프로젝트 인증이면 계정 이메일 대신 프로젝트 ID를 보여 준다.
export function getAntigravityAccountLabel() {
  const project = readJson(ANTIGRAVITY_SETTINGS_PATH, null)?.gcp?.project;
  if (project) return project;
  for (const oauthPath of ANTIGRAVITY_OAUTH_PATHS) {
    try {
      const email = getCredentialEmail(readJson(oauthPath, null));
      if (email) return email;
    } catch {
      // 다음 Antigravity 인증 경로를 확인한다.
    }
  }
  return null;
}

function isGcpProjectAuth() {
  return Boolean(readJson(ANTIGRAVITY_SETTINGS_PATH, null)?.gcp?.project);
}

export function readAntigravityQuotaSnapshot() {
  // 프로젝트 과금의 기본 응답을 개인 플랜의 0% 사용률로 표시하지 않는다.
  if (isGcpProjectAuth()) return { data: null, shouldRefresh: false };
  const cache = readJson(ANTIGRAVITY_QUOTA_CACHE_PATH, null);
  const matched = cache?.accountLabel === getAntigravityAccountLabel();
  const stale =
    !cache?.timestamp ||
    Date.now() - cache.timestamp >= ANTIGRAVITY_QUOTA_STALE_MS;
  const model = readJson(ANTIGRAVITY_SETTINGS_PATH, null)?.model;
  const buckets = matched && Array.isArray(cache?.buckets) ? cache.buckets : [];
  const bucket = buckets
    .filter(
      (item) =>
        model &&
        item &&
        (item?.name === model || item?.id === model) &&
        Number.isFinite(item.remaining_fraction) &&
        item.remaining_fraction >= 0 &&
        item.remaining_fraction <= 1 &&
        Date.parse(item.reset_time) > Date.now(),
    )
    .sort((a, b) => a.remaining_fraction - b.remaining_fraction)[0];
  return {
    data: bucket
      ? {
          usedPercent: Math.round((1 - bucket.remaining_fraction) * 100),
          resetTime: bucket.reset_time,
          stale,
        }
      : null,
    shouldRefresh: !matched || stale,
  };
}

// /usage는 모델 턴을 시작하지 않는 공식 print-mode 조회다.
export function refreshAntigravityQuotaCache(execFileSyncFn = execFileSync) {
  if (isGcpProjectAuth()) return null;
  const accountLabel = getAntigravityAccountLabel();
  let buckets = null;
  try {
    const result = JSON.parse(
      execFileSyncFn("agy", ["-p", "/usage", "--output-format", "json"], {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }),
    );
    if (
      result.status === "SUCCESS" &&
      result.command?.name === "usage" &&
      Array.isArray(result.command.data?.groups)
    ) {
      buckets = result.command.data.groups.flatMap((group) =>
        Array.isArray(group?.buckets) ? group.buckets : [],
      );
    }
  } catch {
    // 실패도 캐시해 인증 오류나 CLI 부재 시 매 렌더마다 실행하지 않는다.
  }
  if (accountLabel === getAntigravityAccountLabel()) {
    writeJsonSafe(ANTIGRAVITY_QUOTA_CACHE_PATH, {
      timestamp: Date.now(),
      accountLabel,
      buckets,
    });
  }
  return buckets;
}

export function scheduleAntigravityQuotaRefresh() {
  const scriptPath = process.argv[1];
  if (
    !scriptPath ||
    !existsSync(ANTIGRAVITY_SETTINGS_PATH) ||
    isGcpProjectAuth()
  )
    return;
  const lock = readJson(ANTIGRAVITY_REFRESH_LOCK_PATH, null);
  if (Date.now() - Number(lock?.t || 0) < SPAWN_LOCK_TTL_MS) return;
  writeJsonSafe(ANTIGRAVITY_REFRESH_LOCK_PATH, { t: Date.now() });
  try {
    const child = spawn(
      process.execPath,
      [scriptPath, ANTIGRAVITY_REFRESH_FLAG],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
  } catch {
    // 다음 렌더에서 다시 시도한다.
  }
}
