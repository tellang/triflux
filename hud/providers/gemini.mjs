import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  ANTIGRAVITY_OAUTH_PATHS,
  ANTIGRAVITY_QUOTA_CACHE_PATH,
  ANTIGRAVITY_QUOTA_STALE_MS,
  ANTIGRAVITY_REFRESH_FLAG,
  ANTIGRAVITY_REFRESH_LOCK_PATH,
  ANTIGRAVITY_SETTINGS_PATH,
  ANTIGRAVITY_SIGNED_IN_GRACE_MS,
  SPAWN_LOCK_TTL_MS,
} from "../constants.mjs";
import {
  acquireSpawnLock,
  decodeJwtEmail,
  readJson,
  writeJsonSafe,
} from "../utils.mjs";

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

const PROJECT_QUOTA_METRIC_PREFIX =
  "discoveryengine.googleapis.com/quota/ratev2/agentic_wtu_tier_";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// 콘솔 Usage & spend 의 코딩 도구 칸과 같은 Cloud Monitoring 지표다.
// 사용량은 7일 창마다 시리즈가 따로 있어 같은 등급끼리 더하고, 리셋은 가장 많이 쓴 창의 시작 + 7일이다.
function summarizeProjectQuota(timeSeries) {
  const tiers = new Map();
  for (const series of timeSeries ?? []) {
    const type = series?.metric?.type ?? "";
    const value = Number(series?.points?.[0]?.value?.int64Value);
    if (
      !type.startsWith(PROJECT_QUOTA_METRIC_PREFIX) ||
      !Number.isFinite(value)
    )
      continue;
    const kind = type.slice(type.lastIndexOf("/") + 1);
    const tierKey = type.slice(0, type.lastIndexOf("/"));
    const tier = tiers.get(tierKey) ?? { used: 0, limit: 0, top: null };
    if (kind === "limit") tier.limit = Math.max(tier.limit, value);
    if (kind === "net_usage") {
      tier.used += value;
      if (!tier.top || value > tier.top.value) {
        tier.top = {
          value,
          start: Number(series.metric.labels?.window_start_time) * 1000,
        };
      }
    }
    tiers.set(tierKey, tier);
  }
  let best = null;
  for (const tier of tiers.values()) {
    if (tier.limit <= 0) continue;
    const usedPercent = Math.min(
      100,
      Math.round((tier.used / tier.limit) * 100),
    );
    const resetMs = tier.top?.start + WEEK_MS;
    const resetTime =
      resetMs > Date.now() ? new Date(resetMs).toISOString() : null;
    if (!best || usedPercent > best.usedPercent)
      best = { usedPercent, resetTime };
  }
  return best;
}

// gcloud 로그인이 없거나 만료되면 null 을 반환해 HUD 가 GCP 표시로 돌아간다.
async function fetchProjectQuota(gcp, execFileSyncFn, fetchFn) {
  try {
    const token = execFileSyncFn("gcloud", ["auth", "print-access-token"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      // Windows 의 gcloud 는 .cmd 라 셸 없이는 실행되지 않는다.
      shell: process.platform === "win32",
    }).trim();
    if (!token) return null;
    const base = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(gcp.project)}`;
    const getJson = async (path, params) => {
      const response = await fetchFn(`${base}/${path}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`monitoring ${response.status}`);
      return response.json();
    };
    // timeSeries 는 요청 하나에 지표 하나만 받으므로 에디션별 지표 이름부터 찾는다.
    const descriptors = await getJson(
      "metricDescriptors",
      new URLSearchParams({
        filter: `metric.type = starts_with("${PROJECT_QUOTA_METRIC_PREFIX}")`,
      }),
    );
    const types = (descriptors.metricDescriptors ?? [])
      .map((descriptor) => descriptor.type)
      .filter((type) => /\/(net_usage|limit)$/.test(type));
    const now = Date.now();
    const location = gcp.location || "global";
    const timeSeries = [];
    for (const type of types) {
      const data = await getJson(
        "timeSeries",
        new URLSearchParams({
          filter: `metric.type = "${type}" AND metric.label.regional_location = "${location}"`,
          "interval.startTime": new Date(now - 10 * 60 * 1000).toISOString(),
          "interval.endTime": new Date(now).toISOString(),
        }),
      );
      timeSeries.push(...(data.timeSeries ?? []));
    }
    return summarizeProjectQuota(timeSeries);
  } catch {
    return null;
  }
}

// Keychain 인증은 파일을 남기지 않으므로 최근 쿼터 조회 성공도 로그인 근거로 본다.
export function getAntigravityAuthKind() {
  if (isGcpProjectAuth()) return "project";
  if (getAntigravityAccountLabel()) return "account";
  const cache = readJson(ANTIGRAVITY_QUOTA_CACHE_PATH, null);
  const signedInAge = Date.now() - Number(cache?.signedInAt);
  return cache?.accountLabel == null &&
    signedInAge < ANTIGRAVITY_SIGNED_IN_GRACE_MS
    ? "account"
    : null;
}

export function readAntigravityQuotaSnapshot() {
  const cache = readJson(ANTIGRAVITY_QUOTA_CACHE_PATH, null);
  const matched = cache?.accountLabel === getAntigravityAccountLabel();
  const stale =
    !cache?.timestamp ||
    Date.now() - cache.timestamp >= ANTIGRAVITY_QUOTA_STALE_MS;
  if (isGcpProjectAuth()) {
    const quota = matched ? cache.projectQuota : null;
    return {
      data: quota ? { ...quota, stale } : null,
      shouldRefresh: !matched || stale,
    };
  }
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
// 프로젝트 과금에서는 /usage 대신 프로젝트 공용 주간 쿼터를 읽는다.
export async function refreshAntigravityQuotaCache(
  execFileSyncFn = execFileSync,
  fetchFn = fetch,
) {
  const gcp = readJson(ANTIGRAVITY_SETTINGS_PATH, null)?.gcp;
  if (gcp?.project) {
    const projectQuota = await fetchProjectQuota(gcp, execFileSyncFn, fetchFn);
    writeJsonSafe(ANTIGRAVITY_QUOTA_CACHE_PATH, {
      timestamp: Date.now(),
      accountLabel: gcp.project,
      projectQuota,
    });
    return projectQuota;
  }
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
    const previous = readJson(ANTIGRAVITY_QUOTA_CACHE_PATH, null);
    const signedInAt = buckets
      ? Date.now()
      : previous?.accountLabel === accountLabel
        ? previous?.signedInAt
        : undefined;
    writeJsonSafe(ANTIGRAVITY_QUOTA_CACHE_PATH, {
      timestamp: Date.now(),
      accountLabel,
      buckets,
      signedInAt,
    });
  }
  return buckets;
}

export function scheduleAntigravityQuotaRefresh() {
  const scriptPath = process.argv[1];
  if (!scriptPath || !existsSync(ANTIGRAVITY_SETTINGS_PATH)) return;
  if (!acquireSpawnLock(ANTIGRAVITY_REFRESH_LOCK_PATH, SPAWN_LOCK_TTL_MS))
    return;
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
