import { createHash } from 'node:crypto';

import { normalizePath } from './platform.mjs';
import { withRetry } from './workers/worker-utils.mjs';

const ADAPTIVE_FINGERPRINT_VERSION = 1;
const DEFAULT_SCOPE = 'default';
const META_PREFIX = 'adaptive_fingerprint:';
const DEFAULT_RETRY_OPTIONS = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 250,
});
const TIME_WINDOWS = Object.freeze([
  { name: 'overnight', start: 0, end: 5 },
  { name: 'morning', start: 6, end: 11 },
  { name: 'afternoon', start: 12, end: 17 },
  { name: 'evening', start: 18, end: 23 },
]);
const MEMORY_FINGERPRINT_CACHE = new WeakMap();

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toIsoTimestamp(value = Date.now()) {
  const time = Number.isFinite(Number(value)) ? Number(value) : Date.now();
  return new Date(time).toISOString();
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeRetryOptions(options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts) || DEFAULT_RETRY_OPTIONS.maxAttempts);
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs) || DEFAULT_RETRY_OPTIONS.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, Number(options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs) || DEFAULT_RETRY_OPTIONS.maxDelayMs);
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function normalizeScope(scope) {
  const text = String(scope ?? DEFAULT_SCOPE).trim();
  return text || DEFAULT_SCOPE;
}

function metaKey(scope) {
  return `${META_PREFIX}${normalizeScope(scope)}`;
}

function hashValue(value) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(value));
  return `sha256:${hash.digest('hex')}`;
}

function normalizeContextPath(value) {
  const normalized = normalizePath(String(value ?? ''));
  return normalized.replace(/\/+/gu, '/').replace(/\/+$/u, '') || '/';
}

function toRelativePath(targetPath, cwd) {
  if (!cwd) return targetPath;
  const base = normalizeContextPath(cwd);
  if (targetPath === base) return '.';
  return targetPath.startsWith(`${base}/`) ? targetPath.slice(base.length + 1) : targetPath;
}

function toUniqueList(values) {
  const seen = new Set();
  const next = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

function collectRawPathCandidates(context = {}) {
  const direct = [context.file_path, context.filePath, context.path, context.target_path, context.targetPath];
  const fromArrays = [context.files, context.paths, context.targets]
    .filter(Array.isArray)
    .flatMap((entry) => entry)
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path));
  return [...direct, ...fromArrays].filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function collectPathPattern(context = {}) {
  const normalized = toUniqueList(
    collectRawPathCandidates(context)
      .map((entry) => normalizeContextPath(entry))
      .map((entry) => toRelativePath(entry, context.cwd || context.project_root || context.projectRoot)),
  ).sort();

  const primaryPath = normalized[0] ?? null;
  const extensions = normalized
    .map((entry) => entry.split('/').pop() || '')
    .map((entry) => (entry.includes('.') ? entry.slice(entry.lastIndexOf('.')).toLowerCase() : 'none'));
  const extensionCounts = extensions.reduce((acc, ext) => ({
    ...acc,
    [ext]: (acc[ext] || 0) + 1,
  }), {});

  return {
    count: normalized.length,
    primary_path: primaryPath,
    sample_paths: normalized.slice(0, 5),
    extension_counts: extensionCounts,
    checksum: hashValue(normalized),
  };
}

function normalizeWorkType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) {
    return { raw: null, normalized: 'general' };
  }
  const normalized = text.replace(/\s+/gu, '-').replace(/[^a-z0-9-]/gu, '') || 'general';
  return { raw: value, normalized };
}

function collectActivityTimestamps(context = {}, now = Date.now) {
  const nowValue = typeof now === 'function' ? now() : now;
  const fromList = [context.activity_timestamps, context.activityTimestamps, context.timestamps]
    .filter(Array.isArray)
    .flatMap((entry) => entry)
    .map(toTimestamp)
    .filter((entry) => entry != null);
  const singles = [context.timestamp, context.started_at, context.startedAt]
    .map(toTimestamp)
    .filter((entry) => entry != null);
  return fromList.length || singles.length ? [...fromList, ...singles] : [Number(nowValue)];
}

function classifyHour(hour) {
  const safeHour = Number.isFinite(Number(hour)) ? Number(hour) : 0;
  const matched = TIME_WINDOWS.find((window) => safeHour >= window.start && safeHour <= window.end);
  return matched?.name || 'overnight';
}

function buildWindowHistogram(timestamps = []) {
  const histogram = TIME_WINDOWS.reduce((acc, window) => ({ ...acc, [window.name]: 0 }), {});
  for (const timestamp of timestamps) {
    const bucket = classifyHour(new Date(timestamp).getHours());
    histogram[bucket] = (histogram[bucket] || 0) + 1;
  }
  return histogram;
}

function dominantWindow(histogram) {
  const sorted = Object.entries(histogram)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return sorted[0]?.[0] || 'overnight';
}

function resolveTimezoneName(context = {}) {
  const fromContext = typeof context.timezone === 'string' ? context.timezone.trim() : '';
  const fromIntl = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return fromContext || fromIntl;
}

function collectTimezonePattern(context = {}, now = Date.now) {
  const timestamps = collectActivityTimestamps(context, now);
  const firstTimestamp = timestamps[0] ?? Date.now();
  const histogram = buildWindowHistogram(timestamps);
  return {
    timezone: resolveTimezoneName(context),
    offset_minutes: -new Date(firstTimestamp).getTimezoneOffset(),
    sample_count: timestamps.length,
    window_histogram: histogram,
    dominant_window: dominantWindow(histogram),
  };
}

function computeFingerprintSignature(input) {
  const source = {
    file_checksum: input.path_pattern.checksum,
    work_type: input.work_type.normalized,
    timezone: input.timezone_pattern.timezone,
    dominant_window: input.timezone_pattern.dominant_window,
  };
  return hashValue(source);
}

function getMemoryStoreMap(store) {
  const current = MEMORY_FINGERPRINT_CACHE.get(store);
  if (current) return current;
  const next = new Map();
  MEMORY_FINGERPRINT_CACHE.set(store, next);
  return next;
}

function readFingerprintFromStore(store, scope) {
  if (!store) return null;
  if (typeof store.loadAdaptiveFingerprint === 'function') {
    return store.loadAdaptiveFingerprint(scope);
  }
  if (store.db?.prepare) {
    const row = store.db.prepare('SELECT value FROM _meta WHERE key = ?').get(metaKey(scope));
    return row?.value ? JSON.parse(row.value) : null;
  }
  return clone(getMemoryStoreMap(store).get(normalizeScope(scope)) || null);
}

function writeFingerprintToStore(store, scope, record) {
  if (!store) return clone(record);
  if (typeof store.saveAdaptiveFingerprint === 'function') {
    return store.saveAdaptiveFingerprint(scope, clone(record));
  }
  if (store.db?.prepare) {
    store.db.prepare('INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)')
      .run(metaKey(scope), JSON.stringify(record));
    return clone(record);
  }
  getMemoryStoreMap(store).set(normalizeScope(scope), clone(record));
  return clone(record);
}

function buildHealthSnapshot(base, patch = {}) {
  return {
    state: patch.state || base.state || 'healthy',
    retry: { ...base.retry },
    last_success_at: patch.last_success_at ?? base.last_success_at ?? null,
    last_failure_at: patch.last_failure_at ?? base.last_failure_at ?? null,
    last_error: patch.last_error ?? base.last_error ?? null,
  };
}

function createInitialHealth(retryOptions) {
  return {
    state: 'healthy',
    retry: { ...retryOptions },
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
  };
}

function resolveNowValue(now) {
  return typeof now === 'function' ? now() : now;
}

function mergeFingerprintSnapshot(previous, computed, scope) {
  return {
    ...computed,
    scope,
    observation_count: (previous?.observation_count || 0) + 1,
    first_captured_at: previous?.first_captured_at || computed.captured_at,
  };
}

function markHealthyHealth(base, now) {
  return buildHealthSnapshot(base, {
    state: 'healthy',
    last_success_at: toIsoTimestamp(resolveNowValue(now)),
    last_error: null,
  });
}

function markDegradedHealth(base, now, error) {
  return buildHealthSnapshot(base, {
    state: 'degraded',
    last_failure_at: toIsoTimestamp(resolveNowValue(now)),
    last_error: {
      name: error?.name || 'Error',
      message: error?.message || 'unknown adaptive fingerprint error',
    },
  });
}

export function buildAdaptiveFingerprint(sessionContext = {}, options = {}) {
  const now = options.now ?? Date.now;
  const capturedAt = toIsoTimestamp(resolveNowValue(now));
  const pathPattern = collectPathPattern(sessionContext);
  const workType = normalizeWorkType(sessionContext.work_type ?? sessionContext.workType);
  const timezonePattern = collectTimezonePattern(sessionContext, now);
  const fingerprintId = computeFingerprintSignature({
    path_pattern: pathPattern,
    work_type: workType,
    timezone_pattern: timezonePattern,
  });

  return {
    version: ADAPTIVE_FINGERPRINT_VERSION,
    captured_at: capturedAt,
    scope: normalizeScope(sessionContext.scope),
    fingerprint_id: fingerprintId,
    path_pattern: pathPattern,
    work_type: workType,
    timezone_pattern: timezonePattern,
  };
}

export async function loadAdaptiveFingerprint(store, scope = DEFAULT_SCOPE) {
  const loaded = await Promise.resolve(readFingerprintFromStore(store, scope));
  return clone(loaded);
}

export async function saveAdaptiveFingerprint(store, scope, fingerprint, options = {}) {
  const retryOptions = normalizeRetryOptions(options.retryOptions);
  const normalizedScope = normalizeScope(scope);
  const write = async () => Promise.resolve(writeFingerprintToStore(store, normalizedScope, fingerprint));
  const saved = await withRetry(write, { ...retryOptions });
  return clone(saved);
}

export function createAdaptiveFingerprintService(options = {}) {
  const store = options.store ?? null;
  const retryOptions = normalizeRetryOptions(options.retryOptions);
  const now = options.now ?? Date.now;
  let health = createInitialHealth(retryOptions);

  async function capture(sessionContext = {}) {
    const computed = buildAdaptiveFingerprint(sessionContext, { now });
    const scope = normalizeScope(sessionContext.scope ?? computed.scope);
    const previous = await loadAdaptiveFingerprint(store, scope);
    const merged = mergeFingerprintSnapshot(previous, computed, scope);

    try {
      const saved = await saveAdaptiveFingerprint(store, scope, merged, { retryOptions });
      health = markHealthyHealth(health, now);
      return saved;
    } catch (error) {
      health = markDegradedHealth(health, now, error);
      throw error;
    }
  }

  async function read(scope = DEFAULT_SCOPE) {
    return loadAdaptiveFingerprint(store, scope);
  }

  function getHealth() {
    return clone(health);
  }

  return Object.freeze({
    captureFingerprint: capture,
    computeFingerprint: (sessionContext = {}) => buildAdaptiveFingerprint(sessionContext, { now }),
    loadFingerprint: read,
    getHealth,
  });
}

export default createAdaptiveFingerprintService;
