// hub 조율 평면 타임아웃/TTL의 단일 기준값. 환경은 호출 시점에 읽는다.
import { readMachineProfile } from "../../scripts/lib/machine-profile.mjs";

export const MIN_DURATION_MS = 1_000;
export const MAX_DURATION_MS = 86_400_000;
export const DEFAULT_ASSIGN_TIMEOUT_MS = 600_000;
export const DEFAULT_ASSIGN_TTL_MS = 600_000;
export const DEFAULT_HANDOFF_TTL_MS = 600_000;
export const DEFAULT_REGISTER_TIMEOUT_SEC = 600;
export const REGISTER_HEARTBEAT_GRACE_MS = 120_000;
export const DEFAULT_STALL_INTERVENTION_SEC = 1_200;
export const DEFAULT_HARD_CEILING_SEC = 21_600;

// 셸(tfx-route.sh)과 같은 우선순위: 명시 env, 그다음 machine profile, 그다음 기본값.
function readSetting(env, name) {
  if (env?.[name] !== undefined) return env[name];
  return readMachineProfile({ env }).values[name];
}

function readSeconds(env, name, fallbackSec, { allowZero = false } = {}) {
  const raw = String(readSetting(env, name) ?? "").trim();
  // 셸의 ${VAR:-기본값} 처럼 빈 값은 기본값이다. Number("") 가 0 이 되는 것을 막는다.
  if (!raw) return fallbackSec;
  const value = Number(raw);
  const min = allowZero ? 0 : 1;
  return Number.isInteger(value) && value >= min ? value : fallbackSec;
}

export function resolveStallInterventionMs(env = process.env) {
  return (
    readSeconds(env, "TFX_STALL_THRESHOLD", DEFAULT_STALL_INTERVENTION_SEC) *
    1000
  );
}

// 0 은 셸과 같이 상한 없음이다.
export function resolveHardCeilingMs(env = process.env) {
  const sec = readSeconds(
    env,
    "TFX_HARD_CEILING_SEC",
    DEFAULT_HARD_CEILING_SEC,
    {
      allowZero: true,
    },
  );
  return sec === 0 ? Number.POSITIVE_INFINITY : sec * 1000;
}

// 셸 heartbeat 와 같은 값 해석. classify 는 무활동이어도 끝내지 않는다.
export function resolveStallKill(env = process.env) {
  const value = String(readSetting(env, "TFX_STALL_KILL") || "kill")
    .trim()
    .toLowerCase();
  if (["1", "on", "kill"].includes(value)) return "kill";
  if (["intervene", "ladder"].includes(value)) return "intervene";
  return "classify";
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
