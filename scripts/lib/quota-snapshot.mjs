// 3사 CLI 쿼터 캐시 및 런타임 쿨다운 읽기 전용 스냅샷 모듈 (ADR-0054)
// HUD 백그라운드 갱신기가 기록한 로컬 JSON 캐시와 런타임 쿨다운 마커만 읽으며
// 외부 CLI 실행이나 네트워크 호출을 절대 수행하지 않는다.

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTrifluxHome } from "./machine-profile.mjs";
import {
  AGY_FAMILY_PROFILES,
  resolveModelFamilies,
} from "./model-family-resolver.mjs";

export const QUOTA_DEMOTE_OVER_PERCENT = 95;
export const QUOTA_EXHAUSTED_PERCENT = 100;

const DEFAULT_STALE_TTL_MS = 300_000;
const CLAUDE_PLUGIN_STALE_TTL_MS = 900_000;

function readJsonSafe(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function clampPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function parseTimestampMs(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e12 ? Math.trunc(raw * 1000) : Math.trunc(raw);
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d+(?:\.\d+)?$/u.test(str)) {
    const num = Number(str);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num < 1e12 ? Math.trunc(num * 1000) : Math.trunc(num);
  }
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? parsed : null;
}

function decodeJwtEmail(idToken) {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return typeof payload?.email === "string" && payload.email.trim()
      ? payload.email.trim()
      : null;
  } catch {
    return null;
  }
}

export function resolveQuotaTmpDir({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env?.TFX_TMP) return env.TFX_TMP;
  if (platform === "win32") {
    return env?.TEMP || env?.TMP || tmpdir();
  }
  const base = env?.TMPDIR || env?.TMP || env?.TEMP || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(base.replace(/\/+$/u, ""), `triflux-${uid}`);
}

function readRuntimeCooldown(tmpDir, filenames, nowMs) {
  for (const name of filenames) {
    try {
      const content = readFileSync(join(tmpDir, name), "utf8").trim();
      const firstLine = content.split(/\r?\n/u)[0]?.trim() || "";
      if (!/^\d{1,15}$/u.test(firstLine)) continue;
      const resetMs = parseTimestampMs(Number(firstLine));
      if (resetMs != null && resetMs > nowMs) {
        return {
          cooldownActive: true,
          cooldownUntilMs: resetMs,
          cooldownResetIso: new Date(resetMs).toISOString(),
        };
      }
    } catch {
      // 마커 파일 부재 또는 읽기 실패는 쿨다운 아님으로 본다.
    }
  }
  return {
    cooldownActive: false,
    cooldownUntilMs: null,
    cooldownResetIso: null,
  };
}

function classifyPercentStatus(usedPercent) {
  if (usedPercent == null || !Number.isFinite(usedPercent)) return "unknown";
  if (usedPercent >= QUOTA_EXHAUSTED_PERCENT) return "exhausted";
  if (usedPercent > QUOTA_DEMOTE_OVER_PERCENT) return "over_95";
  return "ok";
}

function buildStatusFields({
  usedPercent = null,
  resetsAtMs = null,
  cooldownActive = false,
  cooldownUntilMs = null,
  cooldownResetIso = null,
  stale = false,
  reason = null,
} = {}) {
  if (cooldownActive) {
    return {
      status: "cooldown",
      usedPercent,
      percent: usedPercent,
      resetsAtMs: cooldownUntilMs ?? resetsAtMs,
      cooldownActive: true,
      cooldownUntilMs,
      cooldownResetIso,
      exhausted: true,
      demote: false,
      stale,
      reason: reason || "runtime_cooldown",
    };
  }

  const pct = usedPercent != null ? clampPercent(usedPercent) : null;
  const status = classifyPercentStatus(pct);
  return {
    status,
    usedPercent: pct,
    percent: pct,
    resetsAtMs,
    cooldownActive: false,
    cooldownUntilMs: null,
    cooldownResetIso: null,
    exhausted: status === "exhausted",
    demote: status === "over_95",
    stale,
    reason,
  };
}

function readCurrentClaudeAccount(home, env) {
  const configDir = env?.CLAUDE_CONFIG_DIR || home;
  const claudeJson = readJsonSafe(join(configDir, ".claude.json"));
  const oauth = claudeJson?.oauthAccount;
  if (!oauth || typeof oauth !== "object") return null;
  const id = oauth.accountUuid || oauth.emailAddress || null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function parseClaudeCache(cacheDir, home, env, nowMs) {
  const pluginCachePath = join(cacheDir, "tfx-hub", "plugin-usage-cache.json");
  const primaryPath = join(cacheDir, "claude-usage-cache.json");
  const hasPluginCache = existsSync(pluginCachePath);
  const cache = readJsonSafe(primaryPath) ?? readJsonSafe(pluginCachePath);
  if (!cache || typeof cache !== "object") {
    return {
      fiveHourPercent: null,
      weeklyPercent: null,
      ...buildStatusFields({ stale: true, reason: "cache_missing" }),
    };
  }

  const currentAccount = readCurrentClaudeAccount(home, env);
  if (
    currentAccount &&
    typeof cache.account === "string" &&
    cache.account.trim() &&
    cache.account.trim() !== currentAccount
  ) {
    return {
      fiveHourPercent: null,
      weeklyPercent: null,
      ...buildStatusFields({ stale: true, reason: "account_mismatch" }),
    };
  }

  const data =
    cache.data && typeof cache.data === "object" ? cache.data : cache;
  let fiveHour = clampPercent(data?.fiveHourPercent);
  const fiveReset = parseTimestampMs(data?.fiveHourResetsAt);
  if (fiveHour != null && fiveReset != null && fiveReset <= nowMs) {
    fiveHour = 0;
  }

  let weekly = clampPercent(data?.weeklyPercent);
  const weeklyReset = parseTimestampMs(data?.weeklyResetsAt);
  if (weekly != null && weeklyReset != null && weeklyReset <= nowMs) {
    weekly = 0;
  }

  const futureResets = [fiveReset, weeklyReset].filter(
    (ms) => ms != null && ms > nowMs,
  );
  const resetsAtMs = futureResets.length > 0 ? Math.min(...futureResets) : null;

  const staleTtlMs = hasPluginCache
    ? CLAUDE_PLUGIN_STALE_TTL_MS
    : DEFAULT_STALE_TTL_MS;
  const cacheTsMs =
    cache.timestamp !== undefined ? parseTimestampMs(cache.timestamp) : null;
  const expiredWithoutReset =
    resetsAtMs === null &&
    cache.timestamp !== undefined &&
    (cacheTsMs === null || nowMs - cacheTsMs >= staleTtlMs);

  if (expiredWithoutReset) {
    return {
      fiveHourPercent: null,
      weeklyPercent: null,
      ...buildStatusFields({ stale: true, reason: "stale_expired" }),
    };
  }

  const candidates = [fiveHour, weekly].filter((v) => v != null);
  const usedPercent = candidates.length > 0 ? Math.max(...candidates) : null;
  return {
    fiveHourPercent: fiveHour,
    weeklyPercent: weekly,
    ...buildStatusFields({
      usedPercent,
      resetsAtMs,
      stale: Boolean(cache.error) || usedPercent === null,
      reason: usedPercent === null ? "cache_missing" : null,
    }),
  };
}

function classifyCodexSlot(win, fallbackSlot) {
  const mins = Number(win?.window_minutes ?? win?.windowMinutes);
  if (Number.isFinite(mins)) {
    if (mins <= 360) return "primary";
    if (mins >= 7000 && mins <= 14400) return "secondary";
  }
  return fallbackSlot;
}

function extractCodexWindow(win, nowMs) {
  if (!win || typeof win !== "object") return null;
  const used = clampPercent(win.used_percent ?? win.usedPercent);
  if (used == null) return null;
  const resetMs = parseTimestampMs(win.resets_at ?? win.resetsAt);
  if (resetMs != null && resetMs <= nowMs) {
    return { percent: 0, resetsAtMs: null };
  }
  return {
    percent: used,
    resetsAtMs: resetMs != null && resetMs > nowMs ? resetMs : null,
  };
}

function parseCodexCache(cacheDir, home, env, nowMs) {
  const cache = readJsonSafe(join(cacheDir, "codex-rate-limits-cache.json"));
  if (!cache || typeof cache !== "object") {
    return {
      fiveHourPercent: null,
      weeklyPercent: null,
      primaryPercent: null,
      secondaryPercent: null,
      ...buildStatusFields({ stale: true, reason: "cache_missing" }),
    };
  }

  const codexHome =
    env?.CODEX_HOME || env?.TFX_CODEX_HOME || join(home, ".codex");
  if (typeof cache.owner === "string" && cache.owner.trim()) {
    const owner = cache.owner.trim();
    if (owner !== codexHome && !owner.startsWith(`${codexHome}|`)) {
      return {
        fiveHourPercent: null,
        weeklyPercent: null,
        primaryPercent: null,
        secondaryPercent: null,
        ...buildStatusFields({ stale: true, reason: "owner_mismatch" }),
      };
    }
  }

  const bucketsObj =
    cache.buckets && typeof cache.buckets === "object"
      ? cache.buckets
      : cache.data?.buckets && typeof cache.data.buckets === "object"
        ? cache.data.buckets
        : null;

  let targetBucket = null;
  if (bucketsObj) {
    targetBucket =
      bucketsObj.codex ||
      Object.values(bucketsObj).find((b) => b && typeof b === "object") ||
      null;
  }
  if (!targetBucket && cache.probe && typeof cache.probe === "object") {
    targetBucket = cache.probe;
  }

  let primaryWin = null;
  let secondaryWin = null;
  for (const [rawSlot, win] of [
    ["primary", targetBucket?.primary],
    ["secondary", targetBucket?.secondary],
  ]) {
    if (!win || typeof win !== "object") continue;
    const slot = classifyCodexSlot(win, rawSlot);
    const parsed = extractCodexWindow(win, nowMs);
    if (!parsed) continue;
    if (slot === "primary") {
      if (!primaryWin || parsed.percent > primaryWin.percent) {
        primaryWin = parsed;
      }
    } else if (!secondaryWin || parsed.percent > secondaryWin.percent) {
      secondaryWin = parsed;
    }
  }

  const futureResets = [
    primaryWin?.resetsAtMs,
    secondaryWin?.resetsAtMs,
  ].filter((ms) => ms != null && ms > nowMs);
  const resetsAtMs = futureResets.length > 0 ? Math.min(...futureResets) : null;

  const cacheTsMs =
    cache.timestamp !== undefined
      ? typeof cache.timestamp === "number"
        ? parseTimestampMs(cache.timestamp)
        : Date.parse(String(cache.timestamp))
      : null;
  const expiredWithoutReset =
    resetsAtMs === null &&
    cache.timestamp !== undefined &&
    (!Number.isFinite(cacheTsMs) || nowMs - cacheTsMs >= DEFAULT_STALE_TTL_MS);

  if (expiredWithoutReset) {
    return {
      fiveHourPercent: null,
      weeklyPercent: null,
      primaryPercent: null,
      secondaryPercent: null,
      ...buildStatusFields({ stale: true, reason: "stale_expired" }),
    };
  }

  const fiveHourPercent = primaryWin?.percent ?? null;
  const weeklyPercent = secondaryWin?.percent ?? null;
  const candidates = [fiveHourPercent, weeklyPercent].filter((v) => v != null);
  const usedPercent = candidates.length > 0 ? Math.max(...candidates) : null;

  return {
    fiveHourPercent,
    weeklyPercent,
    primaryPercent: fiveHourPercent,
    secondaryPercent: weeklyPercent,
    ...buildStatusFields({
      usedPercent,
      resetsAtMs,
      stale: Boolean(cache.error) || usedPercent === null,
      reason: usedPercent === null ? "cache_missing" : null,
    }),
  };
}

function readCurrentAgyEmail(home) {
  const agyDir = join(home, ".gemini", "antigravity-cli");
  for (const file of ["oauth_creds.json", "credentials.json"]) {
    const creds = readJsonSafe(join(agyDir, file));
    if (!creds) continue;
    const jwtEmail = decodeJwtEmail(creds.id_token);
    if (jwtEmail) return jwtEmail;
    const direct =
      creds.email ||
      creds.account?.email ||
      creds.user?.email ||
      creds.profile?.email ||
      null;
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
  }
  return null;
}

function normalizeAgyBuckets(rawBuckets, nowMs) {
  if (!Array.isArray(rawBuckets)) return [];
  const valid = [];
  for (const item of rawBuckets) {
    if (!item || typeof item !== "object") continue;
    const rawRf = item.remaining_fraction ?? item.remainingFraction;
    const rf = typeof rawRf === "number" ? rawRf : Number(rawRf);
    if (rawRf == null || !Number.isFinite(rf) || rf < 0 || rf > 1) continue;
    const rawReset = item.reset_time ?? item.resetTime;
    const resetMs = parseTimestampMs(rawReset);
    if (resetMs != null && resetMs <= nowMs) {
      // 이미 리셋 시각이 지난 버킷은 제외한다.
      continue;
    }
    valid.push({
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name : "",
      remaining_fraction: rf,
      reset_time: rawReset ?? null,
      resetsAtMs: resetMs,
    });
  }
  return valid;
}

function parseAntigravityCache(cacheDir, home, nowMs) {
  const settings = readJsonSafe(
    join(home, ".gemini", "antigravity-cli", "settings.json"),
  );
  const gcpProject =
    typeof settings?.gcp?.project === "string" && settings.gcp.project.trim()
      ? settings.gcp.project.trim()
      : null;
  const gcpLocation =
    typeof settings?.gcp?.location === "string" && settings.gcp.location.trim()
      ? settings.gcp.location.trim()
      : "global";
  const authKind = gcpProject ? "project" : "account";

  const agyCache =
    readJsonSafe(join(cacheDir, "antigravity-quota-cache.json")) ??
    readJsonSafe(join(cacheDir, "gemini-quota-cache.json"));

  if (!agyCache || typeof agyCache !== "object") {
    return {
      authKind,
      buckets: [],
      ...buildStatusFields({ stale: true, reason: "cache_missing" }),
    };
  }

  if (authKind === "project") {
    const labelMatches =
      agyCache.accountLabel === undefined ||
      agyCache.accountLabel === gcpProject;
    const locMatches = (agyCache.location || "global") === gcpLocation;
    if (!labelMatches || !locMatches) {
      return {
        authKind,
        buckets: [],
        ...buildStatusFields({ stale: true, reason: "account_mismatch" }),
      };
    }

    const proj = agyCache.projectQuota;
    if (!proj || typeof proj !== "object") {
      return {
        authKind,
        buckets: [],
        ...buildStatusFields({ stale: true, reason: "cache_missing" }),
      };
    }
    let usedPercent = clampPercent(proj.usedPercent ?? proj.used_percent);
    const resetMs = parseTimestampMs(proj.resetTime ?? proj.reset_time);
    if (usedPercent != null && resetMs != null && resetMs <= nowMs) {
      usedPercent = 0;
    }
    const futureReset = resetMs != null && resetMs > nowMs ? resetMs : null;
    const cacheTsMs =
      agyCache.timestamp !== undefined
        ? parseTimestampMs(agyCache.timestamp)
        : null;
    if (
      futureReset === null &&
      agyCache.timestamp !== undefined &&
      (cacheTsMs === null || nowMs - cacheTsMs >= DEFAULT_STALE_TTL_MS)
    ) {
      return {
        authKind,
        buckets: [],
        ...buildStatusFields({ stale: true, reason: "stale_expired" }),
      };
    }
    return {
      authKind,
      buckets: [],
      ...buildStatusFields({
        usedPercent,
        resetsAtMs: futureReset,
        stale: usedPercent === null,
        reason: usedPercent === null ? "cache_missing" : null,
      }),
    };
  }

  // 개인 계정 모드 (macOS Keychain 인증 시 둘 다 null 일치 허용)
  const currentAccountEmail = readCurrentAgyEmail(home);
  const cachedLabel = agyCache.accountLabel ?? null;
  if (cachedLabel !== currentAccountEmail) {
    return {
      authKind,
      buckets: [],
      ...buildStatusFields({ stale: true, reason: "account_mismatch" }),
    };
  }

  const rawBuckets = agyCache.buckets ?? agyCache.data?.buckets;
  const buckets = normalizeAgyBuckets(rawBuckets, nowMs);
  if (buckets.length === 0) {
    // 모든 버킷이 리셋 경과로 비워졌고 원본 배열이 존재했다면 리셋 완료(0%)로 복구한다.
    if (Array.isArray(rawBuckets) && rawBuckets.length > 0) {
      return {
        authKind,
        buckets: [],
        ...buildStatusFields({ usedPercent: 0, stale: false, reason: null }),
      };
    }
    return {
      authKind,
      buckets: [],
      ...buildStatusFields({ stale: true, reason: "cache_missing" }),
    };
  }

  let minRf = 1;
  let resetsAtMs = null;
  for (const b of buckets) {
    if (b.remaining_fraction <= minRf) {
      minRf = b.remaining_fraction;
      resetsAtMs = b.resetsAtMs ?? resetsAtMs;
    }
  }
  const usedPercent = clampPercent((1 - minRf) * 100);
  return {
    authKind,
    buckets,
    ...buildStatusFields({
      usedPercent,
      resetsAtMs,
      stale: false,
      reason: null,
    }),
  };
}

function matchAgyBucketForCandidate(buckets, candidate, options = {}) {
  const family = String(candidate?.familyOrModel || "")
    .trim()
    .toLowerCase();
  const effort = String(candidate?.effort || "medium")
    .trim()
    .toLowerCase();
  const profile = candidate?.profile || null;

  let resolved = null;
  try {
    resolved = resolveModelFamilies("agy", {
      ...options,
      allowCommand: false,
      persist: false,
    });
  } catch {
    resolved = null;
  }

  const candidateDisplayModel =
    (profile &&
      (resolved?.profiles?.[profile]?.model ??
        AGY_FAMILY_PROFILES[profile]?.model)) ||
    null;
  const familyBaseSlug =
    (family && resolved?.families?.[family]?.model) ||
    (family ? `gemini-4-${family}` : "");
  const candidateSlug = familyBaseSlug ? `${familyBaseSlug}-${effort}` : "";

  const exactMatches = buckets.filter(
    (b) =>
      (candidateSlug && b.id === candidateSlug) ||
      (candidateDisplayModel !== null &&
        (b.name === candidateDisplayModel || b.id === candidateDisplayModel)),
  );
  const pickMin = (arr) =>
    arr.reduce((best, item) =>
      item.remaining_fraction < best.remaining_fraction ? item : best,
    );

  if (exactMatches.length > 0) return pickMin(exactMatches);

  if (family) {
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const slugRegex = new RegExp(
      `^gemini-\\d+(?:\\.\\d+)*-${escaped}(?:-|$)`,
      "iu",
    );
    const wordRegex = new RegExp(`\\b${escaped}\\b`, "iu");
    const familyMatches = buckets.filter(
      (b) => slugRegex.test(b.id) || wordRegex.test(b.name),
    );
    if (familyMatches.length > 0) return pickMin(familyMatches);
  }

  const poolMatches = buckets.filter(
    (b) => b.id === "all" || /^all models$/iu.test(b.name.trim()),
  );
  if (poolMatches.length > 0) return pickMin(poolMatches);

  return null;
}

/**
 * 스냅샷과 후보(또는 단일 벤더 엔트리)에 대해 쿼터 상태를 계산한다.
 * - evaluateVendorQuota(snapshot, candidate, options)
 * - evaluateVendorQuota(vendorEntry)
 */
export function evaluateVendorQuota(
  snapshotOrEntry = {},
  candidate = null,
  options = {},
) {
  const isFullSnapshot =
    candidate != null &&
    snapshotOrEntry != null &&
    typeof snapshotOrEntry === "object" &&
    ("claude" in snapshotOrEntry ||
      "codex" in snapshotOrEntry ||
      "antigravity" in snapshotOrEntry);

  const cli = candidate?.cli;
  const vendorEntry = isFullSnapshot ? snapshotOrEntry?.[cli] : snapshotOrEntry;
  if (!vendorEntry || typeof vendorEntry !== "object") {
    return buildStatusFields({ reason: "cache_missing" });
  }

  if (vendorEntry.cooldownActive || vendorEntry.status === "cooldown") {
    return buildStatusFields({
      usedPercent: vendorEntry.usedPercent ?? vendorEntry.percent ?? null,
      cooldownActive: true,
      cooldownUntilMs:
        vendorEntry.cooldownUntilMs ?? vendorEntry.resetsAtMs ?? null,
      cooldownResetIso: vendorEntry.cooldownResetIso ?? null,
      reason: "runtime_cooldown",
    });
  }

  if (
    cli === "antigravity" &&
    vendorEntry.authKind === "account" &&
    Array.isArray(vendorEntry.buckets) &&
    vendorEntry.buckets.length > 0
  ) {
    const matched = matchAgyBucketForCandidate(
      vendorEntry.buckets,
      candidate,
      options,
    );
    if (!matched) {
      return buildStatusFields({
        usedPercent: null,
        resetsAtMs: null,
        reason: null,
      });
    }
    const usedPercent = clampPercent((1 - matched.remaining_fraction) * 100);
    return buildStatusFields({
      usedPercent,
      resetsAtMs: matched.resetsAtMs ?? null,
      reason: null,
    });
  }

  const pct = vendorEntry.usedPercent ?? vendorEntry.percent ?? null;
  return buildStatusFields({
    usedPercent: pct,
    resetsAtMs: vendorEntry.resetsAtMs ?? null,
    stale: Boolean(vendorEntry.stale),
    reason: vendorEntry.reason ?? null,
  });
}

/**
 * 로컬 캐시와 런타임 마커에서 3사 쿼터 스냅샷을 읽는다.
 *
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, tmpDir?: string, platform?: string, now?: number }} [options]
 */
export function readQuotaSnapshot(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const nowMs =
    typeof options.now === "number" && Number.isFinite(options.now)
      ? options.now
      : Date.now();
  const home = options.home || resolveTrifluxHome({ env, platform });
  const cacheDir = join(home, ".claude", "cache");
  const resolvedTmpDir =
    options.tmpDir || resolveQuotaTmpDir({ env, platform });

  const claudeCooldown = readRuntimeCooldown(
    resolvedTmpDir,
    ["tfx-quota-reset-claude"],
    nowMs,
  );
  const claudeParsed = parseClaudeCache(cacheDir, home, env, nowMs);
  const claude = claudeCooldown.cooldownActive
    ? {
        ...claudeParsed,
        ...buildStatusFields({
          usedPercent: claudeParsed.usedPercent,
          ...claudeCooldown,
          stale: claudeParsed.stale,
          reason: "runtime_cooldown",
        }),
      }
    : claudeParsed;

  const codexCooldown = readRuntimeCooldown(
    resolvedTmpDir,
    ["tfx-quota-reset-codex"],
    nowMs,
  );
  const codexParsed = parseCodexCache(cacheDir, home, env, nowMs);
  const codex = codexCooldown.cooldownActive
    ? {
        ...codexParsed,
        ...buildStatusFields({
          usedPercent: codexParsed.usedPercent,
          ...codexCooldown,
          stale: codexParsed.stale,
          reason: "runtime_cooldown",
        }),
      }
    : codexParsed;

  const agyCooldown = readRuntimeCooldown(
    resolvedTmpDir,
    ["tfx-agy-quota-reset", "tfx-quota-reset-antigravity"],
    nowMs,
  );
  const agyParsed = parseAntigravityCache(cacheDir, home, nowMs);
  const antigravity = agyCooldown.cooldownActive
    ? {
        ...agyParsed,
        ...buildStatusFields({
          usedPercent: agyParsed.usedPercent,
          ...agyCooldown,
          stale: agyParsed.stale,
          reason: "runtime_cooldown",
        }),
      }
    : agyParsed;

  return {
    now: nowMs,
    claude,
    codex,
    antigravity,
  };
}
