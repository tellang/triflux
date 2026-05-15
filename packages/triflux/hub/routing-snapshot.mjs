// hub/routing-snapshot.mjs
//
// PRD: .omx/plans/prd-dynamic-routing-engine.md
//
// Phase 0 — pure read-only context projector. Wraps HUD providers and the
// AccountBroker public snapshot into a single deterministic snapshot that
// `evaluateDynamicRoute(request, snapshot, policy)` consumes.
//
// Phase 0 contract:
//   - no callers yet (dormant). Only `evaluateDynamicRoute()` is meant to read this.
//   - lazy import of HUD providers + broker so this module imports cleanly even
//     when those surfaces are absent in tests.
//   - never mutates upstream state — strictly read-only.
//   - all output fields are derivable from `publicSnapshot()` / HUD redacted API,
//     so writing the resulting snapshot to disk does not leak credentials.

const CLAUDE_HUD_MODULE = "../hud/providers/claude.mjs";
const CODEX_HUD_MODULE = "../hud/providers/codex.mjs";
const BROKER_MODULE = "./account-broker.mjs";

async function loadHudClaude() {
  try {
    return await import(CLAUDE_HUD_MODULE);
  } catch {
    return null;
  }
}

async function loadHudCodex() {
  try {
    return await import(CODEX_HUD_MODULE);
  } catch {
    return null;
  }
}

async function loadBroker() {
  try {
    const mod = await import(BROKER_MODULE);
    return mod.broker ?? mod.default ?? null;
  } catch {
    return null;
  }
}

function normalizeClaudeUsage(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const data = raw.data ?? raw;
  if (!data) return null;
  return {
    fiveHourPercent: numericOrNull(data.fiveHourPercent),
    weeklyPercent: numericOrNull(data.weeklyPercent),
    fiveHourResetsAt: toEpoch(data.fiveHourResetsAt),
    weeklyResetsAt: toEpoch(data.weeklyResetsAt),
    observedAt: toEpoch(data.observedAt) ?? now,
    isStale: Boolean(raw.isStale ?? data.isStale),
    source: data.source ?? "hud/providers/claude.mjs",
  };
}

function normalizeCodexUsage(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const buckets = raw.buckets ?? raw.data?.buckets ?? raw;
  if (!buckets || typeof buckets !== "object") return null;
  const entries = Object.entries(buckets);
  if (entries.length === 0) return null;
  const out = {};
  for (const [id, bucket] of entries) {
    if (!bucket || typeof bucket !== "object") continue;
    out[id] = {
      primary: normalizeCodexBucketLeg(bucket.primary),
      secondary: normalizeCodexBucketLeg(bucket.secondary),
    };
  }
  return {
    buckets: out,
    observedAt: toEpoch(raw.observedAt) ?? now,
    isStale: Boolean(raw.shouldRefresh === false ? false : raw.isStale),
    source: raw.source ?? "hud/providers/codex.mjs",
  };
}

function normalizeCodexBucketLeg(leg) {
  if (!leg || typeof leg !== "object") return null;
  return {
    usedPercent: numericOrNull(leg.used_percent ?? leg.usedPercent),
    resetsAt: toEpoch(leg.resets_at ?? leg.resetsAt),
  };
}

function normalizeBrokerSnapshot(raw) {
  if (!Array.isArray(raw)) return null;
  const grouped = { codex: [], claude: [], gemini: [] };
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const provider = entry.provider;
    if (!grouped[provider]) continue;
    grouped[provider].push({
      id: entry.id,
      tier: entry.tier ?? "unknown",
      busy: Boolean(entry.busy),
      cooldownUntil: toEpoch(entry.cooldownUntil),
      lastUsedAt: toEpoch(entry.lastUsedAt),
      remainingMs: numericOrNull(entry.remainingMs),
      circuitState: entry.circuitState ?? "closed",
      failureCount: numericOrNull(entry.failureCount) ?? 0,
      expiresAt: toEpoch(entry.expiresAt),
      drainAfter: toEpoch(entry.drainAfter),
    });
  }
  return grouped;
}

function numericOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toEpoch(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function buildRoutingSnapshot({
  forceRefresh = false,
  now = Date.now(),
} = {}) {
  const [hudClaude, hudCodex, broker] = await Promise.all([
    loadHudClaude(),
    loadHudCodex(),
    loadBroker(),
  ]);

  let claude = null;
  if (hudClaude?.readClaudeUsageSnapshot) {
    try {
      claude = normalizeClaudeUsage(
        hudClaude.readClaudeUsageSnapshot({ forceRefresh }),
        now,
      );
    } catch (err) {
      claude = {
        error: String(err?.message ?? err),
        observedAt: now,
        isStale: true,
      };
    }
  }

  let codex = null;
  if (hudCodex?.readCodexRateLimitSnapshot) {
    try {
      codex = normalizeCodexUsage(
        hudCodex.readCodexRateLimitSnapshot({ forceRefresh }),
        now,
      );
    } catch (err) {
      codex = {
        error: String(err?.message ?? err),
        observedAt: now,
        isStale: true,
      };
    }
  }

  let brokerState = null;
  if (broker?.publicSnapshot) {
    try {
      brokerState = normalizeBrokerSnapshot(broker.publicSnapshot());
    } catch (err) {
      brokerState = { error: String(err?.message ?? err) };
    }
  }

  return {
    schemaVersion: 1,
    observedAt: now,
    claude,
    codex,
    broker: brokerState,
  };
}

// Test helpers — pure normalizers exposed so unit tests can build snapshots
// from mock provider responses without running real HUD I/O.
export const __internal__ = {
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizeBrokerSnapshot,
};
