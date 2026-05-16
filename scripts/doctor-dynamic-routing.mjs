// scripts/doctor-dynamic-routing.mjs
//
// Phase 1 Wire-up 4 — `tfx doctor --dynamic-routing` diagnostic helper.
// 사용자가 dynamic routing 상태 (env / policy / snapshot cache / preview decision)
// 를 한 화면에 확인할 수 있도록 진단 report 를 만든다.

import {
  createDynamicRouter,
  __internal__ as dynamicRoutingInternal,
  isDynamicRoutingEnabled,
} from "../hub/dynamic-routing-engine.mjs";
import { getDefaultSnapshot } from "../hub/routing-snapshot.mjs";

/**
 * Dynamic routing 상태 진단.
 * @returns {Promise<{
 *   enabled: boolean,
 *   envFlag: string | null,
 *   policyLoaded: boolean,
 *   policyScenarios: string[],
 *   policyPath: string,
 *   snapshotCached: boolean,
 *   snapshotAgeMs: number | null,
 *   previewDecision: object | null,
 *   error: string | null,
 * }>}
 */
export async function diagnoseDynamicRouting() {
  const envFlag = process.env.TRIFLUX_DYNAMIC_ROUTING ?? null;
  const enabled = isDynamicRoutingEnabled(process.env);
  const policy = dynamicRoutingInternal.loadPolicy();
  const policyPath = dynamicRoutingInternal.DEFAULT_POLICY_PATH;

  const report = {
    enabled,
    envFlag,
    policyLoaded: Boolean(policy),
    policyScenarios: Array.isArray(policy?.scenarios)
      ? policy.scenarios.map((s) => s.id)
      : [],
    policyPath,
    snapshotCached: false,
    snapshotAgeMs: null,
    previewDecision: null,
    error: null,
  };

  try {
    const now = Date.now();
    const snapshot = await getDefaultSnapshot({ now });
    if (snapshot && typeof snapshot.observedAt === "number") {
      report.snapshotCached = true;
      report.snapshotAgeMs = now - snapshot.observedAt;
    }

    if (enabled) {
      const router = createDynamicRouter();
      const decision = await router.routeRequest(
        {
          task_id: `tfx-doctor-preview-${process.pid}-${now}`,
          team_size: 1,
          agent_hint: "codex",
        },
        { now },
      );
      report.previewDecision = {
        decisionId: decision?.decisionId ?? null,
        scenario: decision?.scenario ?? null,
        mode: decision?.mode ?? null,
        lane: decision?.lane ?? null,
        shards: Array.isArray(decision?.shards)
          ? decision.shards.map((s) => ({
              cli: s.cli,
              accountId: s.accountId ?? null,
              riskTier: s.riskTier ?? null,
            }))
          : [],
        snapshotAgeMs: decision?.snapshotAgeMs ?? null,
        confidence: decision?.confidence ?? null,
      };
    }
  } catch (err) {
    report.error = err?.message || String(err);
  }

  return report;
}
