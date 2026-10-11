import { dim } from "./colors.mjs";

export function getPromptCacheState(expiresAt, ttlMs, now) {
  const remaining = expiresAt - now;
  if (!(remaining > 0)) return "cold";
  return remaining <= Math.min(5 * 60_000, ttlMs * 0.2) ? "cooling" : "warm";
}

// full 게이지와 퍼센트 사이 공백 한 칸을 캐시 표시로 쓴다. 폭은 늘지 않는다.
export function cacheGap(cache, color, now = Date.now()) {
  const state = getPromptCacheState(cache?.expiresAt, cache?.ttlMs, now);
  if (state === "cold") return " ";
  return state === "cooling" ? dim("+") : color("+");
}

export function claudePromptCache(cache) {
  if (!cache?.warm || cache.caching_observed === false) return null;
  return {
    expiresAt: cache.expires_at * 1000,
    ttlMs: cache.ttl === "1h" ? 60 * 60_000 : 5 * 60_000,
  };
}
