const VALID_CLIENTS = new Set(["codex", "claude", "gemini", "unknown"]);
const VALID_PHASES = new Set(["ingress", "handler", "store", "event-loop"]);
const SAMPLE_LIMIT = 1000;

const categories = new Map();
const workerDurations = [];
const workerCounts = {
  spawned: 0,
  exited: 0,
};

function debugInvalid(kind, details) {
  if (process.env.TFX_TRACE_DEBUG !== "1") return;
  console.debug(`[trace-recorder] ignored invalid ${kind}`, details);
}

function normalizeClient(client) {
  const value = String(client || "unknown").toLowerCase();
  return VALID_CLIENTS.has(value) ? value : "unknown";
}

function normalizePhase(phase) {
  const value = String(phase || "handler");
  return VALID_PHASES.has(value) ? value : "handler";
}

function validDuration(durMs) {
  return Number.isFinite(durMs) && durMs >= 0;
}

function emptyStats() {
  return {
    count: 0,
    total: 0,
    min: null,
    max: null,
    samples: [],
    phases: {},
  };
}

function addDuration(stats, durMs, phase) {
  stats.count += 1;
  stats.total += durMs;
  stats.min = stats.min == null ? durMs : Math.min(stats.min, durMs);
  stats.max = stats.max == null ? durMs : Math.max(stats.max, durMs);
  stats.samples.push(durMs);
  if (stats.samples.length > SAMPLE_LIMIT) {
    stats.samples.splice(0, stats.samples.length - SAMPLE_LIMIT);
  }

  const phaseStats = stats.phases[phase] || emptyPhaseStats();
  phaseStats.count += 1;
  phaseStats.total += durMs;
  phaseStats.min =
    phaseStats.min == null ? durMs : Math.min(phaseStats.min, durMs);
  phaseStats.max =
    phaseStats.max == null ? durMs : Math.max(phaseStats.max, durMs);
  stats.phases[phase] = phaseStats;
}

function emptyPhaseStats() {
  return { count: 0, total: 0, min: null, max: null };
}

function percentile(samples, percentileValue) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function publicStats(stats) {
  return {
    count: stats.count,
    total: stats.total,
    min: stats.min,
    max: stats.max,
    p50: percentile(stats.samples, 50),
    p95: percentile(stats.samples, 95),
    p99: percentile(stats.samples, 99),
    phases: stats.phases,
  };
}

export function recordRequest(
  category,
  durMs,
  client = "unknown",
  phase = "handler",
) {
  if (!category || typeof category !== "string") return;
  if (!validDuration(durMs)) {
    debugInvalid("request duration", { category, durMs, client, phase });
    return;
  }

  const clientKey = normalizeClient(client);
  const phaseKey = normalizePhase(phase);
  const bucket = categories.get(category) || new Map();
  const stats = bucket.get(clientKey) || emptyStats();
  addDuration(stats, durMs, phaseKey);
  bucket.set(clientKey, stats);
  categories.set(category, bucket);
}

export function recordWorker(workerId, kind, command, durMs) {
  if (!workerId || typeof workerId !== "string") return;
  if (kind === "spawned") {
    workerCounts.spawned += 1;
    return;
  }
  if (kind !== "exited") return;

  workerCounts.exited += 1;
  if (durMs == null) return;
  if (!validDuration(durMs)) {
    debugInvalid("worker duration", { workerId, kind, command, durMs });
    return;
  }
  workerDurations.push(durMs);
  if (workerDurations.length > SAMPLE_LIMIT) {
    workerDurations.splice(0, workerDurations.length - SAMPLE_LIMIT);
  }
}

export function snapshot() {
  const categorySnapshot = {};
  for (const [category, bucket] of categories.entries()) {
    categorySnapshot[category] = {};
    for (const [client, stats] of bucket.entries()) {
      categorySnapshot[category][client] = publicStats(stats);
    }
  }

  return {
    categories: categorySnapshot,
    workers: {
      spawned: workerCounts.spawned,
      exited: workerCounts.exited,
      p50: percentile(workerDurations, 50),
      p95: percentile(workerDurations, 95),
      p99: percentile(workerDurations, 99),
    },
  };
}

export function reset() {
  categories.clear();
  workerDurations.length = 0;
  workerCounts.spawned = 0;
  workerCounts.exited = 0;
}
