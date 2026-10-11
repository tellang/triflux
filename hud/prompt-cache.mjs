import { bold, CLAUDE_ORANGE_BG, CODEX_WHITE_BG, RESET } from "./colors.mjs";

// 마커 글자가 곧 제공자다. 색 함수 비교에 기대지 않는다.
const CACHE_BACKGROUNDS = { c: CLAUDE_ORANGE_BG, x: CODEX_WHITE_BG };

export function getPromptCacheState(expiresAt, ttlMs, now) {
  const remaining = expiresAt - now;
  if (!(remaining > 0)) return "cold";
  return remaining <= Math.min(5 * 60_000, ttlMs * 0.2) ? "cooling" : "warm";
}

export function renderCacheMarker(marker, color, cache, now = Date.now()) {
  const state = getPromptCacheState(cache?.expiresAt, cache?.ttlMs, now);
  if (state === "cold") return bold(color(marker));
  const background = CACHE_BACKGROUNDS[marker];
  if (!background) return bold(color(marker));
  const blink = state === "cooling" ? "\x1b[5m" : "";
  return `${background}\x1b[30m\x1b[1m${blink}${marker}${RESET}`;
}

export function claudePromptCache(cache) {
  if (!cache?.warm || cache.caching_observed === false) return null;
  return {
    expiresAt: cache.expires_at * 1000,
    ttlMs: cache.ttl === "1h" ? 60 * 60_000 : 5 * 60_000,
  };
}
