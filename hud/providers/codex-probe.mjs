// codex app-server account/rateLimits/read 능동 프로브 + 정규화.
// 세션 이벤트(snake_case) 파이프라인에 합류 가능한 스냅샷을 만든다.

function toSnakeBucket(bucket) {
  if (!bucket) return null;
  return {
    used_percent: bucket.usedPercent ?? null,
    window_minutes: bucket.windowDurationMins ?? null,
    resets_at: bucket.resetsAt ?? null,
  };
}

function toSnapshot(entry, nowIso) {
  return {
    limitId: entry.limitId,
    limitName: entry.limitName ?? null,
    primary: toSnakeBucket(entry.primary),
    secondary: toSnakeBucket(entry.secondary),
    credits: entry.credits ?? null,
    tokens: null,
    contextWindow: null,
    timestamp: nowIso,
    probe: true,
  };
}

export function normalizeAppServerRateLimits(result, nowIso) {
  if (!result) return [];
  const byId = result.rateLimitsByLimitId;
  if (byId && typeof byId === "object" && Object.keys(byId).length > 0) {
    return Object.values(byId)
      .filter((e) => e && e.limitId)
      .map((e) => toSnapshot(e, nowIso));
  }
  if (result.rateLimits?.limitId) {
    return [toSnapshot(result.rateLimits, nowIso)];
  }
  return [];
}
