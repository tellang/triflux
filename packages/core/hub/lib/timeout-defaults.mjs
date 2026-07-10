// hub 조율 평면 타임아웃/TTL의 단일 기준값. 환경은 호출 시점에 읽는다.

export const MIN_DURATION_MS = 1_000;
export const MAX_DURATION_MS = 86_400_000;
export const DEFAULT_ASSIGN_TIMEOUT_MS = 600_000;
export const DEFAULT_ASSIGN_TTL_MS = 600_000;
export const DEFAULT_HANDOFF_TTL_MS = 600_000;
export const DEFAULT_SWARM_LOCK_TTL_MS = 600_000;
export const DEFAULT_REGISTER_TIMEOUT_SEC = 600;
export const REGISTER_HEARTBEAT_GRACE_MS = 120_000;
export const DEFAULT_STALL_INTERVENTION_SEC = 1_200;
export const DEFAULT_HARD_CEILING_SEC = 21_600;

function readEnvSeconds(env, name, fallbackSec) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallbackSec;
}

export function resolveStallInterventionMs(env = process.env) {
  return (
    readEnvSeconds(env, "TFX_STALL_THRESHOLD", DEFAULT_STALL_INTERVENTION_SEC) *
    1000
  );
}

export function resolveHardCeilingMs(env = process.env) {
  return (
    readEnvSeconds(env, "TFX_HARD_CEILING_SEC", DEFAULT_HARD_CEILING_SEC) * 1000
  );
}

export function resolveWorkerLeaseTtlMs(env = process.env) {
  return resolveStallInterventionMs(env) + REGISTER_HEARTBEAT_GRACE_MS;
}

export function clampDurationMs(
  value,
  fallback = DEFAULT_ASSIGN_TIMEOUT_MS,
  min = MIN_DURATION_MS,
  max = MAX_DURATION_MS,
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(Math.trunc(numeric), max));
}
