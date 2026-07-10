// 활동 기반 워커 lifecycle. 시간 기본값은 timeout-defaults SSOT에서만 가져온다.
import {
  resolveHardCeilingMs,
  resolveStallInterventionMs,
} from "./timeout-defaults.mjs";

export { resolveHardCeilingMs, resolveStallInterventionMs };

export function isActivityLifecycleEnabled(env = process.env) {
  return env.TFX_ACTIVITY_LIFECYCLE !== "0";
}

/**
 * 활동 신호를 기준으로 무활동 개입과 절대 상한을 판정한다.
 * 호출자는 observe()에 자기 채널의 기존 활동 서명을 전달하고, check()에
 * 개입 대상 문맥을 제공한다. 이 모듈은 신호를 생성하거나 개입을 실행하지 않는다.
 */
export function createActivityLifecycle({
  enabled = isActivityLifecycleEnabled(),
  interventionMs = resolveStallInterventionMs(),
  hardCeilingMs = resolveHardCeilingMs(),
  maxInterventions = 1,
  onIntervene,
  now = Date.now,
} = {}) {
  const startedAt = now();
  let lastActivityAt = startedAt;
  let lastSignature;
  let hasSignature = false;
  let interventions = 0;
  let timeoutReason = "";
  let pendingIntervention = null;

  const markActivity = () => {
    lastActivityAt = now();
  };

  async function intervene(context = {}) {
    if (!enabled || typeof onIntervene !== "function") return false;
    if (interventions >= maxInterventions || pendingIntervention) return false;

    interventions += 1;
    const inactiveMs = Math.max(0, now() - lastActivityAt);
    pendingIntervention = Promise.resolve(
      onIntervene({ ...context, inactiveMs, interventions }),
    )
      .then((handled) => handled === true)
      .catch(() => false);
    try {
      const handled = await pendingIntervention;
      if (handled) markActivity();
      return handled;
    } finally {
      pendingIntervention = null;
    }
  }

  return Object.freeze({
    observe(signature) {
      if (!enabled) return false;
      const changed = arguments.length === 0 || !hasSignature || signature !== lastSignature;
      if (changed) {
        lastSignature = signature;
        hasSignature = true;
        markActivity();
      }
      return changed;
    },
    async check(context = {}) {
      if (!enabled || timeoutReason) return timeoutReason;
      const current = now();
      if (current - startedAt >= hardCeilingMs) {
        timeoutReason = "hard_ceiling";
        return timeoutReason;
      }
      if (current - lastActivityAt < interventionMs || pendingIntervention) return "";
      if (await intervene(context)) return "";
      timeoutReason = "inactivity";
      return timeoutReason;
    },
    intervene,
    get enabled() {
      return enabled;
    },
    get hardCeilingMs() {
      return hardCeilingMs;
    },
    get interventionMs() {
      return interventionMs;
    },
    get interventions() {
      return interventions;
    },
    get timeoutReason() {
      return timeoutReason;
    },
  });
}
